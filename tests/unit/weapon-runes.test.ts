import { describe, it, expect, vi } from "vitest";
import { isRuneEngine, runeParentId, collectRunesByParent } from "../../src/import/weapon-runes.js";
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

  it("reports unknown rune slugs instead of guessing", () => {
    const onUnknown = vi.fn();
    const map = collectRunesByParent([runeEngine("flaming-rm", "w1")], onUnknown);
    expect(onUnknown).toHaveBeenCalledWith("flaming-rm");
    // No property rune resolved, so the weapon gets a zero-rune record.
    expect(map.get("w1")).toEqual({ potency: 0, striking: 0, property: [] });
  });
});
