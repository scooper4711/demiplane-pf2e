import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  createAndImportCharacter,
  stopCoverage,
  type ImportResult,
} from "./helpers.js";

const CHARACTER_UUID = process.env.LINI_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Lini Import Test";

test.describe("Lini Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Valeros suite. Values below are a snapshot of the reference
  // character; update them if Lini is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and LINI_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "lini");
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    await page.close();
  });

  test("no import errors", () => {
    // Unresolvable ChoiceSets fall back to defaults and are flagged as sync
    // issues by design: Druidic Order and Voice of Nature cannot be matched
    // from Demiplane's data (the Animal Order defaults are correct for Lini).
    expect(result.summary.errors).toHaveLength(2);
    for (const error of result.summary.errors) {
      expect(error).toMatch(/Couldn't determine the choice for/);
    }
    expect(result.summary.errors.join("\n")).toContain("Druidic Order");
    expect(result.summary.errors.join("\n")).toContain("Voice of Nature");
    expect(result.summary.itemsSkipped).toBe(0);
  });

  test("correct name, level, ancestry, background, class", () => {
    expect(result.name).toBe("Lini");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Gnome");
    expect(result.heritage).toContain("Sensate Gnome");
    expect(result.background).toBe("Herbalist");
    expect(result.class).toBe("Druid");
  });

  test("imports signature feats including custom-selection lore grant", () => {
    const names = result.feats.map((f) => f.name);
    expect(names).toContain("Natural Medicine");
    expect(names).toContain("Druid Spellcasting");
    expect(names).toContain("Gnome Obsession");
    expect(names).toContain("Additional Lore");
  });

  test("imports background and granted lore plus languages", () => {
    expect(result.loreSkills).toContain("Herbalism Lore");
    expect(result.loreSkills).toContain("Forest Lore");
    expect(result.languages).toEqual(["common", "fey", "gnomish", "wildsong"]);
  });

  test("imports hit points", () => {
    expect(result.hp.max).toBe(18);
  });
});
