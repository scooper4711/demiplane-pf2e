import { describe, it, expect } from "vitest";
import {
  toFoundrySlug,
  getSlug,
  parseFeatSlot,
  categorizeEngine,
  generateSlugCandidates,
  normalizeEquipmentSlug,
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
});
