import { describe, it, expect } from "vitest";
import {
  toFoundrySlug,
  getSlug,
  parseFeatSlot,
  categorizeEngine,
  generateSlugCandidates,
  normalizeEquipmentSlug,
  describeFeatSlot,
  rawEquipmentSlug,
  rankOrdinal,
  genericConsumableSlug,
} from "../../src/import/slug-utils.js";

describe("toFoundrySlug", () => {
  it("strips -rm suffix", () => {
    expect(toFoundrySlug("longsword-rm")).toBe("longsword");
    expect(toFoundrySlug("electric-arc-rm")).toBe("electric-arc");
  });

  it("leaves slugs without -rm unchanged", () => {
    expect(toFoundrySlug("longsword")).toBe("longsword");
    expect(toFoundrySlug("heat-metal")).toBe("heat-metal");
  });

  it("does not strip -rm from the middle", () => {
    expect(toFoundrySlug("charm-rm-legacy")).toBe("charm-rm-legacy");
  });
});

describe("getSlug", () => {
  it("returns args.slug when present", () => {
    const eng = {
      id: "1",
      name: "tabula/feat/test.eng",
      type: "DemiplaneEngine" as const,
      args: { slug: "my-feat-rm" },
    };
    expect(getSlug(eng)).toBe("my-feat-rm");
  });

  it("extracts slug from engine name when args.slug is missing", () => {
    const eng = {
      id: "1",
      name: "tabula/ancestry/human-rm.eng",
      type: "DemiplaneEngine" as const,
      args: {},
    };
    expect(getSlug(eng)).toBe("human-rm");
  });

  it("returns null for non-matching names", () => {
    const eng = {
      id: "1",
      name: "core/character.eng",
      type: "DemiplaneEngine" as const,
      args: {},
    };
    expect(getSlug(eng)).toBe("character");
  });
});

describe("parseFeatSlot", () => {
  it("parses fighter class feat", () => {
    expect(parseFeatSlot("fighter-feat-level-2-rm")).toEqual({
      location: "class-2",
      taken: 2,
    });
  });

  it("parses sorcerer class feat", () => {
    expect(parseFeatSlot("sorcerer-feat-level-4-rm")).toEqual({
      location: "class-4",
      taken: 4,
    });
  });

  it("parses ancestry feat", () => {
    expect(parseFeatSlot("ancestry-feat-level-5-rm")).toEqual({
      location: "ancestry-5",
      taken: 5,
    });
  });

  it("parses skill feat", () => {
    expect(parseFeatSlot("skill-feat-level-2-rm")).toEqual({
      location: "skill-2",
      taken: 2,
    });
  });

  it("parses general feat", () => {
    expect(parseFeatSlot("general-feat-level-3-rm")).toEqual({
      location: "general-3",
      taken: 3,
    });
  });

  it("parses ancestry-feats as level 1", () => {
    expect(parseFeatSlot("ancestry-feats")).toEqual({
      location: "ancestry-1",
      taken: 1,
    });
  });

  it("returns null for select-feat patterns", () => {
    expect(parseFeatSlot("select-feat-natural-ambition")).toEqual({
      location: null,
      taken: null,
    });
  });

  it("returns null for empty string", () => {
    expect(parseFeatSlot("")).toEqual({ location: null, taken: null });
  });

  it("returns null for unknown patterns", () => {
    expect(parseFeatSlot("bloodline-rm")).toEqual({
      location: null,
      taken: null,
    });
  });

  it("parses the mythic calling into its dedicated slot", () => {
    expect(parseFeatSlot("mythic-calling")).toEqual({
      location: "mythic-calling",
      taken: 1,
    });
  });

  it("parses a mythic feat into a mythic level slot (not class)", () => {
    expect(parseFeatSlot("mythic-feat-level-2")).toEqual({
      location: "mythic-2",
      taken: 2,
    });
  });

  it("parses a free-archetype feat into an archetype slot (not class)", () => {
    expect(parseFeatSlot("archetype-feat-level-2")).toEqual({
      location: "archetype-2",
      taken: 2,
    });
    expect(parseFeatSlot("archetype-feat-level-14")).toEqual({
      location: "archetype-14",
      taken: 14,
    });
  });
});

