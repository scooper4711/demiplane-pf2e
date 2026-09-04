import { describe, it, expect, beforeEach, vi } from "vitest";
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
    const itemUpdate = vi.fn();
    // Kitsune-style ancestry: slot 0 is a fixed Charisma boost (single allowed
    // option), slot 2 is the free boost (all six). Demiplane sends only the
    // free choice.
    const ancestryItem = {
      type: "ancestry",
      id: "anc1",
      system: {
        boosts: {
          "0": { value: ["cha"], selected: "cha" },
          "1": { value: [] },
          "2": { value: ["str", "dex", "con", "int", "wis", "cha"], selected: null },
        },
      },
      update: itemUpdate,
    };
    actor.items.find = ((fn: (i: Record<string, unknown>) => boolean) => [ancestryItem].find(fn)) as never;

    const engines: DemiplaneEngineEntry[] = [
      {
        id: "1",
        name: "core/selection/attribute/boost.eng",
        type: "DemiplaneEngine",
        args: { slug: "strength", sourceRow: "ancestry-boosts" },
      },
    ];
    const summary = makeSummary();
    await applyAttributeBoosts(actor as never, engines, summary);

    // The free choice must go to the free slot (2), never the fixed slot (0).
    expect(itemUpdate).toHaveBeenCalledWith({ "system.boosts.2.selected": "str" });
    expect(summary.log.some((l) => l.includes("ancestry"))).toBe(true);
  });

  it("writes alternate ancestry boosts to alternateAncestryBoosts", async () => {
    // With ancestry-boost-option = "two-boosts", the player forgoes the fixed
    // boost for two free ones; PF2e stores them in system.alternateAncestryBoosts
    // and ignores the fixed/free slots.
    const actor = createMockActor();
    const itemUpdate = vi.fn();
    const ancestryItem = {
      type: "ancestry",
      id: "anc1",
      system: { boosts: { "0": { value: ["cha"], selected: "cha" }, "2": { value: ["str", "dex", "con"] } } },
      update: itemUpdate,
    };
    actor.items.find = ((fn: (i: Record<string, unknown>) => boolean) => [ancestryItem].find(fn)) as never;

    const engines: DemiplaneEngineEntry[] = [
      {
        id: "opt",
        name: "ancestry-boost-option",
        type: "CustomDemiplaneEngine",
        value: "two-boosts",
        args: {},
      } as DemiplaneEngineEntry,
      {
        id: "1",
        name: "core/selection/attribute/boost.eng",
        type: "DemiplaneEngine",
        args: { slug: "strength", sourceRow: "ancestry-boosts", selectionGroup: "ancestry" },
      },
      {
        id: "2",
        name: "core/selection/attribute/boost.eng",
        type: "DemiplaneEngine",
        args: { slug: "dexterity", sourceRow: "ancestry-boosts", selectionGroup: "ancestry" },
      },
    ];
    const summary = makeSummary();
    await applyAttributeBoosts(actor as never, engines, summary);

    expect(itemUpdate).toHaveBeenCalledWith({ "system.alternateAncestryBoosts": ["str", "dex"] });
    // Must NOT touch the per-slot selections under the alternate strategy.
    expect(itemUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ "system.boosts.0.selected": expect.anything() })
    );
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

  it("applies level boosts using the ability-boost-level-<n> source-row scheme", async () => {
    // Regression: level 5/10/15 boosts arrive with sourceRow
    // "ability-boost-level-N" (not "attribute-boosts-level-N-rm"), and were
    // previously dropped because only the latter scheme was matched.
    const actor = createMockActor();
    const boost = (slug: string, level: number): DemiplaneEngineEntry =>
      ({
        id: "e86570ed-9602-414d-adb1-474064f14f28",
        name: "core/selection/attribute/boost.eng",
        type: "DemiplaneEngine",
        args: { slug, sourceRow: `ability-boost-level-${String(level)}` },
      }) as DemiplaneEngineEntry;

    const engines: DemiplaneEngineEntry[] = [
      boost("strength", 5),
      boost("constitution", 5),
      boost("intelligence", 5),
      boost("charisma", 5),
      boost("strength", 10),
      boost("charisma", 10),
      boost("charisma", 15),
      boost("wisdom", 15),
    ];
    const summary = makeSummary();
    await applyAttributeBoosts(actor as never, engines, summary);

    expect(actor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        "system.build.attributes.boosts.5": ["str", "con", "int", "cha"],
        "system.build.attributes.boosts.10": ["str", "cha"],
        "system.build.attributes.boosts.15": ["cha", "wis"],
      })
    );
  });

  it("buckets Gradual Ability Boosts using Demiplane's own level group", async () => {
    // Real GAB shape (character ed4a4e3c): sourceRow
    // "gradual-attribute-boost-level-<n>" plus an authoritative
    // selectionGroup "attribute-boost-level-group-<milestone>". The group wins,
    // so a level-2 gradual boost lands in bucket 5.
    const actor = createMockActor();
    const gab = (slug: string, level: number, group: number): DemiplaneEngineEntry =>
      ({
        id: "e86570ed-9602-414d-adb1-474064f14f28",
        name: "core/selection/attribute/boost.eng",
        type: "DemiplaneEngine",
        args: {
          slug,
          sourceRow: `gradual-attribute-boost-level-${String(level)}`,
          selectionGroup: `attribute-boost-level-group-${String(group)}`,
        },
      }) as DemiplaneEngineEntry;

    const engines: DemiplaneEngineEntry[] = [
      gab("strength", 2, 5),
      gab("dexterity", 3, 5),
      gab("constitution", 4, 5),
      gab("intelligence", 5, 5),
      gab("wisdom", 7, 10),
    ];
    const summary = makeSummary();
    await applyAttributeBoosts(actor as never, engines, summary);

    expect(actor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        "system.build.attributes.boosts.5": ["str", "dex", "con", "int"],
        "system.build.attributes.boosts.10": ["wis"],
      })
    );
  });

  it("falls back to level-derived buckets when no level group is present", async () => {
    // If a gradual boost ever arrives without a selectionGroup, derive the
    // bucket from the level in the sourceRow (2-5 → 5, 6-10 → 10).
    const actor = createMockActor();
    const gab = (slug: string, level: number): DemiplaneEngineEntry =>
      ({
        id: "e86570ed-9602-414d-adb1-474064f14f28",
        name: "core/selection/attribute/boost.eng",
        type: "DemiplaneEngine",
        args: { slug, sourceRow: `gradual-attribute-boost-level-${String(level)}` },
      }) as DemiplaneEngineEntry;

    const engines: DemiplaneEngineEntry[] = [gab("strength", 3), gab("wisdom", 8)];
    const summary = makeSummary();
    await applyAttributeBoosts(actor as never, engines, summary);

    expect(actor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        "system.build.attributes.boosts.5": ["str"],
        "system.build.attributes.boosts.10": ["wis"],
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
