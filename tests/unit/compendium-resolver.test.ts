import { describe, it, expect, beforeEach } from "vitest";
import { installFoundryMocks, createMockPack } from "./foundry-mocks.js";
import {
  resolveCompendiumItem,
  resolveSlugToUuid,
  resolveSpellFromCompendium,
} from "../../src/import/compendium-resolver.js";
import { registerSlugMappingSettings, setMapping } from "../../src/slug-mapping.js";

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

  it.each([
    ["power-attack-rm", "Power Attack"],
    ["cantrip-expansion-sorcerer-rm", "Cantrip Expansion"],
    ["combat-assessment-commander-rm", "Combat Assessment"],
    ["imperial-rm", "Bloodline: Imperial"],
  ])("resolves slug %s to %s", async (slug, expectedName) => {
    const result = await resolveCompendiumItem(slug, "feat");
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).name).toBe(expectedName);
  });

  it("returns null for unknown slug", async () => {
    const result = await resolveCompendiumItem("nonexistent-feat-rm", "feat");
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

describe("GM slug mappings take precedence", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.feats-srd": createMockPack([{ _id: "feat1", name: "Power Attack", system: { slug: "power-attack" } }]),
      "pf2e.equipment-srd": createMockPack([
        { _id: "hp1", name: "Half Plate", system: { slug: "half-plate" }, type: "armor" },
      ]),
    });
    registerSlugMappingSettings();
  });

  it("uses the mapped item even when the slug would resolve on its own", async () => {
    // "power-attack-rm" resolves in the compendium, but the GM has overridden it.
    await setMapping("feat", "power-attack-rm", {
      uuid: "Compendium.pf2e.equipment-srd.Item.hp1",
      name: "Half Plate",
    });

    const result = await resolveCompendiumItem("power-attack-rm", "feat");
    expect((result as { name: string }).name).toBe("Half Plate");
  });

  it("falls back to the compendium when no mapping applies", async () => {
    const result = await resolveCompendiumItem("power-attack-rm", "feat");
    expect((result as { name: string }).name).toBe("Power Attack");
  });

  it("ignores a mapping recorded under a different kind", async () => {
    await setMapping("spell", "power-attack-rm", {
      uuid: "Compendium.pf2e.equipment-srd.Item.hp1",
      name: "Half Plate",
    });

    const result = await resolveCompendiumItem("power-attack-rm", "feat");
    expect((result as { name: string }).name).toBe("Power Attack");
  });

  it("applies to the spell resolver too, and falls back when the target is gone", async () => {
    await setMapping("spell", "heal-rm", {
      uuid: "Compendium.pf2e.equipment-srd.Item.hp1",
      name: "Half Plate",
    });
    const spelled = await resolveSpellFromCompendium("heal-rm");
    expect((spelled as { name: string }).name).toBe("Half Plate");

    await setMapping("spell", "heal-rm", { uuid: "Compendium.pf2e.spells-srd.Item.gone", name: "Gone" });
    expect(await resolveSpellFromCompendium("heal-rm")).toBeNull();
  });
});
