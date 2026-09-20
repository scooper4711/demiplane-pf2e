import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
} from "./helpers.js";

const CHARACTER_UUID = process.env.RANGER_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Ranger Import Test";

test.describe("Ranger Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Bard suite. Values below snapshot the reference character
  // (level-1 vindicator ranger "FVTT Ranger"); update them if the character
  // is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and RANGER_UUID env vars required");

  let result: Awaited<ReturnType<typeof createAndImportCharacter>>;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "ranger");
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
    expect(result.name).toBe("FVTT Ranger");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Hobgoblin");
    expect(result.heritage).toBe("Warmarch Hobgoblin");
    expect(result.background).toBe("Animal Whisperer");
    expect(result.class).toBe("Ranger");
  });

  test("imports feats and the vindicator edge", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of ["Hobgoblin Lore", "Initiate Warden", "Vindicator"]) {
      expect(names).toContain(feat);
    }
  });

  test("imports the vindicator deity and holy sanctification", () => {
    // Abadar comes through the archetype's deity selection, and the holy
    // sanctification is an explicitly recorded generic-choice pick — both
    // resolve silently with nothing left over.
    expect(result.deity).toBe("Abadar");
    expect(result.summary.unresolvedChoices).toEqual([]);
  });

  test("files the warden spell in a divine focus Warden Spells entry", () => {
    // Distracting Decoy is picked through the warden-spell builder row — a
    // focus spell, not an innate spell. Warden spells are normally primal,
    // but this vindication-edge ranger's are divine.
    const warden = result.spellcasting.find((e) => e.name === "Warden Spells");
    expect(warden).toBeDefined();
    expect(warden!.prepared).toBe("focus");
    expect(warden!.tradition).toBe("divine");
    expect(warden!.spells).toEqual(["distracting-decoy"]);
  });

  test("files the vindication focus spell alongside the warden spell", () => {
    // Vindicator's Mark arrives through the vindication edge definition (the
    // hunter's-edge grant), not the character's engines. It is its own focus
    // spell rather than a warden spell, so it files in a generic focus entry
    // sharing the warden entry's divine tradition.
    const focusEntries = result.spellcasting.filter((e) => e.prepared === "focus");
    const names = focusEntries.map((e) => e.name).sort();
    expect(names).toEqual(["Focus Spells", "Warden Spells"]);
    const mark = focusEntries.find((e) => e.spells.includes("vindicators-mark"));
    expect(mark).toBeDefined();
    expect(mark!.tradition).toBe("divine");
    expect(mark!.spells).toEqual(["vindicators-mark"]);
  });

  test("files no innate spells", () => {
    expect(result.spellcasting.filter((e) => e.prepared === "innate")).toHaveLength(0);
  });

  test("imports demiplane lore and languages", () => {
    expect(result.loreSkills).toEqual(["Demiplane Lore"]);
    expect(result.languages).toEqual(["common", "goblin"]);
  });

  test("imports hit points and empty purse", () => {
    expect(result.hp.value).toBe(20);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
  });
});
