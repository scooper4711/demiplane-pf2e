import { describe, it, expect } from "vitest";
import { toChoiceSlug } from "../../src/import/choice-slug.js";

describe("toChoiceSlug", () => {
  it("drops a leading namespace before the colon", () => {
    expect(toChoiceSlug("Skill: Society")).toBe("society");
  });

  it("slugifies plain labels", () => {
    expect(toChoiceSlug("Forest Lore")).toBe("forest-lore");
  });

  it("falls back to the full label when nothing follows the colon", () => {
    expect(toChoiceSlug("Skill:")).toBe("skill");
  });

  it("elides a possessive apostrophe instead of splitting on it", () => {
    // The PF2e/Demiplane slug is barrows-edge, not barrow-s-edge, so the ikon
    // ChoiceSet resolves. Both straight and curly apostrophes are handled.
    expect(toChoiceSlug("Barrow's Edge")).toBe("barrows-edge");
    expect(toChoiceSlug("Barrow’s Edge")).toBe("barrows-edge");
    expect(toChoiceSlug("Skybearer's Belt")).toBe("skybearers-belt");
  });
});
