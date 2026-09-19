import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
  type ImportResult,
} from "./helpers.js";

const CHARACTER_UUID = process.env.KINETICIST_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Kineticist Import Test";

test.describe("Kineticist Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Animist suite. Values below snapshot the reference character
  // (level-17 dual-gate kineticist "FVTT Kineticist", gates Air/Fire at 1 with
  // Fork the Path at every junction: wood 5, water 9, earth 13, metal 17);
  // update them if the character is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and KINETICIST_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "kineticist");
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    await page.close();
  });

  test("reports no import errors and nothing needing input", () => {
    // All five previously-unresolved ChoiceSets (gate + four thresholds)
    // resolve from Demiplane data — the dialog stays empty.
    expect(result.summary.itemsSkipped).toBe(0);
    expect(result.summary.errors).toEqual([]);
    expect(result.summary.unresolvedChoices).toEqual([]);
  });

  test("correct name, level, ancestry, background, class", () => {
    expect(result.name).toBe("FVTT Kineticist");
    expect(result.level).toBe(17);
    expect(result.ancestry).toBe("Dwarf");
    expect(result.heritage).toBe("Forge Dwarf");
    expect(result.background).toBe("Barkeep");
    expect(result.class).toBe("Kineticist");
  });

  test("imports all six gates", () => {
    // Dual Gate (air, fire) at 1 plus one gate per forked junction. Each gate
    // item arrives through its ChoiceSet (elementOne/Two/Fork) and native
    // GrantItem — none defaulted.
    const names = result.feats.map((f) => f.name);
    for (const gate of ["Air Gate", "Fire Gate", "Wood Gate", "Water Gate", "Earth Gate", "Metal Gate"]) {
      expect(names).toContain(gate);
    }
  });

  test("imports every junction as Fork the Path", () => {
    const names = result.feats.map((f) => f.name);
    for (const threshold of [
      "Gate's Threshold (Fork the Path)",
      "Second Gate's Threshold (Fork the Path)",
      "Third Gate's Threshold (Fork the Path)",
      "Fourth Gate's Threshold (Fork the Path)",
    ]) {
      expect(names).toContain(threshold);
    }
  });

  test("imports the taken impulses per gate", () => {
    // Impulse feats resolve through their gates' ChoiceSets (scoped
    // select-feat matching): air, fire, wood, water, earth, and metal.
    const names = result.feats.map((f) => f.name);
    for (const impulse of [
      "Four Winds",
      "Whisper on the Wind",
      "Flying Flame",
      "Ravel of Thorns",
      "Call the Hurricane",
      "Rock Rampart",
      "Alloy Flesh and Steel",
    ]) {
      expect(names).toContain(impulse);
    }
  });

  test("imports alcohol lore and languages", () => {
    expect(result.loreSkills).toEqual(["Alcohol Lore"]);
    expect(result.languages).toEqual(["common", "dwarven"]);
  });

  test("imports hit points and empty purse", () => {
    // Current HP synced from Demiplane; the max is system-derived.
    expect(result.hp.value).toBe(231);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
  });
});
