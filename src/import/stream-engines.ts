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

/** A focus-point grant. */
export interface AddFocusPointModifier {
  type: "add-focus-point";
  addFocus: number;
}

/** Spells granted by a staff item. */
export interface AddStaffSpellsModifier {
  type: "add-staff-spells";
  spells: Array<{ rank: number; spell: string }>;
}

/** A spell granted by a wand / special item. */
export interface AddSpecialItemSpellModifier {
  type: "add-special-item-spell";
  rank: string | number;
  spell: string;
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
  | AddSpellModifier
  | AddFocusPointModifier
  | AddStaffSpellsModifier
  | AddSpecialItemSpellModifier
  | AddSpellSlotsModifier;

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
      case "add-focus-point":
        if (typeof mod.addFocus === "number") results.push(mod as unknown as AddFocusPointModifier);
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

/**
 * Parses a single NDJSON line from stream-engines. Returns the engine id, the
 * display name (from the first node carrying modifiers), and every engineModifier
 * found in its `StringObject` nodes. Malformed lines yield an empty modifier list.
 */
export function parseEngineLine(line: string): RawEngineLine {
  try {
    const parsed = JSON.parse(line) as { id?: string; data?: { nodes?: Record<string, EngineNode> } };
    const nodes = Object.values(parsed.data?.nodes ?? {});

    for (const node of nodes) {
      if (node.name !== "StringObject" || !node.data?.string) continue;

      try {
        const obj = JSON.parse(node.data.string) as {
          name?: string;
          engineModifiers?: Array<Record<string, unknown>>;
        };
        const modifiers = extractModifiersFromObject(obj.engineModifiers ?? []);
        if (modifiers.length > 0) {
          return finalizeLine(parsed.id, obj.name, modifiers);
        }
      } catch {
        // Skip malformed nodes
      }
    }

    return finalizeLine(parsed.id, undefined, []);
  } catch {
    return { modifiers: [] };
  }
}

/** Parses a full NDJSON stream-engines payload into per-line modifier records. */
export function parseEngineLines(ndjsonText: string): RawEngineLine[] {
  return ndjsonText
    .split("\n")
    .filter((line) => line.trim())
    .map(parseEngineLine);
}

/**
 * Fetches the given Demiplane engine definitions from stream-engines and returns
 * the parsed modifiers for each. Network or parse failures yield an empty list
 * rather than throwing, so callers can degrade gracefully.
 */
export async function fetchStreamEngineLines(engineIds: string[]): Promise<RawEngineLine[]> {
  if (engineIds.length === 0) return [];

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

    if (!response.ok) return [];

    const text = await response.text();
    return parseEngineLines(text);
  } catch (error) {
    debugLog(`stream-engines fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
