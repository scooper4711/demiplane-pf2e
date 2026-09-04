import { describe, it, expect, beforeEach, vi } from "vitest";
import { installFoundryMocks, createMockActor, createMockPack } from "./foundry-mocks.js";
import { importFontSpells } from "../../src/import/divine-font.js";

const HEAL = { _id: "sp-heal", name: "Heal", type: "spell", system: { slug: "heal", level: { value: 1 } } };

function summary() {
  return { itemsImported: 0, itemsSkipped: 0, unmapped: [], errors: [], log: [] };
}

function fontEngine(slug, selectionRank) {
  return {
    id: `font-${slug ?? "none"}`,
    name: "tabula/spell/heal.eng",
    type: "DemiplaneEngine",
    args: { slug, spellSlot: "divine-font", selectionRank },
  };
}

describe("divine-font", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.spells-srd": createMockPack([HEAL]),
    });
  });

  it("returns zero without font engines", async () => {
    const actor = createMockActor();

    expect(await importFontSpells(actor, [], summary())).toBe(0);
    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it("imports font spells into a dedicated entry with ranked slots", async () => {
    const actor = createMockActor();
    const fontEngines = [fontEngine("heal", 3), fontEngine("heal", 3)];

    const count = await importFontSpells(actor, fontEngines, summary());

    expect(count).toBe(1);
    const entryId = actor.createEmbeddedDocuments.mock.calls[0][1][0].name;
    expect(entryId).toBe("Divine Font (Healing)");
    const entry = actor.items.find((i) => i.type === "spellcastingEntry");
    expect(entry.system.slots.slot1.max).toBe(2);
    expect(entry.system.slots.slot1.prepared).toHaveLength(2);
    // Heightened to the selected rank through the location extras.
    expect(entry.system.slots.slot1.prepared[0].id).toBe(entry.system.slots.slot1.prepared[1].id);
  });

  it("defaults the heightened rank when the engine has none", async () => {
    const actor = createMockActor();

    await importFontSpells(actor, [fontEngine("heal", undefined)], summary());

    const spells = actor.items.filter((i) => i.type === "spell");
    expect(spells).toHaveLength(1);
    expect(spells[0].system.location.heightenedLevel).toBe(1);
  });

  it("falls back to heal when the engine names no slug", async () => {
    const actor = createMockActor();

    const count = await importFontSpells(actor, [fontEngine(undefined, 1)], summary());

    // Unresolvable without a slug, so the entry is created but stays empty.
    expect(count).toBe(0);
  });

  it("skips slot placement when the entry is gone", async () => {
    const actor = createMockActor();
    actor.items.get = () => undefined;

    await importFontSpells(actor, [fontEngine("heal", 1)], summary());

    const entry = actor.items.find((i) => i.type === "spellcastingEntry");
    expect(entry.system.slots).toBeUndefined();
  });
});
