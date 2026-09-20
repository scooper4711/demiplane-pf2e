import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  setFreeArchetype,
  stopCoverage,
} from "./helpers.js";

const CHARACTER_UUID = process.env.RUNESMITH_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Runesmith Import Test";

test.describe("Runesmith Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Bard suite. Values below snapshot the reference character
  // (level-1 catfolk runesmith "FVTT Runesmith"); update them if the
  // character is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and RUNESMITH_UUID env vars required");

  let result: Awaited<ReturnType<typeof createAndImportCharacter>>;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    // The character builder has Free Archetype enabled; match it for the
    // import and restore the world default in afterAll.
    await setFreeArchetype(page, true);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "runesmith");
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    await setFreeArchetype(page, false);
    await page.close();
  });

  test("reports no import errors", () => {
    expect(result.summary.itemsSkipped).toBe(0);
    expect(result.summary.errors).toEqual([]);
  });

  test("correct name, level, ancestry, background, class", () => {
    expect(result.name).toBe("FVTT Runesmith");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Catfolk");
    expect(result.heritage).toBe("Flexible Catfolk");
    expect(result.background).toBe("Alloysmith");
    expect(result.class).toBe("Runesmith");
  });

  test("imports feats and class features", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of ["Rune Ward", "Cat Nap", "Runic Repertoire", "Runes"]) {
      expect(names).toContain(feat);
    }
  });

  test("flags the runic repertoire as unmapped", () => {
    // Runes need the runesmith companion module to resolve — without it every
    // rune surfaces as unmapped rather than vanishing. One entry per chosen
    // rune (including repeats).
    const slugs = result.summary.unmapped.map((u) => u.slug).sort();
    expect(slugs).toEqual([
      "atryl-rune-of-fire-rm",
      "atryl-rune-of-fire-rm",
      "esvadir-rune-of-whetstones-rm",
      "marssyl-rune-of-impact-rm",
      "marssyl-rune-of-impact-rm",
      "marssyl-rune-of-impact-rm",
      "tilus-rune-of-vocabulary-rm",
      "tilus-rune-of-vocabulary-rm",
    ]);
  });

  test("imports plane-of-metal lore and languages", () => {
    expect(result.loreSkills).toEqual(["Plane of Metal Lore"]);
    expect(result.languages).toEqual(["amurrun", "common"]);
  });

  test("imports hit points and empty purse", () => {
    expect(result.hp.value).toBe(17);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
  });
});
