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

  // A skill-increase engine scoped to a specific feat: sourceRow includes
  // `select-skill-<featSlug>`, matching how Demiplane records the pick.
  function featSkillEngine(featSlug, skillSlug) {
    return {
      id: `sel-${featSlug}-${skillSlug}`,
      name: "core/selection/skill/increase/index.eng",
      type: "DemiplaneEngine",
      args: { slug: skillSlug, sourceRow: `abc123_select-skill-${featSlug}-1bd2ed71` },
    };
  }

  it("resolves a Rogue Dedication rank-path choice via the feat-scoped selection", () => {
    // Options carry rank paths, not slugs; the character trained BOTH stealth and
    // thievery, so only the feat-scoped engine disambiguates.
    const choices = [
      { label: "Stealth", value: "system.skills.stealth.rank" },
      { label: "Thievery", value: "system.skills.thievery.rank" },
    ];
    const engines = [
      featSkillEngine("rogue-dedication-rm", "stealth"),
      skillEngine("thievery"), // trained elsewhere; must not win
    ];

    expect(findMatchInChoices(choices, engines, "Rogue Dedication")).toBe(choices[0]);
  });

  it("resolves a Captivator proficiency-suffixed choice via the feat-scoped selection", () => {
    // Captivator options are `deception-trained` / `diplomacy-trained` etc.
    const choices = [
      { label: "Deception", value: "deception-trained" },
      { label: "Deception", value: "deception-expert" },
      { label: "Diplomacy", value: "diplomacy-trained" },
      { label: "Diplomacy", value: "diplomacy-expert" },
    ];
    const engines = [featSkillEngine("captivator-dedication", "diplomacy")];

    // First option whose skill is diplomacy (the trained variant).
    expect(findMatchInChoices(choices, engines, "Captivator Dedication")).toBe(choices[2]);
  });

  it("falls through when the feat-scoped skill is not among the options", () => {
    // Data quirk: the feat-scoped engine names a skill the feat can't grant
    // (stealth for Captivator). The strategy must NOT force a wrong pick.
    const choices = [
      { label: "Deception", value: "deception-trained" },
      { label: "Diplomacy", value: "diplomacy-trained" },
    ];
    const engines = [featSkillEngine("captivator-dedication", "stealth")];

    expect(findMatchInChoices(choices, engines, "Captivator Dedication")).toBeNull();
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

  it("matches a class-suffixed feat slug against the unsuffixed label", () => {
    // Demiplane slug "widen-spell-wizard" must match the compendium label
    // "Widen Spell" — the -wizard class suffix is stripped before comparing.
    const engines = [
      {
        id: "e",
        name: "tabula/feat/widen-spell-wizard-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "widen-spell-wizard-rm", sourceRow: "select-feat-school-of-unified-magical-theory-rm" },
      },
    ];
    const choices = [{ label: "Widen Spell", value: "Compendium.pf2e.feats-srd.Item.ws" }];
    expect(findMatchInChoices(choices, engines, "School of Unified Magical Theory")?.value).toBe(
      "Compendium.pf2e.feats-srd.Item.ws"
    );
  });

  it("scopes feat matching to the owning feature when several selections exist", () => {
    // Two select-feat engines for different features; each feature's ChoiceSet
    // must resolve to its own selection, not whichever appears first.
    const engines = [
      {
        id: "widen",
        name: "tabula/feat/widen-spell-wizard-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "widen-spell-wizard-rm", sourceRow: "a_select-feat-school-of-unified-magical-theory-rm_b" },
      },
      {
        id: "reach",
        name: "tabula/feat/reach-spell-wizard-rm.eng",
        type: "DemiplaneEngine",
        args: { slug: "reach-spell-wizard-rm", sourceRow: "c_select-feat-experimental-spellshaping-rm_d" },
      },
    ];
    const choices = [
      { label: "Reach Spell", value: "Compendium.pf2e.feats-srd.Item.rs" },
      { label: "Widen Spell", value: "Compendium.pf2e.feats-srd.Item.ws" },
    ];

    expect(findMatchInChoices(choices, engines, "School of Unified Magical Theory")?.label).toBe("Widen Spell");
    expect(findMatchInChoices(choices, engines, "Experimental Spellshaping")?.label).toBe("Reach Spell");
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

  // Deity and domain arrive as CustomDemiplaneEngine overrides, which the
  // DemiplaneEngine-only strategies skip — so these use that type deliberately.
  function deityEngine(slug) {
    return { id: `deity-${slug}`, name: `tabula/deity/${slug}.eng`, type: "CustomDemiplaneEngine", args: { slug } };
  }

  function domainEngine(slug) {
    return { id: `domain-${slug}`, name: `tabula/domain/${slug}.eng`, type: "CustomDemiplaneEngine", args: { slug } };
  }

  it("matches the deity choice by label when the option value is a compendium UUID", () => {
    const choices = [
      { label: "Abadar", value: "Compendium.pf2e.deities.Item.abadar" },
      { label: "Sarenrae", value: "Compendium.pf2e.deities.Item.sarenrae" },
    ];

    expect(findMatchInChoices(choices, [deityEngine("sarenrae-rm")])).toBe(choices[1]);
  });

  it("does not match a deity when the character's deity isn't among the options", () => {
    const choices = [{ label: "Abadar", value: "Compendium.pf2e.deities.Item.abadar" }];

    expect(findMatchInChoices(choices, [deityEngine("sarenrae-rm")])).toBeNull();
  });

  it("matches a domain choice by value (fire-rm -> fire)", () => {
    const choices = [
      { label: "Change", value: "change" },
      { label: "Fire", value: "fire" },
    ];

    expect(findMatchInChoices(choices, [domainEngine("fire-rm")])).toBe(choices[1]);
  });

  it("matches a domain choice by slugified label when the value differs", () => {
    const choices = [{ label: "Fire", value: "some-uuid" }];

    expect(findMatchInChoices(choices, [domainEngine("fire-rm")])).toBe(choices[0]);
  });

  // Muse and adopted-ancestry selections arrive as CustomDemiplaneEngine
  // overrides, matched by the engine name path rather than type.
  function museEngine(slug) {
    return {
      id: `muse-${slug}`,
      name: `tabula/class-feature/${slug}.eng`,
      type: "CustomDemiplaneEngine",
      args: { slug },
    };
  }

  function adoptedAncestryEngine(slug) {
    return {
      id: `adopted-${slug}`,
      name: "core/selection/ancestry/custom-selection/index.eng",
      type: "DemiplaneEngine",
      args: { slug },
    };
  }

  it("matches the bard muse choice, stripping the -archetype-rm suffix", () => {
    const choices = [
      { label: "Enigma", value: "enigma" },
      { label: "Maestro", value: "maestro" },
      { label: "Polymath", value: "polymath" },
    ];

    expect(findMatchInChoices(choices, [museEngine("enigma-archetype-rm")])).toBe(choices[0]);
  });

  it("does not match a muse the character didn't take", () => {
    const choices = [{ label: "Maestro", value: "maestro" }];

    expect(findMatchInChoices(choices, [museEngine("enigma-archetype-rm")])).toBeNull();
  });

  it("matches the Adopted Ancestry choice (human-rm -> human)", () => {
    const choices = [
      { label: "Elf", value: "elf" },
      { label: "Human", value: "human" },
    ];

    expect(findMatchInChoices(choices, [adoptedAncestryEngine("human-rm")])).toBe(choices[1]);
  });

  // An ancestry weapon choice (Clan Dagger vs Clan Pistol): the chosen weapon is
  // present as an element-granted tabula/item engine (it carries a sourceData
  // block naming the granting ancestry), and the option value is a compendium
  // UUID, so only the label identifies it.
  function grantedItemEngine(slug) {
    return {
      id: `item-${slug}`,
      name: `tabula/item/${slug}.eng`,
      type: "DemiplaneEngine",
      args: { slug, sourceData: { category: "ancestry", engineID: "dwarf-engine" } },
    };
  }

  // A player-added item carries no sourceData (it has sourceRow
  // "manual-sheet-drawer"); it must not resolve an element's grant ChoiceSet.
  function manualItemEngine(slug) {
    return {
      id: `item-${slug}`,
      name: `tabula/item/${slug}.eng`,
      type: "DemiplaneEngine",
      args: { slug, sourceRow: "manual-sheet-drawer" },
    };
  }

  it("matches an ancestry item choice by label when the value is a compendium UUID", () => {
    const choices = [
      { label: "Clan Dagger", value: "Compendium.pf2e.equipment-srd.Item.cd" },
      { label: "Clan Pistol", value: "Compendium.pf2e.equipment-srd.Item.cp" },
    ];

    expect(findMatchInChoices(choices, [grantedItemEngine("clan-dagger-rm")])).toBe(choices[0]);
  });

  it("matches an item choice by slug value when the ChoiceSet is slug-valued", () => {
    const choices = [{ label: "Clan Dagger", value: "clan-dagger" }];

    expect(findMatchInChoices(choices, [grantedItemEngine("clan-dagger-rm")])).toBe(choices[0]);
  });

  it("does not match an item choice the character doesn't own", () => {
    const choices = [{ label: "Clan Pistol", value: "Compendium.pf2e.equipment-srd.Item.cp" }];

    expect(findMatchInChoices(choices, [grantedItemEngine("clan-dagger-rm")])).toBeNull();
  });

  it("ignores a manually-added item when resolving an element's grant choice", () => {
    const choices = [
      { label: "Clan Dagger", value: "Compendium.pf2e.equipment-srd.Item.cd" },
      { label: "Clan Pistol", value: "Compendium.pf2e.equipment-srd.Item.cp" },
    ];

    // The character bought a Clan Dagger by hand, but the ancestry didn't grant
    // one — the grant ChoiceSet must not be resolved off manual inventory.
    expect(findMatchInChoices(choices, [manualItemEngine("clan-dagger-rm")])).toBeNull();
  });

  // A background (Total Power) that grants a fixed feat Foundry models as a
  // choice ("Blasting Beams" vs "Bone Spikes"). The granting element's
  // definition names the feat outright, keyed by the element slug.
  function grantedFeats(elementSlug, feats) {
    return new Map([[elementSlug, new Set(feats)]]);
  }

  it("matches a granted feat by label when the element grants it outright", () => {
    const choices = [
      { label: "Blasting Beams", value: "Compendium.pf2e.feats-srd.Item.Blasting Beams" },
      { label: "Bone Spikes", value: "Compendium.pf2e.feats-srd.Item.Bone Spikes" },
    ];
    const map = grantedFeats("total-power", ["bone-spikes", "intimidating-glare"]);

    expect(findMatchInChoices(choices, [], "Total Power", map)).toBe(choices[1]);
  });

  it("matches a granted feat by slug value when the ChoiceSet is slug-valued", () => {
    const choices = [
      { label: "Blasting Beams", value: "blasting-beams" },
      { label: "Bone Spikes", value: "bone-spikes" },
    ];
    const map = grantedFeats("total-power", ["bone-spikes"]);

    expect(findMatchInChoices(choices, [], "Total Power", map)).toBe(choices[1]);
  });

  it("ignores granted feats when the ChoiceSet item is a different element", () => {
    const choices = [
      { label: "Blasting Beams", value: "Compendium.pf2e.feats-srd.Item.Blasting Beams" },
      { label: "Bone Spikes", value: "Compendium.pf2e.feats-srd.Item.Bone Spikes" },
    ];
    const map = grantedFeats("some-other-background", ["bone-spikes"]);

    expect(findMatchInChoices(choices, [], "Total Power", map)).toBeNull();
  });

  it("does not resolve when neither option is a granted feat", () => {
    const choices = [
      { label: "Blasting Beams", value: "Compendium.pf2e.feats-srd.Item.Blasting Beams" },
      { label: "Titan Swing", value: "Compendium.pf2e.feats-srd.Item.Titan Swing" },
    ];
    const map = grantedFeats("total-power", ["bone-spikes"]);

    expect(findMatchInChoices(choices, [], "Total Power", map)).toBeNull();
  });
});
