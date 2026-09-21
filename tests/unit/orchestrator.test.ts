import { describe, it, expect, beforeEach, vi } from "vitest";
import { installFoundryMocks, createMockActor, createMockPack } from "./foundry-mocks.js";
import { ImportOrchestrator } from "../../src/import/orchestrator.js";
import { ChoiceSetHandler } from "../../src/import/choice-set-handler.js";
import { collectLoreNames } from "../../src/import/phases.js";

/** The engine selection blob the default happy-path character read returns. */
const DEFAULT_ENGINES = [
  {
    id: "1",
    name: "tabula/ancestry/human-rm.eng",
    type: "DemiplaneEngine",
    args: { slug: "human-rm", sourceRow: "" },
  },
  {
    id: "2",
    name: "tabula/heritage/versatile-human-rm.eng",
    type: "DemiplaneEngine",
    args: { slug: "versatile-human-rm", sourceRow: "" },
  },
  {
    id: "3",
    name: "tabula/background/farmhand-rm.eng",
    type: "DemiplaneEngine",
    args: { slug: "farmhand-rm", sourceRow: "" },
  },
  {
    id: "4",
    name: "tabula/class/fighter-rm.eng",
    type: "DemiplaneEngine",
    args: { slug: "fighter-rm", sourceRow: "" },
  },
  {
    id: "5",
    name: "tabula/feat/power-attack-rm.eng",
    type: "DemiplaneEngine",
    args: { slug: "power-attack-rm", sourceRow: "fighter-feat-level-2-rm" },
  },
  {
    id: "8",
    name: "tabula/class-feature/weapon-specialization-rm.eng",
    type: "DemiplaneEngine",
    args: { slug: "weapon-specialization-rm", sourceRow: "fighter-rm" },
  },
  { id: "6", name: "character_name", type: "CustomDemiplaneEngine", args: {}, value: "Test Fighter" },
  { id: "7", name: "character_level", type: "CustomDemiplaneEngine", args: {}, value: 2 },
];

/**
 * Builds a client stand-in for the orchestrator. `fetchCharacterData` is the
 * seam the orchestrator reads through (it replaced a hand-rolled fetch), so the
 * character payload — and any thrown fetch error — is configured here.
 */
