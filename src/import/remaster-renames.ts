/**
 * Remaster rename resolution from the PF2e system's own "Remaster Changes"
 * journal (`pf2e.journals`, "Rules and Languages" page, "X is now Y."
 * sentences). Demiplane still exports pre-remaster names (e.g. a character
 * speaking Undercommon); the system renamed them (Sakvroth). Rather than
 * hardcoding the table — or punting every rename to the mapping editor — the
 * importer reads the system's own changelog, so the mapping follows system
 * updates. Anything unparseable falls back to previous behavior (unmapped).
 */

const JOURNALS_PACK = "pf2e.journals";
const REMASTER_JOURNAL = "Remaster Changes";
const LANGUAGES_PAGE = "Rules and Languages";

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
  const section = pageText.slice(languagesAt);
  for (const match of section.matchAll(/([A-Za-z][\w\s'-]*?)\s+is now\s+([\w\s'-]+)\./g)) {
    const oldSlug = slugifyLanguage(match[1] ?? "");
    const newSlug = slugifyLanguage(match[2] ?? "");
    if (oldSlug !== "" && newSlug !== "") renames.set(oldSlug, newSlug);
  }
  return renames;
}

function slugifyLanguage(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
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
  return parseLanguageRenames(html.replace(/<[^>]+>/g, "\n"));
}
