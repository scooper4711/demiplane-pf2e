import { debugLog } from "./debug-log.js";
import { toFoundrySlug } from "./slug-utils.js";
import { PF2E_ENGINE_SOURCE } from "../config.js";

/** Demiplane stream-engines endpoint (NDJSON engine-definition fetch). */
const STREAM_ENGINES_URL = "https://character.demiplane.com/stream-engines";

/** Nexus slug sent to stream-engines for PF2e v2 characters. */
const NEXUS_SLUG = "pathfinder2e";

/** A single spell-slot entry inside a `v2-add-spell-slots` modifier. */
export interface DemiplaneSlotEntry {
  rank: number;
  count: number;
  levelPrereq: number;
  slug: string;
}

/** A granted spell (class feature, heritage, feat). */
export interface AddSpellModifier {
  type: "add-spell";
  level: number;
  addSpell: string;
  tradition: string;
  isInnate?: boolean;
  /**
   * True when the feature adds the spell to the character's spell repertoire (a
   * known spell castable with normal slots), e.g. the bard Maestro muse granting
   * Soothe. Distinct from focus (`parentFeature` points at a focus group) and
   * innate (`isInnate`).
   */
  isKnown?: boolean;
  spellLevel?: number;
  parentFeature?: string;
  /**
   * Conditional grant gate: the spell is granted only when the named character
   * store holds the given value (e.g. an apparition's vessel spell gated on
   * its `<apparition>-is-primary` flag). Evaluated against the character's
   * engines by the importer; absent stores are kept, not dropped.
   */
  storeRestriction?: { storeName?: string; storeValue?: string | number } | null;
  autoScaleSpellLevel?: boolean;
  /**
   * Focus-spell casting machinery Demiplane stamps on a hex grant: a save DC
   * source (e.g. `["spell"]`) and/or a spell-attack source
   * (`"spellcasting-modifier"`). A witch feature grants a hex (which carries
   * this machinery) alongside a plain spell added to the prepared list (which
   * does not), so these fields separate the two. See {@link isHexGrant}.
   */
  saveDC?: string[];
  spellAttack?: string;
  /**
   * Set by the resolver (not present in raw Demiplane data) when this grant
   * shares an engine with an `add-focus-point`, marking it a focus-pool spell
   * regardless of tradition or `isKnown` (e.g. a wizard curriculum's Force Bolt).
   */
  forcesFocus?: boolean;
}

/**
 * A feat granted by another element (heritage, class feature, ancestry). The
 * granted feat carries its own engineModifiers — including `add-spell` for
 * innate-spellcasting feats such as Kitsune Spell Familiarity — so it must be
 * resolved to its own engine definition and expanded. `addFeat` is the feat
 * slug; the granting definition does not carry the feat's engine UUID.
 */
export interface AddFeatModifier {
  type: "add-feat";
  addFeat: string;
}

/** Spells granted by a staff item. */
export interface AddStaffSpellsModifier {
  type: "add-staff-spells";
  spells: Array<{ rank: number; spell: string }>;
}

/**
 * A spell granted by a wand / special item.
 *
 * Two shapes occur:
 * - A fixed-spell item (e.g. a Scroll of Glitterdust) names its `spell` and
 *   `rank` inline; `freeSpell` is false.
 * - A generic holder (e.g. Wand of Widening) or a generic ranked scroll/wand
 *   sets `freeSpell` true and omits `spell` — the player-chosen spell, if any,
 *   is carried by a linked `tabula/spell/*` engine instead.
 * So `spell` is optional.
 */
export interface AddSpecialItemSpellModifier {
  type: "add-special-item-spell";
  rank: string | number;
  spell?: string;
  itemType: string;
  freeSpell?: boolean;
}

/** Spell-slot progression granted by a class engine. */
export interface AddSpellSlotsModifier {
  type: "v2-add-spell-slots";
  slug?: string;
  slots?: DemiplaneSlotEntry[];
}

/** One repertoire entry: how many spells of a rank the repertoire holds. */
export interface RepertoireCountEntry {
  rank?: number;
  count?: number;
  levelPrereq?: number;
  repertoireSlug?: string;
}

