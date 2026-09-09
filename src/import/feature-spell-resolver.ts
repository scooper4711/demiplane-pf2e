import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { stampImported } from "./types.js";
import { debugLog } from "./debug-log.js";
import { toFoundrySlug } from "./slug-utils.js";
import {
  fetchStreamEngineLines,
  fetchDomainEngineData,
  resolveFeatEngineIdsBySlug,
  type AddSpellModifier,
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
  /** True when added to the character's spell repertoire (a known, slot-cast spell). */
  isKnown: boolean;
  spellLevel: number;
}

/** Matches spellcasting slot keys such as `slot0` / `slot4`. */
const SLOT_KEY_RE = /^slot(\d+)$/;

/**
 * Fetches feature engines from stream-engines and extracts granted spells.
 * Handles class features, heritage, ancestry feats and domains. Only spells
 * within `maxSpellRank` are returned.
 */
export interface FeatureGrantedSpells {
  innate: GrantedSpell[];
  focus: GrantedSpell[];
  known: GrantedSpell[];
  /** The class's focus-entry label (e.g. "Composition Spells"), when declared. */
  focusEntryName?: string;
}

export async function resolveFeatureGrantedSpells(
  engines: DemiplaneEngineEntry[],
  characterLevel: number,
  maxSpellRank: number,
  cacheEngineIds: string[] = []
): Promise<FeatureGrantedSpells> {
  const featureEngineIds = collectFeatureEngineIds(engines);
  const domainEngineIds = collectDomainEngineIds(engines);

  if (featureEngineIds.length === 0 && domainEngineIds.length === 0) {
    return { innate: [], focus: [], known: [] };
  }

  const [modifiers, domainData] = await Promise.all([
    fetchFeatureModifiers(featureEngineIds, cacheEngineIds),
    fetchDomainEngineData(domainEngineIds),
  ]);

  const { innate, focus, known } = categorizeGrantedSpells(modifiers, characterLevel);
  focus.push(...(await collectDomainFocusSpells(domainData, maxSpellRank)));

  const focusEntryName = findFocusEntryName(modifiers);
  return focusEntryName !== undefined ? { innate, focus, known, focusEntryName } : { innate, focus, known };
}

/**
 * Reads the class's declared focus-entry label from a `v2-add-spellcasting-feature`
 * modifier (e.g. the bard's "Composition Spells"), used to name the Foundry focus
 * spellcasting entry. Returns undefined when no class feature declares one.
 */
function findFocusEntryName(modifiers: EngineModifier[]): string | undefined {
  for (const mod of modifiers) {
    if (mod.type === "v2-add-spellcasting-feature" && mod.hasFocusGroup === true) {
      const name = mod.focusName;
      if (typeof name === "string" && name !== "") return name;
    }
  }
  return undefined;
}

/**
 * Engine-name prefixes whose definitions carry feature-granted `add-spell`
 * modifiers. `tabula/class/` is included because a class's automatic
 * sub-features (e.g. the bard's Composition Spells / Composition Cantrips
 * granting Counter Performance and Courageous Anthem) live inside the class
 * engine definition rather than as top-level engines on the character.
 */
const FEATURE_ENGINE_PREFIXES = ["tabula/class/", "tabula/class-feature/", "tabula/heritage/"] as const;

