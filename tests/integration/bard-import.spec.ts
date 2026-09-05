import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  createAndImportCharacter,
  stopCoverage,
  type ImportResult,
} from "./helpers.js";

const CHARACTER_UUID = process.env.BARD_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Bard Import Test";

test.describe("Bard Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Valeros suite. Languages are reset by
  // scripts/reset-test-characters.mjs; values below snapshot that setup.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and BARD_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "bard");
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

  test("imports a named, leveled character", () => {
    expect(result.name.length).toBeGreaterThan(0);
    expect(result.level).toBeGreaterThan(0);
    expect(result.totalItems).toBeGreaterThan(0);
  });

  test("imports ancestry, background, and class", () => {
    expect(result.ancestry).not.toBeNull();
    expect(result.background).not.toBeNull();
    expect(result.class).not.toBeNull();
  });
});