/**
 * Repertoire capacity granted by a class engine (e.g. a bard's cantrips).
 * Separate from castable slots: spontaneous cantrip slots fall back to the
 * rank-0 repertoire count when the class defines no fixed cantrip slots.
 */
export interface AddRepertoireCountsModifier {
  type: "v2-add-repertoire-counts";
  slug?: string;
  slots?: RepertoireCountEntry[];
}

/**
 * Marks every spell of a spellcasting feature as a signature spell (e.g. the
 * animist's apparition spells, `signatureType: "unlimited"`).
 */
export interface AddSignatureSpellsModifier {
  type: "v2-add-signature-spells";
  featureSlug?: string;
  signatureType?: string;
}

/** A single scaling spell slot declared by a class engine (e.g. the magus's
 * `magus-spell-slot-1`, one slot whose rank unlocks with level). Only the
 * identity fields are parsed — rank scaling itself is not currently consumed;
 * the declaration marks which fixed-entry slugs belong to a real slot pool
 * (unrestricted) versus a separate restricted pool (e.g. studious spells). */
export interface SpellSlotTypeModifier {
  type: "v2-add-spell-slot-type";
  slotSlug?: string;
  hasRestrictions?: boolean;
}

/**
 * Declares a class's spellcasting feature, including its focus spell group. The
 * `focusName` (e.g. "Composition Spells") is the label Demiplane gives the
 * class's focus spellcasting entry, and `focusSlug` (e.g. "composition-spells")
 * is the group that focus `add-spell` grants reference via `parentFeature`.
 */
export interface AddSpellcastingFeatureModifier {
  type: "v2-add-spellcasting-feature";
  focusName?: string;
  focusSlug?: string;
  tradition?: string;
  hasFocusGroup?: boolean;
}

/**
 * Grants a builder selection outright (e.g. an archetype mapping a class
 * feature row to its replacement: hunter's-edge-rm → vindication-rm). Unlike
 * `add-feat`, the grant names a feature for a builder row rather than a feat.
 */
export interface GrantBuilderSelectionModifier {
  type: "grant-builder-selection";
  grantRowType?: string;
  grantRowSlug?: string;
  selectionSlug?: string;
  selectionType?: string;
}

/**
 * Grants a focus point. Its presence in an engine marks that engine's spells as
 * focus spells: a feature that adds both an `add-spell` and an `add-focus-point`
 * (e.g. a wizard curriculum's Force Bolt) grants a focus-pool spell, not a
 * repertoire spell.
 */
export interface AddFocusPointModifier {
  type: "add-focus-point";
}

/** Discriminated union of every engineModifier type we understand. */
export type EngineModifier =
  | AddSpellModifier
  | AddFeatModifier
  | AddStaffSpellsModifier
  | AddSpecialItemSpellModifier
  | AddSpellSlotsModifier
  | AddRepertoireCountsModifier
  | AddSignatureSpellsModifier
  | SpellSlotTypeModifier
  | AddSpellcastingFeatureModifier
  | GrantBuilderSelectionModifier
  | AddFocusPointModifier;

/** One NDJSON response line: the engine id, its display name, and parsed modifiers. */
export interface RawEngineLine {
  id?: string;
  name?: string;
  modifiers: EngineModifier[];
  /**
   * Sub-features the engine grants (e.g. a focus feature's cantrip feature),
   * with the character level each arrives at. Present only when non-empty.
   */
  grantedFeatures?: GrantedSubFeature[];
  /**
   * For `tabula/spell/*` lines, the spell's own focus flag. Present only when
   * the definition declares a slug.
   */
  spellFocus?: SpellDefinitionFocus;
}

/** A sub-feature granted by an engine definition. */
export interface GrantedSubFeature {
  slug: string;
  level: number;
}

/** A spell definition's focus flag, read from its own `tabula/spell/*` line. */
export interface SpellDefinitionFocus {
  /** The Demiplane spell slug (e.g. `create-thrall-rm`). */
  slug: string;
  isFocus: boolean;
}

