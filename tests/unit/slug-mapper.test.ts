import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlugMapper, transformSlug } from "../../src/slug-mapper.js";

// Mock the Foundry VTT game global
const mockGetIndex = vi.fn();
const mockPack = { getIndex: mockGetIndex };
const mockPacks = new Map<string, typeof mockPack>();

vi.stubGlobal("game", {
  packs: mockPacks,
  settings: { get: () => true },
});

describe("transformSlug", () => {
  it("strips -rm suffix", () => {
    expect(transformSlug("fireball-rm")).toBe("fireball");
  });

  it("passes non-rm slugs unchanged", () => {
    expect(transformSlug("glass-shield")).toBe("glass-shield");
  });

  it("strips only trailing -rm, not embedded", () => {
    expect(transformSlug("arm-rm")).toBe("arm");
  });

  it("handles slug that is just '-rm'", () => {
    expect(transformSlug("-rm")).toBe("");
  });
});

describe("SlugMapper", () => {
  beforeEach(() => {
    mockPacks.clear();
    vi.clearAllMocks();
  });

  it("resolves a slug from the first matching pack", async () => {
    mockGetIndex.mockResolvedValue([{ _id: "item1", system: { slug: "fireball" } }]);
    mockPacks.set("pf2e.spells-srd", mockPack);

    const mapper = new SlugMapper(["pf2e.spells-srd"]);
    const result = await mapper.resolve("fireball-rm");

    expect(result).toEqual({
      uuid: "Compendium.pf2e.spells-srd.Item.item1",
      packKey: "pf2e.spells-srd",
      slug: "fireball",
    });
  });

  it("returns undefined when no pack matches", async () => {
    mockGetIndex.mockResolvedValue([]);
    mockPacks.set("pf2e.spells-srd", mockPack);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mapper = new SlugMapper(["pf2e.spells-srd"]);
    const result = await mapper.resolve("nonexistent");

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("nonexistent"));
    warnSpy.mockRestore();
  });

  it("logs info for duplicate slug and returns first match", async () => {
    mockGetIndex.mockResolvedValue([
      { _id: "item1", system: { slug: "shield" } },
      { _id: "item2", system: { slug: "shield" } },
    ]);
    mockPacks.set("pf2e.equipment-srd", mockPack);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mapper = new SlugMapper(["pf2e.equipment-srd"]);
    const result = await mapper.resolve("shield");

    expect(result?.uuid).toBe("Compendium.pf2e.equipment-srd.Item.item1");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Duplicate slug"));
    warnSpy.mockRestore();
  });

  it("skips packs that don't exist", async () => {
    mockGetIndex.mockResolvedValue([{ _id: "cls1", system: { slug: "fighter" } }]);
    mockPacks.set("pf2e.classes", mockPack);
    // "pf2e.feats-srd" not in mockPacks

    const mapper = new SlugMapper(["pf2e.feats-srd", "pf2e.classes"]);
    const result = await mapper.resolve("fighter");

    expect(result?.packKey).toBe("pf2e.classes");
  });
});
