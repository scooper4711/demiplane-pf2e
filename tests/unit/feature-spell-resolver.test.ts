import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFoundryMocks, createMockActor, createMockPack } from "./foundry-mocks.js";
import { resolveFeatureGrantedSpells, applyFeatureGrantedSpells } from "../../src/import/feature-spell-resolver.js";
import type { DemiplaneEngineEntry, ImportSummary } from "../../src/import/types.js";

function featureEngine(name: string, id = "feat-1"): DemiplaneEngineEntry {
  return { id, name, type: "DemiplaneEngine", args: { slug: "x" } } as DemiplaneEngineEntry;
}

function ndjsonLine(engineId: string, modifiers: unknown[]): string {
  return JSON.stringify({
    id: engineId,
    data: {
      nodes: {
        n1: { name: "StringObject", data: { string: JSON.stringify({ engineModifiers: modifiers }) } },
      },
    },
  });
}

const ADD_SPELL = (slug: string, level: number, opts: Record<string, unknown> = {}) => ({
  type: "add-spell",
  level,
  addSpell: slug,
  tradition: "arcane",
  ...opts,
});
const ADD_FOCUS = (n: number) => ({ type: "add-focus-point", addFocus: n });

describe("feature-spell-resolver", () => {
  beforeEach(() => {
    installFoundryMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty result when there are no feature engines", async () => {
    const result = await resolveFeatureGrantedSpells(
      [{ id: "x", name: "tabula/feat/foo.eng", type: "DemiplaneEngine", args: {} } as DemiplaneEngineEntry],
      5
    );
    expect(result).toEqual({ innate: [], focus: [], focusPoints: 0 });
  });

  it("fetches and categorizes innate vs focus spells and focus points", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          [
            ndjsonLine("feat-1", [
              ADD_SPELL("mage-hand-rm", 1, { isInnate: true }),
              ADD_SPELL("shield-rm", 1),
              ADD_FOCUS(1),
            ]),
          ].join("\n"),
      })
    );

    const result = await resolveFeatureGrantedSpells(
      [featureEngine("tabula/class-feature/wizard-rm.eng", "feat-1")],
      5
    );

    expect(result.focusPoints).toBe(1);
    expect(result.innate).toHaveLength(1);
    expect(result.innate[0].slug).toBe("mage-hand-rm");
    expect(result.innate[0].isInnate).toBe(true);
    expect(result.focus).toHaveLength(1);
    expect(result.focus[0].slug).toBe("shield-rm");
    expect(result.focus[0].isFocus).toBe(true);
  });

  it("drops spells above the character level", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          [ndjsonLine("feat-1", [ADD_SPELL("fireball-rm", 9), ADD_SPELL("ray-of-frost-rm", 1)])].join("\n"),
      })
    );

    const result = await resolveFeatureGrantedSpells([featureEngine("tabula/heritage/dwarf-rm.eng", "feat-1")], 3);

    expect(result.focus).toHaveLength(1);
    expect(result.focus[0].slug).toBe("ray-of-frost-rm");
  });

  it("returns empty modifiers on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, text: async () => "" }));
    const result = await resolveFeatureGrantedSpells(
      [featureEngine("tabula/class-feature/wizard-rm.eng", "feat-1")],
      5
    );
    expect(result).toEqual({ innate: [], focus: [], focusPoints: 0 });
  });

  it("applies innate and focus spells to the actor and sets the focus pool", async () => {
    installFoundryMocks({
      "pf2e.spells-srd": createMockPack([
        { _id: "s1", name: "Mage Hand", system: { slug: "mage-hand" } },
        { _id: "s2", name: "Shield", system: { slug: "shield" } },
      ]),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          [
            ndjsonLine("feat-1", [
              ADD_SPELL("mage-hand-rm", 1, { isInnate: true }),
              ADD_SPELL("shield-rm", 1),
              ADD_FOCUS(2),
            ]),
          ].join("\n"),
      })
    );

    const actor = createMockActor();
    const summary: ImportSummary = { itemsImported: 0, itemsSkipped: 0, unresolved: [], errors: [], log: [] };

    await applyFeatureGrantedSpells(
      actor as never,
      [featureEngine("tabula/class-feature/wizard-rm.eng", "feat-1")],
      summary
    );

    // 3 createEmbeddedDocuments calls: innate entry, focus entry, then the spells batch.
    expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    expect(actor.update).toHaveBeenCalledWith(
      expect.objectContaining({ "system.resources.focus.max": 2, "system.resources.focus.value": 2 })
    );
    expect(summary.log.some((l) => l.includes("focus pool"))).toBe(true);
  });

  it("reports unresolved spells not present in the compendium", async () => {
    installFoundryMocks({ "pf2e.spells-srd": createMockPack([]) });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => [ndjsonLine("feat-1", [ADD_SPELL("nonexistent-rm", 1)])].join("\n"),
      })
    );

    const actor = createMockActor();
    const summary: ImportSummary = { itemsImported: 0, itemsSkipped: 0, unresolved: [], errors: [], log: [] };

    await applyFeatureGrantedSpells(
      actor as never,
      [featureEngine("tabula/class-feature/wizard-rm.eng", "feat-1")],
      summary
    );

    expect(summary.unresolved.length).toBeGreaterThan(0);
  });

  it("names the focus entry after a wizard school engine", async () => {
    installFoundryMocks({
      "pf2e.spells-srd": createMockPack([{ _id: "s2", name: "Shield", system: { slug: "shield" } }]),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => [ndjsonLine("feat-1", [ADD_SPELL("shield-rm", 1)])].join("\n"),
      })
    );

    const actor = createMockActor();
    const summary: ImportSummary = { itemsImported: 0, itemsSkipped: 0, unresolved: [], errors: [], log: [] };
    const engines = [
      featureEngine("tabula/class-feature/wizard-rm.eng", "feat-1"),
      {
        id: "school",
        name: "tabula/class-feature/school-of-evocation-rm.eng",
        type: "DemiplaneEngine",
        args: { name: "School of Evocation" },
      } as DemiplaneEngineEntry,
    ];

    await applyFeatureGrantedSpells(actor as never, engines, summary);

    const entries = (actor.createEmbeddedDocuments as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1] as Array<Record<string, unknown>>
    );
    const entryNames = entries.flat().map((i) => i.name);
    expect(entryNames.some((n) => n === "Evocation Focus Spells")).toBe(true);
  });
});
