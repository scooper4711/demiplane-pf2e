import type { DemiplaneEngineEntry } from "./types.js";

/**
 * A single slot entry from the Demiplane stream-engines class feature definition.
 * Found inside engineModifiers with type "v2-add-spell-slots".
 */
export interface DemiplaneSlotEntry {
  rank: number;
  count: number;
  levelPrereq: number;
  slug: string;
}

/** Resolved spell slot counts for a spellcasting feature. */
export interface SpellSlotProgression {
  /** Number of cantrip slots. */
  cantrips: number;
  /** Slots per rank (key = rank 1-10, value = slot count). */
  slots: Record<number, number>;
}

/** Options for resolving spell slots. */
export interface ResolveSpellSlotsOptions {
  /** The engine ID of the class (from tabula/class/*.eng → id field). */
  classEngineId: string;
  /** The character's current level. */
  characterLevel: number;
  /** All engines from the character data (for override detection). */
  engines: DemiplaneEngineEntry[];
  /** The parentSpellFeature value (e.g., "wizard-spellcasting-rm"). */
  parentSpellFeature: string;
  /** Optional: filter by slug to get only curriculum or regular slots. Empty string = regular. */
  slotSlug?: string;
}

const STREAM_ENGINES_URL = "https://character.demiplane.com/stream-engines";

/**
 * Resolves spell slot counts by fetching from stream-engines and checking for user overrides.
 * User overrides take priority over the stream-engines computed defaults.
 */
export async function resolveSpellSlots(options: ResolveSpellSlotsOptions): Promise<SpellSlotProgression> {
  const overrides = findSlotOverrides(options.engines, options.parentSpellFeature, options.slotSlug ?? "");

  if (hasCompleteOverrides(overrides, options.characterLevel)) {
    return buildProgressionFromOverrides(overrides);
  }

  const slotEntries = await fetchSlotEntries(options.classEngineId, options.slotSlug ?? "");

  const computed = computeSlotProgression(slotEntries, options.characterLevel);
  return mergeWithOverrides(computed, overrides);
}

/**
 * Fetches the class engine definition from stream-engines and extracts slot entries.
 */
export async function fetchSlotEntries(classEngineId: string, slotSlug: string): Promise<DemiplaneSlotEntry[]> {
  const response = await fetch(STREAM_ENGINES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      engineIdsBySource: { "pathfinder2e-v2": [classEngineId] },
      isSheet: true,
      nexusSlug: "pathfinder2e",
    }),
  });

  if (!response.ok) {
    return [];
  }

  const text = await response.text();
  return parseSlotEntriesFromNdjson(text, slotSlug);
}

/**
 * Parses NDJSON stream-engines response to extract v2-add-spell-slots entries.
 */
export function parseSlotEntriesFromNdjson(ndjsonText: string, slotSlug: string): DemiplaneSlotEntry[] {
  const lines = ndjsonText.split("\n").filter((line) => line.trim());
  const allSlots: DemiplaneSlotEntry[] = [];

  for (const line of lines) {
    const entries = extractSlotEntriesFromLine(line, slotSlug);
    allSlots.push(...entries);
  }

  return allSlots;
}

function extractSlotEntriesFromLine(line: string, slotSlug: string): DemiplaneSlotEntry[] {
  try {
    const parsed = JSON.parse(line) as {
      data?: { nodes?: Record<string, EngineNode> };
    };
    const nodes = Object.values(parsed.data?.nodes ?? {});

    for (const node of nodes) {
      if (node.name !== "StringObject" || !node.data?.string) continue;

      const slots = extractSlotsFromStringNode(node.data.string, slotSlug);
      if (slots.length > 0) return slots;
    }
  } catch {
    // Skip malformed lines
  }

  return [];
}

interface EngineNode {
  name: string;
  data?: { string?: string; [key: string]: unknown };
}

interface EngineModifier {
  type: string;
  slug?: string;
  slots?: DemiplaneSlotEntry[];
}

