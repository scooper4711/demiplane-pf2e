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
      ]),
    });
  });

  function makeSummary(): ImportSummary {
    return {
      itemsImported: 0,
      itemsSkipped: 0,
      unresolved: [],
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
    expect(entries.length).toBe(1);
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
      expect(spellItems.length).toBe(1); // Only one electric arc
    }
  });

  it("does nothing with no spell engines", async () => {
    const actor = createMockActor();
    const summary = makeSummary();
    await applySpells(actor as never, [], summary);
    expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
  });
});