describe("categorizeEngine", () => {
  it("categorizes ancestry", () => {
    expect(categorizeEngine("tabula/ancestry/human-rm.eng")).toBe("ancestry");
  });

  it("categorizes heritage", () => {
    expect(categorizeEngine("tabula/heritage/skilled-human-rm.eng")).toBe("heritage");
  });

  it("categorizes class", () => {
    expect(categorizeEngine("tabula/class/fighter-rm.eng")).toBe("class");
  });

  it("categorizes feat", () => {
    expect(categorizeEngine("tabula/feat/power-attack-rm.eng")).toBe("feat");
  });

  it("skips class-feature engines", () => {
    expect(categorizeEngine("tabula/class-feature/imperial-rm.eng")).toBeNull();
  });

  it("returns null for spells", () => {
    expect(categorizeEngine("tabula/spell/fireball-rm.eng")).toBeNull();
  });

  it("returns null for core engines", () => {
    expect(categorizeEngine("core/selection/attribute/boost.eng")).toBeNull();
  });

  it("does not treat an ancestry *selection* engine as the character's ancestry", () => {
    // Adopted Ancestry (Human) arrives as core/selection/ancestry/...; it must
    // not be categorized as "ancestry" and overwrite the real ancestry (Skeleton).
    expect(categorizeEngine("core/selection/ancestry/custom-selection/index.eng")).toBeNull();
    expect(categorizeEngine("core/selection/skill/increase/index.eng")).toBeNull();
    expect(categorizeEngine("core/selection/item/custom-selection/index.eng")).toBeNull();
  });
});

describe("generateSlugCandidates", () => {
  it("returns exact slug first", () => {
    const candidates = generateSlugCandidates("fireball");
    expect(candidates[0]).toBe("fireball");
  });

  it("strips class suffix", () => {
    const candidates = generateSlugCandidates("cantrip-expansion-sorcerer");
    expect(candidates).toContain("cantrip-expansion");
  });

  it("strips -commander suffix for commander class feats", () => {
    const candidates = generateSlugCandidates("combat-assessment-commander");
    expect(candidates).toContain("combat-assessment");
  });

  it("adds bloodline prefix", () => {
    const candidates = generateSlugCandidates("imperial");
    expect(candidates).toContain("bloodline-imperial");
  });

  it("does not strip non-class suffixes", () => {
    const candidates = generateSlugCandidates("shield-boss");
    expect(candidates).not.toContain("shield");
  });
});

describe("normalizeEquipmentSlug", () => {
  it("strips -rm suffix", () => {
    expect(normalizeEquipmentSlug("longsword-rm")).toBe("longsword");
  });

  it("normalizes arrow to arrows", () => {
    expect(normalizeEquipmentSlug("arrow-rm")).toBe("arrows");
  });

  it("normalizes rations-1-week", () => {
    expect(normalizeEquipmentSlug("rations-1-week-rm")).toBe("rations");
  });

  it("normalizes rope-50-feet", () => {
    expect(normalizeEquipmentSlug("rope-50-feet-rm")).toBe("rope");
  });

  it("normalizes repair-toolkit-basic", () => {
    expect(normalizeEquipmentSlug("repair-toolkit-basic-rm")).toBe("repair-toolkit");
  });

  it("maps generic scrolls onto the ranked consumable", () => {
    expect(normalizeEquipmentSlug("magic-scroll-2nd-rank-rm")).toBe("scroll-of-2nd-rank-spell");
  });

  it("maps generic wands onto the ranked consumable", () => {
    expect(normalizeEquipmentSlug("magic-wand-1st-rank-rm")).toBe("magic-wand-1st-rank-spell");
  });

  it("keeps the ordinal for every rank", () => {
    expect(normalizeEquipmentSlug("magic-scroll-1st-rank-rm")).toBe("scroll-of-1st-rank-spell");
    expect(normalizeEquipmentSlug("magic-scroll-3rd-rank-rm")).toBe("scroll-of-3rd-rank-spell");
    expect(normalizeEquipmentSlug("magic-wand-10th-rank-rm")).toBe("magic-wand-10th-rank-spell");
  });

  it("passes through unknown slugs", () => {
    expect(normalizeEquipmentSlug("half-plate-rm")).toBe("half-plate");
  });

  it("canonicalizes named specialty scroll/wand rank tiers to -Nth-rank", () => {
    // Demiplane writes the tier as -Nth-level-spell or -Nth-rank-rm; the
    // compendium uses -Nth-rank(-spell). Normalize to a -Nth-rank core so
    // findBySlug can match the real named item (not a generic wand).
    expect(normalizeEquipmentSlug("wand-of-widening-9th-rank-rm")).toBe("wand-of-widening-9th-rank");
    expect(normalizeEquipmentSlug("wand-of-spiritual-warfare-8th-level-spell")).toBe(
      "wand-of-spiritual-warfare-8th-rank"
    );
    expect(normalizeEquipmentSlug("wand-of-thundering-echoes-8th-level-spell")).toBe(
      "wand-of-thundering-echoes-8th-rank"
    );
    expect(normalizeEquipmentSlug("wand-of-legerdemain-9th-level-spell")).toBe("wand-of-legerdemain-9th-rank");
    expect(normalizeEquipmentSlug("wand-of-the-snowfields-5th-level-spell")).toBe("wand-of-the-snowfields-5th-rank");
    expect(normalizeEquipmentSlug("wand-of-the-snowfields-7th-level-spell")).toBe("wand-of-the-snowfields-7th-rank");
  });

  it("still maps the generic ranked consumables (not caught by the named-tier rule)", () => {
    expect(normalizeEquipmentSlug("magic-scroll-6th-rank-rm")).toBe("scroll-of-6th-rank-spell");
    expect(normalizeEquipmentSlug("magic-wand-4th-rank-rm")).toBe("magic-wand-4th-rank-spell");
  });
});

