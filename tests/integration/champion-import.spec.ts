import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
} from "./helpers.js";

const CHARACTER_UUID = process.env.CHAMPION_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Champion Import Test";

test.describe("Champion Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Bard suite. Values below snapshot the reference character
  // (level-1 justice champion "FVTT Champion"); update them if the character
  // is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and CHAMPION_UUID env vars required");

  let result: Awaited<ReturnType<typeof createAndImportCharacter>>;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "champion");
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
    expect(result.name).toBe("FVTT Champion");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Android");
    expect(result.background).toBeNull();
    expect(result.class).toBe("Champion");
  });

  test("imports the class feat and the deity", () => {
    const names = result.feats.map((f) => f.name);
    expect(names).toContain("Desperate Prayer");
    expect(result.deity).toBe("Iomedae");
  });

  test("files the chosen devotion spell in a focus Devotion Spells entry", () => {
    // Shields of the Spirit is picked through the devotion-spells builder
    // row — a focus spell, not an innate spell.
    const devotion = result.spellcasting.find((e) => e.name === "Devotion Spells");
    expect(devotion).toBeDefined();
    expect(devotion!.prepared).toBe("focus");
    expect(devotion!.tradition).toBe("divine");
    expect(devotion!.spells).toEqual(["shields-of-the-spirit"]);
  });

  test("files no innate spells", () => {
    expect(result.spellcasting.filter((e) => e.prepared === "innate")).toHaveLength(0);
  });

  test("imports the focus pool", () => {
    expect(result.focus.value).toBe(1);
    expect(result.focus.max).toBe(1);
  });
});
