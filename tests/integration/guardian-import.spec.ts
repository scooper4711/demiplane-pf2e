import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
} from "./helpers.js";

const CHARACTER_UUID = process.env.GUARDIAN_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Guardian Import Test";

test.describe("Guardian Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Bard suite. Values below snapshot the reference character
  // (level-1 jotunborn guardian "FVTT Guardian"); update them if the
  // character is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and GUARDIAN_UUID env vars required");

  let result: Awaited<ReturnType<typeof createAndImportCharacter>>;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "guardian");
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
    expect(result.name).toBe("FVTT Guardian");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Jotunborn");
    expect(result.heritage).toBe("Keeper Jotunborn");
    expect(result.background).toBe("Nomad");
    expect(result.class).toBe("Guardian");
  });

  test("imports feats and techniques", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of [
      "Caretaker's Intuition",
      "Long-Distance Taunt",
      "Taunt",
      "Guardian's Techniques",
      "Guardian's Armor",
      "Assurance (Survival)",
    ]) {
      expect(names).toContain(feat);
    }
  });

  test("imports fray lore and languages", () => {
    expect(result.loreSkills).toEqual(["Fray"]);
    expect(result.languages).toEqual(["common", "jotun"]);
  });

  test("imports hit points and currency", () => {
    // One point of damage on Demiplane; the max is system-derived.
    expect(result.hp.value).toBe(24);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 1, sp: 0, cp: 0 });
  });

  test("imports equipment", () => {
    const names = result.equipment.map((i) => i.name);
    expect(names).toContain("War Flail");
    expect(names).toContain("Breastplate");
  });
});
