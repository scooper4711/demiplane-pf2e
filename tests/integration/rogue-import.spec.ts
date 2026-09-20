import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
} from "./helpers.js";

const CHARACTER_UUID = process.env.ROGUE_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Rogue Import Test";

test.describe("Rogue Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Bard suite. Values below snapshot the reference character
  // (level-1 thief rogue "FVTT Merisiel"); update them if the character is
  // rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and ROGUE_UUID env vars required");

  let result: Awaited<ReturnType<typeof createAndImportCharacter>>;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "rogue");
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
    expect(result.name).toBe("FVTT Merisiel");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Elf");
    expect(result.heritage).toBe("Whisper Elf");
    expect(result.background).toBe("Criminal");
    expect(result.class).toBe("Rogue");
  });

  test("imports feats and the thief racket", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of ["Forlorn", "Trap Finder", "Cat Fall", "Thief", "Sneak Attack", "Surprise Attack"]) {
      expect(names).toContain(feat);
    }
  });

  test("imports underworld lore and languages", () => {
    expect(result.loreSkills).toEqual(["Underworld Lore"]);
    expect(result.languages).toEqual(["common", "elven"]);
  });

  test("imports hit points and pocket change", () => {
    expect(result.hp.value).toBe(15);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 5, cp: 5 });
  });

  test("imports equipment, flagging the missing leather armor", () => {
    // Leather armor is absent from this world's compendiums — asserted so
    // the gap stays visible (same gap as the animist's studded leather).
    const names = result.equipment.map((i) => i.name);
    expect(names).toContain("Rapier");
    expect(names).toContain("Shortbow");
    expect(names).toContain("Thieves' Toolkit");
    expect(result.summary.unmapped).toContainEqual({ slug: "leather-rm", kind: "equipment" });
  });
});
