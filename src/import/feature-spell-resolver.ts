import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { stampImported } from "./types.js";
import { debugLog } from "./debug-log.js";
import { toFoundrySlug } from "./slug-utils.js";
import {
  fetchStreamEngineLines,
  fetchDomainEngineData,
  resolveFeatEngineIdsBySlug,
  type EngineModifier,
  type DomainEngineData,
} from "./stream-engines.js";
import { resolveSpellFromCompendium } from "./compendium-resolver.js";
import { getCharacterLevel } from "./spell-slots.js";
import { itemSystem } from "../pf2e-types.js";
import { PROFICIENCY_TRAINED } from "./pf2e-ranks.js";

/** A spell granted by a feature engine (class feature, heritage, feat). */
export interface GrantedSpell {
  slug: string;
  tradition: string;
  level: number;
  isInnate: boolean;
  isFocus: boolean;
  spellLevel: number;
}

/** Matches spellcasting slot keys such as `slot0` / `slot4`. */
const SLOT_KEY_RE = /^slot(\d+)$/;

/**
 * Fetches feature engines from stream-engines and extracts granted spells.
 * Handles class features, heritage, ancestry feats and domains. Only spells
 * within `maxSpellRank` are returned.
 */
export async function resolveFeatureGrantedSpells(
  engines: DemiplaneEngineEntry[],
  characterLevel: number,
  maxSpellRank: number,
  cacheEngineIds: string[] = []
): Promise<{ innate: GrantedSpell[]; focus: GrantedSpell[] }> {
  const featureEngineIds = collectFeatureEngineIds(engines);
  const domainEngineIds = collectDomainEngineIds(engines);

  if (featureEngineIds.length === 0 && domainEngineIds.length === 0) {
    return { innate: [], focus: [] };
  }

  const [modifiers, domainData] = await Promise.all([
    fetchFeatureModifiers(featureEngineIds, cacheEngineIds),
    fetchDomainEngineData(domainEngineIds),
  ]);

  const { innate, focus } = categorizeGrantedSpells(modifiers, characterLevel);
  focus.push(...(await collectDomainFocusSpells(domainData, maxSpellRank)));

  return { innate, focus };
}

function collectFeatureEngineIds(engines: DemiplaneEngineEntry[]): string[] {
  const ids: string[] = [];

  for (const eng of engines) {
    if (!eng.id || eng.type !== "DemiplaneEngine") continue;

    const name = eng.name as string;
    if (name.startsWith("tabula/class-feature/") || name.startsWith("tabula/heritage/")) {
      ids.push(eng.id as string);
    }
  }

  return ids;
}

function collectDomainEngineIds(engines: DemiplaneEngineEntry[]): string[] {
  const ids: string[] = [];

  for (const eng of engines) {
    if (!eng.id || eng.type !== "DemiplaneEngine") continue;
    if ((eng.name as string).startsWith("tabula/domain/")) {
      ids.push(eng.id as string);
    }
  }

  return ids;
}

// ─── Stream-Engines Fetch ────────────────────────────────────────────────────

async function fetchFeatureModifiers(engineIds: string[], cacheEngineIds: string[]): Promise<EngineModifier[]> {
  const lines = await fetchStreamEngineLines(engineIds);

  const modifiers: EngineModifier[] = [];
  const grantedFeatSlugs: string[] = [];
  for (const line of lines) {
    for (const mod of line.modifiers) {
      if (mod.type === "add-spell") modifiers.push(mod);
      else if (mod.type === "add-feat") grantedFeatSlugs.push(mod.addFeat);
    }
  }

  modifiers.push(...(await fetchGrantedFeatSpellModifiers(grantedFeatSlugs, cacheEngineIds)));

  return modifiers;
}

/**
 * Expands `add-feat` grants into the `add-spell` modifiers of the granted feats.
 *
 * Heritages and features can grant a feat that itself provides innate
 * spellcasting (e.g. Empty Sky Kitsune → Kitsune Spell Familiarity → Daze /
 * Forbidding Ward / Ghost Sound). That granted feat never appears in the
 * character's `engines` array, so its spells are only reachable by resolving the
 * feat slug to its engine definition and reading that definition's modifiers.
 */
