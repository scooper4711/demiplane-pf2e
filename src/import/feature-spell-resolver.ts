/* eslint-disable max-lines -- Feature-spell routing is inherently large; split would hurt cohesion */
import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { MODULE_ID, stampImported } from "./types.js";
import { debugLog } from "./debug-log.js";
import { toFoundrySlug } from "./slug-utils.js";
import {
  fetchStreamEngineLines,
  fetchDomainEngineData,
  expandFeatGrantLines,
  mapClassFeatureEngineIds,
  mapSpellEngineIds,
  resolveGrantBuilderSelections,
  type AddSpellModifier,
  type EngineModifier,
  type DomainEngineData,
  type RawEngineLine,
} from "./stream-engines.js";
import { resolveSpellFromCompendium } from "./compendium-resolver.js";
import { getCharacterLevel, applySlotMaximums } from "./spell-slots.js";
import { deriveClassEntryName } from "./spell-importer.js";
import { HEX_FOCUS_GROUP, APPARITION_SPELLCASTING, RUNES_SPELLCASTING_FEATURE } from "./spellcasting-features.js";
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
  /**
   * True for an animist apparition grant — filed in the apparition entry
   * rather than the class repertoire. Vessel spells (apparition grants gated
   * on a satisfied primary-apparition restriction) are NOT apparition spells;
   * they fall through to focus like any other parent-feature grant.
   */
  isApparition: boolean;
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
  /** Animist apparition grants — filed in the apparition spellcasting entry. */
  apparition: GrantedSpell[];
  /** The class's focus-entry label (e.g. "Composition Spells"), when declared. */
  focusEntryName?: string;
  /** Spellcasting features whose every spell is signature (unlimited). */
  unlimitedSignatures: string[];
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
    return { innate: [], focus: [], known: [], hexes: [], apparition: [], unlimitedSignatures: [] };
  }

  const [modifiers, domainData] = await Promise.all([
    fetchFeatureModifiers(featureEngineIds, cacheEngineIds),
    fetchDomainEngineData(domainEngineIds),
  ]);
  modifiers.push(...(await fetchLinkSpellModifiers(engines, cacheEngineIds)));
  // Granted builder selections (e.g. an archetype's vindication edge) name
  // feature definitions worth chasing for their own spell grants.
  const builderSelections = await resolveGrantBuilderSelections(cacheEngineIds);
  const { modifiers: subFeatureModifiers, cacheLines } = await fetchSpellcastingSubFeatures(
    engines,
    characterLevel,
    cacheEngineIds,
    [...builderSelections.values()]
  );
  modifiers.push(...subFeatureModifiers);

  const focusEntryName = findFocusEntryName(modifiers);
  const unlimitedSignatures = collectUnlimitedSignatures(modifiers);
  // The witch (hex focus group) files its non-hex granted spells into the
  // prepared repertoire; other classes (e.g. the bard's composition group) file
  // inherited-tradition grants as focus spells. See {@link isInheritedRepertoireGrant}.
  const hexFocusGroup = declaresHexFocusGroup(modifiers);
  const granted = dropUnsatisfiedStoreGrants(modifiers, engines);
  const focusSlugs = await findDefinitionFocusSlugs(granted, cacheLines);
  const { innate, focus, known, hexes, apparition } = categorizeGrantedSpells(
    granted,
    characterLevel,
    hexFocusGroup,
    focusSlugs
  );
  const gatedFocus = await filterAccessibleSpells(focus, maxSpellRank);
  gatedFocus.push(...(await collectDomainFocusSpells(domainData, maxSpellRank)));
  // The apparition entry is spontaneous: every spell in it must be castable
  // with the character's slots, so future-rank grants (e.g. Avatar arriving
  // through a granted-feat chain) are gated out like focus spells. Prepared
  // repertoires (`known`) are left alone — a spellbook may hold spells above
  // the caster's slots.
  const gatedApparition = await filterAccessibleSpells(apparition, maxSpellRank);

  const result: FeatureGrantedSpells = {
    innate,
    focus: gatedFocus,
    known,
    hexes,
    apparition: gatedApparition,
    unlimitedSignatures,
  };
  return focusEntryName !== undefined ? { ...result, focusEntryName } : result;
}

/**
 * Spellcasting features Demiplane marks signature-unlimited (every spell of
 * the feature is a signature spell, e.g. an animist's apparition spells).
 */
