import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFoundryMocks, createMockActor, createMockPack } from "./foundry-mocks.js";
import { applyEquipment, applyCurrency } from "../../src/import/equipment-importer.js";
import { applyCraftingFormulas } from "../../src/import/crafting-formulas.js";
import { getAllMappings, setMapping, registerSlugMappingSettings } from "../../src/slug-mapping.js";
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

  // Two backpacks share the slug `backpack`, so they can only be told apart by
  // their unique Demiplane engine ids. Each backpack's `<id>-container` engine
  // must place its own item into that specific container, not collapse both into
  // one. Regression: the importer previously created only the first backpack.
  it("places items into the correct one of two same-slug containers", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "b1",
        name: "tabula/item/backpack-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "backpack-rm" },
        demiplaneEngineId: "bp-left",
      },
      {
        id: "b2",
        name: "tabula/item/backpack-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "backpack-rm" },
        demiplaneEngineId: "bp-right",
      },
      {
        id: "w1",
        name: "tabula/item/longsword-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "longsword-rm" },
        demiplaneEngineId: "sword-in-left",
      },
      {
        id: "w2",
        name: "tabula/item/whip-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "whip-rm" },
        demiplaneEngineId: "whip-in-right",
      },
      // The two container-link engines: sword → left backpack, whip → right.
      { id: "c1", name: "sword-in-left-container", type: "CustomDemiplaneEngine", value: "bp-left", args: {} },
      { id: "c2", name: "whip-in-right-container", type: "CustomDemiplaneEngine", value: "bp-right", args: {} },
    ];

    await applyEquipment(actor as never, engines, makeSummary());

    // Resolve each created backpack's Foundry id, then confirm each weapon's
    // containerId points at the correct backpack instance.
    const created = [...actor.items];
    const findBySlug = (slug: string) => created.filter((i) => (i.system as { slug?: string })?.slug === slug);
    const backpacks = findBySlug("backpack");
    expect(backpacks).toHaveLength(2);
    const sword = created.find((i) => (i.system as { slug?: string })?.slug === "longsword");
    const whip = created.find((i) => (i.system as { slug?: string })?.slug === "whip");

    // The sword and whip are stowed in different backpacks.
    const swordContainer = (sword?.system as { containerId?: string })?.containerId;
    const whipContainer = (whip?.system as { containerId?: string })?.containerId;
    expect(swordContainer).toBeDefined();
    expect(whipContainer).toBeDefined();
    expect(swordContainer).not.toBe(whipContainer);
    expect(backpacks.map((b) => b.id)).toContain(swordContainer);
    expect(backpacks.map((b) => b.id)).toContain(whipContainer);
  });

  // A renamed container carries its custom name in a `<id>-name` engine, unlike
  // most items which use `<id>-override-name`. Both must import; a container's
  // rename was previously dropped (only `-override-name` was recognized).
  it("imports a container's custom name from its -name engine", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "b1",
        name: "tabula/item/backpack-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "backpack-rm" },
        demiplaneEngineId: "bp-1",
      },
      // The container rename engine (note the `-name` suffix, not `-override-name`).
      {
        id: "n1",
        name: "bp-1-name",
        type: "CustomDemiplaneEngine",
        args: { parentEngine: "bp-1" },
        value: "Left Pouch",
      },
      // The sibling boolean marker must NOT be treated as a name.
      {
        id: "n1o",
        name: "bp-1-name--overridden",
        type: "CustomDemiplaneEngine",
        args: { parentEngine: "bp-1-name" },
        value: 1,
      },
    ];

    await applyEquipment(actor as never, engines, makeSummary());

    const backpack = [...actor.items].find((i) => (i.system as { slug?: string })?.slug === "backpack");
    expect(backpack?.name).toBe("Left Pouch");
  });

  // An item an ancestry/feat grants (e.g. the dwarf's Clan Dagger) is created by
  // Foundry's own GrantItem rule, so importing its engine too would duplicate it.
  // Such engines carry a `sourceData` block naming the granting element; manual
  // inventory has none.
  it("skips item engines granted by another element", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "granted",
        name: "tabula/item/longsword-rm.eng",
        type: "DemiplaneEngine",
        args: {
          slug: "longsword-rm",
          parentEngine: "dwarf-engine",
          sourceData: { name: "Dwarf", slug: "dwarf-rm", category: "ancestry", engineID: "dwarf-engine" },
        },
        demiplaneEngineId: "eng-granted",
      },
    ];
    const summary = makeSummary();
    await applyEquipment(actor as never, engines, summary);

    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it("still imports manually added items alongside a granted one", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "granted",
        name: "tabula/item/longsword-rm.eng",
        type: "DemiplaneEngine",
        args: {
          slug: "longsword-rm",
          sourceData: { category: "ancestry", engineID: "dwarf-engine" },
        },
        demiplaneEngineId: "eng-granted",
      },
      {
        id: "manual",
        name: "tabula/item/whip-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "whip-rm", sourceRow: "manual-sheet-drawer" },
        demiplaneEngineId: "eng-manual",
      },
    ];
    const summary = makeSummary();
    await applyEquipment(actor as never, engines, summary);

    expect(summary.log.some((l) => l.includes("equipment: 1 items"))).toBe(true);
  });

  // Resolved items must show as editable rows on the mapping screen so a GM can
  // correct one that matched the wrong compendium entry — not just unmapped ones.
  it("records the resolved equipment mapping keyed by the Demiplane slug", async () => {
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
    await applyEquipment(actor as never, engines, makeSummary());

    const mapping = getAllMappings("equipment")["longsword-rm"];
    expect(mapping).toEqual({
      uuid: "Compendium.pf2e.equipment-srd.Item.ls1",
      name: "Longsword",
    });
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

  // A Demiplane quantity of 0 is a real quantity (e.g. a consumable the player
  // tops up in town), not a deletion — import it at 0 rather than coercing to 1.
  it("imports a quantity-0 item at quantity 0 (not coerced to 1)", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "tabula/item/longsword-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "longsword-rm" },
        demiplaneEngineId: "eng1",
      },
      { id: "2", name: "eng1--quantity", type: "CustomDemiplaneEngine", args: {}, value: 0 },
    ];
    await applyEquipment(actor as never, engines, makeSummary());

    const itemData = actor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
    expect((itemData.system as Record<string, unknown>).quantity).toBe(0);
  });

  // With soft-delete on, a quantity of 0 marks a deleted item, so it is skipped.
  it("skips a quantity-0 item when soft-delete is enabled", async () => {
    await game.settings.set("demiplane-pf2e", "syncWriteLevel", "text-quantity-delete");
    await game.settings.set("demiplane-pf2e", "syncSoftDelete", true);

    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "tabula/item/longsword-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "longsword-rm" },
        demiplaneEngineId: "eng1",
      },
      { id: "2", name: "eng1--quantity", type: "CustomDemiplaneEngine", args: {}, value: 0 },
    ];
    await applyEquipment(actor as never, engines, makeSummary());

    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
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

      // Renamed the PF2e way (matching a spell dragged onto the sheet), not left
      // as the generic "Magic Wand (1st-Rank Spell)".
      expect(item.name).toBe("Wand of Mending (Rank 1)");
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

  describe("generic ranked consumables with a linked spell (regression)", () => {
    beforeEach(() => {
      installFoundryMocks({
        "pf2e.equipment-srd": createMockPack([
          {
            _id: "sc6",
            name: "Scroll of 6th-rank Spell",
            system: { slug: "scroll-of-6th-rank-spell" },
            type: "consumable",
          },
          {
            _id: "mw4",
            name: "Magic Wand (4th-Rank Spell)",
            system: { slug: "magic-wand-4th-rank-spell" },
            type: "consumable",
          },
        ]),
        "pf2e.spells-srd": createMockPack([
          {
            _id: "bb1",
            name: "Blessed Boundary",
            system: { slug: "blessed-boundary", level: { value: 6 } },
            type: "spell",
          },
          { _id: "bl1", name: "Blink", system: { slug: "blink", level: { value: 4 } }, type: "spell" },
        ]),
      });
    });

    // Mirrors the FVTT Witch's magic-scroll-6th-rank-rm: the linked spell engine
    // names the item via sourceData.engineID (= the item's demiplaneEngineId) and
    // carries parentSpellFeature "scroll".
    it("embeds the linked spell on a 6th-rank scroll (parentSpellFeature scroll)", async () => {
      const actor = createMockActor();
      const engines: DemiplaneEngineEntry[] = [
        {
          id: "scroll-eng",
          name: "tabula/item/magic-scroll-6th-rank-rm.eng",
          type: "DemiplaneEngine",
          args: { slug: "magic-scroll-6th-rank-rm" },
          demiplaneEngineId: "scroll-item",
        },
        {
          id: "spell-eng",
          name: "tabula/spell/blessed-boundary-rm.eng",
          type: "DemiplaneEngine",
          args: {
            slug: "blessed-boundary-rm",
            sourceData: { engineID: "scroll-item" },
            parentEngine: "scroll-item",
            selectionRank: 6,
            parentSpellFeature: "scroll",
          },
          demiplaneEngineId: "spell-item",
        },
      ];
      const summary = makeSummary();
      await applyEquipment(actor as never, engines, summary);

      const item = actor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
      const spell = (item.system as Record<string, unknown>).spell as
        { system: { slug: string; location: { heightenedLevel: number } } } | undefined;
      expect(spell?.system.slug).toBe("blessed-boundary");
      expect(spell?.system.location.heightenedLevel).toBe(6);
      // Renamed to the spell it carries, not left as "Scroll of 6th-rank Spell".
      expect(item.name).toBe("Scroll of Blessed Boundary (Rank 6)");
    });

    it("prefers an explicit override name over the generated spell name", async () => {
      const actor = createMockActor();
      const engines: DemiplaneEngineEntry[] = [
        {
          id: "scroll-eng",
          name: "tabula/item/magic-scroll-6th-rank-rm.eng",
          type: "DemiplaneEngine",
          args: { slug: "magic-scroll-6th-rank-rm" },
          demiplaneEngineId: "scroll-item",
        },
        {
          id: "spell-eng",
          name: "tabula/spell/blessed-boundary-rm.eng",
          type: "DemiplaneEngine",
          args: { slug: "blessed-boundary-rm", sourceData: { engineID: "scroll-item" } },
          demiplaneEngineId: "spell-item",
        },
        {
          id: "name-eng",
          name: "scroll-item-override-name",
          type: "CustomDemiplaneEngine",
          args: { parentEngine: "scroll-item" },
          value: "Grandma's Scroll",
        },
      ];
      const summary = makeSummary();
      await applyEquipment(actor as never, engines, summary);

      const item = actor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
      expect(item.name).toBe("Grandma's Scroll");
    });

    // The FVTT Witch's magic-wand-4th-rank-rm had three linked spell engines
    // (blink, blink, bloodspray-curse) all naming the same wand. Changing a wand's
    // held spell leaves the earlier picks orphaned in the save data; Demiplane's
    // runtime honors the last selection, so the last linked spell wins.
    it("keeps the last linked spell when a wand lists several candidates", async () => {
      installFoundryMocks({
        "pf2e.equipment-srd": createMockPack([
          {
            _id: "mw4",
            name: "Magic Wand (4th-Rank Spell)",
            system: { slug: "magic-wand-4th-rank-spell" },
            type: "consumable",
          },
        ]),
        "pf2e.spells-srd": createMockPack([
          { _id: "bl1", name: "Blink", system: { slug: "blink", level: { value: 4 } }, type: "spell" },
          {
            _id: "bc1",
            name: "Bloodspray Curse",
            system: { slug: "bloodspray-curse", level: { value: 4 } },
            type: "spell",
          },
        ]),
      });
      const actor = createMockActor();
      // Mirrors the real char: the item's stream `id` differs from its
      // demiplaneEngineId, and the linked spells name the wand by its
      // demiplaneEngineId via sourceData.engineID.
      const wandItem: DemiplaneEngineEntry = {
        id: "2b6ee40b-stream-id",
        name: "tabula/item/magic-wand-4th-rank-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "magic-wand-4th-rank-rm" },
        demiplaneEngineId: "facc6aa7-item",
      };
      const linkedSpell = (slug: string, dpId: string): DemiplaneEngineEntry => ({
        id: "spell-stream-id",
        name: `tabula/spell/${slug}.eng`,
        type: "DemiplaneEngine",
        args: { slug, sourceData: { engineID: "facc6aa7-item" }, parentSpellFeature: "wand" },
        demiplaneEngineId: dpId,
      });
      const summary = makeSummary();
      await applyEquipment(
        actor as never,
        [wandItem, linkedSpell("blink", "s1"), linkedSpell("blink", "s2"), linkedSpell("bloodspray-curse-rm", "s3")],
        summary
      );

      const item = actor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
      const spell = (item.system as Record<string, unknown>).spell as { system: { slug: string } } | undefined;
      expect(spell?.system.slug).toBe("bloodspray-curse");
      expect(item.name).toBe("Wand of Bloodspray Curse (Rank 4)");
    });

    // Regression: a spell-bearing wand IS recorded as an equipment mapping (so a
    // GM can correct the base item), and the carried-spell attach still runs when
    // that mapping is hit on a later import — so the wand isn't left empty.
    it("re-attaches the carried spell on a second import even after the base wand is mapped", async () => {
      const packs = {
        "pf2e.equipment-srd": createMockPack([
          {
            _id: "mw4",
            name: "Magic Wand (4th-Rank Spell)",
            system: { slug: "magic-wand-4th-rank-spell" },
            type: "consumable",
          },
        ]),
        "pf2e.spells-srd": createMockPack([
          {
            _id: "bc1",
            name: "Bloodspray Curse",
            system: { slug: "bloodspray-curse", level: { value: 4 } },
            type: "spell",
          },
        ]),
      };
      const wandItem: DemiplaneEngineEntry = {
        id: "wand-stream-id",
        name: "tabula/item/magic-wand-4th-rank-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "magic-wand-4th-rank-rm" },
        demiplaneEngineId: "facc6aa7-item",
      };
      const linkedSpell: DemiplaneEngineEntry = {
        id: "spell-stream-id",
        name: "tabula/spell/bloodspray-curse-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "bloodspray-curse-rm", sourceData: { engineID: "facc6aa7-item" }, parentSpellFeature: "wand" },
        demiplaneEngineId: "s1",
      };

      // First import records the base wand as an equipment mapping.
      installFoundryMocks(packs);
      const firstActor = createMockActor();
      await applyEquipment(firstActor as never, [wandItem, linkedSpell], makeSummary());
      expect(getAllMappings("equipment")["magic-wand-4th-rank-rm"]).toEqual({
        uuid: "Compendium.pf2e.equipment-srd.Item.mw4",
        name: "Magic Wand (4th-Rank Spell)",
      });

      // Second import: fresh mocks reset the settings store, so re-seed the
      // mapping the first import recorded to exercise the mapping-hit path. The
      // spell must still be embedded rather than the bare mapped item returned.
      installFoundryMocks(packs);
      await setMapping("equipment", "magic-wand-4th-rank-rm", {
        uuid: "Compendium.pf2e.equipment-srd.Item.mw4",
        name: "Magic Wand (4th-Rank Spell)",
      });
      const secondActor = createMockActor();
      await applyEquipment(secondActor as never, [wandItem, linkedSpell], makeSummary());

      const item = secondActor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
      const spell = (item.system as Record<string, unknown>).spell as { system: { slug: string } } | undefined;
      expect(spell?.system.slug).toBe("bloodspray-curse");
      expect(item.name).toBe("Wand of Bloodspray Curse (Rank 4)");
    });

    // A carried spell whose slug isn't in the compendium must be surfaced as an
    // unmapped spell for the GM, not silently dropped leaving an empty item.
    it("records a carried spell that fails to resolve as an unmapped spell", async () => {
      installFoundryMocks({
        "pf2e.equipment-srd": createMockPack([
          {
            _id: "mw4",
            name: "Magic Wand (4th-Rank Spell)",
            system: { slug: "magic-wand-4th-rank-spell" },
            type: "consumable",
          },
        ]),
        // Deliberately empty: the carried spell has no compendium match.
        "pf2e.spells-srd": createMockPack([]),
      });
      const actor = createMockActor();
      const wandItem: DemiplaneEngineEntry = {
        id: "wand-stream-id",
        name: "tabula/item/magic-wand-4th-rank-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "magic-wand-4th-rank-rm" },
        demiplaneEngineId: "wand-item",
      };
      const linkedSpell: DemiplaneEngineEntry = {
        id: "spell-stream-id",
        name: "tabula/spell/nonexistent-spell.eng",
        type: "DemiplaneEngine",
        args: { slug: "nonexistent-spell", sourceData: { engineID: "wand-item" }, parentSpellFeature: "wand" },
        demiplaneEngineId: "spell1",
      };
      const summary = makeSummary();
      await applyEquipment(actor as never, [wandItem, linkedSpell], summary);

      expect(summary.unmapped).toContainEqual({ slug: "nonexistent-spell", kind: "spell" });
      const item = actor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
      expect((item.system as Record<string, unknown>).spell).toBeUndefined();
    });
  });

  describe("fixed-spell scrolls and wands (add-special-item-spell fallback)", () => {
    beforeEach(() => {
      installFoundryMocks({
        "pf2e.equipment-srd": createMockPack([
          {
            _id: "sc2",
            name: "Scroll of 2nd-rank Spell",
            system: { slug: "scroll-of-2nd-rank-spell" },
            type: "consumable",
          },
          {
            _id: "mw7",
            name: "Magic Wand (7th-Rank Spell)",
            system: { slug: "magic-wand-7th-rank-spell" },
            type: "consumable",
          },
          {
            _id: "ls1",
            name: "Longsword",
            system: { slug: "longsword" },
            type: "weapon",
          },
        ]),
        "pf2e.spells-srd": createMockPack([
          { _id: "gd1", name: "Glitterdust", system: { slug: "glitterdust", level: { value: 2 } }, type: "spell" },
          {
            _id: "hb1",
            name: "Howling Blizzard",
            system: { slug: "howling-blizzard", level: { value: 5 } },
            type: "spell",
          },
        ]),
      });
    });

    function stubStreamEngines(lines: string[]): void {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => lines.join("\n") }));
    }

    function ndjsonLine(engineId: string, payload: Record<string, unknown>): string {
      return JSON.stringify({
        id: engineId,
        data: { nodes: { n1: { name: "StringObject", data: { string: JSON.stringify(payload) } } } },
      });
    }

    afterEach(() => vi.unstubAllGlobals());

    // A named scroll with no dedicated compendium item. Its add-special-item-spell
    // modifier is what lets us stand in the generic ranked consumable.
    const glitterdustScroll: DemiplaneEngineEntry = {
      id: "scroll-eng",
      name: "tabula/item/scroll-of-glitterdust.eng",
      type: "DemiplaneEngine",
      args: { slug: "scroll-of-glitterdust" },
      demiplaneEngineId: "scroll-item",
    };

    it("stands in the generic ranked scroll and embeds the fixed spell at its rank", async () => {
      stubStreamEngines([
        ndjsonLine("scroll-eng", {
          name: "Scroll of Glitterdust",
          engineModifiers: [
            { type: "add-special-item-spell", rank: "2", spell: "glitterdust", itemType: "scroll", freeSpell: false },
          ],
        }),
      ]);

      const actor = createMockActor();
      const summary = makeSummary();
      await applyEquipment(actor as never, [glitterdustScroll], summary);

      expect(summary.unmapped).toEqual([]);
      const item = actor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
      const system = item.system as Record<string, unknown>;
      const spell = system.spell as { system: { slug: string; location: { heightenedLevel: number } } };

      // Titlecased from the slug since the engine args carry no name here.
      expect(item.name).toBe("Scroll Of Glitterdust");
      expect(spell.system.slug).toBe("glitterdust");
      expect(spell.system.location.heightenedLevel).toBe(2);
    });

    it("records the item as unmapped when the generic consumable itself is missing", async () => {
      // The modifier says rank 5, so it looks for magic-wand-5th-rank-spell, which
      // the mock pack doesn't have (only 7th) — so it stays unmapped rather than
      // silently using the wrong-rank generic.
      stubStreamEngines([
        ndjsonLine("wand-eng", {
          name: "Wand of the Snowfields",
          engineModifiers: [
            {
              type: "add-special-item-spell",
              rank: "5",
              spell: "howling-blizzard-rm",
              itemType: "wand",
              freeSpell: false,
            },
          ],
        }),
      ]);

      const actor = createMockActor();
      const summary = makeSummary();
      await applyEquipment(
        actor as never,
        [
          {
            id: "wand-eng",
            name: "tabula/item/wand-of-the-snowfields-5th-rank-rm.eng",
            type: "DemiplaneEngine",
            args: { slug: "wand-of-the-snowfields-5th-rank-rm" },
            demiplaneEngineId: "wand-item",
          },
        ],
        summary
      );

      expect(summary.unmapped).toEqual([{ slug: "wand-of-the-snowfields-5th-rank-rm", kind: "equipment" }]);
    });

    it("uses the modifier rank to pick the generic wand and embeds the spell", async () => {
      stubStreamEngines([
        ndjsonLine("wand-eng", {
          name: "Wand of the Snowfields",
          engineModifiers: [
            {
              type: "add-special-item-spell",
              rank: "7",
              spell: "howling-blizzard-rm",
              itemType: "wand",
              freeSpell: false,
            },
          ],
        }),
      ]);

      const actor = createMockActor();
      const summary = makeSummary();
      await applyEquipment(
        actor as never,
        [
          {
            id: "wand-eng",
            name: "tabula/item/wand-of-the-snowfields-7th-rank-rm.eng",
            type: "DemiplaneEngine",
            args: { slug: "wand-of-the-snowfields-7th-rank-rm", name: "Wand of the Snowfields (7th-Rank)" },
            demiplaneEngineId: "wand-item",
          },
        ],
        summary
      );

      expect(summary.unmapped).toEqual([]);
      const item = actor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
      const spell = (item.system as Record<string, unknown>).spell as {
        system: { slug: string; location: { heightenedLevel: number } };
      };
      // Prefers the engine's display name over the titlecased slug.
      expect(item.name).toBe("Wand of the Snowfields (7th-Rank)");
      expect(spell.system.slug).toBe("howling-blizzard");
      expect(spell.system.location.heightenedLevel).toBe(7);
    });

    it("records a fixed-spell scroll as unmapped when it carries no special-item-spell", async () => {
      // freeSpell holder (no spell) — nothing to stand in with, so it stays unmapped.
      stubStreamEngines([
        ndjsonLine("scroll-eng", {
          name: "Scroll of Glitterdust",
          engineModifiers: [{ type: "add-special-item-spell", rank: "2", itemType: "scroll", freeSpell: true }],
        }),
      ]);

      const actor = createMockActor();
      const summary = makeSummary();
      await applyEquipment(actor as never, [glitterdustScroll], summary);

      expect(summary.unmapped).toEqual([{ slug: "scroll-of-glitterdust", kind: "equipment" }]);
      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("does not fetch stream-engines for non-scroll/wand equipment", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
      vi.stubGlobal("fetch", fetchMock);

      const actor = createMockActor();
      const summary = makeSummary();
      await applyEquipment(
        actor as never,
        [
          {
            id: "sword-eng",
            name: "tabula/item/longsword-rm.eng",
            type: "DemiplaneEngine",
            args: { slug: "longsword-rm" },
            demiplaneEngineId: "sword-item",
          },
        ],
        summary
      );

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("still records unmapped when there is truly no matching item or spell", async () => {
      // A named wand slug with no compendium item and no fixed spell stays
      // unmapped so the GM can build and map an item for it.
      stubStreamEngines([ndjsonLine("wand-eng", { name: "Wand of Nonsense", engineModifiers: [] })]);

      const actor = createMockActor();
      const summary = makeSummary();
      await applyEquipment(
        actor as never,
        [
          {
            id: "wand-eng",
            name: "tabula/item/wand-of-nonsense.eng",
            type: "DemiplaneEngine",
            args: { slug: "wand-of-nonsense" },
            demiplaneEngineId: "wand-item",
          },
        ],
        summary
      );

      expect(summary.unmapped).toEqual([{ slug: "wand-of-nonsense", kind: "equipment" }]);
    });
  });

  describe("named specialty scrolls and wands resolve to their real compendium items", () => {
    beforeEach(() => {
      installFoundryMocks({
        "pf2e.equipment-srd": createMockPack([
          // Most named specialty wands use -Nth-rank-spell...
          {
            _id: "ww9",
            name: "Wand of Widening (9th-Rank Spell)",
            system: { slug: "wand-of-widening-9th-rank-spell" },
            type: "equipment",
          },
          {
            _id: "sw8",
            name: "Wand of Spiritual Warfare (8th-Rank Spell)",
            system: { slug: "wand-of-spiritual-warfare-8th-rank-spell" },
            type: "equipment",
          },
          {
            _id: "sf5",
            name: "Wand of the Snowfields (5th-Rank Spell)",
            system: { slug: "wand-of-the-snowfields-5th-rank-spell" },
            type: "consumable",
          },
          // ...while a few (Legerdemain) use bare -Nth-rank.
          {
            _id: "lg9",
            name: "Wand of Legerdemain (9th-rank)",
            system: { slug: "wand-of-legerdemain-9th-rank" },
            type: "equipment",
          },
        ]),
      });
    });

    async function importNamedWand(slug: string): Promise<{ summary: ImportSummary; name?: string }> {
      const actor = createMockActor();
      const summary = makeSummary();
      await applyEquipment(
        actor as never,
        [
          {
            id: "1",
            name: `tabula/item/${slug}.eng`,
            type: "DemiplaneEngine",
            args: { slug },
            demiplaneEngineId: "eng1",
          },
        ],
        summary
      );
      const call = actor.createEmbeddedDocuments.mock.calls[0];
      const name = call ? ((call[1][0] as Record<string, unknown>).name as string) : undefined;
      return { summary, name };
    }

    it("resolves -9th-rank-rm to the -9th-rank-spell compendium item", async () => {
      const { summary, name } = await importNamedWand("wand-of-widening-9th-rank-rm");
      expect(summary.unmapped).toEqual([]);
      expect(name).toBe("Wand of Widening (9th-Rank Spell)");
    });

    it("resolves -8th-level-spell to the -8th-rank-spell compendium item", async () => {
      const { summary, name } = await importNamedWand("wand-of-spiritual-warfare-8th-level-spell");
      expect(summary.unmapped).toEqual([]);
      expect(name).toBe("Wand of Spiritual Warfare (8th-Rank Spell)");
    });

    it("resolves the Snowfields -level-spell shell to the real -rank-spell item", async () => {
      const { summary, name } = await importNamedWand("wand-of-the-snowfields-5th-level-spell");
      expect(summary.unmapped).toEqual([]);
      expect(name).toBe("Wand of the Snowfields (5th-Rank Spell)");
    });

    it("resolves Legerdemain -level-spell to the bare -rank compendium item", async () => {
      const { summary, name } = await importNamedWand("wand-of-legerdemain-9th-level-spell");
      expect(summary.unmapped).toEqual([]);
      expect(name).toBe("Wand of Legerdemain (9th-rank)");
    });
  });

  describe("item sizing to the actor", () => {
    beforeEach(() => {
      installFoundryMocks({
        "pf2e.equipment-srd": createMockPack([
          { _id: "ls1", name: "Longsword", system: { slug: "longsword", size: "med" }, type: "weapon" },
          { _id: "gp1", name: "Gold Pieces", system: { slug: "gold-pieces", size: "med" }, type: "treasure" },
        ]),
      });
    });

    function setActorSize(actor: ReturnType<typeof createMockActor>, size: string): void {
      (actor.system as Record<string, unknown>).traits = { size: { value: size } };
    }

    const longswordEngine: DemiplaneEngineEntry = {
      id: "1",
      name: "tabula/item/longsword-rm.eng",
      type: "DemiplaneEngine",
      args: { slug: "longsword-rm" },
      demiplaneEngineId: "eng1",
    };

    async function importLongswordOnSized(size: string): Promise<Record<string, unknown>> {
      const actor = createMockActor();
      setActorSize(actor, size);
      await applyEquipment(actor as never, [longswordEngine], makeSummary());
      const item = actor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
      return item.system as Record<string, unknown>;
    }

    it("shrinks a Medium item to a Tiny actor", async () => {
      expect((await importLongswordOnSized("tiny")).size).toBe("tiny");
    });

    it("leaves a Medium item Medium on a Medium actor", async () => {
      expect((await importLongswordOnSized("med")).size).toBe("med");
    });

    it("treats a Small actor as Medium (item stays Medium)", async () => {
      expect((await importLongswordOnSized("sm")).size).toBe("med");
    });

    it("grows a Medium item to a Large actor and clears price size-sensitivity for non-magical items", async () => {
      const system = await importLongswordOnSized("lg");
      expect(system.size).toBe("lg");
      expect((system.price as Record<string, unknown>).sizeSensitive).toBe(false);
    });

    it("defaults to Medium when the actor has no size trait", async () => {
      const actor = createMockActor();
      await applyEquipment(actor as never, [longswordEngine], makeSummary());
      const item = actor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
      expect((item.system as Record<string, unknown>).size).toBe("med");
    });

    it("does not resize treasure to a Tiny actor", async () => {
      const actor = createMockActor();
      setActorSize(actor, "tiny");
      await applyEquipment(
        actor as never,
        [
          {
            id: "2",
            name: "tabula/item/gold-pieces-rm.eng",
            type: "DemiplaneEngine",
            args: { slug: "gold-pieces-rm" },
            demiplaneEngineId: "eng2",
          },
        ],
        makeSummary()
      );
      const item = actor.createEmbeddedDocuments.mock.calls[0][1][0] as Record<string, unknown>;
      expect((item.system as Record<string, unknown>).size).toBe("med");
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

describe("applyCraftingFormulas", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.equipment-srd": createMockPack([
        {
          _id: "aa1",
          name: "Ablative Armor Plating (Lesser)",
          system: { slug: "ablative-armor-plating" },
          type: "equipment",
        },
        { _id: "ls1", name: "Longsword", system: { slug: "longsword" }, type: "weapon" },
      ]),
    });
    registerSlugMappingSettings();
  });

  function makeSummary(): ImportSummary {
    return { itemsImported: 0, itemsSkipped: 0, unmapped: [], errors: [], log: [] };
  }

  function formulaEngine(slug: string, name = ""): DemiplaneEngineEntry {
    return {
      id: `f-${slug}`,
      name: `tabula/item/${slug}.eng`,
      type: "DemiplaneEngine",
      args: { slug, name, sourceRow: "manual-sheet-drawer", metaItemType: "formula" },
      demiplaneEngineId: `eng-${slug}`,
    };
  }

  /** The formulas written by the last actor.update call, if any. */
  function writtenFormulas(actor: ReturnType<typeof createMockActor>): Array<{ uuid: string }> | undefined {
    const call = actor.update.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)["system.crafting.formulas"] !== undefined
    );
    return call
      ? ((call[0] as Record<string, unknown>)["system.crafting.formulas"] as Array<{ uuid: string }>)
      : undefined;
  }

  it("records a resolved formula on system.crafting.formulas and not as an item", async () => {
    const actor = createMockActor();
    const summary = makeSummary();
    // Demiplane sends the base slug; the compendium item is a tiered variant.
    await applyCraftingFormulas(
      actor as never,
      [formulaEngine("ablative-armor-plating", "Ablative Armor Plating")],
      summary
    );

    expect(writtenFormulas(actor)).toEqual([{ uuid: "Compendium.pf2e.equipment-srd.Item.aa1" }]);
    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(summary.log.some((l) => l.includes("formulas: 1"))).toBe(true);
  });

  it("resolves via a GM mapping when one exists", async () => {
    await setMapping("equipment", "custom-formula-rm", {
      uuid: "Compendium.pf2e.equipment-srd.Item.ls1",
      name: "Longsword",
    });
    const actor = createMockActor();
    await applyCraftingFormulas(actor as never, [formulaEngine("custom-formula-rm")], makeSummary());

    expect(writtenFormulas(actor)).toEqual([{ uuid: "Compendium.pf2e.equipment-srd.Item.ls1" }]);
  });

  it("merges with existing formulas, deduping by uuid", async () => {
    const actor = createMockActor();
    (actor.system as Record<string, unknown>).crafting = {
      formulas: [
        { uuid: "Compendium.pf2e.equipment-srd.Item.existing" },
        { uuid: "Compendium.pf2e.equipment-srd.Item.aa1" },
      ],
    };
    await applyCraftingFormulas(actor as never, [formulaEngine("ablative-armor-plating")], makeSummary());

    const written = writtenFormulas(actor);
    // The already-present aa1 isn't duplicated; the pre-existing entry is kept.
    expect(written).toEqual([
      { uuid: "Compendium.pf2e.equipment-srd.Item.existing" },
      { uuid: "Compendium.pf2e.equipment-srd.Item.aa1" },
    ]);
  });

  it("records an unresolvable formula as unmapped equipment and writes nothing", async () => {
    const actor = createMockActor();
    const summary = makeSummary();
    await applyCraftingFormulas(actor as never, [formulaEngine("unknown-formula-rm")], summary);

    expect(summary.unmapped).toEqual([{ slug: "unknown-formula-rm", kind: "equipment" }]);
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("does nothing when there are no formula engines", async () => {
    const actor = createMockActor();
    await applyCraftingFormulas(actor as never, [], makeSummary());
    expect(actor.update).not.toHaveBeenCalled();
  });

  it("is not imported as inventory by applyEquipment", async () => {
    const actor = createMockActor();
    await applyEquipment(actor as never, [formulaEngine("ablative-armor-plating")], makeSummary());
    // A formula engine must never become an inventory item.
    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
  });
});
