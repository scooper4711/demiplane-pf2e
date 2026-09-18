import type { DemiplaneEngineEntry } from "./types.js";
import {
  fetchStreamEngineLines,
  parseEngineLines,
  resolveClassFeatureEngineIdsBySlug,
  type DemiplaneSlotEntry,
  type RawEngineLine,
  type RepertoireCountEntry,
} from "./stream-engines.js";

export type { DemiplaneSlotEntry };

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
  /**
   * Cached definition IDs for resolving the feature's own slot source (e.g.
   * a summoner's `summoner-spellcasting-rm` feature definition, which carries
   * the ranked slots its flat class definition lacks).
   */
  cacheEngineIds?: string[];
}

/**
 * Resolves spell slot counts by fetching from stream-engines and checking for user overrides.
 * User overrides take priority over the stream-engines computed defaults.
 */
export async function resolveSpellSlots(options: ResolveSpellSlotsOptions): Promise<SpellSlotProgression> {
  const slotSlug = options.slotSlug ?? "";
  const overrides = findSlotOverrides(options.engines, options.parentSpellFeature, slotSlug);

  if (hasCompleteOverrides(overrides)) {
    return buildProgressionFromOverrides(overrides);
  }

  const lines = await fetchStreamEngineLines([options.classEngineId]);
  const featureLines = await fetchFeatureSlotLines(options.parentSpellFeature, options.cacheEngineIds ?? []);
  const allLines = [...lines, ...featureLines];
  const unrestricted = collectUnrestrictedSlotSlugs(allLines);
  const classEntries = extractSlotEntries(lines, slotSlug, unrestricted, options.parentSpellFeature);
  // The class definition wins ties; the feature definition only fills ranks
  // the class leaves empty (e.g. magus rank-1 slots beside class cantrips).
  const coveredRanks = new Set(classEntries.map((entry) => entry.rank));
  const featureEntries = extractSlotEntries(featureLines, slotSlug, unrestricted, options.parentSpellFeature).filter(
    (entry) => !coveredRanks.has(entry.rank)
  );

  const computed = computeSlotProgression([...classEntries, ...featureEntries], options.characterLevel);
  if (computed.cantrips === 0) {
    // Spontaneous cantrips Demiplane models as repertoire capacity rather
    // than fixed slots (bard, psychic) fall back to the rank-0 count.
    computed.cantrips = computeRepertoireCantrips(allLines, options.characterLevel);
  }
  return mergeWithOverrides(computed, overrides);
}

/**
 * Fetches the spellcasting feature's own definition (e.g.
 * `tabula/class-feature/summoner-spellcasting-rm.eng`) for slot sources the
 * flat class definition lacks. Empty unless the cache resolves the feature.
 */
async function fetchFeatureSlotLines(parentSpellFeature: string, cacheEngineIds: string[]): Promise<RawEngineLine[]> {
  if (cacheEngineIds.length === 0) return [];
  const bySlug = await resolveClassFeatureEngineIdsBySlug(cacheEngineIds);
  const resolvedId = bySlug.get(parentSpellFeature);
  if (!resolvedId) return [];
  return fetchStreamEngineLines([resolvedId]);
}

/**
 * Sums rank-0 repertoire counts at or below the character's level.
 */
function computeRepertoireCantrips(lines: RawEngineLine[], characterLevel: number): number {
  let cantrips = 0;
  for (const line of lines) {
    for (const mod of line.modifiers) {
      if (mod.type !== "v2-add-repertoire-counts" || !mod.slots) continue;
      for (const slot of mod.slots as RepertoireCountEntry[]) {
        if ((slot.rank ?? -1) !== 0) continue;
        if ((slot.repertoireSlug ?? "") !== "") continue;
        if ((slot.levelPrereq ?? Number.MAX_SAFE_INTEGER) > characterLevel) continue;
        cantrips += slot.count ?? 0;
      }
    }
  }
  return cantrips;
}

/**
 * Fetches the class engine definition from stream-engines and extracts slot entries.
 */
export async function fetchSlotEntries(classEngineId: string, slotSlug: string): Promise<DemiplaneSlotEntry[]> {
  const lines = await fetchStreamEngineLines([classEngineId]);
  return extractSlotEntries(lines, slotSlug);
}