function collectUnlimitedSignatures(modifiers: EngineModifier[]): string[] {
  const features: string[] = [];
  for (const mod of modifiers) {
    if (mod.type !== "v2-add-signature-spells") continue;
    if (mod.signatureType !== "unlimited") continue;
    if (typeof mod.featureSlug === "string" && mod.featureSlug !== "") features.push(mod.featureSlug);
  }
  return features;
}

/**
 * Drops `add-spell` grants gated on a character store that isn't satisfied
 * (e.g. an apparition's vessel spell gated on its `<apparition>-is-primary`
 * flag when another apparition is primary). Stores Demiplane doesn't export
 * are kept, not dropped — absence of evidence isn't absence of the grant.
 */
function dropUnsatisfiedStoreGrants(modifiers: EngineModifier[], engines: DemiplaneEngineEntry[]): EngineModifier[] {
  return modifiers.filter((mod) => {
    if (mod.type !== "add-spell") return true;
    const restriction = mod.storeRestriction;
    if (!restriction || typeof restriction !== "object") return true;
    const storeName = restriction.storeName;
    if (typeof storeName !== "string" || storeName === "") return true;
    const store = engines.find((e) => e.name === storeName);
    if (!store) return true;
    return String(store.value ?? "") === String(restriction.storeValue ?? "");
  });
}

/**
 * Reads the summoner's link-spell grants from the link-spells feature
 * definition. Every summoner has link cantrips, but Demiplane exports neither
 * engines nor reachable references for the feature — the class definition is
 * flat — so it is resolved by path out of the character's cached definitions,
 * the same cache the feat expansion already downloads. Whatever the
 * definition grants today (Boost Eidolon, Evolution Surge) flows through
 * categorization, rank gating, and compendium resolution like any other grant,
 * as do future link spells from taken feats (Reinforce Eidolon, Eidolon's
 * Wrath), which arrive through the normal feat path.
 */
async function fetchLinkSpellModifiers(
  engines: DemiplaneEngineEntry[],
  cacheEngineIds: string[]
): Promise<EngineModifier[]> {
  if (!engines.some((e) => e.name === "tabula/class/summoner-rm.eng")) return [];
  if (cacheEngineIds.length === 0) return [];

  const lines = await fetchStreamEngineLines(cacheEngineIds);
  const modifiers: EngineModifier[] = [];
  for (const line of lines) {
    if (line.name !== "tabula/class-feature/link-spells-rm.eng") continue;
    modifiers.push(...collectSpellModifiers(line.modifiers));
  }
  return modifiers;
}

/**
 * Fetches spell grants from the class's automatic spellcasting sub-features —
 * definitions the character holds no engines for, so the feature-modifier
 * fetch above never sees them.
 *
 * Most classes embed their automatic grants in the class engine definition
 * (the bard's compositions) or gate them behind chosen features that do appear
 * as engines (mysteries, bloodlines, patrons). The necromancer instead spreads
 * them across separate sub-feature definitions: its spellcasting definition
 * grants harm, its grave-spells focus feature grants Necrotic Bomb, and that
 * feature in turn grants the grave-cantrips feature (Create Thrall, Thrall
 * Charge). Nothing there is ever chosen, so none of it appears in the
 * character's engines — without this chase those spells silently vanish and
 * the focus entry falls back to a generic name.
 *
 * The chase is bounded and strictly additive: roots are the spellcasting
 * features the character's own selected spells name plus the granted
 * builder-selection features (e.g. an archetype's vindication edge), then
 * each level's focus groups, then their granted sub-features gated on arrival
 * level — three levels deep at most. Grants duplicating ones the character
 * engines already provide collapse downstream (spells dedupe per entry when
 * added).
 */
