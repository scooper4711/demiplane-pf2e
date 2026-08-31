import { describe, it, expect, beforeEach } from "vitest";
import { installFoundryMocks, createMockActor } from "./foundry-mocks.js";
import { applyBiography } from "../../src/import/biography-importer.js";
import type { DemiplaneEngineEntry, ImportSummary } from "../../src/import/types.js";

describe("applyBiography", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.deities": {
        getIndex: async () => [
          {
            _id: "deity1",
            name: "Cayden Cailean",
            system: { slug: "cayden-cailean" },
          },
        ],
        getDocument: async () => ({
          toObject: () => ({
            name: "Cayden Cailean",
            type: "deity",
            system: {},
          }),
        }),
      } as never,
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

  function makeEngine(name: string, value: string | number): DemiplaneEngineEntry {
    return { id: "1", name, type: "CustomDemiplaneEngine", args: {}, value };
  }

  it("sets gender, ethnicity, nationality", async () => {
    const actor = createMockActor();
    const engines = [
      makeEngine("character_appearance_gender", "He/him"),
      makeEngine("character_appearance_ethnicity", "Kellid"),
      makeEngine("character_appearance_nationality", "Andoren"),
    ];
    const summary = makeSummary();
    await applyBiography(actor as never, engines, summary);

    expect(actor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        "system.details.gender.value": "He/him",
        "system.details.ethnicity.value": "Kellid",
        "system.details.nationality.value": "Andoren",
      })
    );
  });

  it("splits edicts on commas", async () => {
    const actor = createMockActor();
    const engines = [makeEngine("character_personality_edicts", "Be brave, Help others, Stay true")];
    const summary = makeSummary();
    await applyBiography(actor as never, engines, summary);

    expect(actor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        "system.details.biography.edicts": ["Be brave", "Help others", "Stay true"],
      })
    );
  });

  it("splits edicts on newlines", async () => {
    const actor = createMockActor();
    const engines = [makeEngine("character_personality_edicts", "Be brave\nHelp others\nStay true")];
    const summary = makeSummary();
    await applyBiography(actor as never, engines, summary);

    expect(actor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        "system.details.biography.edicts": ["Be brave", "Help others", "Stay true"],
      })
    );
  });

  it("splits edicts on semicolons", async () => {
    const actor = createMockActor();
    const engines = [makeEngine("character_personality_edicts", "Be brave; Help others; Stay true")];
    const summary = makeSummary();
    await applyBiography(actor as never, engines, summary);

    expect(actor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        "system.details.biography.edicts": ["Be brave", "Help others", "Stay true"],
      })
    );
  });

  it("parses organized play ID", async () => {
    const actor = createMockActor();
    const engines = [makeEngine("character_organizedplayid", "123456-2001")];
    const summary = makeSummary();
    await applyBiography(actor as never, engines, summary);

    expect(actor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        "system.pfs.playerNumber": 123456,
        "system.pfs.characterNumber": 2001,
      })
    );
  });

  it("adds deity from compendium", async () => {
    const actor = createMockActor();
    const engines = [makeEngine("character_personality_beliefs", "Cayden Cailean")];
    const summary = makeSummary();
    await applyBiography(actor as never, engines, summary);

    expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    expect(summary.log).toContain("+ deity: Cayden Cailean");
  });

  it("does nothing with empty engines", async () => {
    const actor = createMockActor();
    const summary = makeSummary();
    await applyBiography(actor as never, [], summary);

    expect(actor.update).not.toHaveBeenCalled();
  });
});
