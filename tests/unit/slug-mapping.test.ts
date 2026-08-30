import { describe, it, expect, beforeEach } from "vitest";
import { installFoundryMocks, createMockPack } from "./foundry-mocks.js";
import {
  registerSlugMappingSettings,
  getMapping,
  setMapping,
  clearMapping,
  resolveMappedItem,
  isMappingResolvable,
} from "../../src/slug-mapping.js";

const EQUIPMENT_UUID = "Compendium.pf2e.equipment-srd.Item.hp1";
const SPELL_UUID = "Compendium.pf2e.spells-srd.Item.sp1";

describe("slug-mapping", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.equipment-srd": createMockPack([
        { _id: "hp1", name: "Half Plate", system: { slug: "half-plate" }, type: "armor" },
      ]),
      "pf2e.spells-srd": createMockPack([{ _id: "sp1", name: "Heal", system: { slug: "heal" }, type: "spell" }]),
    });
    registerSlugMappingSettings();
  });

  it("round-trips a mapping", async () => {
    await setMapping("equipment", "religious-symbol", { uuid: EQUIPMENT_UUID, name: "Half Plate" });
    expect(getMapping("equipment", "religious-symbol")).toEqual({ uuid: EQUIPMENT_UUID, name: "Half Plate" });
  });

  it("keeps the same slug independent across kinds", async () => {
    await setMapping("equipment", "shared-slug", { uuid: EQUIPMENT_UUID, name: "Half Plate" });
    await setMapping("spell", "shared-slug", { uuid: SPELL_UUID, name: "Heal" });

    expect(getMapping("equipment", "shared-slug")?.name).toBe("Half Plate");
    expect(getMapping("spell", "shared-slug")?.name).toBe("Heal");

    await clearMapping("equipment", "shared-slug");
    expect(getMapping("equipment", "shared-slug")).toBeUndefined();
    // Clearing one kind leaves the other alone.
    expect(getMapping("spell", "shared-slug")?.name).toBe("Heal");
  });

  it("returns undefined when there is no mapping", () => {
    expect(getMapping("equipment", "never-mapped")).toBeUndefined();
  });

  it("resolves the mapped item", async () => {
    await setMapping("equipment", "religious-symbol", { uuid: EQUIPMENT_UUID, name: "Half Plate" });

    const item = await resolveMappedItem("equipment", "religious-symbol");
    expect(item).not.toBeNull();
    expect((item as { name: string }).name).toBe("Half Plate");
  });

  it("returns null with no mapping so callers fall through to the compendium", async () => {
    expect(await resolveMappedItem("equipment", "not-mapped")).toBeNull();
  });

  it("returns null when the mapped target no longer exists", async () => {
    await setMapping("equipment", "religious-symbol", {
      uuid: "Compendium.pf2e.equipment-srd.Item.gone",
      name: "Removed Item",
    });

    // Falls through rather than breaking the import.
    expect(await resolveMappedItem("equipment", "religious-symbol")).toBeNull();
  });

  it("reports whether a mapping's target still resolves", async () => {
    await setMapping("equipment", "good", { uuid: EQUIPMENT_UUID, name: "Half Plate" });
    await setMapping("equipment", "bad", { uuid: "Compendium.pf2e.equipment-srd.Item.gone", name: "Removed" });

    expect(await isMappingResolvable(getMapping("equipment", "good")!)).toBe(true);
    expect(await isMappingResolvable(getMapping("equipment", "bad")!)).toBe(false);
  });
});
