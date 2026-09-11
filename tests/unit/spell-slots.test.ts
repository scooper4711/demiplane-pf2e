import { describe, it, expect, vi } from "vitest";
import { applySlotMaximums } from "../../src/import/spell-slots.js";
import type { DemiplaneEngineEntry, ImportSummary } from "../../src/import/types.js";

const FEATURE = "bard-spellcasting-rm";

function makeSummary(): ImportSummary {
  return { itemsImported: 0, itemsSkipped: 0, unmapped: [], unresolvedChoices: [], errors: [], log: [] };
}

/**
 * A custom engine pair that makes `resolveSpellSlots` return purely from
 * overrides (no network fetch): a `_max` value plus its `--overridden` flag.
 */
function slotMaxOverride(slotType: string, value: number): DemiplaneEngineEntry[] {
  const name = `character_spell-feature_${FEATURE}_spell-slots_${slotType}_max`;
  return [
    { id: `custom_${name}`, name, type: "CustomDemiplaneEngine", args: { id: null }, value },
    {
      id: `custom_${name}--overridden`,
      name: `${name}--overridden`,
      type: "CustomDemiplaneEngine",
      args: { id: null, parentEngine: name },
      value: 1,
    },
  ];
}

function remainingSlot(rank: number, value: number): DemiplaneEngineEntry {
  const name = `character_spell-feature_${FEATURE}_spell-slots_rank-${String(rank)}_current`;
  return { id: `custom_${name}`, name, type: "CustomDemiplaneEngine", args: { id: null }, value };
}

/** The class engine `findEngineIdForSlots` needs to resolve regular slots. */
const CLASS_ENGINE: DemiplaneEngineEntry = {
  id: "class-engine-id",
  name: "tabula/class/bard-rm.eng",
  type: "DemiplaneEngine",
  args: { tableID: "class" },
};

/** Captures the entry.update payload so the written slots can be asserted. */
function makeActorCapturingUpdate() {
  const updates: Record<string, unknown>[] = [];
  const entry = {
    update: vi.fn((data: Record<string, unknown>) => {
      updates.push(data);
      return Promise.resolve(undefined);
    }),
  };
  const actor = { items: { get: () => entry } };
  return { actor, updates };
}

describe("applySlotMaximums — spontaneous remaining slots", () => {
  it("sets a rank's value to the remaining count from Demiplane, keeping max", async () => {
    const { actor, updates } = makeActorCapturingUpdate();
    const engines: DemiplaneEngineEntry[] = [
      CLASS_ENGINE,
      ...slotMaxOverride("cantrip", 5),
      ...slotMaxOverride("rank-1", 2),
      // 1 of 2 first-rank slots remaining (a cast happened).
      remainingSlot(1, 1),
    ];

    await applySlotMaximums(actor as never, "entry-id", engines, FEATURE, "", makeSummary());

    const slots = (updates[0]!.system as { slots: Record<string, { max: number; value: number }> }).slots;
    expect(slots.slot1).toEqual({ max: 2, value: 1 });
    // Cantrips are at-will: slot0 stays value=max.
    expect(slots.slot0).toEqual({ max: 5, value: 5 });
  });

  it("defaults a rank's value to its max when no remaining engine is present", async () => {
    const { actor, updates } = makeActorCapturingUpdate();
    const engines: DemiplaneEngineEntry[] = [
      CLASS_ENGINE,
      ...slotMaxOverride("cantrip", 5),
      ...slotMaxOverride("rank-1", 2),
    ];

    await applySlotMaximums(actor as never, "entry-id", engines, FEATURE, "", makeSummary());

    const slots = (updates[0]!.system as { slots: Record<string, { max: number; value: number }> }).slots;
    expect(slots.slot1).toEqual({ max: 2, value: 2 });
  });

  it("clamps a stale remaining value to the rank's max", async () => {
    const { actor, updates } = makeActorCapturingUpdate();
    const engines: DemiplaneEngineEntry[] = [
      CLASS_ENGINE,
      ...slotMaxOverride("cantrip", 5),
      ...slotMaxOverride("rank-1", 2),
      remainingSlot(1, 9), // more than max — clamp to 2
    ];

    await applySlotMaximums(actor as never, "entry-id", engines, FEATURE, "", makeSummary());

    const slots = (updates[0]!.system as { slots: Record<string, { max: number; value: number }> }).slots;
    expect(slots.slot1.value).toBe(2);
  });

  it("stamps the spellcasting feature slug for the export side to build engine names", async () => {
    const { actor, updates } = makeActorCapturingUpdate();
    const engines: DemiplaneEngineEntry[] = [
      CLASS_ENGINE,
      ...slotMaxOverride("cantrip", 5),
      ...slotMaxOverride("rank-1", 2),
    ];

    await applySlotMaximums(actor as never, "entry-id", engines, FEATURE, "", makeSummary());

    expect(updates[0]!["flags.demiplane-pf2e.spellFeature"]).toBe(FEATURE);
  });
});
