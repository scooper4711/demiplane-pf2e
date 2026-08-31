import { describe, it, expect, beforeEach, vi } from "vitest";
import { installFoundryMocks, createMockActor, createMockPack } from "./foundry-mocks.js";
import { applySpells } from "../../src/import/spell-importer.js";
import type { DemiplaneEngineEntry, ImportSummary } from "../../src/import/types.js";

describe("applySpells - curriculum separation", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.spells-srd": createMockPack([
        { _id: "sp1", name: "Message", system: { slug: "message" }, type: "spell" },
        { _id: "sp2", name: "Caustic Blast", system: { slug: "caustic-blast" }, type: "spell" },
        { _id: "sp3", name: "Command", system: { slug: "command" }, type: "spell" },
        { _id: "sp4", name: "Air Bubble", system: { slug: "air-bubble" }, type: "spell" },
      ]),
    });

    // Mock fetch for stream-engines (returns empty — slot resolution won't find data)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, text: async () => "" }));
  });

  function makeSummary(): ImportSummary {
    return { itemsImported: 0, itemsSkipped: 0, unmapped: [], errors: [], log: [] };
  }

  function makeWizardSpellbookEngine(slug: string, rank: number, isCurriculum: boolean): DemiplaneEngineEntry {
    const spellSlot = isCurriculum
      ? rank === 0
        ? "cantrip-wizard-school-spellbook-slot"
        : `rank-${rank}-wizard-school-spellbook-slot`
      : rank === 0
        ? "cantrip"
        : `rank-${rank}`;

    return {
      id: slug,
      name: `tabula/spell/${slug}.eng`,
      type: "DemiplaneEngine",
      args: {
        slug,
        name: slug,
        selectionRank: rank,
        spellSlot,
        addSpellData: { baseSpellbookSpell: true },
        sourceRow: `builder-spell-section--wizard-spellcasting-rm--${rank}`,
        parentSpellFeature: "wizard-spellcasting-rm",
        builderSection: "spells",
      },
    };
  }

  function makePreparedEngine(slug: string, rank: number, isCurriculum: boolean): DemiplaneEngineEntry {
    const spellSlot = isCurriculum
      ? rank === 0
        ? "cantrip-wizard-school-spellbook-slot"
        : `rank-${rank}-wizard-school-spellbook-slot`
      : rank === 0
        ? "cantrip"
        : `rank-${rank}`;

    return {
      id: `prepared-${slug}`,
      name: `tabula/spell/${slug}.eng`,
      type: "DemiplaneEngine",
      args: {
        slug,
        name: "",
        selectionRank: rank,
        spellSlot,
        isPrepare: true,
        sourceRow: "manual-sheet-drawer",
        parentSpellFeature: "wizard-spellcasting-rm",
      },
    };
  }

  it("creates separate curriculum entry for wizard school spells", async () => {
    const actor = createMockActor();
    // Add items.get mock that returns item with update
    const originalGet = actor.items.get;
    actor.items.get = (id: string) => {
      const item = originalGet(id);
      if (item) return { ...item, update: vi.fn().mockResolvedValue(undefined) };
      return undefined;
    };

    const engines: DemiplaneEngineEntry[] = [
      // Class engine needed for slot resolution
      { id: "class-id", name: "tabula/class/wizard-rm.eng", type: "DemiplaneEngine", args: { tableID: "class" } },
      // School feature for naming
      {
        id: "school-id",
        name: "tabula/class-feature/school-of-battle-magic-rm.eng",
        type: "DemiplaneEngine",
        args: { name: "School of Battle Magic", slug: "school-of-battle-magic-rm" },
      },
      // Regular cantrip
      makeWizardSpellbookEngine("caustic-blast-rm", 0, false),
      // Curriculum cantrip
      makeWizardSpellbookEngine("message-rm", 0, true),
      // Regular rank 1
      makeWizardSpellbookEngine("air-bubble-rm", 1, false),
      // Curriculum rank 1
      makeWizardSpellbookEngine("command-rm", 1, true),
    ];

    const summary = makeSummary();
    await applySpells(actor as never, engines, summary);

    // Find all spellcastingEntry creations
    const entryCalls = actor.createEmbeddedDocuments.mock.calls.filter((c: unknown[]) => {
      const items = c[1] as Array<Record<string, unknown>>;
      return items[0]?.type === "spellcastingEntry";
    });

    expect(entryCalls).toHaveLength(2);

    // First entry: regular
    const regularEntry = (entryCalls[0][1] as Array<Record<string, unknown>>)[0];
    expect(regularEntry.name).toBe("Arcane Prepared Spells");

    // Second entry: curriculum (named after school)
    const curriculumEntry = (entryCalls[1][1] as Array<Record<string, unknown>>)[0];
    expect(curriculumEntry.name).toBe("Battle Magic Curriculum Spells");
  });

  it("includes curriculum spells in both regular and curriculum spellbooks", async () => {
    const actor = createMockActor();
    actor.items.get = (id: string) => {
      const item = (actor.items as unknown as { filter: Function }).filter(
        (i: Record<string, unknown>) => i.id === id
      )[0];
      if (item) return { ...item, update: vi.fn().mockResolvedValue(undefined) };
      return undefined;
    };

    const engines: DemiplaneEngineEntry[] = [
      { id: "class-id", name: "tabula/class/wizard-rm.eng", type: "DemiplaneEngine", args: { tableID: "class" } },
      {
        id: "school-id",
        name: "tabula/class-feature/school-of-ars-grammatica-rm.eng",
        type: "DemiplaneEngine",
        args: { name: "School of Ars Grammatica", slug: "school-of-ars-grammatica-rm" },
      },
      makeWizardSpellbookEngine("caustic-blast-rm", 0, false),
      makeWizardSpellbookEngine("message-rm", 0, true),
    ];

    const summary = makeSummary();
    await applySpells(actor as never, engines, summary);

    // Find spell item creation calls (not spellcastingEntry)
    const spellCalls = actor.createEmbeddedDocuments.mock.calls.filter((c: unknown[]) => {
      const items = c[1] as Array<Record<string, unknown>>;
      return items[0]?.type !== "spellcastingEntry";
    });

    // Regular entry gets both spells (message is curriculum but appears in regular too)
    const regularSpells = (spellCalls[0]?.[1] as Array<Record<string, unknown>>) ?? [];
    const regularSlugs = regularSpells.map((s) => (s.system as Record<string, unknown>)?.slug);
    expect(regularSlugs).toContain("caustic-blast");
    expect(regularSlugs).toContain("message");

    // Curriculum entry gets only curriculum spells
    const curriculumSpells = (spellCalls[1]?.[1] as Array<Record<string, unknown>>) ?? [];
    const curriculumSlugs = curriculumSpells.map((s) => (s.system as Record<string, unknown>)?.slug);
    expect(curriculumSlugs).toContain("message");
    expect(curriculumSlugs).not.toContain("caustic-blast");
  });

  it("places prepared spells in slot positions", async () => {
    const actor = createMockActor();
    const updateMock = vi.fn().mockResolvedValue(undefined);
    actor.items.get = () => ({ update: updateMock }) as unknown as undefined;

    const engines: DemiplaneEngineEntry[] = [
      { id: "class-id", name: "tabula/class/wizard-rm.eng", type: "DemiplaneEngine", args: { tableID: "class" } },
      makeWizardSpellbookEngine("caustic-blast-rm", 0, false),
      makeWizardSpellbookEngine("air-bubble-rm", 1, false),
      makePreparedEngine("caustic-blast-rm", 0, false),
      makePreparedEngine("air-bubble-rm", 1, false),
    ];

    const summary = makeSummary();
    await applySpells(actor as never, engines, summary);

    // Check that update was called with prepared slots
    const preparedCalls = updateMock.mock.calls.filter((c: unknown[]) => {
      const arg = c[0] as Record<string, unknown>;
      const system = arg.system as Record<string, unknown> | undefined;
      const slots = system?.slots as Record<string, unknown> | undefined;
      return slots && Object.values(slots).some((s: unknown) => (s as Record<string, unknown>).prepared !== undefined);
    });

    expect(preparedCalls.length).toBeGreaterThan(0);
    expect(summary.log.some((l) => l.includes("prepared"))).toBe(true);
  });
});

