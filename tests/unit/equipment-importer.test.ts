import { describe, it, expect, beforeEach } from "vitest";
import { installFoundryMocks, createMockActor, createMockPack } from "./foundry-mocks.js";
import { applyEquipment, applyCurrency } from "../../src/import/equipment-importer.js";
import type { DemiplaneEngineEntry, ImportSummary } from "../../src/import/types.js";

describe("applyEquipment", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.equipment-srd": createMockPack([
        { _id: "ls1", name: "Longsword", system: { slug: "longsword" }, type: "weapon" },
        { _id: "bp1", name: "Backpack", system: { slug: "backpack" }, type: "backpack" },
        { _id: "hp1", name: "Half Plate", system: { slug: "half-plate" }, type: "armor" },
      ]),
    });
  });

  function makeSummary(): ImportSummary {
    return { itemsImported: 0, itemsSkipped: 0, errors: [], log: [], preview: false };
  }

  it("imports equipment items from compendium", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      { id: "1", name: "tabula/item/longsword-rm.eng", type: "DemiplaneEngine", args: { slug: "longsword-rm" }, demiplaneEngineId: "eng1" },
    ];
    const summary = makeSummary();
    await applyEquipment(actor as never, engines, summary);

    expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    expect(summary.log.some(l => l.includes("equipment: 1 items"))).toBe(true);
  });

  it("skips items not found in compendium", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      { id: "1", name: "tabula/item/unknown-item-rm.eng", type: "DemiplaneEngine", args: { slug: "unknown-item-rm" }, demiplaneEngineId: "eng1" },
    ];
    const summary = makeSummary();
    await applyEquipment(actor as never, engines, summary);

    expect(summary.log.some(l => l.includes("not found"))).toBe(true);
  });

  it("sets quantity from quantity engine", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      { id: "1", name: "tabula/item/longsword-rm.eng", type: "DemiplaneEngine", args: { slug: "longsword-rm" }, demiplaneEngineId: "eng1" },
      { id: "2", name: "eng1--quantity", type: "CustomDemiplaneEngine", args: {}, value: 3 },
    ];
    const summary = makeSummary();
    await applyEquipment(actor as never, engines, summary);

    const call = actor.createEmbeddedDocuments.mock.calls[0];
    const itemData = call[1][0] as Record<string, unknown>;
    expect((itemData.system as Record<string, unknown>).quantity).toBe(3);
  });

  it("sets held state for primary hand", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      { id: "1", name: "tabula/item/longsword-rm.eng", type: "DemiplaneEngine", args: { slug: "longsword-rm" }, demiplaneEngineId: "eng1" },
      { id: "2", name: "character_hand_primary_equipped-id", type: "CustomDemiplaneEngine", args: {}, value: "eng1" },
    ];
    const summary = makeSummary();
    await applyEquipment(actor as never, engines, summary);

    const call = actor.createEmbeddedDocuments.mock.calls[0];
    const itemData = call[1][0] as Record<string, unknown>;
    expect((itemData.system as Record<string, unknown>).equipped).toEqual({ carryType: "held", handsHeld: 1, invested: null });
  });

  it("does nothing with no item engines", async () => {
    const actor = createMockActor();
    const summary = makeSummary();
    await applyEquipment(actor as never, [], summary);
    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
  });
});

describe("applyCurrency", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.equipment-srd": createMockPack([
        { _id: "gp1", name: "Gold Pieces", system: { slug: "gold-pieces" }, type: "treasure" },
        { _id: "sp1", name: "Silver Pieces", system: { slug: "silver-pieces" }, type: "treasure" },
      ]),
    });
  });

  function makeSummary(): ImportSummary {
    return { itemsImported: 0, itemsSkipped: 0, errors: [], log: [], preview: false };
  }

  it("creates currency items with correct quantity", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      { id: "1", name: "character_currency_gold", type: "CustomDemiplaneEngine", args: {}, value: 50 },
      { id: "2", name: "character_currency_silver", type: "CustomDemiplaneEngine", args: {}, value: 10 },
    ];
    const summary = makeSummary();
    await applyCurrency(actor as never, engines, summary);

    expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    expect(summary.log[0]).toContain("currency");
  });

  it("skips zero-value currencies", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      { id: "1", name: "character_currency_gold", type: "CustomDemiplaneEngine", args: {}, value: 0 },
    ];
    const summary = makeSummary();
    await applyCurrency(actor as never, engines, summary);

    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
  });
});