function extractSlotsFromStringNode(jsonString: string, slotSlug: string): DemiplaneSlotEntry[] {
  try {
    const obj = JSON.parse(jsonString) as {
      engineModifiers?: EngineModifier[];
    };

    if (!obj.engineModifiers) return [];

    for (const modifier of obj.engineModifiers) {
      if (modifier.type !== "v2-add-spell-slots") continue;
      if (!modifier.slots) continue;

      const matching = modifier.slots.filter((slot) => (slot.slug ?? "") === slotSlug);

      if (matching.length > 0) return matching;
    }
  } catch {
    // Skip unparseable JSON strings
  }

  return [];
}

/**
 * Computes slot counts per rank from raw slot entries for a given character level.
 * Sums all count values where levelPrereq <= characterLevel, grouped by rank.
 */
export function computeSlotProgression(entries: DemiplaneSlotEntry[], characterLevel: number): SpellSlotProgression {
  let cantrips = 0;
  const slots: Record<number, number> = {};

  for (const entry of entries) {
    if (entry.levelPrereq > characterLevel) continue;

    if (entry.rank === 0) {
      cantrips += entry.count;
    } else {
      slots[entry.rank] = (slots[entry.rank] ?? 0) + entry.count;
    }
  }

  return { cantrips, slots };
}

/**
 * Finds user-overridden slot maximums from character engine data.
 * Pattern: character_spell-feature_{feature}_spell-slots_{slotType}_max
 * with companion --overridden flag set to 1.
 */
export function findSlotOverrides(
  engines: DemiplaneEngineEntry[],
  parentSpellFeature: string,
  slotSlug: string
): Map<string, number> {
  const overrides = new Map<string, number>();
  const prefix = `character_spell-feature_${parentSpellFeature}_spell-slots_`;
  const suffix = "_max";

  for (const engine of engines) {
    if (engine.type !== "CustomDemiplaneEngine") continue;
    if (typeof engine.name !== "string") continue;
    if (!engine.name.startsWith(prefix) || !engine.name.endsWith(suffix)) continue;
    if (engine.name.endsWith("--overridden")) continue;

    const slotType = engine.name.slice(prefix.length, -suffix.length);
    if (!matchesSlotSlug(slotType, slotSlug)) continue;

    if (!isOverrideActive(engines, engine.name)) continue;

    overrides.set(slotType, engine.value as number);
  }

  return overrides;
}

function matchesSlotSlug(slotType: string, slotSlug: string): boolean {
  if (slotSlug === "") {
    return !slotType.includes("wizard-school-spellbook-slot");
  }
  return slotType.includes(slotSlug);
}

function isOverrideActive(engines: DemiplaneEngineEntry[], overrideName: string): boolean {
  const flagName = `${overrideName}--overridden`;
  return engines.some((e) => e.type === "CustomDemiplaneEngine" && e.name === flagName && e.value === 1);
}

function hasCompleteOverrides(overrides: Map<string, number>, _characterLevel: number): boolean {
  // Only use overrides exclusively if we have at least cantrip + one rank override.
  // Otherwise we need stream-engines data to fill gaps.
  return overrides.size >= 2 && overrides.has("cantrip");
}

function buildProgressionFromOverrides(overrides: Map<string, number>): SpellSlotProgression {
  let cantrips = 0;
  const slots: Record<number, number> = {};

  for (const [slotType, count] of overrides) {
    if (slotType === "cantrip" || slotType.startsWith("cantrip")) {
      cantrips = count;
    } else {
      const rankMatch = /rank-(\d+)/.exec(slotType);
      if (rankMatch?.[1]) {
        slots[Number(rankMatch[1])] = count;
      }
    }
  }

  return { cantrips, slots };
}

function mergeWithOverrides(computed: SpellSlotProgression, overrides: Map<string, number>): SpellSlotProgression {
  if (overrides.size === 0) return computed;

  const result = { cantrips: computed.cantrips, slots: { ...computed.slots } };

  for (const [slotType, count] of overrides) {
    if (slotType === "cantrip" || slotType.startsWith("cantrip")) {
      result.cantrips = count;
    } else {
      const rankMatch = /rank-(\d+)/.exec(slotType);
      if (rankMatch?.[1]) {
        result.slots[Number(rankMatch[1])] = count;
      }
    }
  }

  return result;
}
