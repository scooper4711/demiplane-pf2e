import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
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
    const repertoire = result.spellcasting.find((e) => e.prepared === "spontaneous" && e.tradition === "primal");
    expect(repertoire).toBeDefined();
    expect(repertoire!.name).toBe("Summoner Spells (Primal)");
    expect(repertoire!.spells).toEqual([
      "500-toads",
      "approximate",
      "caustic-blast",
      "create-earthen-facsimile",
      "deep-breath",
      "detect-magic",
    ]);
  });

  test("applies slot maximums with the cast rank-1 slot spent", () => {
    const repertoire = result.spellcasting.find((e) => e.prepared === "spontaneous" && e.tradition === "primal");
    expect(repertoire).toBeDefined();
    // NOTE: Demiplane models summoner cantrips nowhere, so the import mirrors
    // the sheet and counts the five known cantrips. The single rank-1 slot
    // resolves from the summoner-spellcasting feature definition; its zero
    // remaining count is the cast 500 Toads (session state).
    expect(repertoire!.slots.slot0).toMatchObject({ max: 5, value: 5 });
    expect(repertoire!.slots.slot1).toMatchObject({ max: 1, value: 0 });
  });

  test("files the heritage spell as innate", () => {
    // Bramble Bush comes from the awakened-animal heritage (a select-spell
    // without a school marker), consistent with dedication cantrips.
    const innateEntries = result.spellcasting.filter((e) => e.prepared === "innate");
    expect(innateEntries).toHaveLength(1);
    expect(innateEntries[0]!.spells).toEqual(["bramble-bush"]);
  });

  test("files the link cantrips in a focus entry and imports the focus pool", () => {
    // Boost Eidolon and Evolution Surge have no engines — they resolve from
    // the cached link-spells definition — and the class grants the focus
    // point.
    const focusEntry = result.spellcasting.find((e) => e.prepared === "focus");
    expect(focusEntry).toBeDefined();
    expect(focusEntry!.name).toBe("Link Spells");
    expect(focusEntry!.tradition).toBe("primal");
    expect(focusEntry!.spells).toEqual(["boost-eidolon", "evolution-surge"]);
    expect(result.focus.value).toBe(1);
    expect(result.focus.max).toBe(1);
    expect(result.standaloneSpells).toEqual([]);
  });
});