interface EngineNode {
  name: string;
  data?: { string?: string };
}

function extractModifiersFromObject(modifiers: Array<Record<string, unknown>>): EngineModifier[] {
  const results: EngineModifier[] = [];
  for (const mod of modifiers) {
    // Parse boundary: `mod` is an untyped record from parsed NDJSON, narrowed to
    // a union member by its discriminant `type`. Not a Foundry-type gap.
    switch (mod.type) {
      case "add-spell":
        // eslint-disable-next-line no-restricted-syntax -- discriminated-union narrowing at parse boundary
        if (typeof mod.addSpell === "string") results.push(mod as unknown as AddSpellModifier);
        break;
      case "add-feat":
        // eslint-disable-next-line no-restricted-syntax -- discriminated-union narrowing at parse boundary
        if (typeof mod.addFeat === "string") results.push(mod as unknown as AddFeatModifier);
        break;
      case "add-staff-spells":
        // eslint-disable-next-line no-restricted-syntax -- discriminated-union narrowing at parse boundary
        results.push(mod as unknown as AddStaffSpellsModifier);
        break;
      case "add-special-item-spell":
        // eslint-disable-next-line no-restricted-syntax -- discriminated-union narrowing at parse boundary
        results.push(mod as unknown as AddSpecialItemSpellModifier);
        break;
      case "v2-add-spell-slots":
        // eslint-disable-next-line no-restricted-syntax -- discriminated-union narrowing at parse boundary
        results.push(mod as unknown as AddSpellSlotsModifier);
        break;
      case "v2-add-repertoire-counts":
        // eslint-disable-next-line no-restricted-syntax -- discriminated-union narrowing at parse boundary
        results.push(mod as unknown as AddRepertoireCountsModifier);
        break;
      case "v2-add-spell-slot-type":
        // eslint-disable-next-line no-restricted-syntax -- discriminated-union narrowing at parse boundary
        if (typeof mod.slotSlug === "string") results.push(mod as unknown as SpellSlotTypeModifier);
        break;
      case "v2-add-signature-spells":
        // eslint-disable-next-line no-restricted-syntax -- discriminated-union narrowing at parse boundary
        results.push(mod as unknown as AddSignatureSpellsModifier);
        break;
      case "v2-add-spellcasting-feature":
        // eslint-disable-next-line no-restricted-syntax -- discriminated-union narrowing at parse boundary
        results.push(mod as unknown as AddSpellcastingFeatureModifier);
        break;
      default: {
        const simple = extractSimpleModifier(mod);
        if (simple) results.push(simple);
        break;
      }
    }
  }
  return results;
}

/**
 * Parses the flag-like modifiers (no payload beyond the discriminant) at the
 * same parse boundary as {@link extractModifiersFromObject}. Split out to
 * keep that switch under the complexity budget.
 */
function extractSimpleModifier(mod: Record<string, unknown>): EngineModifier | null {
  switch (mod.type) {
    case "grant-builder-selection":
      // eslint-disable-next-line no-restricted-syntax -- discriminated-union narrowing at parse boundary
      return typeof mod.selectionSlug === "string" ? (mod as unknown as GrantBuilderSelectionModifier) : null;
    case "add-focus-point":
      return { type: "add-focus-point" };
    default:
      return null;
  }
}

function finalizeLine(
  id: string | undefined,
  name: string | undefined,
  modifiers: EngineModifier[],
  grantedFeatures?: GrantedSubFeature[],
  spellFocus?: SpellDefinitionFocus
): RawEngineLine {
  const result: RawEngineLine = { modifiers };
  if (id !== undefined) result.id = id;
  if (name !== undefined) result.name = name;
  if (grantedFeatures !== undefined && grantedFeatures.length > 0) result.grantedFeatures = grantedFeatures;
  if (spellFocus !== undefined) result.spellFocus = spellFocus;
  return result;
}

/** Splits an NDJSON payload into its non-empty lines. */
function splitNdjson(text: string): string[] {
  return text.split("\n").filter((line) => line.trim());
}