describe("describeFeatSlot", () => {
  it("labels leveled category slots", () => {
    expect(describeFeatSlot("skill-feat-level-2-rm")).toBe("Skill feat (level 2)");
    expect(describeFeatSlot("general-feat-level-3-rm")).toBe("General feat (level 3)");
    expect(describeFeatSlot("ancestry-feat-level-5-rm")).toBe("Ancestry feat (level 5)");
    expect(describeFeatSlot("archetype-feat-level-4")).toBe("Archetype feat (level 4)");
  });

  it("labels a class feat slot from the class-name prefix", () => {
    expect(describeFeatSlot("champion-feat-level-1-rm")).toBe("Class feat (level 1)");
    expect(describeFeatSlot("barbarian-feat-level-6-rm")).toBe("Class feat (level 6)");
  });

  it("labels the level-1 ancestry feats slot without a level", () => {
    expect(describeFeatSlot("ancestry-feats")).toBe("Ancestry feat");
  });

  it("labels background and granted feats", () => {
    expect(describeFeatSlot("some-background-row")).toBe("Background feat");
    expect(describeFeatSlot("b09db8d2_select-feat-versatile-human-rm-1bd2ed71")).toBe("Granted feat");
  });

  it("labels the mythic calling slot", () => {
    expect(describeFeatSlot("mythic-calling")).toBe("Mythic calling");
  });

  it("returns undefined for empty or unrecognized source rows", () => {
    expect(describeFeatSlot(undefined)).toBeUndefined();
    expect(describeFeatSlot("")).toBeUndefined();
    expect(describeFeatSlot("manual-sheet-drawer")).toBeUndefined();
  });
});

describe("rawEquipmentSlug", () => {
  it("prefers args.slug when present", () => {
    expect(rawEquipmentSlug({ args: { slug: "longsword" }, name: "tabula/item/longsword-rm.eng" })).toBe("longsword");
  });

  it("falls back to the engine name for slug-less class-kit items", () => {
    expect(rawEquipmentSlug({ args: { id: null }, name: "tabula/item/scimitar-rm.eng" })).toBe("scimitar-rm");
    expect(rawEquipmentSlug({ args: null, name: "tabula/item/scimitar-rm.eng" })).toBe("scimitar-rm");
  });

  it("normalizes the fallback the same way as a real slug", () => {
    const eng = { args: {}, name: "tabula/item/scimitar-rm.eng" };
    expect(normalizeEquipmentSlug(rawEquipmentSlug(eng))).toBe("scimitar");
  });
});

describe("rankOrdinal", () => {
  it("uses st/nd/rd for 1-3", () => {
    expect(rankOrdinal(1)).toBe("1st");
    expect(rankOrdinal(2)).toBe("2nd");
    expect(rankOrdinal(3)).toBe("3rd");
  });

  it("uses th for 4 and up", () => {
    expect(rankOrdinal(4)).toBe("4th");
    expect(rankOrdinal(9)).toBe("9th");
    expect(rankOrdinal(10)).toBe("10th");
  });

  it("uses th for the 11-13 special case", () => {
    expect(rankOrdinal(11)).toBe("11th");
    expect(rankOrdinal(12)).toBe("12th");
    expect(rankOrdinal(13)).toBe("13th");
  });
});

describe("genericConsumableSlug", () => {
  it("builds the ranked scroll slug", () => {
    expect(genericConsumableSlug("scroll", 2)).toBe("scroll-of-2nd-rank-spell");
    expect(genericConsumableSlug("scroll", 1)).toBe("scroll-of-1st-rank-spell");
  });

  it("builds the ranked wand slug", () => {
    expect(genericConsumableSlug("wand", 7)).toBe("magic-wand-7th-rank-spell");
    expect(genericConsumableSlug("wand", 1)).toBe("magic-wand-1st-rank-spell");
  });

  it("round-trips with normalizeEquipmentSlug for the generic Demiplane slugs", () => {
    expect(genericConsumableSlug("scroll", 2)).toBe(normalizeEquipmentSlug("magic-scroll-2nd-rank-rm"));
    expect(genericConsumableSlug("wand", 1)).toBe(normalizeEquipmentSlug("magic-wand-1st-rank-rm"));
  });
});
