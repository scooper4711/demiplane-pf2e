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
});