async function fetchSpellcastingSubFeatures(
  engines: DemiplaneEngineEntry[],
  characterLevel: number,
  cacheEngineIds: string[],
  selectionSlugs: string[] = []
): Promise<{ modifiers: EngineModifier[]; cacheLines: RawEngineLine[] }> {
  const empty = { modifiers: [], cacheLines: [] };
  if (cacheEngineIds.length === 0) return empty;
  const roots = [...collectSpellcastingFeatureSlugs(engines), ...selectionSlugs];
  if (roots.length === 0) return empty;
  // One full-cache fetch serves both the class-feature chase below and the
  // spell-definition focus check (via the returned lines).
  const cacheLines = await fetchStreamEngineLines(cacheEngineIds);
  const bySlug = mapClassFeatureEngineIds(cacheLines);
  const modifiers: EngineModifier[] = [];
  const seen = new Set<string>(roots);
  let current = await fetchLinesForSlugs(bySlug, roots);
  for (let depth = 0; depth < 3 && current.length > 0; depth++) {
    const next: string[] = [];
    for (const line of current) {
      modifiers.push(...collectSpellModifiers(line.modifiers));
      next.push(...chasedSlugsIn(line, characterLevel));
    }
    const fresh = [...new Set(next)].filter((slug) => !seen.has(slug));
    if (fresh.length === 0) break;
    for (const slug of fresh) seen.add(slug);
    current = await fetchLinesForSlugs(bySlug, fresh);
  }
  return { modifiers, cacheLines };
}

/**
 * The next chase level named by one fetched definition: its focus group plus
 * its granted sub-features gated on arrival level.
 */
function chasedSlugsIn(line: RawEngineLine, characterLevel: number): string[] {
  const next: string[] = [];
  for (const mod of line.modifiers) {
    if (mod.type === "v2-add-spellcasting-feature" && typeof mod.focusSlug === "string" && mod.focusSlug !== "") {
      next.push(mod.focusSlug);
    }
  }
  for (const sub of line.grantedFeatures ?? []) {
    if (sub.level <= characterLevel) next.push(sub.slug);
  }
  return next;
}

/**
 * Splits repertoire-shaped grants by each spell's own Demiplane definition.
 * The grant shape alone cannot separate a true repertoire grant (the bard
 * Maestro muse's Soothe: `isKnown` + concrete tradition + no focus group)
 * from a focus cantrip grant wearing the same shape (the necromancer's
 * `grave-cantrips-rm` granting Create Thrall / Thrall Charge that way — those
 * cantrips don't even carry the "focus" trait, only the definition's
 * `isFocus` flag marks them). Spells whose definitions cannot be resolved
 * keep the previous behavior (repertoire) and surface as unmapped downstream
 * when genuinely missing.
 */
async function findDefinitionFocusSlugs(
  modifiers: EngineModifier[],
  cacheLines: RawEngineLine[]
): Promise<Set<string>> {
  const candidates = [
    ...new Set(
      modifiers
        .filter((mod): mod is AddSpellModifier => mod.type === "add-spell" && isRepertoireGrant(mod))
        .map((mod) => mod.addSpell)
    ),
  ];
  if (candidates.length === 0 || cacheLines.length === 0) return new Set();
  const bySlug = mapSpellEngineIds(cacheLines);
  const ids = candidates.map((slug) => bySlug.get(slug)).filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return new Set();
  const focused = new Set<string>();
  for (const line of await fetchStreamEngineLines(ids)) {
    if (line.spellFocus?.isFocus === true) focused.add(line.spellFocus.slug);
  }
  return focused;
}

/**
 * Spellcasting features the character casts with, named by its own selected
 * spell engines. Ritual, scroll/wand, and rune selections name no class
 * feature and are excluded.
 */
function collectSpellcastingFeatureSlugs(engines: DemiplaneEngineEntry[]): string[] {
  const slugs = new Set<string>();
  for (const eng of engines) {
    if (eng.type !== "DemiplaneEngine" || !(eng.name as string).startsWith("tabula/spell/")) continue;
    const parent = eng.args?.parentSpellFeature as string | undefined;
    if (
      typeof parent !== "string" ||
      parent === "" ||
      parent === "ritual" ||
      parent === "scroll" ||
      parent === "wand" ||
      parent === RUNES_SPELLCASTING_FEATURE
    ) {
      continue;
    }
    slugs.add(parent);
  }
  return [...slugs];
}

/** Fetches class-feature definitions for slugs, skipping ones the cache cannot resolve. */
async function fetchLinesForSlugs(bySlug: Map<string, string>, slugs: string[]): Promise<RawEngineLine[]> {
  const ids = slugs.map((slug) => bySlug.get(slug)).filter((id): id is string => typeof id === "string");
  return fetchStreamEngineLines(ids);
}

/**
 * Drops granted spells above the highest rank the character's slots reach — a
 * definition can grant spells for later levels (e.g. a conflux's rank-2 rider
 * alongside its rank-1 spell) that the sheet doesn't show yet. Mirrors the
 * domain gating in {@link collectDomainFocusSpells}. Unresolvable spells count
 * as rank 0, so they still surface as unmapped rather than vanishing.
 */
