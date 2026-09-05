import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
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
    // Unresolvable ChoiceSets fall back to defaults and are flagged as sync
    // issues by design (see "flag unresolved ChoiceSets" feature): Deity and
    // Domain Initiate cannot be matched from Demiplane's data.
    expect(result.summary.errors).toHaveLength(3);
    for (const error of result.summary.errors) {
      expect(error).toMatch(/Couldn't determine the choice for/);
    }
    expect(result.summary.errors.join("\n")).toContain("Deity (Cleric)");
    expect(result.summary.errors.join("\n")).toContain("Domain Initiate");
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
    expect(names).toContain("Divine Font");
    expect(names).toContain("Domain Initiate");
  });

  test("imports background lore and languages", () => {
    expect(result.loreSkills).toContain("Scribing Lore");
    expect(result.languages).toEqual(["common", "kelish"]);
  });

  test("imports hit points", () => {
    expect(result.hp.max).toBe(48);
  });
});
