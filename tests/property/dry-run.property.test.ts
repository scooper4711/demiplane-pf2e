import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";

vi.mock("@scooper4711/demiplane-api", () => ({
  isDemiplaneEngine: (e: { type: string }) => e.type === "DemiplaneEngine",
  findCustomEngineByName: (
    engines: { name: string; type: string; value?: unknown }[],
    storeName: string,
  ) =>
    engines.find(
      (e) => e.type === "CustomDemiplaneEngine" && e.name === storeName,
    ),
  updateCustomEngineValue: (engines: unknown[]) => engines,
}));

vi.stubGlobal("fromUuid", vi.fn());
vi.stubGlobal("ui", { notifications: { error: vi.fn(), info: vi.fn() } });

import { ImportOrchestrator } from "../../src/import-orchestrator.js";
import { ExportManager } from "../../src/export-manager.js";

function createMockClient() {
  return {
    fetchCharacterData: vi.fn().mockResolvedValue({
      engines: [
        {
          id: "eng-1",
          name: "character_hit-points_current",
          value: 30,
          type: "CustomDemiplaneEngine",
          saveType: "CharacterSheet",
          storeType: "override",
          demiplaneEngineId: "de-1",
          args: { id: null },
        },
        {
          id: "eng-2",
          demiplaneEngineId: "de-2",
          name: "tabula/class/fighter-rm.eng",
          type: "DemiplaneEngine",
          saveType: "CharacterBuilder",
          args: { slug: "fighter-rm" },
        },
      ],
    }),
    fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 5 }),
    updateCharacter: vi.fn().mockResolvedValue(true),
  };
}

function createMockSlugMapper() {
  return {
    resolve: vi.fn().mockResolvedValue({
      uuid: "Compendium.pf2e.classes.Item.fighter1",
      packKey: "pf2e.classes",
      slug: "fighter",
    }),
  };
}

function createMockActor(characterId = "char-123") {
  return {
    items: {
      filter: () => [],
      map: () => [],
    },
    update: vi.fn(),
    createEmbeddedDocuments: vi.fn(),
    deleteEmbeddedDocuments: vi.fn(),
    setFlag: vi.fn(),
    getFlag: (_moduleId: string, key: string) => {
      if (key === "characterId") return characterId;
      if (key === "lastKnownVersion") return 3;
      return undefined;
    },
  };
}

/**
 * Validates: Requirements 18.1, 18.3, 18.4, 18.5
 */
describe("Feature: demiplane-foundry-sync, Property 14: Dry run mode is purely observational", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ImportOrchestrator never modifies actor state in dry run mode for any character data", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 10 }), async (numEngines) => {
        vi.clearAllMocks();

        const client = createMockClient();
        const engines = Array.from({ length: numEngines }, (_, i) => ({
          id: `eng-${i}`,
          demiplaneEngineId: `de-${i}`,
          name: `tabula/feat/feat-${i}.eng`,
          type: "DemiplaneEngine" as const,
          saveType: "CharacterBuilder" as const,
          args: { slug: `feat-${i}`, id: null },
        }));
        client.fetchCharacterData.mockResolvedValue({
          engines: [
            ...engines,
            {
              id: "custom-1",
              name: "character_hit-points_current",
              value: 42,
              type: "CustomDemiplaneEngine",
              saveType: "CharacterSheet",
              storeType: "override",
              demiplaneEngineId: "de-c1",
              args: { id: null },
            },
          ],
        });

        const slugMapper = createMockSlugMapper();
        const actor = createMockActor();
        const orchestrator = new ImportOrchestrator(
          client as never,
          slugMapper as never,
        );

        await orchestrator.importCharacter(actor as never, "char-123", {
          dryRun: true,
        });

        // No writes to actor
        expect(actor.update).not.toHaveBeenCalled();
        expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
        expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
        expect(actor.setFlag).not.toHaveBeenCalled();
        // No mutations sent to Demiplane
        expect(client.updateCharacter).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });

  it("ExportManager never calls updateCharacter in dry run mode for any pending changes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            field: fc.constantFrom(
              "character_hit-points_current",
              "character_hit-points_temp",
              "character_hero-points",
              "character_focus_current",
              "character_currency_gold",
            ),
            value: fc.integer({ min: 0, max: 999 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (changes) => {
          vi.clearAllMocks();

          const client = createMockClient();
          const manager = new ExportManager(client as never);
          const actor = createMockActor();

          for (const change of changes) {
            manager.queueChange(actor as never, change.field, change.value);
          }

          const result = await manager.flush(actor as never, { dryRun: true });

          // Verify no mutations
          expect(result.success).toBe(true);
          expect(result.preview).toBeDefined();
          expect(client.updateCharacter).not.toHaveBeenCalled();
          // Actor flags not modified
          expect(actor.setFlag).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });
});
