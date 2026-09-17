import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { MODULE_ID, stampImported } from "./types.js";
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
  /** True for a witch hex — a focus spell cast from the "Hexes" entry. */
  isHex: boolean;
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
  /** Witch hexes — focus spells that live in a dedicated "Hexes" entry. */
  hexes: GrantedSpell[];
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
    return { innate: [], focus: [], known: [], hexes: [] };
  }

  const [modifiers, domainData] = await Promise.all([
    fetchFeatureModifiers(featureEngineIds, cacheEngineIds),
    fetchDomainEngineData(domainEngineIds),
  ]);

  const focusEntryName = findFocusEntryName(modifiers);
  // The witch (hex focus group) files its non-hex granted spells into the
  // prepared repertoire; other classes (e.g. the bard's composition group) file
  // inherited-tradition grants as focus spells. See {@link isInheritedRepertoireGrant}.
  const hexFocusGroup = declaresHexFocusGroup(modifiers);
  const { innate, focus, known, hexes } = categorizeGrantedSpells(modifiers, characterLevel, hexFocusGroup);
  focus.push(...(await collectDomainFocusSpells(domainData, maxSpellRank)));

  const result: FeatureGrantedSpells = { innate, focus, known, hexes };
  return focusEntryName !== undefined ? { ...result, focusEntryName } : result;
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

/** The `focusSlug` the witch's spellcasting feature declares for its hexes. */
const HEX_FOCUS_SLUG = "hex-spells";

/**
 * Whether the class's declared focus group is the witch's hex group. The witch's
 * spellcasting feature declares `focusSlug: "hex-spells"`, distinguishing it from
 * the bard's `"composition-spells"`. This tells us the class's non-hex granted
 * spells (Sure Strike, Phantom Pain) are ordinary familiar spells bound for the
 * prepared repertoire, whereas the bard's inherited-tradition grants (Courageous
 * Anthem) are composition focus spells. See {@link isInheritedRepertoireGrant}.
 */
function declaresHexFocusGroup(modifiers: EngineModifier[]): boolean {
  return modifiers.some((mod) => mod.type === "v2-add-spellcasting-feature" && mod.focusSlug === HEX_FOCUS_SLUG);
}

/**
 * Engine-name prefixes whose definitions carry feature-granted `add-spell`
 * modifiers. `tabula/class/` is included because a class's automatic
 * sub-features (e.g. the bard's Composition Spells / Composition Cantrips
 * granting Counter Performance and Courageous Anthem) live inside the class
 * engine definition rather than as top-level engines on the character.
 * `tabula/feat/` is included because a directly-taken feat can grant a spell
 * outright (e.g. the witch's Cackle feat grants the Cackle hex via an `add-spell`
 * whose `parentFeature` is the hex group); such feats are not reached by the
 * `add-feat` expansion, which only follows feats granted by *other* features.
 */
const FEATURE_ENGINE_PREFIXES = ["tabula/class/", "tabula/class-feature/", "tabula/heritage/", "tabula/feat/"] as const;

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

/** The focus group Demiplane assigns a witch hex's `add-spell` grant. */
const HEX_FOCUS_GROUP = "hex-spells";

/**
 * Recognizes a witch hex among a feature's `add-spell` grants.
 *
 * A witch lesson or patron grants two spells from one engine: the hex itself
 * (a focus spell) and a plain spell added to the witch's prepared list (the
 * familiar's known spell). For example, Lesson of Vengeance grants the Needle
 * of Vengeance hex plus Phantom Pain; Spinner of Threads grants the Nudge Fate
 * hex cantrip plus Sure Strike. Only the hex belongs in the "Hexes" focus
 * entry; the plain spell belongs in the prepared repertoire.
 *
 * Demiplane distinguishes them two ways, either of which marks a hex:
 * - the grant's `parentFeature` is the hex focus group (`"hex-spells"`), which is
 *   inherently witch-specific and so needs no class check; or
 * - the grant carries focus-spell casting machinery — a save DC source
 *   (`saveDC`) or a spell-attack source (`spellAttack`) — as on Nudge Fate and
 *   Needle of Vengeance, whose grants omit the hex `parentFeature`. This branch
 *   is only a hex signal on a witch: other classes' focus grants (e.g. a
 *   sorcerer bloodline spell) carry the same machinery, so it is gated on
 *   `hexFocusGroup` (the character's class declares `focusSlug: "hex-spells"`).
 *   Without the gate such grants would be misfiled into a witch "Hexes" entry.
 */