/**
 * Parses NDJSON stream-engines response to extract v2-add-spell-slots entries.
 */
export function parseSlotEntriesFromNdjson(
  ndjsonText: string,
  slotSlug: string,
  unrestrictedSlugs: Set<string> = new Set()
): DemiplaneSlotEntry[] {
  return extractSlotEntries(parseEngineLines(ndjsonText), slotSlug, unrestrictedSlugs);
}

/** Marker Demiplane tags wizard school slot entries with. */
const CURRICULUM_SLOT_MARKER = "wizard-school-spellbook-slot";

function extractSlotEntries(
  lines: RawEngineLine[],
  slotSlug: string,
  unrestrictedSlugs: Set<string> = new Set(),
  parentSpellFeature = ""
): DemiplaneSlotEntry[] {
  const allSlots: DemiplaneSlotEntry[] = [];

  for (const line of lines) {
    for (const mod of line.modifiers) {
      if (mod.type !== "v2-add-spell-slots" || !mod.slots) continue;
      if (!modMatchesFeature(mod.slug, parentSpellFeature)) continue;
      const matching = mod.slots.filter((slot) => slotMatches(slot.slug ?? "", slotSlug, unrestrictedSlugs));
      allSlots.push(...matching);
    }
  }

  return allSlots;
}

/**
 * Whether a slot modifier belongs to the requested spellcasting feature.
 * Modifiers carry their feature slug (e.g. a class response mixes animist and
 * apparition slot blocks); without scoping, each entry would count the
 * other's slots. Modifiers without a slug predate the field and keep the old
 * include-everything behavior. Comparison is `-rm`-insensitive (Demiplane
 * mixes `magus-spellcasting` and `magus-spellcasting-rm`).
 */
function modMatchesFeature(modSlug: string | undefined, parentSpellFeature: string): boolean {
  if (parentSpellFeature === "") return true;
  if (modSlug === undefined || modSlug === "") return true;
  const norm = (s: string): string => (s.endsWith("-rm") ? s.slice(0, -3) : s);
  return norm(modSlug) === norm(parentSpellFeature);
}

/**
 * Whether a fixed slot entry belongs to the requested pool. Curriculum pools
 * match by slug inclusion; regular pools take empty-slug entries plus entries
 * tagged with an unrestricted per-slot type (e.g. the magus's
 * `magus-spell-slot-1`). Restricted pools (divine font, studious spells) and
 * unknown tags stay out of regular — they are separate pools, not base slots.
 */
function slotMatches(slotEntrySlug: string, slotSlug: string, unrestrictedSlugs: Set<string>): boolean {
  if (slotSlug !== "") return slotEntrySlug === slotSlug;
  if (slotEntrySlug === "") return true;
  return unrestrictedSlugs.has(slotEntrySlug) && !slotEntrySlug.includes(CURRICULUM_SLOT_MARKER);
}

/**
 * Collects the slot slugs Demiplane declares as unrestricted single-slot
 * pools (`v2-add-spell-slot-type` without restrictions). Fixed slot entries
 * carrying one of these slugs count toward the regular pool.
 */
export function collectUnrestrictedSlotSlugs(lines: RawEngineLine[]): Set<string> {
  const slugs = new Set<string>();
  for (const line of lines) {
    for (const mod of line.modifiers) {
      if (mod.type !== "v2-add-spell-slot-type") continue;
      if (mod.hasRestrictions === true) continue;
      if (typeof mod.slotSlug === "string" && mod.slotSlug !== "") slugs.add(mod.slotSlug);
    }
  }
  return slugs;
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
    return !slotType.includes(CURRICULUM_SLOT_MARKER);
  }
  return slotType.includes(slotSlug);
}

function isOverrideActive(engines: DemiplaneEngineEntry[], overrideName: string): boolean {
  const flagName = `${overrideName}--overridden`;
  return engines.some((e) => e.type === "CustomDemiplaneEngine" && e.name === flagName && e.value === 1);
}

function hasCompleteOverrides(overrides: Map<string, number>): boolean {
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