/** Decodes the JSON payload of each `StringObject` node, skipping malformed ones. */
function parseStringObjects(nodes: EngineNode[]): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];

  for (const node of nodes) {
    if (node.name !== "StringObject" || !node.data?.string) continue;
    try {
      results.push(JSON.parse(node.data.string) as Record<string, unknown>);
    } catch {
      // Skip malformed nodes
    }
  }

  return results;
}

/**
 * Reads an engine definition's `grantedFeatures` groups (arrays of
 * `{slug, level}` entries) into a flat, de-duplicated list. Malformed groups
 * and entries are skipped — this is data ingestion at a parse boundary.
 */
function extractGrantedSubFeatures(objects: Array<Record<string, unknown>>): GrantedSubFeature[] {
  const seen = new Set<string>();
  const features: GrantedSubFeature[] = [];
  for (const obj of objects) {
    if (!Array.isArray(obj.grantedFeatures)) continue;
    features.push(...extractGroupFeatures(obj.grantedFeatures, seen));
  }
  return features;
}

/** Flattens one `grantedFeatures` group array, skipping malformed groups. */
function extractGroupFeatures(groups: unknown[], seen: Set<string>): GrantedSubFeature[] {
  const features: GrantedSubFeature[] = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      const feature = asGrantedSubFeature(entry, seen);
      if (feature) features.push(feature);
    }
  }
  return features;
}

/** Validates one `{slug, level}` entry, deduped by slug. Null when malformed. */
function asGrantedSubFeature(entry: unknown, seen: Set<string>): GrantedSubFeature | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { slug, level } = entry as { slug?: unknown; level?: unknown };
  if (typeof slug !== "string" || slug === "" || typeof level !== "number") return null;
  if (seen.has(slug)) return null;
  seen.add(slug);
  return { slug, level };
}

/**
 * Reads a spell definition's own focus flag. Demiplane marks focus spells on
 * the spell itself (`isFocus`), which is the only signal separating a focus
 * cantrip grant (the necromancer's Create Thrall) from a repertoire grant
 * wearing the same shape — the cantrips don't even carry the "focus" trait.
 */
function extractSpellFocus(
  engineName: string | undefined,
  objects: Array<Record<string, unknown>>
): SpellDefinitionFocus | undefined {
  if (!engineName?.startsWith("tabula/spell/")) return undefined;
  for (const obj of objects) {
    const slug = obj.slug;
    if (typeof slug !== "string" || slug === "") continue;
    return { slug, isFocus: obj.isFocus === true };
  }
  return undefined;
}

/**
 * Parses a single NDJSON line from stream-engines. Returns the engine id, the
 * display name (from the first node carrying modifiers), every engineModifier
 * found in its `StringObject` nodes, and the granted sub-features (when any).
 * Malformed lines yield an empty modifier list.
 */
export function parseEngineLine(line: string): RawEngineLine {
  try {
    const parsed = JSON.parse(line) as {
      id?: string;
      engineName?: string;
      data?: { nodes?: Record<string, EngineNode> };
    };
    const objects = parseStringObjects(Object.values(parsed.data?.nodes ?? {}));
    const grantedFeatures = extractGrantedSubFeatures(objects);
    const spellFocus = extractSpellFocus(parsed.engineName, objects);

    for (const obj of objects) {
      const modifiers = extractModifiersFromObject((obj.engineModifiers as Array<Record<string, unknown>>) ?? []);
      if (modifiers.length > 0) {
        // Prefer the top-level engineName (e.g. "tabula/feat/foxfire.eng"), which
        // is stable and present on every line; fall back to the element display
        // name only when engineName is absent.
        return finalizeLine(
          parsed.id,
          parsed.engineName ?? (obj.name as string | undefined),
          modifiers,
          grantedFeatures,
          spellFocus
        );
      }
    }

    return finalizeLine(parsed.id, parsed.engineName, [], grantedFeatures, spellFocus);
  } catch {
    return { modifiers: [] };
  }
}

/** Extracts the feat slug from a feat engine name, e.g. `tabula/feat/foxfire.eng` → `foxfire`. */
const FEAT_ENGINE_NAME_RE = /^tabula\/feat\/(.+)\.eng$/;