function isHexGrant(mod: AddSpellModifier, hexFocusGroup: boolean): boolean {
  if ((mod.parentFeature ?? "") === HEX_FOCUS_GROUP) return true;
  if (!hexFocusGroup) return false;
  const hasSaveDc = Array.isArray(mod.saveDC) && mod.saveDC.length > 0;
  const hasSpellAttack = (mod.spellAttack ?? "") !== "";
  return hasSaveDc || hasSpellAttack;
}

/**
 * A witch feature's *plain* granted spell — the familiar's known spell that
 * accompanies a hex (Sure Strike beside Nudge Fate, Phantom Pain beside Needle
 * of Vengeance). It is `isKnown: true`, inherits the class tradition, carries no
 * focus group, and is not itself a hex, so it belongs in the class's prepared
 * repertoire rather than a focus entry.
 *
 * This is deliberately narrower than {@link isRepertoireGrant} (which requires a
 * concrete tradition to catch the bard Maestro muse's Soothe). The bard's
 * composition cantrips (e.g. Courageous Anthem) look identical to these witch
 * grants — `isKnown`, no concrete tradition, no focus group on the modifier — so
 * the modifier alone cannot separate them. The distinguishing signal is the
 * class: only the witch declares a hex focus group (`focusSlug: "hex-spells"`),
 * so the `hexFocusGroup` gate selects it while the bard's composition grants
 * stay focus. Hexes are excluded by the caller checking {@link isHexGrant} first.
 *
 * The tradition test accepts both the explicit `"inherit"` sentinel (Sure
 * Strike) and an absent tradition (Phantom Pain, whose grant omits the field):
 * both are the witch's own tradition, distinct from a concrete tradition that
 * would mark a true cross-tradition repertoire grant handled by
 * {@link isRepertoireGrant}.
 */
function isInheritedRepertoireGrant(mod: AddSpellModifier, hexFocusGroup: boolean): boolean {
  if (!hexFocusGroup) return false;
  if (mod.isKnown !== true || mod.forcesFocus === true) return false;
  if ((mod.parentFeature ?? "") !== "") return false;
  const tradition = mod.tradition ?? "";
  return tradition === "" || tradition === INHERIT_TRADITION;
}

/**
 * Sorts feature-granted `add-spell` modifiers into four kinds:
 *
 * - **innate** (`isInnate: true`, and no forced focus): cast at will from an
 *   Innate Spells entry (e.g. Seer Elf → Detect Magic).
 * - **hex** (a witch hex per {@link isHexGrant}): a focus spell placed in the
 *   dedicated "Hexes" entry (e.g. patron/lesson hexes, Cackle).
 * - **known** (a repertoire grant): added to the class's spell repertoire — a
 *   spontaneous caster's known spell (Maestro muse → Soothe, per
 *   {@link isRepertoireGrant}) or a witch's prepared-list spell that accompanies
 *   a hex (per {@link isInheritedRepertoireGrant}).
 * - **focus** (everything else): a focus-pool spell. This includes the bard's
 *   composition spells (a focus group with inherited tradition) and any grant
 *   sharing an engine with an `add-focus-point` (`forcesFocus`, e.g. a wizard
 *   curriculum's Force Bolt).
 *
 * Order matters: a hex is tested before repertoire so the hex lands in "Hexes"
 * while its plain sibling spell falls through to the repertoire.
 */
