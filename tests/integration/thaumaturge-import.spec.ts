import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
} from "./helpers.js";

const CHARACTER_UUID = process.env.THAUMATURGE_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Thaumaturge Import Test";

test.describe("Thaumaturge Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Bard suite. Values below snapshot the reference character
  // (level-2 amulet thaumaturge "FVTT Thaumaturge"); update them if the
  // character is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and THAUMATURGE_UUID env vars required");

  let result: Awaited<ReturnType<typeof createAndImportCharacter>>;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "thaumaturge");
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
    expect(result.name).toBe("FVTT Thaumaturge");
    expect(result.level).toBe(2);
    expect(result.ancestry).toBe("Gnome");
    expect(result.heritage).toBe("Dromaar");
    expect(result.background).toBe("Back-Alley Doctor");
    expect(result.class).toBe("Thaumaturge");
  });

  test("imports feats", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of ["Root to Life", "Turn Away Misfortune", "Orc Ferocity", "Vasodilation"]) {
      expect(names).toContain(feat);
    }
  });

  test("imports the amulet implement and its benefits", () => {
    // The first-implement choice resolves to Amulet through the class
    // feature engine, bringing its initiate benefit and empowerment.
    const names = result.feats.map((f) => f.name);
    for (const feat of [
      "First Implement and Esoterica",
      "Amulet",
      "Initiate Benefit (Amulet)",
      "Implement's Empowerment",
    ]) {
      expect(names).toContain(feat);
    }
  });

  test("imports underworld lore and languages", () => {
    expect(result.loreSkills).toEqual(["Underworld Lore"]);
    expect(result.languages).toEqual(["common", "fey", "gnomish"]);
  });

  test("imports hit points and empty purse", () => {
    expect(result.hp.value).toBe(30);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
  });

  test("leaves no gaps", () => {
    expect(result.summary.unmapped).toEqual([]);
    expect(result.summary.unresolvedChoices).toEqual([]);
    expect(result.spellcasting).toEqual([]);
  });
});
