import { describe, it, expect } from "vitest";
import { findVariantMismatches, type FoundryVariantSettings } from "../../src/import/variant-check.js";
import type { DemiplaneEngineEntry } from "../../src/import/types.js";

function pref(name: string, value: number): DemiplaneEngineEntry {
  return { id: name, name, type: "CustomDemiplaneEngine", value, args: {} } as DemiplaneEngineEntry;
}

const GAB = "preferences--enable-gradual-ability-boosts";
const MYTHIC = "preferences--enable-mythic";
const FA = "preferences--enable-free-archetype";

const allOff: FoundryVariantSettings = { gradualAbilityBoosts: false, mythic: false, freeArchetype: false };
const allOn: FoundryVariantSettings = { gradualAbilityBoosts: true, mythic: true, freeArchetype: true };

describe("findVariantMismatches", () => {
  it("is silent when neither side uses any variant", () => {
    expect(findVariantMismatches([], allOff)).toEqual([]);
  });

  it("is silent when both sides agree the variants are on", () => {
    expect(findVariantMismatches([pref(GAB, 1), pref(MYTHIC, 1), pref(FA, 1)], allOn)).toEqual([]);
  });

  it("flags a variant used in Demiplane but disabled in Foundry", () => {
    const issues = findVariantMismatches([pref(GAB, 1)], allOff);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("Gradual Attribute Boosts");
    expect(issues[0]).toContain("not enabled in Foundry");
  });

  it("flags a variant enabled in Foundry but not used by the character", () => {
    const issues = findVariantMismatches([], { gradualAbilityBoosts: true, mythic: false, freeArchetype: false });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("Gradual Attribute Boosts");
    expect(issues[0]).toContain("enabled in Foundry, but this character does not use it");
  });

  it("flags Mythic in both mismatch directions", () => {
    expect(findVariantMismatches([pref(MYTHIC, 1)], allOff)[0]).toContain("Mythic Rules");
    expect(findVariantMismatches([], { gradualAbilityBoosts: false, mythic: true, freeArchetype: false })[0]).toContain(
      "Mythic Rules"
    );
  });

  it("flags Free Archetype in both mismatch directions", () => {
    expect(findVariantMismatches([pref(FA, 1)], allOff)[0]).toContain("Free Archetype");
    expect(findVariantMismatches([], { gradualAbilityBoosts: false, mythic: false, freeArchetype: true })[0]).toContain(
      "Free Archetype"
    );
  });

  it("flags every variant when all three mismatch", () => {
    // GAB used but off; Mythic + FA on in Foundry but unused → three issues.
    const issues = findVariantMismatches([pref(GAB, 1)], {
      gradualAbilityBoosts: false,
      mythic: true,
      freeArchetype: true,
    });
    expect(issues).toHaveLength(3);
  });

  it("treats a preference flag set to 0 as not used", () => {
    expect(findVariantMismatches([pref(GAB, 0)], allOff)).toEqual([]);
    // ...and still flags it when Foundry has it on but the flag is 0/unused.
    expect(
      findVariantMismatches([pref(GAB, 0)], { gradualAbilityBoosts: true, mythic: false, freeArchetype: false })
    ).toHaveLength(1);
  });

  it("names both settings paths so the GM can fix either side", () => {
    const issue = findVariantMismatches([pref(MYTHIC, 1)], allOff)[0];
    expect(issue).toContain("Toggle Variant Rules");
    expect(issue).toContain("Preferences & Rules");
  });
});
