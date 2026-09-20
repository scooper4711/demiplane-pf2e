import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
} from "./helpers.js";

const CHARACTER_UUID = process.env.COMMANDER_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Commander Import Test";

test.describe("Commander Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Bard suite. Values below snapshot the reference character
  // (level-1 orc commander "FVTT Commander"); update them if the character is
  // rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and COMMANDER_UUID env vars required");

  let result: Awaited<ReturnType<typeof createAndImportCharacter>>;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "commander");
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
    expect(result.name).toBe("FVTT Commander");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Orc");
    expect(result.heritage).toBe("Hold-Scarred Orc");
    expect(result.background).toBe("Warrior");
    expect(result.class).toBe("Commander");
  });

  test("imports feats and tactics", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of ["Orc Ferocity", "Combat Assessment", "Commander's Banner", "Tactics"]) {
      expect(names).toContain(feat);
    }
  });

  test("imports warfare lore and languages", () => {
    expect(result.loreSkills).toEqual(["Warfare Lore"]);
    expect(result.languages).toEqual(["common", "orcish", "dwarven", "elven", "goblin", "jotun"]);
  });

  test("imports hit points and currency", () => {
    expect(result.hp.value).toBe(21);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 1, sp: 0, cp: 0 });
  });

  test("imports equipment with containers", () => {
    const names = result.equipment.map((i) => i.name);
    expect(names).toContain("Halberd");
    expect(names).toContain("Breastplate");
    expect(names).toContain("Backpack");
    const stowed = result.equipment.filter((i) => i.carryType === "stowed");
    expect(stowed.length).toBeGreaterThan(0);
  });
});
