import { describe, it, expect } from "vitest";
import {
  CLASS_SPELLCASTING,
  EIDOLON_TRADITIONS,
  eidolonTradition,
  stripRemasterSuffix,
  isArchetypeSpellcasting,
  baseSpellcastingSlug,
  featureSlugMatches,
  baseConfigForFeature,
} from "../../src/import/spellcasting-features.js";

describe("stripRemasterSuffix", () => {
  it("drops a trailing -rm", () => {
    expect(stripRemasterSuffix("magus-spellcasting-rm")).toBe("magus-spellcasting");
  });

  it("leaves a slug without -rm unchanged", () => {
    expect(stripRemasterSuffix("psychic-spellcasting")).toBe("psychic-spellcasting");
  });

  it("only strips a trailing -rm, not an internal one", () => {
    expect(stripRemasterSuffix("rm-spellcasting")).toBe("rm-spellcasting");
  });
});

describe("isArchetypeSpellcasting", () => {
  it("recognizes an archetype feature with -rm", () => {
    expect(isArchetypeSpellcasting("wizard-spellcasting-archetype-rm")).toBe(true);
  });

  it("recognizes an archetype feature without -rm", () => {
    expect(isArchetypeSpellcasting("wizard-spellcasting-archetype")).toBe(true);
  });

  it("rejects a base-class feature", () => {
    expect(isArchetypeSpellcasting("wizard-spellcasting-rm")).toBe(false);
  });

  it("does not match 'archetype' appearing mid-slug", () => {
    // Only the -archetype segment immediately before the end (or -rm) qualifies.
    expect(isArchetypeSpellcasting("archetype-flavored-spellcasting-rm")).toBe(false);
  });
});

describe("baseSpellcastingSlug", () => {
  it("reduces an archetype slug to its base class", () => {
    expect(baseSpellcastingSlug("wizard-spellcasting-archetype-rm")).toBe("wizard-spellcasting-rm");
  });

  it("reduces a suffixless archetype slug", () => {
    expect(baseSpellcastingSlug("wizard-spellcasting-archetype")).toBe("wizard-spellcasting");
  });

  it("leaves a non-archetype slug unchanged", () => {
    expect(baseSpellcastingSlug("bard-spellcasting-rm")).toBe("bard-spellcasting-rm");
  });
});

describe("featureSlugMatches", () => {
  it("matches identical slugs", () => {
    expect(featureSlugMatches("magus-spellcasting-rm", "magus-spellcasting-rm")).toBe(true);
  });

  it("matches -rm-insensitively (bare vs suffixed)", () => {
    expect(featureSlugMatches("magus-spellcasting", "magus-spellcasting-rm")).toBe(true);
    expect(featureSlugMatches("magus-spellcasting-rm", "magus-spellcasting")).toBe(true);
  });

  it("rejects different features", () => {
    expect(featureSlugMatches("animist-spellcasting-rm", "apparition-spellcasting-rm")).toBe(false);
  });

  it("an absent/empty modifier slug matches everything (legacy behavior)", () => {
    expect(featureSlugMatches(undefined, "witch-spellcasting-rm")).toBe(true);
    expect(featureSlugMatches("", "witch-spellcasting-rm")).toBe(true);
  });

  it("an empty parentSpellFeature matches everything", () => {
    expect(featureSlugMatches("anything-rm", "")).toBe(true);
  });
});

describe("baseConfigForFeature", () => {
  it("resolves a base-class feature", () => {
    expect(baseConfigForFeature("bard-spellcasting-rm")).toEqual({
      tradition: "occult",
      preparedType: "spontaneous",
      ability: "cha",
    });
  });

  it("resolves an archetype feature through its base class", () => {
    // Wizard archetype casts exactly like the wizard.
    expect(baseConfigForFeature("wizard-spellcasting-archetype-rm")).toEqual(
      CLASS_SPELLCASTING["wizard-spellcasting-rm"]
    );
  });

  it("resolves the necromancer as a prepared occult Int caster", () => {
    expect(baseConfigForFeature("necromancer-spellcasting-rm")).toEqual({
      tradition: "occult",
      preparedType: "prepared",
      ability: "int",
    });
  });

  it("returns null for the summoner (dynamic, eidolon-based tradition)", () => {
    expect(baseConfigForFeature("summoner-spellcasting-rm")).toBeNull();
  });

  it("returns null for an unknown feature", () => {
    expect(baseConfigForFeature("mystery-spellcasting-rm")).toBeNull();
  });
});

describe("EIDOLON_TRADITIONS / eidolonTradition", () => {
  // Rulebook (Player Core 2) eidolon → tradition mapping. A typo here silently
  // mis-traditions a summoner, so each entry is asserted explicitly.
  const expected: Record<string, string> = {
    angel: "divine",
    beast: "primal",
    construct: "arcane",
    demon: "divine",
    dragon: "arcane",
    fey: "primal",
    ghost: "occult",
    plant: "primal",
    psychopomp: "divine",
    undead: "occult",
  };

  it.each(Object.entries(expected))("maps %s eidolon to the %s tradition", (slug, tradition) => {
    expect(eidolonTradition(slug)).toBe(tradition);
  });

  it("covers exactly the documented eidolon types (no extras, none missing)", () => {
    expect(Object.keys(EIDOLON_TRADITIONS).sort()).toEqual(Object.keys(expected).sort());
  });

  it("returns null for an unknown eidolon", () => {
    expect(eidolonTradition("aberrant")).toBeNull();
  });

  it("only yields the four PF2e traditions", () => {
    const valid = new Set(["arcane", "divine", "occult", "primal"]);
    for (const tradition of Object.values(EIDOLON_TRADITIONS)) {
      expect(valid.has(tradition)).toBe(true);
    }
  });
});
