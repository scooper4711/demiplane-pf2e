import { describe, it, expect, beforeEach } from "vitest";
import { installFoundryMocks } from "./foundry-mocks.js";
import { findMatchInChoices } from "../../src/import/choice-matchers.js";

function skillEngine(slug) {
  return {
    id: `skill-${slug}`,
    name: "core/selection/skill/increase/index.eng",
    type: "CustomDemiplaneEngine",
    args: { slug },
  };
}

function loreEngine(name, sourceRow) {
  return {
    id: `lore-${name}`,
    name: "core/selection/skill/custom-selection/index.eng",
    type: "DemiplaneEngine",
    args: sourceRow === undefined ? { name } : { name, sourceRow },
  };
}

function demiEngine(name, slug) {
  return { id: `eng-${slug}`, name, type: "DemiplaneEngine", args: { slug } };
}

function featEngine(slug) {
  return {
    id: `feat-${slug}`,
    name: "tabula/feat/x.eng",
    type: "DemiplaneEngine",
    args: { slug, sourceRow: "select-feat-1" },
  };
}

describe("choice-matchers", () => {
  beforeEach(() => {
    installFoundryMocks();
  });

  it("matches skill increases by slug", () => {
    const choices = [
      { label: "Arcana", value: "arcana" },
      { label: "Crafting", value: "crafting" },
    ];

    expect(findMatchInChoices(choices, [skillEngine("crafting")])).toBe(choices[1]);
  });

  it("returns null when no strategy matches anything", () => {
    expect(findMatchInChoices([{ label: "X", value: "y" }], [])).toBeNull();
    expect(findMatchInChoices([{ label: "X", value: 42 }], [skillEngine("arcana")])).toBeNull();
  });

  it("matches custom-selection lore scoped to the originating feat", () => {
    const choices = [{ label: "Forest Lore", value: "forest-lore" }];
    const engines = [loreEngine("Forest Lore", "assurance-rm-grant")];

    expect(findMatchInChoices(choices, engines, "Assurance")).toBe(choices[0]);
  });

  it("matches lore by label slug when the value differs", () => {
    const choices = [{ label: "Forest Lore", value: "something-else" }];
    const engines = [loreEngine("Forest Lore", "assurance-grant")];

    expect(findMatchInChoices(choices, engines, "Assurance")).toBe(choices[0]);
  });

  it("matches lore without scoping when no item name is given", () => {
    const choices = [{ label: "Forest Lore", value: "forest-lore" }];
    const engines = [loreEngine("Forest Lore")];

    expect(findMatchInChoices(choices, engines)).toBe(choices[0]);
  });

  it("ignores lore engines scoped to a different feat", () => {
    const choices = [{ label: "Forest Lore", value: "forest-lore" }];
    const engines = [loreEngine("Forest Lore", "other-thing")];

    expect(findMatchInChoices(choices, engines, "Assurance")).toBeNull();
  });

  it("ignores non-string choice values when matching lore", () => {
    const choices = [{ label: "X", value: 42 }];
    const engines = [loreEngine("Forest Lore")];

    expect(findMatchInChoices(choices, engines)).toBeNull();
  });

  it("matches any Demiplane engine slug", () => {
    const choices = [{ label: "Power Attack", value: "power-attack" }];
    const engines = [demiEngine("tabula/feat/x.eng", "power-attack-rm")];

    expect(findMatchInChoices(choices, engines)).toBe(choices[0]);
  });

  it("ignores non-string values when matching engine slugs", () => {
    const choices = [{ label: "X", value: null }];
    const engines = [demiEngine("tabula/feat/x.eng", "power-attack")];

    expect(findMatchInChoices(choices, engines)).toBeNull();
  });

  it("matches class features by exact and suffix label slugs", () => {
    const exact = [{ label: "Evocation", value: "zzz" }];
    const suffixed = [{ label: "School of Evocation", value: "zzz" }];
    const engines = [demiEngine("tabula/class-feature/school-evocation.eng", "evocation")];

    expect(findMatchInChoices(exact, engines)).toBe(exact[0]);
    expect(findMatchInChoices(suffixed, engines)).toBe(suffixed[0]);
    expect(findMatchInChoices([{ label: "Abjuration", value: "zzz" }], engines)).toBeNull();
  });

  it("matches generic features by substring, skipping compendium and empty values", () => {
    const engines = [demiEngine("tabula/generic-feature/darkvision.eng", "darkvision-low-light")];

    expect(findMatchInChoices([{ label: "Low-Light Vision", value: "low-light" }], engines)?.value).toBe("low-light");
    expect(findMatchInChoices([{ label: "X", value: "" }], engines)).toBeNull();
    expect(findMatchInChoices([{ label: "X", value: "Compendium.pf2e.feats-srd.Item.y" }], engines)).toBeNull();
    expect(findMatchInChoices([{ label: "X", value: "unrelated" }], engines)).toBeNull();
  });

  it("matches feat slugs against compendium choice labels", () => {
    const engines = [featEngine("power-attack")];

    const exact = [{ label: "Power Attack", value: "Compendium.pf2e.feats-srd.Item.pa" }];
    expect(findMatchInChoices(exact, engines)).toBe(exact[0]);

    const partial = [{ label: "Greater Power Attack", value: "Compendium.pf2e.feats-srd.Item.gpa" }];
    expect(findMatchInChoices(partial, engines)).toBe(partial[0]);

    expect(findMatchInChoices([{ label: "Toughness", value: "Compendium.pf2e.feats-srd.Item.t" }], engines)).toBeNull();
  });

  it("skips feat matching for non-compendium values", () => {
    const engines = [featEngine("power-attack")];

    expect(findMatchInChoices([{ label: "Power Attack", value: "unrelated" }], engines)).toBeNull();
  });

  it("matches generic-choice keywords by value and label", () => {
    const engines = [demiEngine("tabula/generic-choice/canny-acumen.eng", "canny-acumen-save-option-will")];

    expect(findMatchInChoices([{ label: "Will", value: "will" }], engines)?.value).toBe("will");
    expect(findMatchInChoices([{ label: "will", value: "zzz" }], engines)?.label).toBe("will");
  });

  it("skips empty generic-choice keywords", () => {
    const engines = [demiEngine("tabula/generic-choice/trailing.eng", "trailing-")];

    expect(findMatchInChoices([{ label: "Will", value: "will" }], engines)).toBeNull();
  });

  it("runs the item-scoped generic-choice pass only when the broad pass misses", () => {
    // Scoped filter matches nothing: early null without keyword logging.
    expect(
      findMatchInChoices(
        [{ label: "X", value: "zzz" }],
        [demiEngine("tabula/generic-choice/other.eng", "unrelated-thing")],
        "Canny Acumen"
      )
    ).toBeNull();

    // Scoped filter matches engines but keywords still miss.
    expect(
      findMatchInChoices(
        [{ label: "X", value: "zzz" }],
        [demiEngine("tabula/generic-choice/canny.eng", "canny-acumen-foo")],
        "Canny Acumen"
      )
    ).toBeNull();
  });
});
