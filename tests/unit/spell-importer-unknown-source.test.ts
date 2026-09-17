import { describe, it, expect } from "vitest";
import { createMockActor } from "./foundry-mocks.js";
import { applySpells } from "../../src/import/spell-importer.js";
import type { DemiplaneEngineEntry, ImportSummary } from "../../src/import/types.js";

describe("applySpells - unknown spellcasting source", () => {
  function makeSummary(): ImportSummary {
    return { itemsImported: 0, itemsSkipped: 0, unmapped: [], unresolvedChoices: [], errors: [], log: [] };
  }

  it("flags spells from an unrecognized feature as a sync error instead of dropping them", async () => {
    // A future Demiplane feature (e.g. a technomancer dedication) granting
    // spells through its own parentSpellFeature must be loud, not silent.
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "mystic-armor-engine",
        name: "tabula/spell/mystic-armor-rm.eng",
        type: "DemiplaneEngine",
        args: {
          slug: "mystic-armor-rm",
          selectionRank: 1,
          spellSlot: "rank-1",
          sourceRow: "builder-spell-section--spell-technomancer-spellcasting--1",
          parentSpellFeature: "spell-technomancer-spellcasting",
        },
      },
    ];
    const summary = makeSummary();
    await applySpells(actor, engines, summary);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("spell-technomancer-spellcasting");
    expect(summary.errors[0]).toContain("mystic-armor");
  });
});
