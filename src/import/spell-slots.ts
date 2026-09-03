import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
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

    await writeSlotMaximums(actor, entryId, progression, label, summary);
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
  label: string,
  summary: ImportSummary
): Promise<void> {
  const slotsUpdate = buildSlotsUpdate(progression);
  const entry = actor.items.get(entryId);
  if (!entry) return;

  await entry.update({ system: { slots: slotsUpdate } });
  summary.log.push(
    `+ spell-slots (${label}): cantrips=${String(progression.cantrips)}, ${Object.entries(progression.slots)
      .map(([rank, count]) => `rank${rank}=${String(count)}`)
      .join(", ")}`
  );
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

function buildSlotsUpdate(progression: SlotProgression): Record<string, { max: number; value: number }> {
  const update: Record<string, { max: number; value: number }> = {};
  update.slot0 = { max: progression.cantrips, value: progression.cantrips };

  for (const [rank, count] of Object.entries(progression.slots)) {
    update[`slot${rank}`] = { max: count, value: count };
  }

  return update;
}
