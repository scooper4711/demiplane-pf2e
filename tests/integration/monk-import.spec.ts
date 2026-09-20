import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
} from "./helpers.js";

const CHARACTER_UUID = process.env.MONK_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Monk Import Test";

test.describe("Monk Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Bard suite. Values below snapshot the reference character
  // (level-4 wild-mimic monk "FVTT Monk"); update them if the character is
  // rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and MONK_UUID env vars required");

  let result: Awaited<ReturnType<typeof createAndImportCharacter>>;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "monk");
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
    expect(result.name).toBe("FVTT Monk");
    expect(result.level).toBe(4);
    expect(result.ancestry).toBe("Human");
    expect(result.heritage).toBe("Versatile Human");
    expect(result.background).toBe("Martial Disciple");
    expect(result.class).toBe("Monk");
  });

  test("imports feats", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of [
      "Natural Ambition",
      "Tiger Stance",
      "Qi Spells",
      "Canny Acumen (Will)",
      "Automatic Knowledge",
      "Ancestral Paragon",
      "General Training",
      "Weapon Proficiency",
      "Wild Mimic Dedication",
      "Rend Mimicry",
      "Kreighton's Cognitive Crossover",
      "Flurry of Blows",
      "Powerful Fist",
      "Mystic Strikes",
      "Incredible Movement",
      "Quick Jump",
    ]) {
      expect(names).toContain(feat);
    }
  });

  test("files the chosen qi spell in a focus Qi Spells entry", () => {
    // Qi Rush is picked through the qi-spells builder row — a focus spell,
    // not an innate spell.
    const qi = result.spellcasting.find((e) => e.name === "Qi Spells");
    expect(qi).toBeDefined();
    expect(qi!.prepared).toBe("focus");
    expect(qi!.tradition).toBe("occult");
    expect(qi!.spells).toEqual(["qi-rush"]);
  });

  test("files no innate spells", () => {
    expect(result.spellcasting.filter((e) => e.prepared === "innate")).toHaveLength(0);
  });

  test("imports the focus pool", () => {
    expect(result.focus.value).toBe(1);
    expect(result.focus.max).toBe(1);
  });

  test("imports warfare lore and languages", () => {
    expect(result.loreSkills).toEqual(["Warfare Lore"]);
    expect(result.languages).toEqual(["common"]);
  });

  test("imports hit points and currency", () => {
    // Current HP synced from Demiplane; the max is system-derived.
    expect(result.hp.value).toBe(52);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 175, sp: 11, cp: 0 });
  });

  test("imports equipment with runes, flagging the two unmapped items", () => {
    // The handwraps and the beginner-box invisibility potion are absent from
    // this world's compendiums — asserted so the gap stays visible.
    const names = result.equipment.map((i) => i.name);
    expect(names).toContain("+1 Striking Bow Staff");
    expect(names).toContain("+1 Resilient Explorer's Clothing");
    expect(names).toContain("Wayfinder");
    expect(result.summary.unmapped).toContainEqual({ slug: "handwraps-of-mighty-blows-1-rm", kind: "equipment" });
    expect(result.summary.unmapped).toContainEqual({
      slug: "invisibility-potion-beginner-box",
      kind: "equipment",
    });
    const staff = result.equipment.find((i) => i.name === "+1 Striking Bow Staff");
    expect(staff!.runes).toMatchObject({ potency: 1, striking: 1 });
  });

  test("resolves every choice without leftovers", () => {
    // Canny Acumen (Will), Kreighton's skills, and the Natural Ambition /
    // Versatile Human feat chains all match — nothing falls back to a guess.
    expect(result.summary.unresolvedChoices).toEqual([]);
  });
});
