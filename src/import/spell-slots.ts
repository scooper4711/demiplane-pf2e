import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { MODULE_ID } from "./types.js";
import { debugLog } from "./debug-log.js";
import { resolveSpellSlots } from "./spell-slot-resolver.js";

export async function applySlotMaximums(
  actor: Actor,
  entryId: string,
  engines: DemiplaneEngineEntry[],
  parentSpellFeature: string,
  slotSlug: string,
  summary: ImportSummary
): Promise<void> {
  const engineId = findEngineIdForSlots(engines, slotSlug);
  if (!engineId) {
    debugLog(`[spell-slots] No engine found for slot resolution, skipping`);
    return;
  }

  const label = slotSlug ? `curriculum (${slotSlug})` : "regular";
  debugLog(`[spell-slots] Resolving ${label} slots for feature="${parentSpellFeature}", engineId="${engineId}"`);

  try {
    const progression = await resolveSpellSlots({
      classEngineId: engineId,
      characterLevel: getCharacterLevel(engines),
      engines,
      parentSpellFeature,
      slotSlug,
    });

    debugLog(
      `[spell-slots] Resolved: cantrips=${String(progression.cantrips)}, slots=${JSON.stringify(progression.slots)}`
    );

    const remaining = collectRemainingSlots(engines, parentSpellFeature);
    await writeSlotMaximums(actor, entryId, progression, remaining, parentSpellFeature, label, summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`[spell-slots] Failed to resolve ${label} slots: ${message}`);
    summary.log.push(`! spell-slots: failed to resolve ${label} (${message})`);
  }
}

interface SlotProgression {
  cantrips: number;
  slots: Record<number, number>;
}

async function writeSlotMaximums(
  actor: Actor,
  entryId: string,
  progression: SlotProgression,
  remaining: Map<number, number>,
  parentSpellFeature: string,
  label: string,
  summary: ImportSummary
): Promise<void> {
  const slotsUpdate = buildSlotsUpdate(progression, remaining);
  const entry = actor.items.get(entryId);
  if (!entry) return;

  // Stamp the feature slug so a later export can build this entry's
  // `character_spell-feature_{feature}_spell-slots_rank-{N}_current` engine name
  // when a spontaneous caster spends a slot on the Foundry sheet.
  await entry.update({
    system: { slots: slotsUpdate },
    [`flags.${MODULE_ID}.spellFeature`]: parentSpellFeature,
  });
  summary.log.push(
    `+ spell-slots (${label}): cantrips=${String(progression.cantrips)}, ${Object.entries(progression.slots)
      .map(([rank, count]) => `rank${rank}=${String(count)}`)
      .join(", ")}`
  );
}

/** The prefix Demiplane uses for a feature's per-rank remaining-slot engines. */
const SLOTS_PREFIX = "character_spell-feature_";
/** The suffix marking the *remaining* (current) slot count, vs `_max`. */
const CURRENT_SUFFIX = "_current";

/**
 * Collects the remaining (unspent) spell-slot count per rank for a spellcasting
 * feature, read from Demiplane's session-state engines. A spontaneous caster
 * tracks spent slots as `character_spell-feature_{feature}_spell-slots_rank-{N}_current`
 * (value = casts left at rank N); a prepared caster has none of these (it tracks
 * individual cast spells via `-is-cast` flags instead), so the map is empty and
 * every rank keeps its full maximum.
 */
function collectRemainingSlots(engines: DemiplaneEngineEntry[], parentSpellFeature: string): Map<number, number> {
  const prefix = `${SLOTS_PREFIX}${parentSpellFeature}_spell-slots_rank-`;
  const remaining = new Map<number, number>();
  for (const eng of engines) {
    if (eng.type !== "CustomDemiplaneEngine") continue;
    if (typeof eng.name !== "string" || !eng.name.startsWith(prefix) || !eng.name.endsWith(CURRENT_SUFFIX)) continue;
    const rankText = eng.name.slice(prefix.length, -CURRENT_SUFFIX.length);
    const rank = Number(rankText);
    const value = Number(eng.value);
    if (Number.isInteger(rank) && Number.isFinite(value)) remaining.set(rank, value);
  }
  return remaining;
}

export function getCharacterLevel(engines: DemiplaneEngineEntry[]): number {
  const levelEngine = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === "character_level");
  return Number(levelEngine?.value) || 1;
}

/**
 * Finds the correct engine ID for slot resolution.
 * For regular slots: use the class engine.
 * For curriculum slots: use the school class-feature engine.
 */
function findEngineIdForSlots(engines: DemiplaneEngineEntry[], slotSlug: string): string | null {
  if (slotSlug) {
    // Curriculum: find the school class-feature engine
    const schoolEngine = engines.find(
      (e) => e.type === "DemiplaneEngine" && e.name?.startsWith("tabula/class-feature/school-")
    );
    return (schoolEngine?.id as string) ?? null;
  }

  // Regular: use the class engine
  const classEngine = engines.find((e) => e.name?.startsWith("tabula/class/"));
  return (classEngine?.id as string) ?? null;
}

/**
 * Builds the per-rank slot update. Each rank's `value` (current available casts)
 * is the remaining count imported from Demiplane when present, else the max — so
 * a spontaneous caster's spent slots survive a re-import instead of resetting to
 * full. Cantrips are always at-will, so slot0 stays value=max. `value` is clamped
 * to `max` so a stale remaining value can never exceed the pool.
 */
function buildSlotsUpdate(
  progression: SlotProgression,
  remaining: Map<number, number>
): Record<string, { max: number; value: number }> {
  const update: Record<string, { max: number; value: number }> = {};
  update.slot0 = { max: progression.cantrips, value: progression.cantrips };

  for (const [rankText, count] of Object.entries(progression.slots)) {
    const rank = Number(rankText);
    const remainingAtRank = remaining.get(rank);
    const value = remainingAtRank === undefined ? count : Math.min(Math.max(remainingAtRank, 0), count);
    update[`slot${rank}`] = { max: count, value };
  }

  return update;
}
