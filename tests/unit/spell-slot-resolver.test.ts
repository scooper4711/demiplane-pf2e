import { describe, it, expect } from "vitest";
import {
  computeSlotProgression,
  findSlotOverrides,
  parseSlotEntriesFromNdjson,
} from "../../src/import/spell-slot-resolver.js";
import type { DemiplaneEngineEntry } from "../../src/import/types.js";
import type { DemiplaneSlotEntry } from "../../src/import/spell-slot-resolver.js";

describe("computeSlotProgression", () => {
  const wizardSlots: DemiplaneSlotEntry[] = [
    { rank: 0, count: 5, levelPrereq: 1, slug: "" },
    { rank: 1, count: 2, levelPrereq: 1, slug: "" },
    { rank: 1, count: 1, levelPrereq: 2, slug: "" },
    { rank: 2, count: 2, levelPrereq: 3, slug: "" },
    { rank: 2, count: 1, levelPrereq: 4, slug: "" },
    { rank: 3, count: 2, levelPrereq: 5, slug: "" },
    { rank: 3, count: 1, levelPrereq: 6, slug: "" },
  ];

  it("computes level 1 wizard slots", () => {
    const result = computeSlotProgression(wizardSlots, 1);
    expect(result.cantrips).toBe(5);
    expect(result.slots[1]).toBe(2);
    expect(result.slots[2]).toBeUndefined();
  });

  it("computes level 2 wizard slots", () => {
    const result = computeSlotProgression(wizardSlots, 2);
    expect(result.cantrips).toBe(5);
    expect(result.slots[1]).toBe(3);
    expect(result.slots[2]).toBeUndefined();
  });

  it("computes level 4 wizard slots", () => {
    const result = computeSlotProgression(wizardSlots, 4);
    expect(result.cantrips).toBe(5);
    expect(result.slots[1]).toBe(3);
    expect(result.slots[2]).toBe(3);
    expect(result.slots[3]).toBeUndefined();
  });

  it("computes level 6 wizard slots", () => {
    const result = computeSlotProgression(wizardSlots, 6);
    expect(result.cantrips).toBe(5);
    expect(result.slots[1]).toBe(3);
    expect(result.slots[2]).toBe(3);
    expect(result.slots[3]).toBe(3);
  });

  it("returns empty slots for empty entries", () => {
    const result = computeSlotProgression([], 5);
    expect(result.cantrips).toBe(0);
    expect(Object.keys(result.slots)).toHaveLength(0);
  });

  it("computes sorcerer slots (3+1 pattern)", () => {
    const sorcererSlots: DemiplaneSlotEntry[] = [
      { rank: 0, count: 5, levelPrereq: 1, slug: "" },
      { rank: 1, count: 3, levelPrereq: 1, slug: "" },
      { rank: 1, count: 1, levelPrereq: 2, slug: "" },
    ];
    const result = computeSlotProgression(sorcererSlots, 2);
    expect(result.cantrips).toBe(5);
    expect(result.slots[1]).toBe(4);
  });
});

describe("findSlotOverrides", () => {
  function makeOverrideEngines(feature: string, slotType: string, value: number): DemiplaneEngineEntry[] {
    return [
      {
        id: `custom_character_spell-feature_${feature}_spell-slots_${slotType}_max`,
        name: `character_spell-feature_${feature}_spell-slots_${slotType}_max`,
        type: "CustomDemiplaneEngine",
        args: { id: null },
        value,
      },
      {
        id: `custom_character_spell-feature_${feature}_spell-slots_${slotType}_max--overridden`,
        name: `character_spell-feature_${feature}_spell-slots_${slotType}_max--overridden`,
        type: "CustomDemiplaneEngine",
        args: { id: null, parentEngine: `character_spell-feature_${feature}_spell-slots_${slotType}_max` },
        value: 1,
      },
    ];
  }

  it("finds cantrip override for regular slots", () => {
    const engines = makeOverrideEngines("wizard-spellcasting-rm", "cantrip", 7);
    const result = findSlotOverrides(engines, "wizard-spellcasting-rm", "");
    expect(result.get("cantrip")).toBe(7);
  });

  it("finds rank-1 override for regular slots", () => {
    const engines = makeOverrideEngines("wizard-spellcasting-rm", "rank-1", 4);
    const result = findSlotOverrides(engines, "wizard-spellcasting-rm", "");
    expect(result.get("rank-1")).toBe(4);
  });

  it("excludes curriculum overrides when filtering for regular slots", () => {
    const engines = makeOverrideEngines("wizard-spellcasting-rm", "cantrip-wizard-school-spellbook-slot", 1);
    const result = findSlotOverrides(engines, "wizard-spellcasting-rm", "");
    expect(result.size).toBe(0);
  });

  it("finds curriculum overrides when filtering for curriculum slots", () => {
    const engines = makeOverrideEngines("wizard-spellcasting-rm", "cantrip-wizard-school-spellbook-slot", 2);
    const result = findSlotOverrides(engines, "wizard-spellcasting-rm", "wizard-school-spellbook-slot");
    expect(result.get("cantrip-wizard-school-spellbook-slot")).toBe(2);
  });

  it("ignores overrides without the --overridden flag", () => {
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "custom_character_spell-feature_wizard-spellcasting-rm_spell-slots_cantrip_max",
        name: "character_spell-feature_wizard-spellcasting-rm_spell-slots_cantrip_max",
        type: "CustomDemiplaneEngine",
        args: { id: null },
        value: 99,
      },
      // No companion --overridden flag
    ];
    const result = findSlotOverrides(engines, "wizard-spellcasting-rm", "");
    expect(result.size).toBe(0);
  });

  it("ignores overrides for a different spell feature", () => {
    const engines = makeOverrideEngines("cleric-spellcasting-rm", "cantrip", 5);
    const result = findSlotOverrides(engines, "wizard-spellcasting-rm", "");
    expect(result.size).toBe(0);
  });

  it("returns empty map when no overrides exist", () => {
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "something-else",
        name: "character_name",
        type: "CustomDemiplaneEngine",
        args: { id: null },
        value: "Wizard",
      },
    ];
    const result = findSlotOverrides(engines, "wizard-spellcasting-rm", "");
    expect(result.size).toBe(0);
  });
});