async function fetchGrantedFeatSpellModifiers(
  grantedFeatSlugs: string[],
  cacheEngineIds: string[]
): Promise<EngineModifier[]> {
  if (grantedFeatSlugs.length === 0 || cacheEngineIds.length === 0) return [];

  const featEngineIdsBySlug = await resolveFeatEngineIdsBySlug(cacheEngineIds);
  const grantedFeatEngineIds = grantedFeatSlugs
    .map((slug) => featEngineIdsBySlug.get(slug))
    .filter((id): id is string => typeof id === "string");

  if (grantedFeatEngineIds.length === 0) {
    debugLog(`[feature-spells] no engine ids resolved for granted feats: ${grantedFeatSlugs.join(", ")}`);
    return [];
  }

  const lines = await fetchStreamEngineLines(grantedFeatEngineIds);
  const modifiers: EngineModifier[] = [];
  for (const line of lines) {
    for (const mod of line.modifiers) {
      if (mod.type === "add-spell") modifiers.push(mod);
    }
  }

  debugLog(
    `[feature-spells] expanded ${String(grantedFeatEngineIds.length)} granted feat(s) into ${String(modifiers.length)} spell grant(s)`
  );

  return modifiers;
}

// ─── Categorization ──────────────────────────────────────────────────────────

function categorizeGrantedSpells(
  modifiers: EngineModifier[],
  characterLevel: number
): { innate: GrantedSpell[]; focus: GrantedSpell[] } {
  const innate: GrantedSpell[] = [];
  const focus: GrantedSpell[] = [];

  for (const mod of modifiers) {
    if (mod.type !== "add-spell") continue;
    if (mod.level > characterLevel) continue;

    const spell: GrantedSpell = {
      slug: mod.addSpell,
      tradition: mod.tradition ?? "arcane",
      level: mod.level,
      isInnate: mod.isInnate === true,
      isFocus: mod.isInnate !== true,
      spellLevel: mod.spellLevel ?? 0,
    };

    if (spell.isInnate) {
      innate.push(spell);
    } else {
      focus.push(spell);
    }
  }

  return { innate, focus };
}

/**
 * Applies feature-granted spells (focus and innate) to the actor.
 * Creates spellcasting entries and adds spells from stream-engines data.
 */
export async function applyFeatureGrantedSpells(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary,
  cacheEngineIds: string[] = []
): Promise<void> {
  const characterLevel = getCharacterLevel(engines);
  const maxSpellRank = getMaxAccessibleSpellRank(actor, characterLevel);
  const { innate, focus } = await resolveFeatureGrantedSpells(engines, characterLevel, maxSpellRank, cacheEngineIds);

  debugLog(
    `[feature-spells] Found ${String(innate.length)} innate, ${String(focus.length)} focus spells (max rank ${String(maxSpellRank)})`
  );

  // Focus points are deliberately not written here: the PF2e system derives the
  // pool from the number of spells in the focus spellcasting entry.
  if (innate.length > 0) {
    await addFeatureInnateSpells(actor, innate, summary);
  }

  if (focus.length > 0) {
    await addFeatureFocusSpells(actor, focus, engines, summary);
  }
}

async function addFeatureInnateSpells(actor: Actor, spells: GrantedSpell[], summary: ImportSummary): Promise<void> {
  const tradition = spells[0]?.tradition ?? "arcane";
  const entryId = await createFeatureEntry(actor, "Innate Spells", tradition, "innate");

  await addGrantedSpellsToEntry(actor, entryId, spells, summary, "innate");
}

async function addFeatureFocusSpells(
  actor: Actor,
  spells: GrantedSpell[],
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const tradition = spells[0]?.tradition ?? "arcane";
  const entryName = deriveFocusEntryName(engines);
  const entryId = await createFeatureEntry(actor, entryName, tradition, "focus");

  await addGrantedSpellsToEntry(actor, entryId, spells, summary, "focus");
}

function deriveFocusEntryName(engines: DemiplaneEngineEntry[]): string {
  // Look for a school class feature (wizard) or patron (witch) that grants focus spells
  const schoolEngine = engines.find(
    (e) =>
      e.type === "DemiplaneEngine" &&
      (e.name?.startsWith("tabula/class-feature/school-of-") || e.name?.startsWith("tabula/class-feature/school-"))
  );
  if (schoolEngine?.args?.name) {
    const schoolName = (schoolEngine.args.name as string).replace(/^School of /i, "");
    return `${schoolName} Focus Spells`;
  }

  // Witch patron
  const patronEngine = engines.find(
    (e) =>
      e.type === "DemiplaneEngine" && e.name?.startsWith("tabula/class-feature/") && e.args?.sourceRow === "patron-rm"
  );
  if (patronEngine?.args?.name) {
    return `${patronEngine.args.name as string} Focus Spells`;
  }

  // Cleric/other domains (module `initialize/domain/index.eng`)
  const domainEngine = engines.find((e) => e.type === "DemiplaneEngine" && e.name?.startsWith("tabula/domain/"));
  if (domainEngine?.args?.name) {
    return `${domainEngine.args.name as string} Domain Spells`;
  }

  return "Focus Spells";
}