function collectFeatureEngineIds(engines: DemiplaneEngineEntry[]): string[] {
  const ids: string[] = [];

  for (const eng of engines) {
    if (!eng.id || eng.type !== "DemiplaneEngine") continue;

    const name = eng.name as string;
    if (FEATURE_ENGINE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
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
    modifiers.push(...collectSpellModifiers(line.modifiers));
    for (const mod of line.modifiers) {
      if (mod.type === "add-feat") grantedFeatSlugs.push(mod.addFeat);
    }
  }

  modifiers.push(...(await fetchGrantedFeatSpellModifiers(grantedFeatSlugs, cacheEngineIds)));

  return modifiers;
}

/**
 * Keeps the spell-bearing modifiers from a single engine's modifier list. An
 * `add-spell` grant is tagged `forcesFocus` when the same engine also grants a
 * focus point, since that pairing marks it as a focus-pool spell (e.g. a wizard
 * curriculum granting Force Bolt alongside `add-focus-point`).
 */
function collectSpellModifiers(lineModifiers: EngineModifier[]): EngineModifier[] {
  const grantsFocusPoint = lineModifiers.some((mod) => mod.type === "add-focus-point");
  const spellModifiers: EngineModifier[] = [];

  for (const mod of lineModifiers) {
    if (mod.type === "add-spell") {
      spellModifiers.push(grantsFocusPoint ? { ...mod, forcesFocus: true } : mod);
    } else if (mod.type === "v2-add-spellcasting-feature") {
      spellModifiers.push(mod);
    }
  }

  return spellModifiers;
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
    modifiers.push(...collectSpellModifiers(line.modifiers));
  }

  debugLog(
    `[feature-spells] expanded ${String(grantedFeatEngineIds.length)} granted feat(s) into ${String(modifiers.length)} spell grant(s)`
  );

  return modifiers;
}

// ─── Categorization ──────────────────────────────────────────────────────────

/**
 * Tradition sentinel used by focus/composition spells that take the tradition of
 * the class that grants them (e.g. a bard's Composition Spells are occult). Such
 * a grant is a focus spell, never a standalone repertoire spell.
 */
const INHERIT_TRADITION = "inherit";

/**
 * Decides whether an `isKnown` grant is a true *repertoire* spell (added to the
 * class's normal, slot-cast spell list) versus a *focus* spell that merely
 * carries the same flag.
 *
 * The `isKnown` flag alone is ambiguous: the bard Maestro muse's Soothe (a real
 * repertoire spell) and the bard's composition spells (Courageous Anthem,
 * Counter Performance, Lingering Composition — all focus spells) are all flagged
 * `isKnown: true`. Two signals separate them:
 *
 * - **Concrete tradition**: a repertoire grant names its tradition (`"occult"`),
 *   whereas composition/focus spells inherit it (`"inherit"` or unset).
 * - **No focus group**: a `parentFeature` pointing at a focus group (e.g.
 *   `"composition-spells"`) marks the grant as a focus spell.
 *
 * A grant that {@link forcesFocus} (its engine also granted a focus point) is
 * never a repertoire spell.
 */
function isRepertoireGrant(mod: AddSpellModifier): boolean {
  if (mod.isKnown !== true || mod.forcesFocus === true) return false;
  const tradition = mod.tradition ?? "";
  const hasConcreteTradition = tradition !== "" && tradition !== INHERIT_TRADITION;
  const belongsToFocusGroup = (mod.parentFeature ?? "") !== "";
  return hasConcreteTradition && !belongsToFocusGroup;
}

/**
 * Sorts feature-granted `add-spell` modifiers into three kinds:
 *
 * - **innate** (`isInnate: true`, and no forced focus): cast at will from an
 *   Innate Spells entry (e.g. Seer Elf → Detect Magic).
 * - **known** (a repertoire grant per {@link isRepertoireGrant}): added to the
 *   class's spell repertoire, cast with normal slots (e.g. Maestro muse → Soothe).
 * - **focus** (everything else): a focus-pool spell. This includes `isKnown`
 *   grants that inherit their tradition or belong to a focus group (the bard's
 *   composition spells) and any grant sharing an engine with an `add-focus-point`
 *   (`forcesFocus`, e.g. a wizard curriculum's Force Bolt).
 *
 * The previous logic had no `known` bucket and treated every non-innate grant as
 * focus, so repertoire spells like Soothe were wrongly filed under Focus Spells.
 */
