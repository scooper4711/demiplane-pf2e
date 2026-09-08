import { describe, it, expect, beforeEach } from "vitest";
import { installFoundryMocks, createMockPack } from "./foundry-mocks.js";
import {
  registerSlugMappingSettings,
  getMapping,
  setMapping,
  clearMapping,
  resolveMappedItem,
  isMappingResolvable,
  recordResolvedMapping,
  exportMappings,
  parseMappingsExport,
  importMappings,
  MAPPINGS_EXPORT_VERSION,
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

  it("records a resolution when the slug is new", async () => {
    await recordResolvedMapping("equipment", "auto-resolved", { uuid: EQUIPMENT_UUID, name: "Half Plate" });
    expect(getMapping("equipment", "auto-resolved")).toEqual({ uuid: EQUIPMENT_UUID, name: "Half Plate" });
  });

  it("leaves an existing mapping untouched when recording", async () => {
    await setMapping("equipment", "already", { uuid: EQUIPMENT_UUID, name: "GM Choice" });
    await recordResolvedMapping("equipment", "already", { uuid: SPELL_UUID, name: "Auto" });
    // The deliberate entry wins; recording never clobbers it.
    expect(getMapping("equipment", "already")).toEqual({ uuid: EQUIPMENT_UUID, name: "GM Choice" });
  });
});

describe("slug-mapping export/import", () => {
  const MISSING_UUID = "Compendium.pf2e.equipment-srd.Item.gone";

  beforeEach(() => {
    installFoundryMocks({
      "pf2e.equipment-srd": createMockPack([
        { _id: "hp1", name: "Half Plate", system: { slug: "half-plate" }, type: "armor" },
      ]),
      "pf2e.spells-srd": createMockPack([{ _id: "sp1", name: "Heal", system: { slug: "heal" }, type: "spell" }]),
    });
    registerSlugMappingSettings();
  });

  it("exports mappings grouped by kind, omitting empty kinds", async () => {
    await setMapping("equipment", "religious-symbol", { uuid: EQUIPMENT_UUID, name: "Half Plate" });
    await setMapping("spell", "frostbite-psychic-rm", { uuid: SPELL_UUID, name: "Heal" });

    const data = exportMappings();
    expect(data.version).toBe(MAPPINGS_EXPORT_VERSION);
    expect(data.mappings.equipment).toEqual({ "religious-symbol": { uuid: EQUIPMENT_UUID, name: "Half Plate" } });
    expect(data.mappings.spell).toEqual({ "frostbite-psychic-rm": { uuid: SPELL_UUID, name: "Heal" } });
    expect(data.mappings.feat).toBeUndefined();
  });

  it("round-trips through export then parse", async () => {
    await setMapping("equipment", "religious-symbol", { uuid: EQUIPMENT_UUID, name: "Half Plate" });
    const text = JSON.stringify(exportMappings());

    const parsed = parseMappingsExport(text);
    expect(parsed?.mappings.equipment?.["religious-symbol"]).toEqual({ uuid: EQUIPMENT_UUID, name: "Half Plate" });
  });

  it("rejects malformed or non-export files", () => {
    expect(parseMappingsExport("{not json")).toBeNull();
    expect(parseMappingsExport("[]")).toBeNull();
    expect(parseMappingsExport('{"version":1}')).toBeNull();
  });

  it("drops unknown kinds and malformed entries when parsing untrusted input", () => {
    const raw = JSON.stringify({
      version: 1,
      mappings: {
        equipment: { good: { uuid: EQUIPMENT_UUID, name: "Half Plate" }, bad: { uuid: 42 } },
        bogusKind: { x: { uuid: EQUIPMENT_UUID, name: "X" } },
      },
    });

    const parsed = parseMappingsExport(raw);
    expect(parsed?.mappings.equipment).toEqual({ good: { uuid: EQUIPMENT_UUID, name: "Half Plate" } });
    expect((parsed?.mappings as Record<string, unknown>).bogusKind).toBeUndefined();
  });

  it("imports resolvable mappings and skips those whose target is missing", async () => {
    const parsed = {
      version: 1,
      mappings: {
        equipment: {
          "res-symbol": { uuid: EQUIPMENT_UUID, name: "Half Plate" },
          "gone-item": { uuid: MISSING_UUID, name: "Removed" },
        },
      },
    };

    const result = await importMappings(parsed, { overwrite: false });

    expect(result.imported).toBe(1);
    expect(result.skippedMissing).toBe(1);
    expect(result.missingSamples).toContain("gone-item → Removed");
    expect(getMapping("equipment", "res-symbol")).toEqual({ uuid: EQUIPMENT_UUID, name: "Half Plate" });
    expect(getMapping("equipment", "gone-item")).toBeUndefined();
  });

  it("does not overwrite an existing mapping unless asked", async () => {
    await setMapping("equipment", "res-symbol", { uuid: EQUIPMENT_UUID, name: "Local Choice" });
    const parsed = {
      version: 1,
      mappings: { equipment: { "res-symbol": { uuid: SPELL_UUID, name: "Imported" } } },
    };

    const kept = await importMappings(parsed, { overwrite: false });
    expect(kept.skippedExisting).toBe(1);
    expect(kept.imported).toBe(0);
    expect(getMapping("equipment", "res-symbol")?.name).toBe("Local Choice");
  });

  it("overwrites an existing mapping when overwrite is set", async () => {
    await setMapping("equipment", "res-symbol", { uuid: EQUIPMENT_UUID, name: "Local Choice" });
    const parsed = {
      version: 1,
      mappings: { equipment: { "res-symbol": { uuid: SPELL_UUID, name: "Imported" } } },
    };

    const replaced = await importMappings(parsed, { overwrite: true });
    expect(replaced.imported).toBe(1);
    expect(getMapping("equipment", "res-symbol")).toEqual({ uuid: SPELL_UUID, name: "Imported" });
  });
});
