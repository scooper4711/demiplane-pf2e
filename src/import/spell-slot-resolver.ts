import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import {
  fetchStreamEngineLines,
  parseEngineLines,
  resolveClassFeatureEngineIdsBySlug,
  expandFeatGrantLines,
  type DemiplaneSlotEntry,
  type RawEngineLine,
  type RepertoireCountEntry,
} from "./stream-engines.js";
import { isArchetypeSpellcasting, featureSlugMatches } from "./spellcasting-features.js";

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
  /**
   * Optional import summary. When present, a note is logged if cantrip count
   * had to fall back to the known-cantrip count (a data-mirroring last resort
   * with no authoritative source), so a surprising value is traceable.
   */
  summary?: ImportSummary;
}

/**
 * Resolves spell slot counts by fetching from stream-engines and checking for user overrides.
 * User overrides take priority over the stream-engines computed defaults.
 */
export async function resolveSpellSlots(options: ResolveSpellSlotsOptions): Promise<SpellSlotProgression> {
  const slotSlug = options.slotSlug ?? "";
  const overrides = findSlotOverrides(options.engines, options.parentSpellFeature, slotSlug);

  const lines = await fetchStreamEngineLines([options.classEngineId]);
  const featureLines = await fetchFeatureSlotLines(options.parentSpellFeature, options.cacheEngineIds ?? []);
  const featLines = await fetchArchetypeFeatSlotLines(
    options.engines,
    options.parentSpellFeature,
    options.cacheEngineIds ?? []
  );
  const allLines = [...lines, ...featureLines, ...featLines];
  const unrestricted = collectUnrestrictedSlotSlugs(allLines);
  const classEntries = extractSlotEntries(lines, slotSlug, unrestricted, options.parentSpellFeature);
  // The class definition wins ties; feature and feat definitions only fill
  // ranks the class leaves empty (e.g. magus rank-1 slots beside class
  // cantrips, archetype slots beside an empty class block).
  const coveredRanks = new Set(classEntries.map((entry) => entry.rank));
  const extraEntries = extractSlotEntries(
    [...featureLines, ...featLines],
    slotSlug,
    unrestricted,
    options.parentSpellFeature
  ).filter((entry) => !coveredRanks.has(entry.rank));

  const computed = computeSlotProgression([...classEntries, ...extraEntries], options.characterLevel);
  if (computed.cantrips === 0) {
    // Spontaneous cantrips Demiplane models as repertoire capacity rather
    // than fixed slots (bard, psychic) fall back to the rank-0 count of the
    // feature's own repertoire pool — never another feature's (a psychic
    // repertoire must not size a wizard-archetype entry).
    computed.cantrips = computeRepertoireCantrips(allLines, options.characterLevel, options.parentSpellFeature);
  }
  if (computed.cantrips === 0) {
    // No cantrip data anywhere (e.g. summoner): Demiplane itself counts the
    // known cantrips, so mirror that rather than demanding an override. This
    // is a data-mirroring last resort with no authoritative source, so leave
    // a breadcrumb — a mis-built character's known count becomes the max here.
    computed.cantrips = countKnownCantrips(options.engines, options.parentSpellFeature);
    if (computed.cantrips > 0) {
      options.summary?.log.push(
        `! spell-slots (${options.parentSpellFeature}): cantrip max taken from ${String(computed.cantrips)} known cantrip(s) — no slot or repertoire data in Demiplane`
      );
    }
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
 * Fetches the definitions of the character's taken feats for archetype slot
 * sources. Archetype spellcasting (e.g. wizard dedication) carries no
 * per-character slot engines; its slots come from `v2-add-spell-slots`
 * modifiers on the archetype feats, all sharing the archetype's feature
 * slug, summed across feats and gated by levelPrereq. Follows one `add-feat`
 * expansion round (dedication → basic arcana) like the spell resolver.
 */
async function fetchArchetypeFeatSlotLines(
  engines: DemiplaneEngineEntry[],
  parentSpellFeature: string,
  cacheEngineIds: string[]
): Promise<RawEngineLine[]> {
  if (!isArchetypeSpellcasting(parentSpellFeature)) return [];
  const featIds = engines
    .filter((e) => e.type === "DemiplaneEngine" && e.name.startsWith("tabula/feat/") && typeof e.id === "string")
    .map((e) => e.id as string);
  if (featIds.length === 0) return [];

  const lines = await fetchStreamEngineLines(featIds);
  // Dedication → basic-arcana style chains: expand one round so the granted
  // spellcasting feat's ranked slots are seen alongside the taken feats.
  lines.push(...(await expandFeatGrantLines(lines, cacheEngineIds)));
  return lines;
}

/**
 * Counts the distinct rank-0 spells a feature knows (excluding prepared
 * duplicates, which mirror the spellbook). Last-resort cantrip source when
 * neither fixed slots nor repertoire counts exist.
 */
function countKnownCantrips(engines: DemiplaneEngineEntry[], parentSpellFeature: string): number {
  const slugs = new Set<string>();
  for (const engine of engines) {
    if (!engine.name?.startsWith("tabula/spell/")) continue;
    // Match `-rm`-insensitively like the slot/repertoire paths so a bare-suffix
    // feature (e.g. psychic) is scoped consistently across all cantrip sources.
    if (!featureSlugMatches(engine.args?.parentSpellFeature as string | undefined, parentSpellFeature)) continue;
    if (engine.args?.isPrepare === true) continue;
    if ((engine.args?.selectionRank as number | undefined) !== 0) continue;
    const slug = engine.args?.slug as string | undefined;
    if (typeof slug === "string" && slug !== "") slugs.add(slug);
  }
  return slugs.size;
}

/**
 * Sums rank-0 repertoire counts at or below the character's level, scoped to
 * the requested feature (mod slugs normalize `-rm`-insensitively like fixed
 * entries; slugless mods keep the old include-everything behavior).
 */
function computeRepertoireCantrips(lines: RawEngineLine[], characterLevel: number, parentSpellFeature: string): number {
  let cantrips = 0;
  for (const line of lines) {
    cantrips += countLineCantrips(line, characterLevel, parentSpellFeature);
  }
  return cantrips;
}

/** Rank-0 repertoire counts on one definition line, scoped to the feature. */
function countLineCantrips(line: RawEngineLine, characterLevel: number, parentSpellFeature: string): number {
  let count = 0;
  for (const mod of line.modifiers) {
    if (mod.type !== "v2-add-repertoire-counts" || !mod.slots) continue;
    if (!featureSlugMatches(mod.slug, parentSpellFeature)) continue;
    for (const slot of mod.slots as RepertoireCountEntry[]) {
      if (isCountedCantrip(slot, characterLevel)) count += slot.count ?? 0;
    }
  }
  return count;
}

/** A rank-0, feature-wide count slot the character's level unlocks. */
function isCountedCantrip(slot: RepertoireCountEntry, characterLevel: number): boolean {
  return (
    (slot.rank ?? -1) === 0 &&
    (slot.repertoireSlug ?? "") === "" &&
    (slot.levelPrereq ?? Number.MAX_SAFE_INTEGER) <= characterLevel
  );
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
      if (!featureSlugMatches(mod.slug, parentSpellFeature)) continue;
      const matching = mod.slots.filter((slot) => slotMatches(slot.slug ?? "", slotSlug, unrestrictedSlugs));
      allSlots.push(...matching);
    }
  }

  return allSlots;
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
 * Finds per-character slot maximums from character engine data. Pattern:
 * `character_spell-feature_{feature}_spell-slots_{slotType}_max`. These are
 * the authoritative per-character values whether or not the player pinned
 * them (a `--overridden` companion marks a manual pin); with the companion
 * absent they carry the class progression.
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

/**
 * Maps a Demiplane slot-type token (the `{slotType}` in a
 * `..._spell-slots_{slotType}_max` engine name) to a rank: 0 for a cantrip
 * token, N for `rank-N`, or null when it names neither. Single source of the
 * slot-type → rank rule shared by every override reader.
 */
export function slotTypeToRank(slotType: string): number | null {
  if (slotType === "cantrip" || slotType.startsWith("cantrip")) return 0;
  const rankMatch = /rank-(\d+)/.exec(slotType);
  return rankMatch?.[1] ? Number(rankMatch[1]) : null;
}

/**
 * Applies per-character slot maximums over the computed progression. Each
 * override wins for its own rank (authoritative per-character value); ranks
 * without an override keep the computed count. Always safe to call — an empty
 * override map returns the computed progression unchanged — so there is no
 * need to decide up front whether the overrides are "complete".
 */
function mergeWithOverrides(computed: SpellSlotProgression, overrides: Map<string, number>): SpellSlotProgression {
  if (overrides.size === 0) return computed;

  const result = { cantrips: computed.cantrips, slots: { ...computed.slots } };

  for (const [slotType, count] of overrides) {
    const rank = slotTypeToRank(slotType);
    if (rank === 0) {
      result.cantrips = count;
    } else if (rank !== null) {
      result.slots[rank] = count;
    }
  }

  return result;
}