function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    setToken: vi.fn(),
    isAuthenticated: vi.fn().mockReturnValue(true),
    fetchCharacterData: vi.fn().mockResolvedValue({ engines: DEFAULT_ENGINES, engineCacheIdsBySource: {} }),
    fetchCharacterJournals: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("ImportOrchestrator", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.classes": createMockPack([{ _id: "c1", name: "Fighter", system: { slug: "fighter" } }]),
      "pf2e.ancestries": createMockPack([{ _id: "a1", name: "Human", system: { slug: "human" } }]),
      "pf2e.heritages": createMockPack([
        {
          _id: "h1",
          name: "Versatile Human",
          system: { slug: "versatile-human" },
        },
      ]),
      "pf2e.backgrounds": createMockPack([{ _id: "b1", name: "Farmhand", system: { slug: "farmhand" } }]),
      "pf2e.feats-srd": createMockPack([{ _id: "f1", name: "Power Attack", system: { slug: "power-attack" } }]),
      "pf2e.classfeatures": createMockPack([
        { _id: "cf1", name: "Weapon Specialization", system: { slug: "weapon-specialization" } },
      ]),
      "pf2e.spells-srd": createMockPack([]),
      "pf2e.equipment-srd": createMockPack([]),
    });
  });

  it("returns error when no token provided and none is configured", async () => {
    const orchestrator = new ImportOrchestrator(createMockClient() as never);
    const actor = createMockActor();
    const summary = await orchestrator.importCharacter(actor as never, "test-uuid", {});
    expect(summary.errors).toContain("No authentication token provided");
  });

  it("falls back to the configured token setting when no token is passed", async () => {
    // Structural guarantee: a caller that omits the token still authenticates
    // from the live setting rather than diverging from the push path.
    mockChoiceSetPrototype();
    await globalThis.game.settings.set("demiplane-pf2e", "demiplaneToken", "Bearer configured-token");
    const client = createMockClient();
    const orchestrator = new ImportOrchestrator(client as never);
    const actor = createMockActor();

    const summary = await orchestrator.importCharacter(actor as never, "test-uuid", {});

    expect(summary.errors).toHaveLength(0);
    // Authenticated from the setting, normalized (Bearer stripped). beforeEach
    // reinstalls a fresh settings store, so this value does not leak.
    expect(client.setToken).toHaveBeenCalledWith("configured-token");
  });

  it("imports basic character structure", async () => {
    const orchestrator = new ImportOrchestrator(createMockClient() as never);
    const actor = createMockActor();

    // Mock the ChoiceSet monkey-patch target
    (globalThis as unknown as Record<string, unknown>).game = {
      ...(globalThis as unknown as { game: Record<string, unknown> }).game,
      pf2e: {
        RuleElements: {
          builtin: { ChoiceSet: { prototype: { preCreate: async () => {} } } },
        },
      },
    };

    const summary = await orchestrator.importCharacter(actor as never, "test-uuid", { token: "fake-token" });

    expect(summary.errors).toHaveLength(0);
    expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    expect(actor.update).toHaveBeenCalled();

    const createdItems = actor.createEmbeddedDocuments.mock.calls.flatMap(
      (call: unknown[]) => call[1] as Array<Record<string, unknown>>
    );
    expect(createdItems.some((item) => item.name === "Weapon Specialization")).toBe(false);
  });

  it("drains unresolved choices into the import summary", async () => {
    const drain = vi.spyOn(ChoiceSetHandler.prototype, "drainUnresolvedChoices");
    const orchestrator = new ImportOrchestrator(createMockClient() as never);
    const actor = createMockActor();

    (globalThis as unknown as Record<string, unknown>).game = {
      ...(globalThis as unknown as { game: Record<string, unknown> }).game,
      pf2e: {
        RuleElements: {
          builtin: { ChoiceSet: { prototype: { preCreate: async () => {} } } },
        },
      },
    };

    const summary = await orchestrator.importCharacter(actor as never, "test-uuid", { token: "fake-token" });

    expect(drain).toHaveBeenCalled();
    expect(summary.unresolvedChoices).toEqual([]);
    drain.mockRestore();
  });

  it("stamps lastImportTimestamp after a successful pipeline run", async () => {
    const orchestrator = new ImportOrchestrator(createMockClient() as never);
    const actor = createMockActor();

    (globalThis as unknown as Record<string, unknown>).game = {
      ...(globalThis as unknown as { game: Record<string, unknown> }).game,
      pf2e: {
        RuleElements: {
          builtin: { ChoiceSet: { prototype: { preCreate: async () => {} } } },
        },
      },
    };

    const summary = await orchestrator.importCharacter(actor as never, "test-uuid", { token: "fake-token" });

    expect(summary.errors).toHaveLength(0);
    expect(actor.setFlag).toHaveBeenCalledWith("demiplane-pf2e", "lastImportTimestamp", expect.any(Number));
  });

  it.each([
    {
      name: "surfaces a non-token GraphQL error verbatim",
      rejection: 'GraphQL errors: field "foo" not found',
      expected: "GraphQL",
    },
    {
      name: "translates a token-rejection failure into plain language",
      rejection: "GraphQL errors: unauthorized",
      expected: "Demiplane rejected the token",
    },
    {
      // The client throws `Character not found: <id>` for an empty result set.
      name: "handles missing character",
      rejection: "Character not found: test-uuid",
      expected: "Character not found",
    },
  ])("$name", async ({ rejection, expected }) => {
    const client = createMockClient({
      fetchCharacterData: vi.fn().mockRejectedValue(new Error(rejection)),
    });
    const orchestrator = new ImportOrchestrator(client as never);
    const actor = createMockActor();
    const summary = await orchestrator.importCharacter(actor as never, "test-uuid", { token: "token" });

    expect(summary.errors[0]).toContain(expected);
  });

  it("stores the server updated timestamp when present", async () => {
    mockChoiceSetPrototype();
    const client = createMockClient({
      fetchCharacterData: vi
        .fn()
        .mockResolvedValue({ engines: [], engineCacheIdsBySource: {}, updated: "2026-05-05T00:00:00.000Z" }),
    });
    const orchestrator = new ImportOrchestrator(client as never);
    const actor = createMockActor();
    await orchestrator.importCharacter(actor as never, "test-uuid", { token: "token" });

    expect(actor.setFlag).toHaveBeenCalledWith("demiplane-pf2e", "lastUpdated", "2026-05-05T00:00:00.000Z");
  });

  it("reports character-read failures with Error and non-Error reasons", async () => {
    const actor = createMockActor();

    const errors = await new ImportOrchestrator(
      createMockClient({ fetchCharacterData: vi.fn().mockRejectedValue(new Error("down")) }) as never
    ).importCharacter(actor as never, "test-uuid", { token: "token" });
    expect(errors.errors[0]).toContain("down");

    const stringErrors = await new ImportOrchestrator(
      createMockClient({ fetchCharacterData: vi.fn().mockRejectedValue("string-fail") }) as never
    ).importCharacter(actor as never, "test-uuid", { token: "token" });
    expect(stringErrors.errors[0]).toContain("string-fail");
  });

  it("reports a clear error when no client is configured", async () => {
    const orchestrator = new ImportOrchestrator();
    const actor = createMockActor();
    const summary = await orchestrator.importCharacter(actor as never, "test-uuid", { token: "token" });
    expect(summary.errors).toContain("No Demiplane client configured");
  });

  it("stamps new items through the preCreateItem hook", async () => {
    mockChoiceSetPrototype();
    const orchestrator = new ImportOrchestrator(createMockClient() as never);
    const actor = createMockActor();
    actor.id = "actor-1";
    (globalThis as unknown as Record<string, unknown>).game = {
      ...(globalThis as unknown as { game: Record<string, unknown> }).game,
      pf2e: {
        RuleElements: {
          builtin: { ChoiceSet: { prototype: { preCreate: async () => {} } } },
        },
      },
    };
    await orchestrator.importCharacter(actor as never, "test-uuid", { token: "fake-token" });

    const hooks = globalThis as unknown as { Hooks: { on: ReturnType<typeof vi.fn> } };
    const preCreate = hooks.Hooks.on.mock.calls.find((call) => call[0] === "preCreateItem")?.[1];
    const updateSource = vi.fn();

    // Matching parent stamps the imported flag.
    preCreate({ parent: { id: "actor-1" }, updateSource });
    expect(updateSource).toHaveBeenCalledWith({ "flags.demiplane-pf2e.imported": true });

    // Other actors' items and parentless documents pass through untouched.
    const untouched = vi.fn();
    preCreate({ parent: { id: "someone-else" }, updateSource: untouched });
    preCreate({ updateSource: untouched });
    expect(untouched).not.toHaveBeenCalled();
  });

  it("imports the campaign journal when a client is configured", async () => {
    mockChoiceSetPrototype();
    const orchestrator = new ImportOrchestrator(
      createMockClient({
        fetchCharacterJournals: vi
          .fn()
          .mockResolvedValue([{ objectID: "j1", title: "Campaign", description: "Party notes" }]),
      }) as never
    );
    const actor = createMockActor();

    await orchestrator.importCharacter(actor as never, "test-uuid", { token: "fake-token" });

    expect(actor.update).toHaveBeenCalledWith({ "system.details.biography.campaignNotes": "Party notes" });
  });

  it("skips the journal update without a campaign entry", async () => {
    mockChoiceSetPrototype();
    const orchestrator = new ImportOrchestrator(
      createMockClient({
        fetchCharacterJournals: vi.fn().mockResolvedValue([{ objectID: "j2", title: "Other", description: "x" }]),
      }) as never
    );
    const actor = createMockActor();
    actor.update.mockClear();

    await orchestrator.importCharacter(actor as never, "test-uuid", { token: "fake-token" });

    const journalWrites = actor.update.mock.calls.filter((call) =>
      Object.keys(call[0]).some((key) => String(key).includes("campaignNotes"))
    );
    expect(journalWrites).toHaveLength(0);
  });

  it("survives journal fetch failures with Error and non-Error reasons", async () => {
    mockChoiceSetPrototype();
    for (const failure of [new Error("nope"), "string-fail"]) {
      const orchestrator = new ImportOrchestrator(
        createMockClient({ fetchCharacterJournals: vi.fn().mockRejectedValueOnce(failure) }) as never
      );
      const actor = createMockActor();

      const summary = await orchestrator.importCharacter(actor as never, "test-uuid", { token: "fake-token" });

      expect(summary.errors).toHaveLength(0);
    }
  });

  /** Full pipeline runs patch ChoiceSets, which needs the mocked rule element prototype. */
  function mockChoiceSetPrototype(): void {
    (globalThis as unknown as Record<string, unknown>).game = {
      ...(globalThis as unknown as { game: Record<string, unknown> }).game,
      pf2e: {
        RuleElements: {
          builtin: { ChoiceSet: { prototype: { preCreate: async () => {} } } },
        },
      },
    };
  }
});