/** Extracts the feature slug from a class-feature engine name. */
const CLASS_FEATURE_ENGINE_NAME_RE = /^tabula\/class-feature\/(.+)\.eng$/;

/**
 * Builds a map from feat slug to engine UUID by fetching the given engine
 * definitions and matching those whose engine name is `tabula/feat/<slug>.eng`.
 *
 * A grant modifier (`add-feat`) references a feat only by slug, but
 * stream-engines addresses definitions by UUID. This resolves that gap using
 * the character's cached engine IDs (from `engineCacheIdsBySource`), which
 * already include every feat the character can access — including feats granted
 * indirectly, which never appear in the `engines` selection array.
 */
export async function resolveFeatEngineIdsBySlug(cacheEngineIds: string[]): Promise<Map<string, string>> {
  const bySlug = new Map<string, string>();
  if (cacheEngineIds.length === 0) return bySlug;

  const lines = await fetchStreamEngineLines(cacheEngineIds);
  for (const line of lines) {
    if (!line.id || !line.name) continue;
    const slug = FEAT_ENGINE_NAME_RE.exec(line.name)?.[1];
    if (slug) bySlug.set(slug, line.id);
  }
  return bySlug;
}

/**
 * Builds a map from class-feature slug to engine UUID, mirroring
 * {@link resolveFeatEngineIdsBySlug} for `tabula/class-feature/<slug>.eng`
 * definitions (e.g. a summoner's `summoner-spellcasting-rm` slot source).
 */
export async function resolveClassFeatureEngineIdsBySlug(cacheEngineIds: string[]): Promise<Map<string, string>> {
  if (cacheEngineIds.length === 0) return new Map();
  return mapClassFeatureEngineIds(await fetchStreamEngineLines(cacheEngineIds));
}

/**
 * Maps class-feature slugs to engine UUIDs from already-fetched lines, so a
 * caller holding the cache lines can resolve without refetching.
 */
export function mapClassFeatureEngineIds(lines: RawEngineLine[]): Map<string, string> {
  return mapEngineIdsByName(lines, CLASS_FEATURE_ENGINE_NAME_RE);
}

/** Extracts the spell slug from a spell engine name, e.g. `tabula/spell/foxfire.eng` → `foxfire`. */
const SPELL_ENGINE_NAME_RE = /^tabula\/spell\/(.+)\.eng$/;

/**
 * Maps Demiplane spell slugs to engine UUIDs from already-fetched lines, so a
 * caller can fetch spell definitions (for their `isFocus` flags) with one
 * batched request instead of another full-cache fetch.
 */
export function mapSpellEngineIds(lines: RawEngineLine[]): Map<string, string> {
  return mapEngineIdsByName(lines, SPELL_ENGINE_NAME_RE);
}

/** Maps engine-name slugs captured by `pattern` to engine UUIDs. */
function mapEngineIdsByName(lines: RawEngineLine[], pattern: RegExp): Map<string, string> {
  const bySlug = new Map<string, string>();
  for (const line of lines) {
    if (!line.id || !line.name) continue;
    const slug = pattern.exec(line.name)?.[1];
    if (slug) bySlug.set(slug, line.id);
  }
  return bySlug;
}

/**
 * Expands one round of `add-feat` grants found in the given engine lines into
 * the granted feats' own engine definitions.
 *
 * Some elements (heritages, class features, other feats) grant a feat that
 * itself carries spell or slot modifiers — e.g. Empty Sky Kitsune → Kitsune
 * Spell Familiarity → Daze, or Wizard Dedication → Basic Arcana → ranked
 * slots. The granted feat never appears in the character's `engines` array, so
 * it is only reachable by resolving each `add-feat` slug to its engine UUID
 * (via the cache) and fetching that definition. Returns the fetched lines
 * (empty when there are no grants or the cache can't resolve them). Only one
 * round is followed, matching the depth Demiplane's own spellcasting archetype
 * chains need.
 */
