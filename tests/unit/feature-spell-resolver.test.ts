import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFoundryMocks, createMockActor, createMockPack } from "./foundry-mocks.js";
import { resolveFeatureGrantedSpells, applyFeatureGrantedSpells } from "../../src/import/feature-spell-resolver.js";
import type { DemiplaneEngineEntry, ImportSummary } from "../../src/import/types.js";

function featureEngine(name: string, id = "feat-1"): DemiplaneEngineEntry {
  return { id, name, type: "DemiplaneEngine", args: { slug: "x" } } as DemiplaneEngineEntry;
}

function domainEngine(slug: string, displayName: string, id: string): DemiplaneEngineEntry {
  return {
    id,
    name: `tabula/domain/${slug}.eng`,
    type: "DemiplaneEngine",
    args: { name: displayName },
  } as DemiplaneEngineEntry;
}

function levelEngine(level: number): DemiplaneEngineEntry {
  return { name: "character_level", type: "CustomDemiplaneEngine", value: level } as DemiplaneEngineEntry;
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

/** NDJSON line for a domain engine declaring its domain / advanced domain spells. */
function domainNdjsonLine(engineId: string, spells: Record<string, unknown>): string {
  return JSON.stringify({
    id: engineId,
    data: {
      nodes: {
        n1: { name: "StringObject", data: { string: JSON.stringify(spells) } },
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

/** Fire Ray is rank 1; Flame Barrier is the rank-4 advanced domain spell. */
const FIRE_DOMAIN_SPELLS = [
  { _id: "s1", name: "Fire Ray", system: { slug: "fire-ray", level: { value: 1 } } },
  { _id: "s2", name: "Flame Barrier", system: { slug: "flame-barrier", level: { value: 4 } } },
];

const FIRE_DOMAIN = { name: "Fire", domainSpell: "fire-ray-rm", advancedSpell: "flame-barrier-rm" };

/** A level-1 cleric's class entry: cantrips plus a single rank-1 slot. */
function clericEntryWithSlots(rank: number) {
  return {
    type: "spellcastingEntry",
    name: "Divine Prepared Spells",
    system: { slots: { slot0: { max: 5, value: 5 }, [`slot${rank}`]: { max: 1, value: 1 } } },
  };
}

function emptySummary(): ImportSummary {
  return { itemsImported: 0, itemsSkipped: 0, unmapped: [], errors: [], log: [] };
}

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
      5,
      3
    );
    expect(result).toEqual({ innate: [], focus: [] });
  });

  it("categorizes innate vs focus spells", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          [ndjsonLine("feat-1", [ADD_SPELL("mage-hand-rm", 1, { isInnate: true }), ADD_SPELL("shield-rm", 1)])].join(
            "\n"
          ),
      })
    );

    const result = await resolveFeatureGrantedSpells(
      [featureEngine("tabula/class-feature/wizard-rm.eng", "feat-1")],
      5,
      3
    );

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

    const result = await resolveFeatureGrantedSpells([featureEngine("tabula/heritage/dwarf-rm.eng", "feat-1")], 3, 3);

    expect(result.focus).toHaveLength(1);
    expect(result.focus[0].slug).toBe("ray-of-frost-rm");
  });

  it("returns empty modifiers on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, text: async () => "" }));
    const result = await resolveFeatureGrantedSpells(
      [featureEngine("tabula/class-feature/wizard-rm.eng", "feat-1")],
      5,
      3
    );
    expect(result).toEqual({ innate: [], focus: [] });
  });

  describe("add-feat grant expansion", () => {
    /**
     * A heritage grants a feat via `add-feat`; that feat grants innate spells.
     * The granted feat is not in `engines` — it is reached by resolving the feat
     * slug to its engine id through the cached engine ids, then reading that
     * feat definition's `add-spell` modifiers. This is the Empty Sky Kitsune →
     * Kitsune Spell Familiarity → Daze / Forbidding Ward chain.
     */
    function requestAwareFetch() {
      const featEngineName = "tabula/feat/kitsune-spell-familiarity.eng";
      return vi.fn().mockImplementation((_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { engineIdsBySource: Record<string, string[]> };
        const ids = body.engineIdsBySource["pathfinder2e-v2"] ?? [];

        // Call 1: the heritage feature engine → add-feat grant.
        if (ids.includes("her-1")) {
          return Promise.resolve({
            ok: true,
            text: async () => ndjsonLine("her-1", [{ type: "add-feat", addFeat: "kitsune-spell-familiarity" }]),
          });
        }
        // Call 2: cache-index resolution → map feat slug to its engine id.
        if (ids.includes("c50dedbd")) {
          return Promise.resolve({
            ok: true,
            text: async () =>
              JSON.stringify({
                id: "c50dedbd",
                engineName: featEngineName,
                data: {
                  nodes: {
                    n1: {
                      name: "StringObject",
                      data: {
                        string: JSON.stringify({
                          engineModifiers: [
                            ADD_SPELL("daze", 1, { isInnate: true, tradition: "divine" }),
                            ADD_SPELL("forbidding-ward", 1, { isInnate: true, tradition: "divine" }),
                          ],
                        }),
                      },
                    },
                  },
                },
              }),
          });
        }
        return Promise.resolve({ ok: true, text: async () => "" });
      });
    }

    it("expands a heritage-granted feat into its innate spells", async () => {
      vi.stubGlobal("fetch", requestAwareFetch());

      const result = await resolveFeatureGrantedSpells(
        [featureEngine("tabula/heritage/empty-sky-kitsune.eng", "her-1")],
        2,
        1,
        ["c50dedbd"]
      );

      expect(result.innate.map((s) => s.slug).sort()).toEqual(["daze", "forbidding-ward"]);
      expect(result.innate.every((s) => s.isInnate && s.tradition === "divine")).toBe(true);
    });

    it("does not expand granted feats when no cache ids are provided", async () => {
      vi.stubGlobal("fetch", requestAwareFetch());

      const result = await resolveFeatureGrantedSpells(
        [featureEngine("tabula/heritage/empty-sky-kitsune.eng", "her-1")],
        2,
        1
      );

      expect(result.innate).toEqual([]);
      expect(result.focus).toEqual([]);
    });
  });

  describe("domain focus spells", () => {
    beforeEach(() => {
      installFoundryMocks({ "pf2e.spells-srd": createMockPack(FIRE_DOMAIN_SPELLS) });
    });

    it("excludes the advanced domain spell above the character's max rank", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: async () => domainNdjsonLine("dom-1", FIRE_DOMAIN),
        })
      );

      const result = await resolveFeatureGrantedSpells([domainEngine("fire-rm", "Fire", "dom-1")], 1, 1);

      expect(result.focus.map((f) => f.slug)).toEqual(["fire-ray-rm"]);
      expect(result.focus.every((f) => f.isFocus && f.tradition === "divine")).toBe(true);
    });

    it("includes the advanced domain spell once that rank is accessible", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: async () => domainNdjsonLine("dom-1", FIRE_DOMAIN),
        })
      );

      const result = await resolveFeatureGrantedSpells([domainEngine("fire-rm", "Fire", "dom-1")], 8, 4);

      expect(result.focus.map((f) => f.slug).sort()).toEqual(["fire-ray-rm", "flame-barrier-rm"]);
    });

    it("collects the accessible spell from every domain", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: async () =>
            [
              domainNdjsonLine("dom-1", { name: "Fire", domainSpell: "fire-ray-rm" }),
              domainNdjsonLine("dom-2", { name: "Sun", domainSpell: "sun-blade-rm" }),
            ].join("\n"),
        })
      );
      installFoundryMocks({
        "pf2e.spells-srd": createMockPack([
          ...FIRE_DOMAIN_SPELLS,
          { _id: "s3", name: "Sun Blade", system: { slug: "sun-blade", level: { value: 1 } } },
        ]),
      });

      const result = await resolveFeatureGrantedSpells(
        [domainEngine("fire-rm", "Fire", "dom-1"), domainEngine("sun-rm", "Sun", "dom-2")],
        1,
        1
      );

      expect(result.focus.map((f) => f.slug).sort()).toEqual(["fire-ray-rm", "sun-blade-rm"]);
    });
  });

  describe("applyFeatureGrantedSpells", () => {
    it("adds innate and focus spells without writing the focus pool", async () => {
      installFoundryMocks({
        "pf2e.spells-srd": createMockPack([
          { _id: "s1", name: "Mage Hand", system: { slug: "mage-hand", level: { value: 1 } } },
          { _id: "s2", name: "Shield", system: { slug: "shield", level: { value: 1 } } },
        ]),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: async () =>
            [ndjsonLine("feat-1", [ADD_SPELL("mage-hand-rm", 1, { isInnate: true }), ADD_SPELL("shield-rm", 1)])].join(
              "\n"
            ),
        })
      );

      const actor = createMockActor();
      const summary = emptySummary();

      await applyFeatureGrantedSpells(
        actor as never,
        [featureEngine("tabula/class-feature/wizard-rm.eng", "feat-1")],
        summary
      );

      // The PF2e system derives the focus pool from the entry's spell count,
      // so the importer must not touch the actor's focus resources.
      expect(actor.update).not.toHaveBeenCalled();
      expect(summary.log.some((l) => l.includes("focus pool"))).toBe(false);
    });

    it("derives the max rank from the class slots already imported onto the actor", async () => {
      installFoundryMocks({ "pf2e.spells-srd": createMockPack(FIRE_DOMAIN_SPELLS) });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: async () => domainNdjsonLine("dom-1", FIRE_DOMAIN),
        })
      );

      const actor = createMockActor({ items: [clericEntryWithSlots(1)] });
      const summary = emptySummary();

      await applyFeatureGrantedSpells(
        actor as never,
        [levelEngine(1), domainEngine("fire-rm", "Fire", "dom-1")],
        summary
      );

      const created = (actor.createEmbeddedDocuments as ReturnType<typeof vi.fn>).mock.calls.flatMap(
        (c) => c[1] as Array<Record<string, unknown>>
      );
      const names = created.map((i) => i.name);

      expect(names).toContain("Fire Domain Spells");
      expect(names).toContain("Fire Ray");
      expect(names).not.toContain("Flame Barrier");
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
      const summary = emptySummary();

      await applyFeatureGrantedSpells(
        actor as never,
        [featureEngine("tabula/class-feature/wizard-rm.eng", "feat-1")],
        summary
      );

      expect(summary.unmapped.length).toBeGreaterThan(0);
    });

    it("names the focus entry after a wizard school engine", async () => {
      installFoundryMocks({
        "pf2e.spells-srd": createMockPack([
          { _id: "s2", name: "Shield", system: { slug: "shield", level: { value: 1 } } },
        ]),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          text: async () => [ndjsonLine("feat-1", [ADD_SPELL("shield-rm", 1)])].join("\n"),
        })
      );

      const actor = createMockActor();
      const summary = emptySummary();
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
});
