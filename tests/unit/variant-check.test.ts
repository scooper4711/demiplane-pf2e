import { describe, it, expect } from "vitest";
import { findVariantMismatches, type FoundryVariantSettings } from "../../src/import/variant-check.js";
import type { DemiplaneEngineEntry } from "../../src/import/types.js";

function pref(name: string, value: number): DemiplaneEngineEntry {
  return { id: name, name, type: "CustomDemiplaneEngine", value, args: {} } as DemiplaneEngineEntry;
}

const GAB = "preferences--enable-gradual-ability-boosts";
const MYTHIC = "preferences--enable-mythic";

const bothOff: FoundryVariantSettings = { gradualAbilityBoosts: false, mythic: false };
const bothOn: FoundryVariantSettings = { gradualAbilityBoosts: true, mythic: true };

describe("findVariantMismatches", () => {
  it("returns nothing when the character uses no variants", () => {
    expect(findVariantMismatches([], bothOff)).toEqual([]);
  });

  it("flags Gradual Ability Boosts when the character uses it but Foundry has it off", () => {
    const issues = findVariantMismatches([pref(GAB, 1)], bothOff);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("Gradual Ability Boosts");
  });

  it("flags Mythic when the character uses it but Foundry has it off", () => {
    const issues = findVariantMismatches([pref(MYTHIC, 1)], bothOff);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("Mythic");
  });

  it("flags both when both are used but neither is enabled", () => {
    const issues = findVariantMismatches([pref(GAB, 1), pref(MYTHIC, 1)], bothOff);
    expect(issues).toHaveLength(2);
  });

  it("stays silent when the variants the character uses are enabled in Foundry", () => {
    expect(findVariantMismatches([pref(GAB, 1), pref(MYTHIC, 1)], bothOn)).toEqual([]);
  });

  it("does not flag a variant whose preference flag is present but not set to 1", () => {
    expect(findVariantMismatches([pref(GAB, 0)], bothOff)).toEqual([]);
  });

  it("flags only the mismatched variant when settings differ", () => {
    // GAB used and off → flagged; Mythic used but on → not flagged.
    const issues = findVariantMismatches([pref(GAB, 1), pref(MYTHIC, 1)], {
      gradualAbilityBoosts: false,
      mythic: true,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("Gradual Ability Boosts");
  });
});
