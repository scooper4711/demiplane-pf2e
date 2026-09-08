import { debugLog } from "./debug-log.js";
import { toFoundrySlug } from "./slug-utils.js";

/** Demiplane stream-engines endpoint (NDJSON engine-definition fetch). */
const STREAM_ENGINES_URL = "https://character.demiplane.com/stream-engines";

/** Source key and nexus slug sent to stream-engines for PF2e v2 characters. */
const ENGINE_SOURCE = "pathfinder2e-v2";
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
  spellLevel?: number;
  parentFeature?: string;
  autoScaleSpellLevel?: boolean;
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

/** Discriminated union of every engineModifier type we understand. */
export type EngineModifier =
  AddSpellModifier | AddFeatModifier | AddStaffSpellsModifier | AddSpecialItemSpellModifier | AddSpellSlotsModifier;

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
        engineIdsBySource: { [ENGINE_SOURCE]: engineIds },
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
