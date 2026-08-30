import { debugLog } from "./debug-log.js";

/** Demiplane stream-engines endpoint (NDJSON engine-definition fetch). */
export const STREAM_ENGINES_URL = "https://character.demiplane.com/stream-engines";

/** Source key and nexus slug sent to stream-engines for PF2e v2 characters. */
export const ENGINE_SOURCE = "pathfinder2e-v2";
export const NEXUS_SLUG = "pathfinder2e";

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

/** Spells granted by a staff item. */
export interface AddStaffSpellsModifier {
  type: "add-staff-spells";
  spells: Array<{ rank: number; spell: string }>;
}

/**
 * A spell granted by a wand / special item. Generic scroll and wand items emit
 * only the rank and item type here — the actual spell is carried by a linked
 * `tabula/spell/*` engine, so `spell` is optional.
 */
export interface AddSpecialItemSpellModifier {
  type: "add-special-item-spell";
  rank: string | number;
  spell?: string;
  itemType: string;
}

/** Spell-slot progression granted by a class engine. */
export interface AddSpellSlotsModifier {
  type: "v2-add-spell-slots";
  slug?: string;
  slots?: DemiplaneSlotEntry[];
}

/** Discriminated union of every engineModifier type we understand. */
export type EngineModifier =
  AddSpellModifier | AddStaffSpellsModifier | AddSpecialItemSpellModifier | AddSpellSlotsModifier;

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
    switch (mod.type) {
      case "add-spell":
        if (typeof mod.addSpell === "string") results.push(mod as unknown as AddSpellModifier);
        break;
      case "add-staff-spells":
        results.push(mod as unknown as AddStaffSpellsModifier);
        break;
      case "add-special-item-spell":
        results.push(mod as unknown as AddSpecialItemSpellModifier);
        break;
      case "v2-add-spell-slots":
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
    const parsed = JSON.parse(line) as { id?: string; data?: { nodes?: Record<string, EngineNode> } };
    const objects = parseStringObjects(Object.values(parsed.data?.nodes ?? {}));

    for (const obj of objects) {
      const modifiers = extractModifiersFromObject((obj.engineModifiers as Array<Record<string, unknown>>) ?? []);
      if (modifiers.length > 0) {
        return finalizeLine(parsed.id, obj.name as string | undefined, modifiers);
      }
    }

    return finalizeLine(parsed.id, undefined, []);
  } catch {
    return { modifiers: [] };
  }
}

/** Parses a full NDJSON stream-engines payload into per-line modifier records. */
export function parseEngineLines(ndjsonText: string): RawEngineLine[] {
  return splitNdjson(ndjsonText).map(parseEngineLine);
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
