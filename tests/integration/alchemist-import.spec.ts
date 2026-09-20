import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
} from "./helpers.js";

const CHARACTER_UUID = process.env.ALCHEMIST_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Alchemist Import Test";

test.describe("Alchemist Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Bard suite. Values below snapshot the reference character
  // (level-1 bomber alchemist "FVTT Alchemist"); update them if the
  // character is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and ALCHEMIST_UUID env vars required");

  let result: Awaited<ReturnType<typeof createAndImportCharacter>>;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "alchemist");
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
    expect(result.name).toBe("FVTT Alchemist");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Jotunborn");
    expect(result.heritage).toBe("Keeper Jotunborn");
    expect(result.background).toBe("Aeronaut");
    expect(result.class).toBe("Alchemist");
  });

  test("imports feats and the bomber research field", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of ["Jotunborn Lore", "Far Lobber", "Bomber"]) {
      expect(names).toContain(feat);
    }
  });

  test("files the formula book as crafting formulas, not inventory", () => {
    // Base-slug formulas resolve to their lesser compendium variants (the
    // compendium only carries leveled tiers for bombs and tools).
    for (const formula of [
      "Acid Flask (Lesser)",
      "Alchemical Fuse",
      "Alchemist's Fire (Lesser)",
      "Arsenic",
      "Blasting Stone (Lesser)",
      "Blight Bomb (Lesser)",
      "Bottled Lightning (Lesser)",
      "Frost Vial (Lesser)",
    ]) {
      expect(result.formulas).toContain(formula);
    }
    const equipmentNames = result.equipment.map((i) => i.name);
    // The reference character also carries a physical Acid Flask (Lesser) in
    // inventory now, so only the purely formula-book entries are asserted absent.
    for (const formula of ["Alchemist's Fire (Lesser)", "Bottled Lightning (Lesser)"]) {
      expect(equipmentNames).not.toContain(formula);
    }
  });

  test("imports tiered consumables as inventory, resized to the Large actor", () => {
    // The reference character carries physical acid flasks of every tier
    // (manual-sheet-drawer engines with variant slugs) alongside the
    // base-slug formula-book entry — inventory and formulas stay separate.
    const names = result.equipment.map((i) => i.name);
    for (const flask of [
      "Acid Flask (Lesser)",
      "Acid Flask (Moderate)",
      "Acid Flask (Greater)",
      "Acid Flask (Major)",
    ]) {
      expect(names).toContain(flask);
    }
    // Jotunborn are Large; equipment created before the ancestry item must
    // still end up Large rather than flagged as the wrong size.
    for (const item of result.equipment) {
      expect(item.size).toBe("lg");
    }
  });

  test("resolves every choice without leftovers", () => {
    expect(result.summary.unresolvedChoices).toEqual([]);
  });

  test("imports hit points and empty purse", () => {
    // Alchemist d8 + Jotunborn ancestry HP 10, Con 0.
    expect(result.hp.value).toBe(18);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
  });
});