describe("collectLoreNames", () => {
  const mkEngine = (name: string, args?: Record<string, unknown>) =>
    ({ name, type: "DemiplaneEngine", args }) as unknown as DemiplaneEngineEntry;

  it("includes background lore names", () => {
    expect(collectLoreNames([], ["Underworld Lore"])).toEqual(["Underworld Lore"]);
  });

  it("captures custom-skill lore selections", () => {
    const engines = [mkEngine("core/selection/skill/custom-skill/index.eng", { name: "Sailing Lore" })];
    expect(collectLoreNames(engines)).toEqual(["Sailing Lore"]);
  });

  it("captures custom-selection lore (e.g. Gnome Obsession additional Lore)", () => {
    const engines = [
      mkEngine("core/selection/skill/custom-selection/index.eng", {
        name: "Forest Lore",
        skill: "additional-lore-rm-abc-0-lore",
      }),
    ];
    expect(collectLoreNames(engines)).toEqual(["Forest Lore"]);
  });

  it("ignores custom-selection engines that are not lore skills", () => {
    const engines = [mkEngine("core/selection/skill/custom-selection/index.eng", { name: "Stealth" })];
    expect(collectLoreNames(engines)).toEqual([]);
  });

  it("deduplicates across sources", () => {
    const engines = [mkEngine("core/selection/skill/custom-selection/index.eng", { name: "Forest Lore" })];
    expect(collectLoreNames(engines, ["Forest Lore"])).toEqual(["Forest Lore"]);
  });

  const mkCustomEngine = (name: string, value: unknown) =>
    ({ name, type: "CustomDemiplaneEngine", value, args: {} }) as unknown as DemiplaneEngineEntry;

  it("captures a background lore subject from a _lore_name override (e.g. Emissary → Absalom)", () => {
    const engines = [mkCustomEngine("character_emissary-rm-73c1822b-0-lore_name", "Absalom")];
    expect(collectLoreNames(engines)).toEqual(["Absalom"]);
  });

  it("ignores an empty or non-string _lore_name value", () => {
    const engines = [
      mkCustomEngine("character_emissary-rm-0-lore_name", "   "),
      mkCustomEngine("character_emissary-rm-1-lore_name", 0),
    ];
    expect(collectLoreNames(engines)).toEqual([]);
  });

  it("deduplicates a _lore_name subject already provided by the background", () => {
    const engines = [mkCustomEngine("character_emissary-rm-0-lore_name", "Absalom")];
    expect(collectLoreNames(engines, ["Absalom"])).toEqual(["Absalom"]);
  });
});