/**
 * Classifies one `add-spell` grant, resolving its kind (innate/hex/known/focus)
 * into the `GrantedSpell` flags. Kept separate from the collection loop so the
 * loop stays a simple dispatch and this holds the (mutually exclusive) decision.
 */
function buildGrantedSpell(mod: AddSpellModifier, hexFocusGroup: boolean): GrantedSpell {
  const isInnate = mod.isInnate === true && mod.forcesFocus !== true;
  const isHex = !isInnate && isHexGrant(mod, hexFocusGroup);
  const isKnown = !isInnate && !isHex && (isRepertoireGrant(mod) || isInheritedRepertoireGrant(mod, hexFocusGroup));
  return {
    slug: mod.addSpell,
    tradition: mod.tradition ?? "arcane",
    level: mod.level,
    isInnate,
    isKnown,
    isHex,
    isFocus: !isInnate && !isHex && !isKnown,
    spellLevel: mod.spellLevel ?? 0,
  };
}

function categorizeGrantedSpells(
  modifiers: EngineModifier[],
  characterLevel: number,
  hexFocusGroup: boolean
): { innate: GrantedSpell[]; focus: GrantedSpell[]; known: GrantedSpell[]; hexes: GrantedSpell[] } {
  const innate: GrantedSpell[] = [];
  const focus: GrantedSpell[] = [];
  const known: GrantedSpell[] = [];
  const hexes: GrantedSpell[] = [];

  for (const mod of modifiers) {
    if (mod.type !== "add-spell") continue;
    if (mod.level > characterLevel) continue;

    const spell = buildGrantedSpell(mod, hexFocusGroup);

    if (spell.isInnate) innate.push(spell);
    else if (spell.isHex) hexes.push(spell);
    else if (spell.isKnown) known.push(spell);
    else focus.push(spell);
  }

  return { innate, focus, known, hexes };
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
  const { innate, focus, known, hexes, focusEntryName } = await resolveFeatureGrantedSpells(
    engines,
    characterLevel,
    maxSpellRank,
    cacheEngineIds
  );

  debugLog(
    `[feature-spells] Found ${String(innate.length)} innate, ${String(focus.length)} focus, ${String(known.length)} known, ${String(hexes.length)} hex spells (max rank ${String(maxSpellRank)})`
  );

  // Focus points are deliberately not written here: the PF2e system derives the
  // pool from the number of spells in the focus spellcasting entry.
  if (innate.length > 0) {
    await addFeatureInnateSpells(actor, innate, summary);
  }

  if (hexes.length > 0) {
    await addFeatureHexSpells(actor, hexes, summary);
  }

  if (focus.length > 0) {
    await addFeatureFocusSpells(actor, focus, engines, summary, focusEntryName);
  }

  if (known.length > 0) {
    await addFeatureKnownSpells(actor, known, summary);
  }
}

/** The label PF2e uses for a witch's focus-spell (hex) spellcasting entry. */
const HEX_ENTRY_NAME = "Hexes";

/**
 * Adds witch hexes to a dedicated "Hexes" focus entry. Hexes inherit the witch's
 * spellcasting tradition (resolved from the class entry `applySpells` created),
 * and PF2e derives the focus-pool size from the number of spells in this entry.
 */
async function addFeatureHexSpells(actor: Actor, spells: GrantedSpell[], summary: ImportSummary): Promise<void> {
  const tradition = resolveFocusTradition(actor, spells[0]?.tradition);
  // Player-selected hexes (e.g. Phase Familiar) already created the "Hexes"
  // entry in applySpells; reuse it so patron/lesson hexes and Cackle join the
  // same focus pool rather than a second "Hexes" entry.
  const entryId =
    findImportedFocusEntryId(actor, HEX_ENTRY_NAME) ??
    (await createFeatureEntry(actor, HEX_ENTRY_NAME, tradition, "focus"));

  await addGrantedSpellsToEntry(actor, entryId, spells, summary, "hex");
}

