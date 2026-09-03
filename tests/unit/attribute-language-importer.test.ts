import { describe, it, expect, beforeEach } from "vitest";
import { installFoundryMocks, createMockActor } from "./foundry-mocks.js";
import {
  applySkillProficiencies,
  applyLanguages,
  applyAttributeBoosts,
  isAttributeSlug,
  isSkillSlug,
} from "../../src/import/attribute-language-importer.js";
import type { DemiplaneEngineEntry, ImportSummary } from "../../src/import/types.js";

describe("applySkillProficiencies", () => {
  beforeEach(() => {
    installFoundryMocks();
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

  it("sets skill ranks from increase engines", async () => {
    const actor = createMockActor();
    actor.system.skills = { athletics: { rank: 0 }, crafting: { rank: 0 } };
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "core/selection/skill/increase/index.eng",
        type: "DemiplaneEngine",
        args: { slug: "athletics", sourceRow: "skill-training-fighter-rm" },
      },
      {
        id: "2",
        name: "core/selection/skill/increase/index.eng",
        type: "DemiplaneEngine",
        args: { slug: "crafting", sourceRow: "skill-training-fighter-rm" },
      },
    ];
    const summary = makeSummary();
    await applySkillProficiencies(actor as never, engines, summary);

    expect(actor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        "system.skills.athletics.rank": 1,
        "system.skills.crafting.rank": 1,
      })
    );
  });

  it("sets expert rank for skill-increase sourceRow", async () => {
    const actor = createMockActor();
    actor.system.skills = { athletics: { rank: 1 } };
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "core/selection/skill/increase/index.eng",
        type: "DemiplaneEngine",
        args: { slug: "athletics", sourceRow: "skill-increase-level-3-rm" },
      },
    ];
    const summary = makeSummary();
    await applySkillProficiencies(actor as never, engines, summary);

    expect(actor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        "system.skills.athletics.rank": 2,
      })
    );
  });

  it("applies overrides when --overridden flag is set", async () => {
    const actor = createMockActor();
    actor.system.skills = { survival: { rank: 1 } };
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "core/selection/skill/increase/index.eng",
        type: "DemiplaneEngine",
        args: { slug: "survival", sourceRow: "skill-training-fighter-rm" },
      },
      {
        id: "2",
        name: "character_survival_prof",
        type: "CustomDemiplaneEngine",
        args: {},
        value: 0,
      },
      {
        id: "3",
        name: "character_survival_prof--overridden",
        type: "CustomDemiplaneEngine",
        args: {},
        value: 1,
      },
    ];
    const summary = makeSummary();
    await applySkillProficiencies(actor as never, engines, summary);

    // Second update call applies overrides
    const overrideCall = actor.update.mock.calls.find((c: unknown[]) => {
      const data = c[0] as Record<string, unknown>;
      return "system.skills.survival.rank" in data;
    });
    expect(overrideCall).toBeDefined();
  });

  it("does nothing with no skill engines", async () => {
    const actor = createMockActor();
    const summary = makeSummary();
    await applySkillProficiencies(actor as never, [], summary);
    expect(actor.update).not.toHaveBeenCalled();
  });
});

describe("applyLanguages", () => {
  beforeEach(() => {
    installFoundryMocks();
    (
      globalThis as unknown as {
        CONFIG: { PF2E: { languages: Record<string, string> } };
      }
    ).CONFIG = {
      PF2E: {
        languages: { common: "Common", draconic: "Draconic", elven: "Elven" },
      },
    };
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

  it.each([
    { delimiter: "commas", value: "Draconic, Elven" },
    { delimiter: "newlines", value: "Draconic\nElven" },
    { delimiter: "semicolons", value: "Draconic; Elven" },
  ])("adds valid languages split on $delimiter", async ({ value }) => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "character-languages-user",
        type: "CustomDemiplaneEngine",
        args: {},
        value,
      },
    ];
    const summary = makeSummary();
    await applyLanguages(actor as never, engines, summary);

    expect(actor.update).toHaveBeenCalledWith({
      "system.details.languages.value": ["common", "draconic", "elven"],
    });
  });

  it("reports unmatched languages", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "character-languages-user",
        type: "CustomDemiplaneEngine",
        args: {},
        value: "Draconic, Klingon",
      },
    ];
    const summary = makeSummary();
    await applyLanguages(actor as never, engines, summary);

    expect(summary.log.some((l) => l.includes("not found") && l.includes("klingon"))).toBe(true);
  });
});

describe("applyAttributeBoosts", () => {
  beforeEach(() => {
    installFoundryMocks();
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

  it("applies ancestry boosts", async () => {
    const actor = createMockActor();
    // Add a mock ancestry item
    actor.items.filter = ((fn: (i: Record<string, unknown>) => boolean) => {
      const items = [{ type: "ancestry", id: "anc1", system: {}, update: actor.update }];
      return items.filter(fn);
    }) as never;
    actor.items.find = ((fn: (i: Record<string, unknown>) => boolean) => {
      const items = [{ type: "ancestry", id: "anc1", system: {}, update: actor.update }];
      return items.find(fn);
    }) as never;

    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "core/selection/attribute/boost.eng",
        type: "DemiplaneEngine",
        args: { slug: "strength", sourceRow: "ancestry-boosts" },
      },
      {
        id: "2",
        name: "core/selection/attribute/boost.eng",
        type: "DemiplaneEngine",
        args: { slug: "dexterity", sourceRow: "ancestry-boosts" },
      },
    ];
    const summary = makeSummary();
    await applyAttributeBoosts(actor as never, engines, summary);

    expect(actor.update).toHaveBeenCalled();
    expect(summary.log.some((l) => l.includes("ancestry"))).toBe(true);
  });

  it("applies level boosts to actor", async () => {
    const actor = createMockActor();
    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "core/selection/attribute/boost.eng",
        type: "DemiplaneEngine",
        args: { slug: "strength", sourceRow: "attribute-boosts-level-1-rm" },
      },
      {
        id: "2",
        name: "core/selection/attribute/boost.eng",
        type: "DemiplaneEngine",
        args: {
          slug: "constitution",
          sourceRow: "attribute-boosts-level-1-rm",
        },
      },
    ];
    const summary = makeSummary();
    await applyAttributeBoosts(actor as never, engines, summary);

    expect(actor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        "system.build.attributes.boosts.1": ["str", "con"],
      })
    );
  });
});

describe("slug validation", () => {
  it("recognizes valid ability abbreviations", () => {
    expect(isAttributeSlug("str")).toBe(true);
    expect(isAttributeSlug("cha")).toBe(true);
    expect(isAttributeSlug("wisdom")).toBe(false);
  });

  it("recognizes standard skills and lore slugs", () => {
    expect(isSkillSlug("athletics")).toBe(true);
    expect(isSkillSlug("lore-warfare")).toBe(true);
    expect(isSkillSlug("not-a-skill")).toBe(false);
  });
});