export async function expandFeatGrantLines(lines: RawEngineLine[], cacheEngineIds: string[]): Promise<RawEngineLine[]> {
  const grantedSlugs: string[] = [];
  for (const line of lines) {
    for (const mod of line.modifiers) {
      if (mod.type === "add-feat" && !grantedSlugs.includes(mod.addFeat)) grantedSlugs.push(mod.addFeat);
    }
  }
  if (grantedSlugs.length === 0 || cacheEngineIds.length === 0) return [];

  const bySlug = await resolveFeatEngineIdsBySlug(cacheEngineIds);
  const grantedIds = grantedSlugs.map((slug) => bySlug.get(slug)).filter((id): id is string => typeof id === "string");
  if (grantedIds.length === 0) {
    debugLog(`[stream-engines] no engine ids resolved for granted feats: ${grantedSlugs.join(", ")}`);
    return [];
  }
  return fetchStreamEngineLines(grantedIds);
}

/** Parses a full NDJSON stream-engines payload into per-line modifier records. */
export function parseEngineLines(ndjsonText: string): RawEngineLine[] {
  return splitNdjson(ndjsonText).map(parseEngineLine);
}

/** The feat slugs a single element (background, feat, class feature) grants outright. */
export interface GrantedFeatsEntry {
  /** The granting element's own slug, e.g. `total-power`. */
  slug: string;
  /** The feat slugs it grants, e.g. `["bone-spikes", "intimidating-glare"]`. */
  feats: string[];
}

/** Reads a StringObject's `slug` and `feats` array, if both are present and well-formed. */
function extractGrantedFeats(object: Record<string, unknown>): GrantedFeatsEntry | null {
  const slug = object.slug;
  const feats = object.feats;
  if (typeof slug !== "string" || !Array.isArray(feats)) return null;

  const featSlugs = feats.filter((feat): feat is string => typeof feat === "string");
  if (featSlugs.length === 0) return null;

  return { slug, feats: featSlugs };
}

/**
 * Parses a single NDJSON line looking for an element that grants feats outright.
 *
 * Some elements — notably backgrounds like Total Power — grant specific feats
 * via a `feats` array on their StringObject definition rather than via
 * `engineModifiers`. That grant is authoritative: it names exactly which feat
 * the element confers. Foundry, by contrast, may model the same element as a
 * player *choice* (Total Power offers "Blasting Beams" vs "Bone Spikes"), so the
 * grant list is what disambiguates the choice during import. Returns null for
 * lines that declare no `feats`.
 */