async function createFeatureEntry(
  actor: Actor,
  name: string,
  tradition: string,
  preparedType: string
): Promise<string> {
  const created = await actor.createEmbeddedDocuments("Item", [
    stampImported({
      name,
      type: "spellcastingEntry",
      system: {
        prepared: { value: preparedType },
        tradition: { value: tradition },
        proficiency: { value: PROFICIENCY_TRAINED },
        showSlotlessLevels: { value: false },
      },
    }),
  ]);
  const first = created[0];
  if (!first) throw new Error(`Failed to create spellcasting entry "${name}"`);
  return first.id;
}

async function addGrantedSpellsToEntry(
  actor: Actor,
  entryId: string,
  spells: GrantedSpell[],
  summary: ImportSummary,
  label: string
): Promise<void> {
  const spellItems: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const spell of spells) {
    const foundrySlug = toFoundrySlug(spell.slug);
    if (seen.has(foundrySlug)) continue;
    seen.add(foundrySlug);

    const spellData = await resolveSpellFromCompendium(spell.slug);
    if (!spellData) {
      summary.log.push(`- ${label}: ${foundrySlug} (not found)`);
      summary.unmapped.push({ slug: spell.slug, kind: "spell" });
      continue;
    }

    (spellData as { system: Record<string, unknown> }).system.location = { value: entryId };
    spellItems.push(stampImported(spellData));
  }

  if (spellItems.length > 0) {
    await actor.createEmbeddedDocuments("Item", spellItems);
    summary.log.push(`+ ${label}: ${String(spellItems.length)} spells added`);
  }
}

/**
 * Domain engines (module `initialize/domain/index.eng`) declare their focus
 * spells via `domainSpell` / `advancedSpell` fields rather than add-spell
 * engineModifiers. Domains are always divine.
 *
 * Only spells within `maxSpellRank` are returned: the advanced domain spell is
 * higher-rank and isn't available to low-level characters.
 */
async function collectDomainFocusSpells(domainData: DomainEngineData[], maxSpellRank: number): Promise<GrantedSpell[]> {
  const slugs = domainData.flatMap((data) =>
    [data.domainSpell, data.advancedSpell].filter((s): s is string => typeof s === "string" && s.length > 0)
  );
  if (slugs.length === 0) return [];

  const ranked = await Promise.all(slugs.map(async (slug) => ({ slug, rank: await getSpellRank(slug) })));

  return ranked
    .filter(({ rank }) => rank <= maxSpellRank)
    .map(({ slug }) => ({
      slug,
      tradition: "divine",
      level: 0,
      isInnate: false,
      isFocus: true,
      spellLevel: 0,
    }));
}

/** Resolves a spell's rank from the compendium; unresolvable spells count as rank 0. */
async function getSpellRank(slug: string): Promise<number> {
  const spellData = await resolveSpellFromCompendium(slug);
  if (!spellData) return 0;
  return itemSystem(spellData).level?.value ?? 0;
}

interface SpellcastingEntryLike {
  system?: { slots?: Record<string, { max?: number }> };
}

function getSpellcastingEntries(actor: Actor): SpellcastingEntryLike[] {
  // Entries are items of that type; read slots through the PF2e item shape.
  return Array.from(actor.items)
    .filter((item) => item.type === "spellcastingEntry")
    .map((item) => ({ system: itemSystem(item) }));
}

/**
 * Highest spell rank the character's class grants slots for. The slot maximums
 * are written onto the spellcasting entries by `applySpells`, which runs first
 * and derives them from the class progression in Demiplane. Cantrip slots
 * (rank 0) don't grant access to a rank.
 *
 * Falls back to the standard rank-by-level curve when no entry has slots yet.
 */
function getMaxAccessibleSpellRank(actor: Actor, characterLevel: number): number {
  let maxRank = 0;

  for (const entry of getSpellcastingEntries(actor)) {
    const slots = entry.system?.slots ?? {};

    for (const [key, slot] of Object.entries(slots)) {
      const rank = Number(SLOT_KEY_RE.exec(key)?.[1] ?? Number.NaN);
      if (!Number.isFinite(rank) || rank < 1) continue;
      if ((slot?.max ?? 0) > 0 && rank > maxRank) maxRank = rank;
    }
  }

  return maxRank || Math.ceil(characterLevel / 2);
}
