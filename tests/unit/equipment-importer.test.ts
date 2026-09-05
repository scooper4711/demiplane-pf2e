import { describe, it, expect, beforeEach } from "vitest";
import { installFoundryMocks, createMockActor, createMockPack } from "./foundry-mocks.js";
import { applyEquipment, applyCurrency } from "../../src/import/equipment-importer.js";
import type { DemiplaneEngineEntry, ImportSummary } from "../../src/import/types.js";

describe("applyEquipment", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.equipment-srd": createMockPack([
        {
          _id: "ls1",
          name: "Longsword",
          system: { slug: "longsword" },
          type: "weapon",
        },
        {
          _id: "bp1",
          name: "Backpack",
          system: { slug: "backpack" },
          type: "backpack",
        },
        {
          _id: "hp1",
          name: "Half Plate",
          system: { slug: "half-plate" },
          type: "armor",
        },
        {
          _id: "cb1",
          name: "Commander's Banner",
          system: { slug: "commanders-banner" },
          type: "equipment",
        },
        {
          _id: "whip1",
          name: "Whip",
          system: { slug: "whip", runes: { potency: 0, striking: 0, property: [] } },
          type: "weapon",
        },
      ]),
    });
  });

  function makeSummary(): ImportSummary {
    return {
      itemsImported: 0,
      itemsSkipped: 0,
      unmapped: [],
      errors: [],
      log: [],
    };
  }

  it("imports equipment items from compendium", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "tabula/item/longsword-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "longsword-rm" },
        demiplaneEngineId: "eng1",
      },
    ];
    const summary = makeSummary();
    await applyEquipment(actor as never, engines, summary);

    expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    expect(summary.log.some((l) => l.includes("equipment: 1 items"))).toBe(true);
  });

  it("affixes a potency rune to its weapon instead of creating a separate item", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "whip",
        name: "tabula/item/whip-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "whip-rm" },
        demiplaneEngineId: "whip-eng-id",
      },
      {
        id: "rune",
        name: "tabula/item/weapon-potency-1-rm.eng",
        type: "DemiplaneEngine",
        args: {
          slug: "weapon-potency-1-rm",
          metaItemType: "item-rune",
          parentItemID: "whip-eng-id",
          parentEngine: "whip-eng-id",
        },
        demiplaneEngineId: "rune-eng-id",
      },
    ];
    const summary = makeSummary();
    await applyEquipment(actor as never, engines, summary);

    const created = (actor.createEmbeddedDocuments as ReturnType<typeof import("vitest").vi.fn>).mock.calls.flatMap(
      (c: unknown[]) => c[1] as Array<Record<string, unknown>>
    );
    // Exactly one item — the whip — and no standalone rune item.
    expect(created).toHaveLength(1);
    const whip = created[0]!;
    expect(whip.name).toBe("Whip");
    expect((whip.system as { runes: { potency: number } }).runes.potency).toBe(1);
    expect(created.some((i) => (i.name as string)?.toLowerCase().includes("potency"))).toBe(false);
  });

  it("derives slug from engine name when args.slug is missing", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "tabula/item/commanders-banner-rm.eng",
        type: "DemiplaneEngine",
        args: undefined,
        demiplaneEngineId: "eng1",
      },
    ];
    const summary = makeSummary();
    await applyEquipment(actor as never, engines, summary);

    expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    expect(summary.unmapped).toEqual([]);
    expect(summary.log.some((l) => l.includes("equipment: 1 items"))).toBe(true);
  });

  it("skips items not found in compendium", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "tabula/item/unknown-item-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "unknown-item-rm" },
        demiplaneEngineId: "eng1",
      },
    ];
    const summary = makeSummary();
    await applyEquipment(actor as never, engines, summary);

    expect(summary.log.some((l) => l.includes("not found"))).toBe(true);
  });

  it("sets quantity from quantity engine", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "tabula/item/longsword-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "longsword-rm" },
        demiplaneEngineId: "eng1",
      },
      {
        id: "2",
        name: "eng1--quantity",
        type: "CustomDemiplaneEngine",
        args: {},
        value: 3,
      },
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
      {
        id: "1",
        name: "tabula/item/longsword-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "longsword-rm" },
        demiplaneEngineId: "eng1",
      },
      {
        id: "2",
        name: "character_hand_primary_equipped-id",
        type: "CustomDemiplaneEngine",
        args: {},
        value: "eng1",
      },
    ];
    const summary = makeSummary();
    await applyEquipment(actor as never, engines, summary);

    const call = actor.createEmbeddedDocuments.mock.calls[0];
    const itemData = call[1][0] as Record<string, unknown>;
    expect((itemData.system as Record<string, unknown>).equipped).toEqual({
      carryType: "held",
      handsHeld: 1,
      invested: null,
    });
  });

  it("marks an item invested from its is-invested flag even when not held or worn", async () => {
    // Mirrors a pendant of the occult: is-equipped is absent/0, but the
    // value--is-invested--<id> flag is 1, so it must import as invested.
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "tabula/item/longsword-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "longsword-rm" },
        demiplaneEngineId: "eng1",
      },
      {
        id: "2",
        name: "value--is-invested--eng1",
        type: "CustomDemiplaneEngine",
        args: {},
        value: 1,
      },
    ];
    const summary = makeSummary();
    await applyEquipment(actor as never, engines, summary);

    const itemData = actor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
    expect((itemData.system as Record<string, unknown>).equipped).toEqual({
      carryType: "worn",
      handsHeld: 0,
      invested: true,
    });
  });

  it("does nothing with no item engines", async () => {
    const actor = createMockActor();
    const summary = makeSummary();
    await applyEquipment(actor as never, [], summary);
    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
  });

  describe("generic scrolls and wands", () => {
    beforeEach(() => {
      installFoundryMocks({
        "pf2e.equipment-srd": createMockPack([
          {
            _id: "sc1",
            name: "Scroll of 2nd-rank Spell",
            system: { slug: "scroll-of-2nd-rank-spell" },
            type: "consumable",
          },
          {
            _id: "mw1",
            name: "Magic Wand (1st-Rank Spell)",
            system: { slug: "magic-wand-1st-rank-spell" },
            type: "consumable",
          },
        ]),
        "pf2e.spells-srd": createMockPack([
          { _id: "cm1", name: "Clear Mind", system: { slug: "clear-mind", level: { value: 2 } }, type: "spell" },
          { _id: "me1", name: "Mending", system: { slug: "mending", level: { value: 1 } }, type: "spell" },
        ]),
      });
    });

    const scrollEngine: DemiplaneEngineEntry = {
      id: "1",
      name: "tabula/item/magic-scroll-2nd-rank-rm.eng",
      type: "DemiplaneEngine",
      args: { slug: "magic-scroll-2nd-rank-rm" },
      demiplaneEngineId: "item1",
    };

    it("maps the Demiplane slug onto the ranked consumable and embeds its spell", async () => {
      const actor = createMockActor();
      const engines: DemiplaneEngineEntry[] = [
        scrollEngine,
        {
          id: "2",
          name: "tabula/spell/clear-mind-rm.eng",
          type: "DemiplaneEngine",
          args: { slug: "clear-mind-rm", sourceData: { engineID: "item1" } },
        },
        {
          id: "3",
          name: "item1-override-name",
          type: "CustomDemiplaneEngine",
          args: { parentEngine: "item1" },
          value: "Scroll of clear mind",
        },
      ];
      const summary = makeSummary();
      await applyEquipment(actor as never, engines, summary);

      expect(summary.unmapped).toEqual([]);
      const item = actor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
      const system = item.system as Record<string, unknown>;

      expect(item.name).toBe("Scroll of clear mind");
      expect((system.spell as { system: { slug: string } }).system.slug).toBe("clear-mind");
      expect(
        (system.spell as { system: { location: { heightenedLevel: number } } }).system.location.heightenedLevel
      ).toBe(2);
    });

    it("gives the embedded spell a valid 16-character Foundry id", async () => {
      const actor = createMockActor();
      const engines: DemiplaneEngineEntry[] = [
        scrollEngine,
        {
          id: "2",
          name: "tabula/spell/clear-mind-rm.eng",
          type: "DemiplaneEngine",
          args: { slug: "clear-mind-rm", sourceData: { engineID: "item1" } },
        },
      ];
      const summary = makeSummary();
      await applyEquipment(actor as never, engines, summary);

      const item = actor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
      const spell = (item.system as Record<string, unknown>).spell as { _id: string };

      // Foundry rejects UUIDs here, so the embedded spell needs a Foundry-style id.
      expect(spell._id).toMatch(/^[A-Za-z0-9]{16}$/);
    });

    it("embeds the wand's spell at the wand's rank", async () => {
      const actor = createMockActor();
      const engines: DemiplaneEngineEntry[] = [
        {
          id: "1",
          name: "tabula/item/magic-wand-1st-rank-rm.eng",
          type: "DemiplaneEngine",
          args: { slug: "magic-wand-1st-rank-rm" },
          demiplaneEngineId: "wand1",
        },
        {
          id: "2",
          name: "tabula/spell/mending-rm.eng",
          type: "DemiplaneEngine",
          args: { slug: "mending-rm", sourceData: { engineID: "wand1" } },
        },
      ];
      const summary = makeSummary();
      await applyEquipment(actor as never, engines, summary);

      expect(summary.unmapped).toEqual([]);
      const item = actor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
      const spell = (item.system as Record<string, unknown>).spell as {
        system: { slug: string; location: { heightenedLevel: number } };
      };

      expect(item.name).toBe("Magic Wand (1st-Rank Spell)");
      expect(spell.system.slug).toBe("mending");
      expect(spell.system.location.heightenedLevel).toBe(1);
    });

    it("imports the item without a spell when no spell is linked", async () => {
      const actor = createMockActor();
      const summary = makeSummary();
      await applyEquipment(actor as never, [scrollEngine], summary);

      expect(summary.unmapped).toEqual([]);
      const item = actor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
      expect((item.system as Record<string, unknown>).spell).toBeUndefined();
    });
  });
});

describe("applyCurrency", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.equipment-srd": createMockPack([
        {
          _id: "gp1",
          name: "Gold Pieces",
          system: { slug: "gold-pieces" },
          type: "treasure",
        },
        {
          _id: "sp1",
          name: "Silver Pieces",
          system: { slug: "silver-pieces" },
          type: "treasure",
        },
      ]),
    });
  });

  function makeSummary(): ImportSummary {
    return {
      itemsImported: 0,
      itemsSkipped: 0,
      unmapped: [],
      errors: [],
      log: [],
    };
  }

  it("creates currency items with correct quantity", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "character_currency_gold",
        type: "CustomDemiplaneEngine",
        args: {},
        value: 50,
      },
      {
        id: "2",
        name: "character_currency_silver",
        type: "CustomDemiplaneEngine",
        args: {},
        value: 10,
      },
    ];
    const summary = makeSummary();
    await applyCurrency(actor as never, engines, summary);

    expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    expect(summary.log[0]).toContain("currency");
  });

  it("skips zero-value currencies", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "character_currency_gold",
        type: "CustomDemiplaneEngine",
        args: {},
        value: 0,
      },
    ];
    const summary = makeSummary();
    await applyCurrency(actor as never, engines, summary);

    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
  });
});
