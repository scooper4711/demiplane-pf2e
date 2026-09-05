import { describe, it, expect, vi } from "vitest";
import { isRuneEngine, runeParentId, collectRunesByParent, toPropertyRuneSlug } from "../../src/import/weapon-runes.js";
import type { DemiplaneEngineEntry } from "../../src/import/types.js";

function runeEngine(slug: string, parentItemID: string): DemiplaneEngineEntry {
  return {
    id: "rune",
    name: `tabula/item/${slug}.eng`,
    type: "DemiplaneEngine",
    args: { slug, metaItemType: "item-rune", parentItemID, parentEngine: parentItemID },
  } as DemiplaneEngineEntry;
}

describe("isRuneEngine", () => {
  it("is true for an item-rune engine", () => {
    expect(isRuneEngine(runeEngine("weapon-potency-1-rm", "w1"))).toBe(true);
  });

  it("is false for a normal item engine", () => {
    const item = {
      name: "tabula/item/whip-rm.eng",
      type: "DemiplaneEngine",
      args: { slug: "whip-rm" },
    } as DemiplaneEngineEntry;
    expect(isRuneEngine(item)).toBe(false);
  });
});

describe("runeParentId", () => {
  it("prefers parentItemID and falls back to parentEngine", () => {
    expect(runeParentId(runeEngine("weapon-potency-1-rm", "w1"))).toBe("w1");
    const onlyParentEngine = {
      name: "tabula/item/striking-basic-rm.eng",
      type: "DemiplaneEngine",
      args: { slug: "striking-basic-rm", metaItemType: "item-rune", parentEngine: "w2" },
    } as DemiplaneEngineEntry;
    expect(runeParentId(onlyParentEngine)).toBe("w2");
  });
});

describe("collectRunesByParent", () => {
  it("resolves a potency rune to its parent weapon", () => {
    const map = collectRunesByParent([runeEngine("weapon-potency-1-rm", "whip-id")]);
    expect(map.get("whip-id")).toEqual({ potency: 1, striking: 0, property: [] });
  });

  it("accumulates potency and striking on the same weapon, taking the max grade", () => {
    const map = collectRunesByParent([
      runeEngine("weapon-potency-2-rm", "w1"),
      runeEngine("striking-greater-rm", "w1"),
    ]);
    expect(map.get("w1")).toEqual({ potency: 2, striking: 2, property: [] });
  });

  it("maps striking grades: basic=1, greater=2, major=3", () => {
    expect(collectRunesByParent([runeEngine("striking-basic-rm", "a")]).get("a")?.striking).toBe(1);
    expect(collectRunesByParent([runeEngine("striking-greater-rm", "b")]).get("b")?.striking).toBe(2);
    expect(collectRunesByParent([runeEngine("striking-major-rm", "c")]).get("c")?.striking).toBe(3);
  });

  it("keeps runes for different weapons separate", () => {
    const map = collectRunesByParent([
      runeEngine("weapon-potency-1-rm", "whip"),
      runeEngine("weapon-potency-2-rm", "handwraps"),
    ]);
    expect(map.get("whip")?.potency).toBe(1);
    expect(map.get("handwraps")?.potency).toBe(2);
  });

  it("resolves validated property runes to their PF2e slug (Ezren's staff)", () => {
    // Injected validator stands in for the PF2e localization registry.
    const valid = new Set(["ghostTouch", "greaterCorrosive", "greaterShock"]);
    const isValid = (slug: string) => valid.has(slug);
    const onUnknown = vi.fn();

    const map = collectRunesByParent(
      [
        runeEngine("weapon-potency-3-rm", "staff"),
        runeEngine("striking-major-rm", "staff"),
        runeEngine("ghost-touch-rm", "staff"),
        runeEngine("corrosive-greater-rm", "staff"),
        runeEngine("shock-greater-rm", "staff"),
      ],
      onUnknown,
      isValid
    );

    expect(map.get("staff")).toEqual({
      potency: 3,
      striking: 3,
      property: ["ghostTouch", "greaterCorrosive", "greaterShock"],
    });
    expect(onUnknown).not.toHaveBeenCalled();
  });

  it("reports a property rune the system does not recognize instead of guessing", () => {
    const onUnknown = vi.fn();
    const map = collectRunesByParent([runeEngine("made-up-rune-rm", "w1")], onUnknown, () => false);
    expect(onUnknown).toHaveBeenCalledWith("made-up-rune-rm");
    expect(map.get("w1")).toEqual({ potency: 0, striking: 0, property: [] });
  });
});

describe("toPropertyRuneSlug", () => {
  it("camelCases a multi-word rune", () => {
    expect(toPropertyRuneSlug("ghost-touch-rm")).toBe("ghostTouch");
  });

  it("moves a trailing grade word to the front", () => {
    expect(toPropertyRuneSlug("corrosive-greater-rm")).toBe("greaterCorrosive");
    expect(toPropertyRuneSlug("shock-greater-rm")).toBe("greaterShock");
  });

  it("leaves an ungraded single-word rune unchanged", () => {
    expect(toPropertyRuneSlug("flaming-rm")).toBe("flaming");
  });
});