async function filterAccessibleSpells(spells: GrantedSpell[], maxSpellRank: number): Promise<GrantedSpell[]> {
  const ranked = await Promise.all(spells.map(async (spell) => ({ spell, rank: await getSpellRank(spell.slug) })));
  return ranked.filter(({ rank }) => rank <= maxSpellRank).map(({ spell }) => spell);
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
 * Whether the class's declared focus group is the witch's hex group. The witch's
 * spellcasting feature declares `focusSlug: "hex-spells"`, distinguishing it from
 * the bard's `"composition-spells"`. This tells us the class's non-hex granted
 * spells (Sure Strike, Phantom Pain) are ordinary familiar spells bound for the
 * prepared repertoire, whereas the bard's inherited-tradition grants (Courageous
 * Anthem) are composition focus spells. See {@link isInheritedRepertoireGrant}.
 */
function declaresHexFocusGroup(modifiers: EngineModifier[]): boolean {
  return modifiers.some((mod) => mod.type === "v2-add-spellcasting-feature" && mod.focusSlug === HEX_FOCUS_GROUP);
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
  for (const line of lines) modifiers.push(...collectSpellModifiers(line.modifiers));

  // A granted feat can itself provide innate spellcasting (Empty Sky Kitsune →
  // Kitsune Spell Familiarity → Daze / Forbidding Ward / Ghost Sound); expand
  // one round and collect those definitions' spell modifiers too.
  const grantedLines = await expandFeatGrantLines(lines, cacheEngineIds);
  for (const line of grantedLines) modifiers.push(...collectSpellModifiers(line.modifiers));

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
    } else if (mod.type === "v2-add-signature-spells") {
      spellModifiers.push(mod);
    }
  }

  return spellModifiers;
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
 * A repertoire grant parented at the class's main spellcasting feature (e.g.
 * an Ashes mystery granting ignition / breathe fire with
 * `parentFeature: "oracle-spellcasting-rm"`, or the necromancer spellcasting
 * granting harm that way). It belongs in the class repertoire, not the focus
 * entry — only the revelation/focus-group grant (parented at e.g.
 * `"revelation-spells-rm"`) is a focus spell. Tradition is irrelevant here:
 * the mystery grants inherit it while harm names it concretely.
 *
 * Parenting at the spellcasting feature is the distinguishing signal: focus
 * grants parent at a focus group (`composition-spells`, `revelation-spells-rm`,
 * `grave-spells-rm`, `link-spells-rm`) or carry no parent at all, so the
 * `-spellcasting` suffix test never misfires on them. Apparition grants
 * (`apparition-spellcasting-rm`) also match the suffix but are tested earlier,
 * so they still file as apparition — except a store-restricted vessel spell,
 * which the apparition bucket rejects and which must fall through to focus
 * rather than sneak into the repertoire here.
 */
function isSpellcastingFeatureRepertoireGrant(mod: AddSpellModifier): boolean {
  if (mod.isKnown !== true || mod.forcesFocus === true) return false;
  const restriction = mod.storeRestriction;
  if (restriction && typeof restriction === "object") return false;
  const parent = mod.parentFeature ?? "";
  if (parent === "") return false;
  const stripped = parent.endsWith("-rm") ? parent.slice(0, -3) : parent;
  return stripped.endsWith("-spellcasting") || stripped === "spellcasting";
}

/**
 * Sorts feature-granted `add-spell` modifiers into five kinds:
 *
 * - **innate** (`isInnate: true`, and no forced focus): cast at will from an
 *   Innate Spells entry (e.g. Seer Elf → Detect Magic).
 * - **hex** (a witch hex per {@link isHexGrant}): a focus spell placed in the
 *   dedicated "Hexes" entry (e.g. patron/lesson hexes, Cackle).
 * - **known** (a repertoire grant): added to the class's spell repertoire — a
 *   spontaneous caster's known spell (Maestro muse → Soothe, per
 *   {@link isRepertoireGrant}), a witch's prepared-list spell that accompanies
 *   a hex (per {@link isInheritedRepertoireGrant}), or a grant parented at the
 *   class spellcasting feature (per {@link isSpellcastingFeatureRepertoireGrant},
 *   e.g. an oracle's ignition / breathe fire or the necromancer's harm).
 *   Repertoire-shaped grants whose spell itself is a focus spell (the
 *   necromancer's grave cantrips, shaped exactly like Soothe) file
 *   as focus instead — see {@link findDefinitionFocusSlugs}.
 * - **apparition** (an animist apparition grant): filed in the apparition
 *   spellcasting entry, never the class repertoire — except a vessel spell
 *   (gated on a satisfied primary-apparition restriction), which falls through
 *   to focus like any other parent-feature grant.
 * - **focus** (everything else): a focus-pool spell. This includes the bard's
 *   composition spells (a focus group with inherited tradition) and any grant
 *   sharing an engine with an `add-focus-point` (`forcesFocus`, e.g. a wizard
 *   curriculum's Force Bolt).
 *
 * Order matters: a hex is tested before repertoire so the hex lands in "Hexes"
 * while its plain sibling spell falls through to the repertoire.
 */