/** Finds an imported focus spellcasting entry by name, so hexes share one entry. */
function findImportedFocusEntryId(actor: Actor, name: string): string | undefined {
  for (const item of Array.from(actor.items)) {
    if (item.type !== "spellcastingEntry" || item.name !== name) continue;
    if (!isImportedEntry(item)) continue;
    if (itemSystem(item).prepared?.value === "focus") return item.id ?? undefined;
  }
  return undefined;
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
  // Reuse an existing imported focus entry of this name (e.g. a witch's "Hexes"
  // entry created by applySpells or addFeatureHexSpells) rather than creating a
  // duplicate, so all focus spells of one entry share it.
  const entryId =
    findImportedFocusEntryId(actor, entryName) ?? (await createFeatureEntry(actor, entryName, tradition, "focus"));

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
 * Adds feature-granted *known* spells to the character's class spell list. A
 * known spell joins the existing class entry of the same tradition — a
 * spontaneous caster's repertoire (the bard Maestro muse's Soothe joins the
 * bard's occult repertoire) or a witch's prepared spell list (Sure Strike and
 * Phantom Pain, taught by the patron and a lesson, join the witch's occult
 * spellbook so they can be prepared). The spell becomes an item in that entry;
 * for a prepared caster it is available to prepare but occupies no slot. If the
 * character has no matching class entry, a spontaneous entry of that tradition
 * is created to hold them.
 *
 * Spells that inherit their tradition are resolved to the class's own tradition
 * so they match the entry `applySpells` created rather than a stray "Arcane".
 */
async function addFeatureKnownSpells(actor: Actor, spells: GrantedSpell[], summary: ImportSummary): Promise<void> {
  const tradition = resolveFocusTradition(actor, spells[0]?.tradition);
  const entryId =
    findClassSpellListEntryId(actor, tradition) ??
    (await createFeatureEntry(actor, `${capitalize(tradition)} Spells`, tradition, "spontaneous"));

  await addGrantedSpellsToEntry(actor, entryId, spells, summary, "known");
}

/**
 * Finds an existing Demiplane-imported class spell-list entry matching the
 * tradition — spontaneous (repertoire) or prepared (spellbook) — so a granted
 * known spell joins the class's own list rather than a separate entry. Returns
 * undefined when the character has none.
 *
 * Innate and focus entries are excluded: a granted known spell is a normal
 * slot-cast spell, not an at-will innate or a focus-pool spell.
 *
 * Only entries this module imported are considered. Hand-crafted entries a user
 * built in Foundry (e.g. a macro that gathers a staff's spells into a
 * spontaneous arcane entry) must never receive Demiplane-granted spells: the
 * module does not manage user content, and merging into it both corrupts the
 * user's entry and leaves the granted spells outside the class list. A user
 * entry lacks the `imported` flag, so skipping unflagged entries excludes it;
 * when no imported class entry exists the caller creates its own.
 */
function findClassSpellListEntryId(actor: Actor, tradition: string): string | undefined {
  for (const item of Array.from(actor.items)) {
    if (item.type !== "spellcastingEntry") continue;
    if (!isImportedEntry(item)) continue;
    const system = itemSystem(item);
    const prepared = system.prepared?.value;
    if ((prepared === "spontaneous" || prepared === "prepared") && system.tradition?.value === tradition) {
      return item.id ?? undefined;
    }
  }
  return undefined;
}

/** Whether a spellcasting entry was created by this module's import (vs. hand-crafted). */
function isImportedEntry(item: { flags?: Record<string, unknown> }): boolean {
  const flags = item.flags?.[MODULE_ID] as { imported?: unknown } | undefined;
  return flags?.imported === true;
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
      isHex: false,
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
