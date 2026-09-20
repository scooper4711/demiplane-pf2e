import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  expectSpellcastingEntries,
  stopCoverage,
  type ImportResult,
} from "./helpers.js";

const CHARACTER_UUID = process.env.SUMMONER_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Summoner Import Test";

test.describe("Summoner Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Animist suite. Values below snapshot the reference character
  // (level-1 beast-eidolon summoner "FVTT Summoner"); update them if the
  // character is rebuilt on Demiplane. The eidolon itself is a separate
  // Foundry actor and out of scope for v1.0, as is Beast's Charge (eidolon-side).
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and SUMMONER_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "summoner");
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    await page.close();
  });

  test("reports no import errors", () => {
    expect(result.summary.itemsSkipped).toBe(0);
    expect(result.summary.errors).toEqual([]);
  });

  test("correct name, level, ancestry, background, class", () => {
    expect(result.name).toBe("FVTT Summoner");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Awakened Animal");
    expect(result.heritage).toBe("Running Animal");
    expect(result.background).toBe("Acrobat");
    expect(result.class).toBe("Summoner");
  });

  test("imports feats and resolves the eidolon and evolution picks", () => {
    // The Eidolon ChoiceSet resolves to Beast (not the alphabetical-first
    // Aberrant) and Evolution Feat to the taken Energy Heart.
    const names = result.feats.map((f) => f.name);
    for (const feat of [
      "Awakened Mind",
      "Awakened Form",
      "Animal Attack",
      "Steady Balance",
      "Beast Eidolon",
      "Energy Heart",
      "Link Spells",
      "Awakened Magic",
    ]) {
      expect(names).toContain(feat);
    }
  });

  test("imports the focus pool and no standalone spells", () => {
    expect(result.focus.value).toBe(1);
    expect(result.focus.max).toBe(1);
    expect(result.standaloneSpells).toEqual([]);
  });

  test("imports circus lore and languages", () => {
    expect(result.loreSkills).toEqual(["Circus Lore"]);
    expect(result.languages).toEqual(["common", "fey"]);
  });

  test("imports hit points and empty purse", () => {
    // Current HP synced from Demiplane; the max is system-derived.
    expect(result.hp.value).toBe(22);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
    expect(result.equipment).toEqual([]);
  });

  test("files the repertoire in a spontaneous primal entry", () => {
    // NOTE: Demiplane models summoner cantrips nowhere, so the import mirrors
    // the sheet and counts the five known cantrips. The single rank-1 slot
    // resolves from the summoner-spellcasting feature definition; its zero
    // remaining count is the cast 500 Toads (session state).
    expectSpellcastingEntries(result, [
      {
        name: "Summoner Spells (Primal)",
        prepared: "spontaneous",
        tradition: "primal",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: [
          "500-toads",
          "approximate",
          "caustic-blast",
          "create-earthen-facsimile",
          "deep-breath",
          "detect-magic",
        ],
        slots: { slot0: { max: 5, value: 5 }, slot1: { max: 1, value: 0 } },
      },
      {
        // Bramble Bush comes from the awakened-animal heritage (a select-spell
        // without a school marker), consistent with dedication cantrips.
        name: "Awakened Magic (Innate)",
        prepared: "innate",
        tradition: "primal",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["bramble-bush"],
      },
      {
        // Boost Eidolon and Evolution Surge have no engines — they resolve
        // from the cached link-spells definition — and the class grants the
        // focus point.
        name: "Link Spells",
        prepared: "focus",
        tradition: "primal",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["boost-eidolon", "evolution-surge"],
      },
    ]);
  });
});