describe("parseSlotEntriesFromNdjson", () => {
  it("extracts v2-add-spell-slots entries from NDJSON", () => {
    const ndjson = JSON.stringify({
      id: "engine-1",
      data: {
        nodes: {
          "1": {
            name: "StringObject",
            data: {
              string: JSON.stringify({
                name: "Wizard Spellcasting",
                engineModifiers: [
                  {
                    type: "v2-add-spell-slots",
                    slug: "wizard-spellcasting-rm",
                    slots: [
                      { rank: 0, count: 5, levelPrereq: 1, slug: "" },
                      { rank: 1, count: 2, levelPrereq: 1, slug: "" },
                    ],
                  },
                ],
              }),
            },
          },
        },
      },
    });

    const result = parseSlotEntriesFromNdjson(ndjson, "");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ rank: 0, count: 5, levelPrereq: 1, slug: "" });
    expect(result[1]).toEqual({ rank: 1, count: 2, levelPrereq: 1, slug: "" });
  });

  it("filters by slotSlug for curriculum slots", () => {
    const ndjson = JSON.stringify({
      id: "engine-1",
      data: {
        nodes: {
          "1": {
            name: "StringObject",
            data: {
              string: JSON.stringify({
                name: "School of Ars Grammatica",
                engineModifiers: [
                  {
                    type: "v2-add-spell-slots",
                    slug: "wizard-spellcasting-rm",
                    slots: [
                      { rank: 0, count: 1, levelPrereq: 1, slug: "wizard-school-spellbook-slot" },
                      { rank: 1, count: 1, levelPrereq: 1, slug: "wizard-school-spellbook-slot" },
                    ],
                  },
                ],
              }),
            },
          },
        },
      },
    });

    const result = parseSlotEntriesFromNdjson(ndjson, "wizard-school-spellbook-slot");
    expect(result).toHaveLength(2);
    expect(result[0]?.slug).toBe("wizard-school-spellbook-slot");
  });

  it("returns empty array when no matching slots", () => {
    const ndjson = JSON.stringify({
      id: "engine-1",
      data: { nodes: { "1": { name: "Module", data: { module: "some/module.eng" } } } },
    });

    const result = parseSlotEntriesFromNdjson(ndjson, "");
    expect(result).toHaveLength(0);
  });

  it("handles multi-line NDJSON with target in second line", () => {
    const line1 = JSON.stringify({ id: "line1", data: { nodes: {} } });
    const line2 = JSON.stringify({
      id: "line2",
      data: {
        nodes: {
          "1": {
            name: "StringObject",
            data: {
              string: JSON.stringify({
                engineModifiers: [
                  {
                    type: "v2-add-spell-slots",
                    slots: [{ rank: 0, count: 5, levelPrereq: 1, slug: "" }],
                  },
                ],
              }),
            },
          },
        },
      },
    });

    const result = parseSlotEntriesFromNdjson(`${line1}\n${line2}`, "");
    expect(result).toHaveLength(1);
    expect(result[0]?.rank).toBe(0);
  });

  it("handles malformed JSON gracefully", () => {
    const ndjson = "not valid json\n{also broken";
    const result = parseSlotEntriesFromNdjson(ndjson, "");
    expect(result).toHaveLength(0);
  });
});
