import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
  type ImportResult,
} from "./helpers.js";

const CHARACTER_UUID = process.env.KYRA_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Kyra Import Test";

test.describe("Kyra Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Valeros suite. Values below are a snapshot of the reference
  // character; update them if Kyra is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and KYRA_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "kyra");
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    await page.close();
  });

  test("no import errors", () => {
    // Demiplane doesn't export deity sanctification, so the import defaults
    // to holy and flags it once. Everything else (including the Deity and
    // Domain Initiate ChoiceSets) resolves cleanly.
    expect(result.summary.errors).toHaveLength(1);
    expect(result.summary.errors[0]).toMatch(/sanctification.*holy/i);
    expect(result.summary.itemsSkipped).toBe(0);
  });

  test("correct name, level, ancestry, background, class", () => {
    expect(result.name).toBe("Kyra");
    expect(result.level).toBe(5);
    expect(result.ancestry).toBe("Human");
    expect(result.heritage).toContain("Versatile Human");
    expect(result.background).toBe("Acolyte");
    expect(result.class).toBe("Cleric");
  });

  test("imports signature feats", () => {
    const names = result.feats.map((f) => f.name);
    expect(names).toContain("Student of the Canon");
    expect(names).toContain("Cleric Spellcasting");
    // Resolved ChoiceSets rename the item like the UI does ("Feat (Choice)").
    expect(names).toContain("Divine Font (Healing)");
    expect(names).toContain("Domain Initiate (Fire)");
  });

  test("imports background lore and languages", () => {
    expect(result.loreSkills).toContain("Scribing Lore");
    expect(result.languages).toEqual(["common", "kelish"]);
  });

  test("imports hit points", () => {
    expect(result.hp.max).toBe(48);
  });
});