describe("applySpells - signature spells", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.spells-srd": createMockPack([
        { _id: "sp1", name: "Thunderstrike", system: { slug: "thunderstrike" }, type: "spell" },
        { _id: "sp2", name: "Blazing Bolt", system: { slug: "blazing-bolt" }, type: "spell" },
      ]),
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, text: async () => "" }));
  });

  function makeSummary(): ImportSummary {
    return { itemsImported: 0, itemsSkipped: 0, unmapped: [], errors: [], log: [] };
  }

  it("marks signature spells for spontaneous casters", async () => {
    const actor = createMockActor();
    actor.items.get = () => ({ update: vi.fn().mockResolvedValue(undefined) }) as unknown as undefined;
    (actor as unknown as Record<string, unknown>).updateEmbeddedDocuments = vi.fn().mockResolvedValue([]);

    const engines: DemiplaneEngineEntry[] = [
      { id: "class-id", name: "tabula/class/sorcerer-rm.eng", type: "DemiplaneEngine", args: { tableID: "class" } },
      {
        id: "spell-1",
        name: "tabula/spell/thunderstrike-rm.eng",
        type: "DemiplaneEngine",
        args: {
          slug: "thunderstrike-rm",
          selectionRank: 1,
          parentSpellFeature: "sorcerer-spellcasting-rm",
          sourceRow: "builder-spell-section--sorcerer-spellcasting-rm--1",
          builderSection: "spells",
        },
        demiplaneEngineId: "engine-id-123",
      },
      {
        id: "spell-2",
        name: "tabula/spell/blazing-bolt-rm.eng",
        type: "DemiplaneEngine",
        args: {
          slug: "blazing-bolt-rm",
          selectionRank: 2,
          parentSpellFeature: "sorcerer-spellcasting-rm",
          sourceRow: "builder-spell-section--sorcerer-spellcasting-rm--2",
          builderSection: "spells",
        },
        demiplaneEngineId: "engine-id-456",
      },
      // Signature marker for thunderstrike
      {
        id: "custom_engine-id-123-spell-is-signature",
        name: "engine-id-123-spell-is-signature",
        type: "CustomDemiplaneEngine",
        args: { id: null, parentEngine: "engine-id-123" },
        value: 1,
      },
    ];

    const summary = makeSummary();
    await applySpells(actor as never, engines, summary);

    const updateCalls = (actor as unknown as Record<string, { mock: { calls: unknown[][] } }>).updateEmbeddedDocuments
      .mock.calls;
    expect(updateCalls).toHaveLength(1);

    const updates = updateCalls[0][1] as Array<Record<string, unknown>>;
    expect(updates).toHaveLength(1);
    expect(updates[0]["system.location.signature"]).toBe(true);
    expect(summary.log.some((l) => l.includes("signature"))).toBe(true);
  });
});
