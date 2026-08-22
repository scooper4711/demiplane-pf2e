import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  installFoundryMocks,
  createMockActor,
  createMockPack,
} from "./foundry-mocks.js";
import { ImportOrchestrator } from "../../src/import/orchestrator.js";

describe("ImportOrchestrator", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.classes": createMockPack([
        { _id: "c1", name: "Fighter", system: { slug: "fighter" } },
      ]),
      "pf2e.ancestries": createMockPack([
        { _id: "a1", name: "Human", system: { slug: "human" } },
      ]),
      "pf2e.heritages": createMockPack([
        {
          _id: "h1",
          name: "Versatile Human",
          system: { slug: "versatile-human" },
        },
      ]),
      "pf2e.backgrounds": createMockPack([
        { _id: "b1", name: "Farmhand", system: { slug: "farmhand" } },
      ]),
      "pf2e.feats-srd": createMockPack([
        { _id: "f1", name: "Power Attack", system: { slug: "power-attack" } },
      ]),
      "pf2e.classfeatures": createMockPack([]),
      "pf2e.spells-srd": createMockPack([]),
      "pf2e.equipment-srd": createMockPack([]),
    });

    // Mock fetch for GraphQL
    (globalThis as unknown as Record<string, unknown>).fetch = vi
      .fn()
      .mockResolvedValue({
        json: async () => ({
          data: {
            demiplane_user_character: [
              {
                data: {
                  engines: [
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
                      args: {
                        slug: "power-attack-rm",
                        sourceRow: "fighter-feat-level-2-rm",
                      },
                    },
                    {
                      id: "6",
                      name: "character_name",
                      type: "CustomDemiplaneEngine",
                      args: {},
                      value: "Test Fighter",
                    },
                    {
                      id: "7",
                      name: "character_level",
                      type: "CustomDemiplaneEngine",
                      args: {},
                      value: 2,
                    },
                  ],
                },
                version: 1,
              },
            ],
          },
        }),
      });
  });

  it("returns error when no token provided", async () => {
    const orchestrator = new ImportOrchestrator();
    const actor = createMockActor();
    const summary = await orchestrator.importCharacter(
      actor as never,
      "test-uuid",
      {},
    );
    expect(summary.errors).toContain("No authentication token provided");
  });

  it("imports basic character structure", async () => {
    const orchestrator = new ImportOrchestrator();
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

    const summary = await orchestrator.importCharacter(
      actor as never,
      "test-uuid",
      { token: "fake-token" },
    );

    expect(summary.errors).toHaveLength(0);
    expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    expect(actor.update).toHaveBeenCalled();
  });

  it("handles GraphQL errors", async () => {
    (globalThis as unknown as Record<string, unknown>).fetch = vi
      .fn()
      .mockResolvedValue({
        json: async () => ({ errors: [{ message: "Unauthorized" }] }),
      });

    const orchestrator = new ImportOrchestrator();
    const actor = createMockActor();
    const summary = await orchestrator.importCharacter(
      actor as never,
      "test-uuid",
      { token: "bad-token" },
    );

    expect(summary.errors[0]).toContain("GraphQL");
  });

  it("handles missing character", async () => {
    (globalThis as unknown as Record<string, unknown>).fetch = vi
      .fn()
      .mockResolvedValue({
        json: async () => ({ data: { demiplane_user_character: [] } }),
      });

    const orchestrator = new ImportOrchestrator();
    const actor = createMockActor();
    const summary = await orchestrator.importCharacter(
      actor as never,
      "test-uuid",
      { token: "token" },
    );

    expect(summary.errors[0]).toContain("Character not found");
  });
});