/**
 * Classifies one `add-spell` grant into its kind. Kept separate from the
 * collection loop so the loop stays a simple dispatch and this holds the
 * (mutually exclusive) decision.
 */
type GrantKind = "innate" | "hex" | "apparition" | "known" | "focus";

function grantKind(mod: AddSpellModifier, hexFocusGroup: boolean): GrantKind {
  // A grant sharing an engine with an add-focus-point IS a focus-pool spell by
  // definition (that's what forcesFocus records) — it takes precedence over the
  // hex and repertoire heuristics below, which key off the same signals a focus
  // grant can carry (a school focus spell like Force Bolt has both a save DC
  // and a concrete tradition). Without this, such a grant misfiles as a hex
  // (via saveDC) or repertoire (via concrete tradition).
  if (mod.forcesFocus === true) return "focus";
  if (mod.isInnate === true) return "innate";
  if (isHexGrant(mod, hexFocusGroup)) return "hex";
  if (isApparitionGrant(mod)) return "apparition";
  if (
    isRepertoireGrant(mod) ||
    isInheritedRepertoireGrant(mod, hexFocusGroup) ||
    isSpellcastingFeatureRepertoireGrant(mod)
  )
    return "known";
  return "focus";
}

function buildGrantedSpell(mod: AddSpellModifier, hexFocusGroup: boolean): GrantedSpell {
  const kind = grantKind(mod, hexFocusGroup);
  return {
    slug: mod.addSpell,
    tradition: mod.tradition ?? "arcane",
    level: mod.level,
    isInnate: kind === "innate",
    isKnown: kind === "known",
    isHex: kind === "hex",
    isApparition: kind === "apparition",
    isFocus: kind === "focus",
    spellLevel: mod.spellLevel ?? 0,
  };
}
/**
 * An animist apparition grant: parented at the apparition spellcasting
 * feature, without a vessel (primary-apparition) store restriction — vessel
 * spells keep the restriction through the pre-filter and fall through to
 * focus. Unsatisfied restrictions never reach here (dropped up front).
 */
function isApparitionGrant(mod: AddSpellModifier): boolean {
  if ((mod.parentFeature ?? "") !== APPARITION_SPELLCASTING) return false;
  const restriction = mod.storeRestriction;
  return !restriction || typeof restriction !== "object";
}

