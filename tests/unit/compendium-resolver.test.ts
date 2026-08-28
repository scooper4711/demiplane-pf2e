import { describe, it, expect, beforeEach } from "vitest";
import { installFoundryMocks, createMockPack } from "./foundry-mocks.js";
import { resolveCompendiumItem, resolveSlugToUuid } from "../../src/import/compendium-resolver.js";

describe("resolveCompendiumItem", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.feats-srd": createMockPack([
        {
          _id: "feat1",
          name: "Power Attack",
          system: { slug: "power-attack" },
        },
        {
          _id: "feat2",
          name: "Cantrip Expansion",
          system: { slug: "cantrip-expansion" },
        },
        {
          _id: "feat3",
          name: "Combat Assessment",
          system: { slug: "combat-assessment" },
        },
      ]),
      "pf2e.classfeatures": createMockPack([
        {
          _id: "bloodline1",
          name: "Bloodline: Imperial",
          system: { slug: "bloodline-imperial" },
        },
      ]),
    });
  });

  it("resolves a simple slug after stripping -rm", async () => {
    const result = await resolveCompendiumItem("power-attack-rm");
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).name).toBe("Power Attack");
  });

  it("resolves by stripping class suffix", async () => {
    const result = await resolveCompendiumItem("cantrip-expansion-sorcerer-rm");
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).name).toBe("Cantrip Expansion");
  });

  it("resolves commander class feats by stripping -commander suffix", async () => {
    const result = await resolveCompendiumItem("combat-assessment-commander-rm");
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).name).toBe("Combat Assessment");
  });

  it("resolves by adding bloodline prefix", async () => {
    const result = await resolveCompendiumItem("imperial-rm");
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).name).toBe("Bloodline: Imperial");
  });

  it("returns null for unknown slug", async () => {
    const result = await resolveCompendiumItem("nonexistent-feat-rm");
    expect(result).toBeNull();
  });
});

describe("resolveSlugToUuid", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.feats-srd": createMockPack([
        {
          _id: "feat1",
          name: "Power Attack",
          system: { slug: "power-attack" },
        },
      ]),
      "pf2e.classfeatures": createMockPack([
        {
          _id: "bloodline1",
          name: "Bloodline: Imperial",
          system: { slug: "bloodline-imperial" },
        },
      ]),
    });
  });

  it("returns compendium UUID for known slug", async () => {
    const uuid = await resolveSlugToUuid("power-attack");
    expect(uuid).toBe("Compendium.pf2e.feats-srd.Item.feat1");
  });

  it("returns null for unknown slug", async () => {
    const uuid = await resolveSlugToUuid("nonexistent");
    expect(uuid).toBeNull();
  });

  it("resolves a bloodline choice slug to its compendium UUID", async () => {
    const uuid = await resolveSlugToUuid("imperial");
    expect(uuid).toBe("Compendium.pf2e.classfeatures.Item.bloodline1");
  });
});
