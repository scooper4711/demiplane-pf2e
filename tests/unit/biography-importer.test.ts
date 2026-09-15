import { describe, it, expect, beforeEach } from "vitest";
import { installFoundryMocks, createMockActor, createMockPack } from "./foundry-mocks.js";
import { applyBiography } from "../../src/import/biography-importer.js";
import { clearPackDiscoveryCache } from "../../src/import/pack-discovery.js";
import type { DemiplaneEngineEntry, ImportSummary } from "../../src/import/types.js";

// Pack discovery caches per item-type set; packs change between tests.
beforeEach(() => {
  clearPackDiscoveryCache();
});

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
      unresolvedChoices: [],
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

  it.each([
    ["Be brave, Help others, Stay true", ["Be brave", "Help others", "Stay true"]],
    ["Be brave\nHelp others\nStay true", ["Be brave", "Help others", "Stay true"]],
    ["Be brave; Help others; Stay true", ["Be brave", "Help others", "Stay true"]],
  ])("splits edicts on delimiters", async (input, expected) => {
    const actor = createMockActor();
    const engines = [makeEngine("character_personality_edicts", input)];
    const summary = makeSummary();
    await applyBiography(actor as never, engines, summary);

    expect(actor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        "system.details.biography.edicts": expected,
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

  function makeDeityEngine(displayName: string, slug: string): DemiplaneEngineEntry {
    return {
      id: "deity-eng",
      name: `tabula/deity/${slug}.eng`,
      type: "DemiplaneEngine",
      args: { name: displayName, slug },
    };
  }

  it("adds deity from compendium via the beliefs free-text fallback", async () => {
    const actor = createMockActor();
    const engines = [makeEngine("character_personality_beliefs", "Cayden Cailean")];
    const summary = makeSummary();
    await applyBiography(actor as never, engines, summary);

    expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    expect(summary.log).toContain("+ deity: Cayden Cailean");
  });

  it("prefers the class-selected deity engine over the beliefs free text", async () => {
    const actor = createMockActor();
    const engines = [
      makeDeityEngine("Cayden Cailean", "cayden-cailean-rm"),
      makeEngine("character_personality_beliefs", "Some Personal Creed"),
    ];
    const summary = makeSummary();
    await applyBiography(actor as never, engines, summary);

    // The engine's display name resolves to the compendium deity, not the free text.
    expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    expect(summary.log).toContain("+ deity: Cayden Cailean");
  });

  it("uses the deity engine even when beliefs is blank", async () => {
    const actor = createMockActor();
    const engines = [makeDeityEngine("Cayden Cailean", "cayden-cailean-rm")];
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

  it("resolves a deity from a third-party pack when the official pack misses", async () => {
    installFoundryMocks({
      "pf2e.deities": createMockPack([
        { _id: "deity1", name: "Cayden Cailean", system: { slug: "cayden-cailean" }, type: "deity" },
      ]),
      "sf2e-anachronism.deities": createMockPack([
        { _id: "d2", name: "Triune", system: { slug: "triune" }, type: "deity" },
      ]),
    });
    const actor = createMockActor();
    const engines = [makeDeityEngine("Triune", "triune-rm")];
    const summary = makeSummary();
    await applyBiography(actor as never, engines, summary);

    expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    expect(summary.log).toContain("+ deity: Triune");
  });
});
