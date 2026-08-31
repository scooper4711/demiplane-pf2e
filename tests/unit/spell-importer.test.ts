import { describe, it, expect, beforeEach } from "vitest";
import { installFoundryMocks, createMockActor, createMockPack } from "./foundry-mocks.js";
import { applySpells } from "../../src/import/spell-importer.js";
import type { DemiplaneEngineEntry, ImportSummary } from "../../src/import/types.js";

describe("applySpells", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.spells-srd": createMockPack([
        {
          _id: "sp1",
          name: "Electric Arc",
          system: { slug: "electric-arc" },
          type: "spell",
        },
        {
          _id: "sp2",
          name: "Fireball",
          system: { slug: "fireball" },
          type: "spell",
        },
        {
          _id: "sp3",
          name: "Shield",
          system: { slug: "shield" },
          type: "spell",
        },
        { _id: "sp4", name: "Heal", system: { slug: "heal" }, type: "spell" },
        { _id: "sp5", name: "Daze", system: { slug: "daze" }, type: "spell" },
        { _id: "sp6", name: "Divine Lance", system: { slug: "divine-lance" }, type: "spell" },
        { _id: "sp7", name: "Guidance", system: { slug: "guidance" }, type: "spell" },
        { _id: "sp8", name: "Light", system: { slug: "light" }, type: "spell" },
        { _id: "sp9", name: "Stabilize", system: { slug: "stabilize" }, type: "spell" },
        { _id: "sp10", name: "Bless", system: { slug: "bless" }, type: "spell" },
        { _id: "sp11", name: "Sanctuary", system: { slug: "sanctuary" }, type: "spell" },
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

  function makeSpellEngine(slug: string, rank: number, source: string): DemiplaneEngineEntry {
    return {
      id: slug,
      name: `tabula/spell/${slug}.eng`,
      type: "DemiplaneEngine",
      args: {
        slug,
        selectionRank: rank,
        sourceRow: `builder-spell-section--${source}--${rank}`,
        parentSpellFeature: source,
        builderSection: "spells",
      },
    };
  }

  it("creates spellcasting entry for sorcerer", async () => {
    const actor = createMockActor();
    const engines = [
      makeSpellEngine("electric-arc-rm", 0, "sorcerer-spellcasting-rm"),
      makeSpellEngine("fireball-rm", 3, "sorcerer-spellcasting-rm"),
    ];
    const summary = makeSummary();
    await applySpells(actor as never, engines, summary);

    // Should create a spellcastingEntry + spells
    expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    const firstCall = actor.createEmbeddedDocuments.mock.calls[0];
    expect((firstCall[1][0] as Record<string, unknown>).type).toBe("spellcastingEntry");
    expect(summary.log.some((l) => l.includes("spells"))).toBe(true);
  });

  it("creates innate entry for feat-granted spells", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "tabula/spell/heal-rm.eng",
        type: "DemiplaneEngine",
        args: {
          slug: "heal-rm",
          sourceRow: "uuid_select-spell-adapted-cantrip-rm-id",
          sourceType: "select-spell",
        },
      },
    ];
    const summary = makeSummary();
    await applySpells(actor as never, engines, summary);

    const entries = actor.createEmbeddedDocuments.mock.calls.filter(
      (c: unknown[]) => (c[1] as Array<Record<string, unknown>>)[0].type === "spellcastingEntry"
    );
    expect(entries).toHaveLength(1);
    const entryData = (entries[0][1] as Array<Record<string, unknown>>)[0];
    expect((entryData.system as Record<string, Record<string, unknown>>).prepared.value).toBe("innate");
  });

  it("skips scroll-sourced spells", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "tabula/spell/fireball-rm.eng",
        type: "DemiplaneEngine",
        args: {
          slug: "fireball-rm",
          parentSpellFeature: "scroll",
          sourceRow: "manual-sheet-drawer",
        },
      },
    ];
    const summary = makeSummary();
    await applySpells(actor as never, engines, summary);

    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it("deduplicates spells by slug", async () => {
    const actor = createMockActor();
    const engines = [
      makeSpellEngine("electric-arc-rm", 0, "sorcerer-spellcasting-rm"),
      makeSpellEngine("electric-arc-rm", 0, "sorcerer-spellcasting-rm"), // duplicate
    ];
    const summary = makeSummary();
    await applySpells(actor as never, engines, summary);

    // Count spell items created (exclude spellcastingEntry)
    const spellCalls = actor.createEmbeddedDocuments.mock.calls.filter((c: unknown[]) => {
      const items = c[1] as Array<Record<string, unknown>>;
      return items.some((i) => i.type !== "spellcastingEntry");
    });
    if (spellCalls.length > 0) {
      const spellItems = (spellCalls[0][1] as Array<Record<string, unknown>>).filter(
        (i) => i.type !== "spellcastingEntry"
      );
      expect(spellItems).toHaveLength(1); // Only one electric arc
    }
  });

  it("does nothing with no spell engines", async () => {
    const actor = createMockActor();
    const summary = makeSummary();
    await applySpells(actor as never, [], summary);
    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
  });

  function makeClericSpell(slug: string, rank: number, spellSlot: string): DemiplaneEngineEntry {
    return {
      id: slug,
      name: `tabula/spell/${slug}.eng`,
      type: "DemiplaneEngine",
      args: {
        slug,
        isPrepare: true,
        selectionRank: rank,
        parentSpellFeature: "cleric-spellcasting-rm",
        spellSlot,
      },
    };
  }

  it("prepares cleric spells (isPrepare only, no spellbook)", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      makeClericSpell("daze-rm", 0, "cantrip"),
      makeClericSpell("divine-lance-rm", 0, "cantrip"),
      makeClericSpell("guidance-rm", 0, "cantrip"),
      makeClericSpell("light-rm", 0, "cantrip"),
      makeClericSpell("stabilize-rm", 0, "cantrip"),
      makeClericSpell("bless-rm", 1, "rank-1"),
      makeClericSpell("sanctuary-rm", 1, "rank-1"),
    ];
    const summary = makeSummary();
    await applySpells(actor as never, engines, summary);

    const entry = (actor.items as unknown as Array<Record<string, unknown>>).find(
      (i) => i.type === "spellcastingEntry" && i.name === "Divine Prepared Spells"
    );
    expect(entry).toBeDefined();

    const slots = (entry!.system as Record<string, Record<string, { prepared: Array<{ id: string | null }> }>>).slots;
    expect(slots.slot0.prepared).toHaveLength(5);
    expect(slots.slot1.prepared).toHaveLength(2);

    const allIds = [...slots.slot0.prepared, ...slots.slot1.prepared].map((p) => p.id);
    expect(allIds.every((id) => id !== null)).toBe(true);

    // Spells should also exist as items in the actor
    const spellItems = (actor.items as unknown as Array<Record<string, unknown>>).filter((i) => i.type === "spell");
    expect(spellItems).toHaveLength(7);
  });

  it("creates Divine Font entry with heal x4", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = Array.from({ length: 4 }, () =>
      makeClericSpell("heal-rm", 1, "divine-font")
    );
    const summary = makeSummary();
    await applySpells(actor as never, engines, summary);

    const entry = (actor.items as unknown as Array<Record<string, unknown>>).find(
      (i) => i.type === "spellcastingEntry" && i.name === "Divine Font (Healing)"
    );
    expect(entry).toBeDefined();
    expect(((entry!.system as Record<string, Record<string, string>>).prepared as Record<string, string>).value).toBe(
      "spontaneous"
    );

    const slots = (entry!.system as Record<string, Record<string, { prepared: Array<{ id: string | null }> }>>).slots;
    expect(slots.slot1.prepared).toHaveLength(4);
    const healIds = slots.slot1.prepared.map((p) => p.id);
    expect(healIds.every((id) => id !== null)).toBe(true);
    expect(new Set(healIds).size).toBe(1); // single Heal item referenced 4x

    const healItem = (
      actor.items as unknown as Array<Record<string, { location: { heightenedLevel: number; signature: boolean } }>>
    ).find((i) => i.type === "spell" && (i.system as Record<string, unknown>).slug === "heal");
    expect(healItem).toBeDefined();
    expect(healItem!.system.location.heightenedLevel).toBe(1);
    expect(healItem!.system.location.signature).toBe(true);
  });
});
