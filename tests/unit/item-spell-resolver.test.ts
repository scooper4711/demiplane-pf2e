import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFoundryMocks, createMockActor, createMockPack } from "./foundry-mocks.js";
import { applyItemSpells } from "../../src/import/item-spell-resolver.js";
import type { DemiplaneEngineEntry, ImportSummary } from "../../src/import/types.js";

function itemEngine(name: string, slug: string, id = "item-1"): DemiplaneEngineEntry {
  return { id, name, type: "DemiplaneEngine", args: { slug } } as DemiplaneEngineEntry;
}

function ndjsonLine(engineId: string, stringPayload: Record<string, unknown>): string {
  return JSON.stringify({
    id: engineId,
    data: { nodes: { n1: { name: "StringObject", data: { string: JSON.stringify(stringPayload) } } } },
  });
}

const STAFF_PAYLOAD = {
  name: "Staff of Power",
  engineModifiers: [{ type: "add-staff-spells", spells: [{ rank: 1, spell: "mage-hand-rm" }] }],
};
const WAND_PAYLOAD = {
  name: "Wand of Healing",
  engineModifiers: [{ type: "add-special-item-spell", rank: 2, spell: "heal-rm", itemType: "wand" }],
};

describe("item-spell-resolver", () => {
  beforeEach(() => installFoundryMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("does nothing when there are no spellcasting items", async () => {
    const actor = createMockActor();
    const summary: ImportSummary = { itemsImported: 0, itemsSkipped: 0, unmapped: [], errors: [], log: [] };
    await applyItemSpells(actor as never, [itemEngine("tabula/item/sword-rm.eng", "sword-rm")], summary);
    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it("creates a spellcasting entry and adds staff spells", async () => {
    installFoundryMocks({
      "pf2e.spells-srd": createMockPack([{ _id: "s1", name: "Mage Hand", system: { slug: "mage-hand" } }]),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => [ndjsonLine("item-1", STAFF_PAYLOAD)].join("\n") })
    );

    const actor = createMockActor();
    const summary: ImportSummary = { itemsImported: 0, itemsSkipped: 0, unmapped: [], errors: [], log: [] };

    await applyItemSpells(
      actor as never,
      [itemEngine("tabula/item/staff-of-power-rm.eng", "staff-of-power-rm", "item-1")],
      summary
    );

    expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    const entryCall = (actor.createEmbeddedDocuments as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[1] as Array<Record<string, unknown>>)[0]?.type === "spellcastingEntry"
    );
    expect(entryCall).toBeDefined();
    expect((entryCall![1] as Array<Record<string, unknown>>)[0].name).toBe("Staff of Power");
  });

  it("adds wand spells and resolves compendium slugs", async () => {
    installFoundryMocks({ "pf2e.spells-srd": createMockPack([{ _id: "h1", name: "Heal", system: { slug: "heal" } }]) });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => [ndjsonLine("item-1", WAND_PAYLOAD)].join("\n") })
    );

    const actor = createMockActor();
    const summary: ImportSummary = { itemsImported: 0, itemsSkipped: 0, unmapped: [], errors: [], log: [] };

    await applyItemSpells(
      actor as never,
      [itemEngine("tabula/item/wand-of-healing-rm.eng", "wand-of-healing-rm", "item-1")],
      summary
    );

    const calls = (actor.createEmbeddedDocuments as ReturnType<typeof vi.fn>).mock.calls;
    const spellCall = calls.find(
      (c) =>
        (c[1] as Array<Record<string, unknown>>)[0]?.type === "spell" ||
        (c[1] as Array<Record<string, unknown>>)[0]?.system?.location
    );
    expect(spellCall).toBeDefined();
  });

  it("ignores a rank-only modifier that carries no spell", async () => {
    installFoundryMocks();
    // Generic scrolls/wands emit rank + itemType only; the spell lives in a
    // linked engine, so there is nothing to resolve here.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          [
            ndjsonLine("item-1", {
              name: "Wand of Mending",
              engineModifiers: [{ type: "add-special-item-spell", rank: 1, itemType: "wand", freeSpell: true }],
            }),
          ].join("\n"),
      })
    );

    const actor = createMockActor();
    const summary: ImportSummary = { itemsImported: 0, itemsSkipped: 0, unmapped: [], errors: [], log: [] };

    await expect(
      applyItemSpells(
        actor as never,
        [itemEngine("tabula/item/wand-of-mending-rm.eng", "wand-of-mending-rm", "item-1")],
        summary
      )
    ).resolves.toBeUndefined();

    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it("leaves generic ranked scrolls and wands to the equipment importer", async () => {
    installFoundryMocks();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchSpy);

    const actor = createMockActor();
    const summary: ImportSummary = { itemsImported: 0, itemsSkipped: 0, unmapped: [], errors: [], log: [] };

    await applyItemSpells(
      actor as never,
      [
        itemEngine("tabula/item/magic-scroll-2nd-rank-rm.eng", "magic-scroll-2nd-rank-rm", "item-1"),
        itemEngine("tabula/item/magic-wand-1st-rank-rm.eng", "magic-wand-1st-rank-rm", "item-2"),
      ],
      summary
    );

    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("derives the tradition from the parent spell feature", async () => {
    installFoundryMocks({
      "pf2e.spells-srd": createMockPack([{ _id: "s1", name: "Mage Hand", system: { slug: "mage-hand" } }]),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => [ndjsonLine("item-1", STAFF_PAYLOAD)].join("\n") })
    );

    const actor = createMockActor();
    const summary: ImportSummary = { itemsImported: 0, itemsSkipped: 0, unmapped: [], errors: [], log: [] };
    const engines = [
      itemEngine("tabula/item/staff-of-power-rm.eng", "staff-of-power-rm", "item-1"),
      {
        id: "sp",
        name: "tabula/spell/cleric-spell-rm.eng",
        type: "DemiplaneEngine",
        args: { parentSpellFeature: "cleric-spellcasting-rm" },
      } as DemiplaneEngineEntry,
    ];

    await applyItemSpells(actor as never, engines, summary);

    const entryCall = (actor.createEmbeddedDocuments as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[1] as Array<Record<string, unknown>>)[0]?.type === "spellcastingEntry"
    );
    const entry = (entryCall![1] as Array<Record<string, unknown>>)[0];
    expect((entry.system as Record<string, Record<string, string>>).tradition.value).toBe("divine");
  });
});
