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
  | SpellSlotTypeModifier
  | AddSpellcastingFeatureModifier
  | AddFocusPointModifier;

/** One NDJSON response line: the engine id, its display name, and parsed modifiers. */
export interface RawEngineLine {
  id?: string;
  name?: string;
  modifiers: EngineModifier[];
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
      case "v2-add-spellcasting-feature":
        // eslint-disable-next-line no-restricted-syntax -- discriminated-union narrowing at parse boundary
        results.push(mod as unknown as AddSpellcastingFeatureModifier);
        break;
      case "add-focus-point":
        results.push({ type: "add-focus-point" });
        break;
      default:
        break;
    }
  }
  return results;
}

function finalizeLine(id: string | undefined, name: string | undefined, modifiers: EngineModifier[]): RawEngineLine {
  const result: RawEngineLine = { modifiers };
  if (id !== undefined) result.id = id;
  if (name !== undefined) result.name = name;
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
 * Parses a single NDJSON line from stream-engines. Returns the engine id, the
 * display name (from the first node carrying modifiers), and every engineModifier
 * found in its `StringObject` nodes. Malformed lines yield an empty modifier list.
 */
export function parseEngineLine(line: string): RawEngineLine {
  try {
    const parsed = JSON.parse(line) as {
      id?: string;
      engineName?: string;
      data?: { nodes?: Record<string, EngineNode> };
    };
    const objects = parseStringObjects(Object.values(parsed.data?.nodes ?? {}));

    for (const obj of objects) {
      const modifiers = extractModifiersFromObject((obj.engineModifiers as Array<Record<string, unknown>>) ?? []);
      if (modifiers.length > 0) {
        // Prefer the top-level engineName (e.g. "tabula/feat/foxfire.eng"), which
        // is stable and present on every line; fall back to the element display
        // name only when engineName is absent.
        return finalizeLine(parsed.id, parsed.engineName ?? (obj.name as string | undefined), modifiers);
      }
    }

    return finalizeLine(parsed.id, parsed.engineName, []);
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
  const bySlug = new Map<string, string>();
  if (cacheEngineIds.length === 0) return bySlug;

  const lines = await fetchStreamEngineLines(cacheEngineIds);
  for (const line of lines) {
    if (!line.id || !line.name) continue;
    const slug = CLASS_FEATURE_ENGINE_NAME_RE.exec(line.name)?.[1];
    if (slug) bySlug.set(slug, line.id);
  }
  return bySlug;
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