function categorizeGrantedSpells(
  modifiers: EngineModifier[],
  characterLevel: number,
  hexFocusGroup: boolean,
  focusSlugs: Set<string>
): {
  innate: GrantedSpell[];
  focus: GrantedSpell[];
  known: GrantedSpell[];
  hexes: GrantedSpell[];
  apparition: GrantedSpell[];
} {
  const innate: GrantedSpell[] = [];
  const focus: GrantedSpell[] = [];
  const known: GrantedSpell[] = [];
  const hexes: GrantedSpell[] = [];
  const apparition: GrantedSpell[] = [];
  /** Repertoire-shaped grants, split by spell-definition focus flag below. */
  const ambiguous: AddSpellModifier[] = [];

  for (const mod of modifiers) {
    if (mod.type !== "add-spell") continue;
    if (mod.level > characterLevel) continue;

    if (isRepertoireGrant(mod)) {
      ambiguous.push(mod);
      continue;
    }
    const spell = buildGrantedSpell(mod, hexFocusGroup);

    if (spell.isInnate) innate.push(spell);
    else if (spell.isHex) hexes.push(spell);
    else if (spell.isApparition) apparition.push(spell);
    else if (spell.isKnown) known.push(spell);
    else focus.push(spell);
  }

  for (const mod of ambiguous) {
    const spell = buildGrantedSpell(mod, hexFocusGroup);
    if (focusSlugs.has(mod.addSpell)) {
      spell.isKnown = false;
      spell.isFocus = true;
      focus.push(spell);
    } else {
      known.push(spell);
    }
  }

  return { innate, focus, known, hexes, apparition };
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
  const { innate, focus, known, hexes, apparition, focusEntryName, unlimitedSignatures } =
    await resolveFeatureGrantedSpells(engines, characterLevel, maxSpellRank, cacheEngineIds);

  debugLog(
    `[feature-spells] Found ${String(innate.length)} innate, ${String(focus.length)} focus, ${String(known.length)} known, ${String(hexes.length)} hex, ${String(apparition.length)} apparition spells (max rank ${String(maxSpellRank)})`
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

  if (apparition.length > 0) {
    await addFeatureApparitionSpells(
      actor,
      apparition,
      engines,
      summary,
      cacheEngineIds,
      unlimitedSignatures.includes(APPARITION_SPELLCASTING)
    );
  }

  flagMissingLinkSpells(actor, engines, summary);
}

/**
 * Flags a summoner import with no focus spells at all. Every summoner has
 * link cantrips (Boost Eidolon, Evolution Surge), but Demiplane currently
 * exports neither engines nor definitions for them — without this check their
 * absence (and the empty focus pool) would be silent. Loud, with the gap
 * named, until Demiplane models link spells.
 */
function flagMissingLinkSpells(actor: Actor, engines: DemiplaneEngineEntry[], summary: ImportSummary): void {
  const isSummoner = engines.some((e) => e.name === "tabula/class/summoner-rm.eng");
  if (!isSummoner) return;

  const focusEntryIds = new Set<string>();
  for (const item of Array.from(actor.items)) {
    if (item.type !== "spellcastingEntry" || itemSystem(item).prepared?.value !== "focus") continue;
    if (typeof item.id === "string") focusEntryIds.add(item.id);
  }
  let hasFocusSpells = false;
  for (const item of Array.from(actor.items)) {
    if (item.type !== "spell") continue;
    const location = itemSystem(item).location;
    const entryId = typeof location === "string" ? location : location?.value;
    if (typeof entryId === "string" && focusEntryIds.has(entryId)) {
      hasFocusSpells = true;
      break;
    }
  }
  if (!hasFocusSpells) {
    summary.errors.push(
      "Summoner has no focus spells — the link spells (Boost Eidolon, Evolution Surge) couldn't be added."
    );
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

/**
 * Files animist apparition grants in their own spontaneous apparition entry
 * ("Apparition Spells (Divine)") with the feature's slot progression — never
 * the class repertoire. Marks every spell signature when the feature declares
 * unlimited signatures.
 */
async function addFeatureApparitionSpells(
  actor: Actor,
  spells: GrantedSpell[],
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary,
  cacheEngineIds: string[],
  signatureUnlimited: boolean
): Promise<void> {
  const entryId = await createFeatureEntry(
    actor,
    deriveClassEntryName(APPARITION_SPELLCASTING, "divine"),
    "divine",
    "spontaneous"
  );

  await addGrantedSpellsToEntry(actor, entryId, spells, summary, "apparition");
  await applySlotMaximums(actor, entryId, engines, APPARITION_SPELLCASTING, "", summary, cacheEngineIds);

  if (signatureUnlimited) {
    await markEntrySpellsSignature(actor, entryId, summary);
  }
}

/** Flags every spell filed in an entry as a signature spell. */
async function markEntrySpellsSignature(actor: Actor, entryId: string, summary: ImportSummary): Promise<void> {
  const updates: Array<{ _id: string; "system.location.signature": boolean }> = [];
  for (const item of Array.from(actor.items)) {
    if (item.type !== "spell") continue;
    const location = itemSystem(item).location;
    const locationId = typeof location === "string" ? location : location?.value;
    if (locationId !== entryId || typeof item.id !== "string") continue;
    updates.push({ _id: item.id, "system.location.signature": true });
  }
  if (updates.length > 0) {
    await actor.updateEmbeddedDocuments("Item", updates);
    summary.log.push(`+ apparition signature: ${String(updates.length)} spells marked as signature`);
  }
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

  // Summoner link cantrips file as focus spells (see fetchLinkSpellModifiers).
  if (engines.some((e) => e.name === "tabula/class/summoner-rm.eng")) {
    return "Link Spells";
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
      isApparition: false,
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
