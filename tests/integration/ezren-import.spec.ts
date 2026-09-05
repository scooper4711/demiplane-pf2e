import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  createAndImportCharacter,
  stopCoverage,
  type ImportResult,
} from "./helpers.js";

const CHARACTER_UUID = process.env.EZREN_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Ezren Import Test";

test.describe("Ezren Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Valeros suite. Values below are a snapshot of the reference
  // character; update them if Ezren is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and EZREN_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "ezren");
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    await page.close();
  });

  test("no import errors", () => {
    expect(result.summary.errors).toHaveLength(0);
    expect(result.summary.itemsSkipped).toBe(0);
  });

  test("correct name, level, ancestry, background, class", () => {
    expect(result.name).toBe("Ezren");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Human");
    expect(result.heritage).toContain("Skilled Human");
    expect(result.background).toBe("Merchant");
    expect(result.class).toBe("Wizard");
  });

  test("imports signature feats", () => {
    const names = result.feats.map((f) => f.name);
    expect(names).toContain("Bargain Hunter");
    expect(names).toContain("Wizard Spellcasting");
    expect(names).toContain("Arcane Bond");
  });

  test("imports background lore and languages", () => {
    expect(result.loreSkills).toContain("Mercantile Lore");
    expect(result.languages).toEqual(["common", "draconic", "dwarven", "halfling", "sakvroth", "varisian"]);
  });

  test("imports hit points", () => {
    expect(result.hp.max).toBe(16);
  });
});
