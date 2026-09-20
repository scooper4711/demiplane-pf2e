import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
} from "./helpers.js";

const CHARACTER_UUID = process.env.INVENTOR_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Inventor Import Test";

test.describe("Inventor Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Bard suite. Values below snapshot the reference character
  // (level-1 armor inventor "FVTT Armor Inventor"); update them if the
  // character is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and INVENTOR_UUID env vars required");

  let result: Awaited<ReturnType<typeof createAndImportCharacter>>;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "inventor");
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
    expect(result.name).toBe("FVTT Armor Inventor");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Automaton");
    expect(result.heritage).toBe("Defensive Automaton");
    expect(result.background).toBe("Aeronaut");
    expect(result.class).toBe("Inventor");
  });

  test("imports feats and the innovation", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of ["Tamper", "Energy Beam", "Armor Innovation", "Otherworldly Protection"]) {
      expect(names).toContain(feat);
    }
  });

  test("imports the power suit", () => {
    const names = result.equipment.map((i) => i.name);
    expect(names).toContain("Power Suit");
  });

  test("resolves every choice without leftovers", () => {
    // The armor statistics pick (Power Suit over Subterfuge Suit) matches by
    // engine slug — nothing falls back to a guess.
    expect(result.summary.unresolvedChoices).toEqual([]);
  });

  test("imports piloting lore and languages", () => {
    expect(result.loreSkills).toEqual(["Piloting Lore"]);
    expect(result.languages).toEqual(["common", "utopian"]);
  });

  test("imports hit points and empty purse", () => {
    expect(result.hp.value).toBe(20);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
  });
});