export function parseGrantedFeatsLine(line: string): GrantedFeatsEntry | null {
  try {
    const parsed = JSON.parse(line) as { data?: { nodes?: Record<string, EngineNode> } };
    const objects = parseStringObjects(Object.values(parsed.data?.nodes ?? {}));

    for (const object of objects) {
      const entry = extractGrantedFeats(object);
      if (entry) return entry;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Builds a map from a granting element's slug to the set of feat slugs it grants.
 *
 * Fetches the character's cached engine definitions and collects every element
 * that carries a `feats` array (e.g. the Total Power background granting
 * `bone-spikes`). The importer consults this when resolving a ChoiceSet whose
 * owning element grants a fixed feat, so the choice matches Demiplane's grant
 * instead of defaulting to the first option.
 */
export async function resolveGrantedFeatsBySlug(cacheEngineIds: string[]): Promise<Map<string, Set<string>>> {
  const bySlug = new Map<string, Set<string>>();
  if (cacheEngineIds.length === 0) return bySlug;

  const text = await postStreamEngines(cacheEngineIds, "granted-feats");
  if (!text) return bySlug;

  for (const line of splitNdjson(text)) {
    const entry = parseGrantedFeatsLine(line);
    if (entry) bySlug.set(toFoundrySlug(entry.slug), new Set(entry.feats.map(toFoundrySlug)));
  }
  return bySlug;
}

/**
 * Builds a map from a builder row to the feature Demiplane granted for it
 * (e.g. an archetype mapping `hunters-edge` to `vindication-rm`).
 *
 * Fetches the character's cached engine definitions and collects every
 * `grant-builder-selection` carrying both a row and a selection. The importer
 * consults this when a ChoiceSet offers one option per row value (the hunter's
 * edge choice offering Flurry/Outwit/Precision/Vindicator), so the pick
 * matches Demiplane's grant instead of defaulting to the first option.
 * Entries without a row (e.g. a flat dedication grant) name no ChoiceSet and
 * are skipped.
 *
 * Keys are foundry slugs (what ChoiceSets are looked up by); values stay in
 * Demiplane form (what definition lookups address) — compare with
 * {@link toFoundrySlug} at use sites that match text.
 */
export async function resolveGrantBuilderSelections(cacheEngineIds: string[]): Promise<Map<string, string>> {
  const byRow = new Map<string, string>();
  if (cacheEngineIds.length === 0) return byRow;

  const text = await postStreamEngines(cacheEngineIds, "grant-builder-selection");
  if (!text) return byRow;

  for (const line of parseEngineLines(text)) {
    for (const mod of line.modifiers) {
      if (mod.type !== "grant-builder-selection") continue;
      if (typeof mod.grantRowSlug !== "string" || mod.grantRowSlug === "") continue;
      if (typeof mod.selectionSlug !== "string" || mod.selectionSlug === "") continue;
      byRow.set(toFoundrySlug(mod.grantRowSlug), mod.selectionSlug);
    }
  }
  return byRow;
}

/** Domain spell slugs carried by a `tabula/domain/*` engine definition. */
export interface DomainEngineData {
  name?: string;
  domainSpell?: string;
  advancedSpell?: string;
}

/**
 * Parses a single NDJSON line from stream-engines looking for a domain engine.
 * Domain engines (module `initialize/domain/index.eng`) declare their focus
 * spells via `domainSpell` / `advancedSpell` fields on the StringObject node —
 * not via `add-spell` engineModifiers. Returns an empty record for non-domain
 * or malformed lines.
 */
export function parseDomainLine(line: string): DomainEngineData {
  try {
    const parsed = JSON.parse(line) as { data?: { nodes?: Record<string, EngineNode> } };
    const objects = parseStringObjects(Object.values(parsed.data?.nodes ?? {}));

    for (const obj of objects) {
      if (typeof obj.domainSpell !== "string" && typeof obj.advancedSpell !== "string") continue;

      const result: DomainEngineData = {};
      if (typeof obj.name === "string") result.name = obj.name;
      if (typeof obj.domainSpell === "string") result.domainSpell = obj.domainSpell;
      if (typeof obj.advancedSpell === "string") result.advancedSpell = obj.advancedSpell;
      return result;
    }

    return {};
  } catch {
    return {};
  }
}

/**
 * POSTs engine ids to stream-engines and returns the raw NDJSON response text.
 * Network failures are logged and yield null so callers can degrade gracefully.
 */
async function postStreamEngines(engineIds: string[], label: string): Promise<string | null> {
  try {
    const response = await fetch(STREAM_ENGINES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engineIdsBySource: { [PF2E_ENGINE_SOURCE]: engineIds },
        isSheet: true,
        nexusSlug: NEXUS_SLUG,
      }),
    });

    if (!response.ok) return null;
    return await response.text();
  } catch (error) {
    debugLog(`stream-engines (${label}) fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Fetches the given domain engine definitions and returns their spell slugs. */
export async function fetchDomainEngineData(engineIds: string[]): Promise<DomainEngineData[]> {
  if (engineIds.length === 0) return [];

  const text = await postStreamEngines(engineIds, "domain");
  return text ? splitNdjson(text).map(parseDomainLine) : [];
}

/**
 * Fetches the given Demiplane engine definitions from stream-engines and returns
 * the parsed modifiers for each. Network or parse failures yield an empty list
 * rather than throwing, so callers can degrade gracefully.
 */
export async function fetchStreamEngineLines(engineIds: string[]): Promise<RawEngineLine[]> {
  if (engineIds.length === 0) return [];

  const text = await postStreamEngines(engineIds, "engines");
  return text ? parseEngineLines(text) : [];
}
