/**
 * Remaster rename resolution from the PF2e system's own "Remaster Changes"
 * journal (`pf2e.journals`, "Rules and Languages" page, "X is now Y."
 * sentences). Demiplane still exports pre-remaster names (e.g. a character
 * speaking Undercommon); the system renamed them (Sakvroth). Rather than
 * hardcoding the table — or punting every rename to the mapping editor — the
 * importer reads the system's own changelog, so the mapping follows system
 * updates. Anything unparseable falls back to previous behavior (unmapped).
 */

import { slugifyFreeText, stripHtmlTags } from "./slug-utils.js";

const JOURNALS_PACK = "pf2e.journals";
const REMASTER_JOURNAL = "Remaster Changes";
const LANGUAGES_PAGE = "Rules and Languages";

/** Marker inside a rename sentence ("Abyssal is now Chthonian."). */
const RENAME_MARKER = " is now ";

/** Old language slug → new language slug, once loaded. */
let cachedLanguageRenames: Map<string, string> | null = null;

/** Test-only: clears the cached rename table. */
export function _resetRemasterRenamesForTests(): void {
  cachedLanguageRenames = null;
}

/**
 * Parses "X is now Y." rename sentences from a journal page's plain text.
 * Only sentences after the "Languages" section heading are considered, so
 * domain renames (Delirium → Disorientation) in the same page don't leak in.
 */
export function parseLanguageRenames(pageText: string): Map<string, string> {
  const renames = new Map<string, string>();
  const languagesAt = pageText.indexOf("Languages");
  if (languagesAt < 0) return renames;
  // Only period-terminated sentences count, matching the old "X is now Y."
  // pattern. Plain indexOf scans keep this linear; the lazy-quantifier
  // matchAll this replaces can backtrack super-linearly on long pages.
  let rest = pageText.slice(languagesAt);
  for (;;) {
    const dot = rest.indexOf(".");
    if (dot < 0) break;
    const sentence = rest.slice(0, dot);
    rest = rest.slice(dot + 1);
    const at = sentence.indexOf(RENAME_MARKER);
    if (at < 0) continue;
    const oldSlug = slugifyFreeText(sentence.slice(0, at));
    const newSlug = slugifyFreeText(sentence.slice(at + RENAME_MARKER.length));
    if (oldSlug !== "" && newSlug !== "") renames.set(oldSlug, newSlug);
  }
  return renames;
}

/**
 * Resolves a pre-remaster language slug to its current slug via the system's
 * remaster journal, or null when unresolvable. The table loads once per
 * session; any failure (missing pack, journal, or page) yields null so the
 * caller keeps its existing unmatched handling.
 */
export async function resolveRemasterLanguage(slug: string): Promise<string | null> {
  try {
    if (!cachedLanguageRenames) {
      cachedLanguageRenames = await loadLanguageRenames();
    }
    return cachedLanguageRenames.get(slug) ?? null;
  } catch {
    return null;
  }
}

async function loadLanguageRenames(): Promise<Map<string, string>> {
  const pack = game.packs.get(JOURNALS_PACK);
  if (!pack) return new Map();
  const indexEntry = pack.index.find((e: { name: string }) => e.name === REMASTER_JOURNAL);
  if (!indexEntry) return new Map();
  // eslint-disable-next-line no-restricted-syntax -- game.packs.getDocument is union-typed; only journals carry pages
  const journal = (await pack.getDocument(indexEntry._id)) as unknown as {
    pages: Array<{ name: string; text?: { content?: string } }>;
  };
  const page = (journal.pages ?? []).find((p) => p.name === LANGUAGES_PAGE);
  const html = page?.text?.content ?? "";
  return parseLanguageRenames(stripHtmlTags(html));
}