function categorizeGrantedSpells(
  modifiers: EngineModifier[],
  characterLevel: number
): { innate: GrantedSpell[]; focus: GrantedSpell[]; known: GrantedSpell[] } {
  const innate: GrantedSpell[] = [];
  const focus: GrantedSpell[] = [];
  const known: GrantedSpell[] = [];

  for (const mod of modifiers) {
    if (mod.type !== "add-spell") continue;
    if (mod.level > characterLevel) continue;

    const isInnate = mod.isInnate === true && mod.forcesFocus !== true;
    const isKnown = !isInnate && isRepertoireGrant(mod);
    const spell: GrantedSpell = {
      slug: mod.addSpell,
      tradition: mod.tradition ?? "arcane",
      level: mod.level,
      isInnate,
      isKnown,
      isFocus: !isInnate && !isKnown,
      spellLevel: mod.spellLevel ?? 0,
    };

    if (isInnate) innate.push(spell);
    else if (isKnown) known.push(spell);
    else focus.push(spell);
  }

  return { innate, focus, known };
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
  const { innate, focus, known, focusEntryName } = await resolveFeatureGrantedSpells(
    engines,
    characterLevel,
    maxSpellRank,
    cacheEngineIds
  );

  debugLog(
    `[feature-spells] Found ${String(innate.length)} innate, ${String(focus.length)} focus, ${String(known.length)} known spells (max rank ${String(maxSpellRank)})`
  );

  // Focus points are deliberately not written here: the PF2e system derives the
  // pool from the number of spells in the focus spellcasting entry.
  if (innate.length > 0) {
    await addFeatureInnateSpells(actor, innate, summary);
  }

  if (focus.length > 0) {
    await addFeatureFocusSpells(actor, focus, engines, summary, focusEntryName);
  }

  if (known.length > 0) {
    await addFeatureKnownSpells(actor, known, summary);
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
  summary: ImportSummary,
  focusEntryName?: string
): Promise<void> {
  const tradition = resolveFocusTradition(actor, spells[0]?.tradition);
  const entryName = focusEntryName ?? deriveFocusEntryName(engines);
  const entryId = await createFeatureEntry(actor, entryName, tradition, "focus");

  await addGrantedSpellsToEntry(actor, entryId, spells, summary, "focus");
}

/**
 * Resolves the tradition for a focus entry. Composition and other class focus
 * spells inherit their tradition (`"inherit"` or unset); resolve that to the
 * character's own spellcasting tradition (already imported by applySpells) so
 * the focus entry matches the class, falling back to "arcane" when unknown.
 */
function resolveFocusTradition(actor: Actor, granted: string | undefined): string {
  if (granted !== undefined && granted !== "" && granted !== INHERIT_TRADITION) return granted;
  return primarySpellcastingTradition(actor) ?? "arcane";
}

/** The tradition of the character's first repertoire/prepared spellcasting entry, if any. */
function primarySpellcastingTradition(actor: Actor): string | undefined {
  for (const item of Array.from(actor.items)) {
    if (item.type !== "spellcastingEntry") continue;
    const tradition = itemSystem(item).tradition?.value;
    if (typeof tradition === "string" && tradition !== "") return tradition;
  }
  return undefined;
}

/**
 * Adds feature-granted *known* spells to the character's repertoire. A known
 * spell belongs in an existing spontaneous spellcasting entry of the same
 * tradition (the bard Maestro muse's Soothe joins the bard's occult repertoire);
 * if the character has no such entry, a new spontaneous entry of that tradition
 * is created to hold them.
 */
async function addFeatureKnownSpells(actor: Actor, spells: GrantedSpell[], summary: ImportSummary): Promise<void> {
  const tradition = spells[0]?.tradition ?? "arcane";
  const entryId =
    findRepertoireEntryId(actor, tradition) ??
    (await createFeatureEntry(actor, `${capitalize(tradition)} Spells`, tradition, "spontaneous"));

  await addGrantedSpellsToEntry(actor, entryId, spells, summary, "known");
}

/**
 * Finds an existing spontaneous (repertoire) spellcasting entry matching the
 * tradition, so a granted known spell joins the class's own repertoire rather
 * than a separate entry. Returns undefined when the character has none.
 */
function findRepertoireEntryId(actor: Actor, tradition: string): string | undefined {
  for (const item of Array.from(actor.items)) {
    if (item.type !== "spellcastingEntry") continue;
    const system = itemSystem(item);
    if (system.prepared?.value === "spontaneous" && system.tradition?.value === tradition) {
      return item.id ?? undefined;
    }
  }
  return undefined;
}

/** Title-cases a tradition slug for a generated entry name (e.g. "occult" → "Occult"). */
function capitalize(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
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
      isKnown: false,
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
