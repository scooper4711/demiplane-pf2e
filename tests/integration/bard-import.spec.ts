import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  expectSpellcastingEntries,
  stopCoverage,
  type ImportResult,
} from "./helpers.js";

const CHARACTER_UUID = process.env.BARD_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Bard Import Test";

test.describe("Bard Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Valeros suite. Languages are reset by
  // scripts/reset-test-characters.mjs; values below snapshot that setup.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and BARD_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "bard");
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    await page.close();
  });

  test("no import errors", () => {
    expect(result.summary.errors).toHaveLength(0);
    expect(result.summary.itemsSkipped).toBe(0);
  });

  test("imports a named, leveled character", () => {
    expect(result.name.length).toBeGreaterThan(0);
    expect(result.level).toBeGreaterThan(0);
    expect(result.totalItems).toBeGreaterThan(0);
  });

  test("imports ancestry, background, and class", () => {
    expect(result.ancestry).not.toBeNull();
    expect(result.background).not.toBeNull();
    expect(result.class).not.toBeNull();
  });

  test("files the bard repertoire in a spontaneous occult entry", () => {
    // Demiplane "Bard spellcasting" plus the rank-1 spontaneous spells (Alarm,
    // Soothe, Animate Rope) all join one repertoire, including the Maestro
    // muse's granted Soothe.
    expectSpellcastingEntries(result, [
      {
        name: "Bard Spells (Occult)",
        prepared: "spontaneous",
        tradition: "occult",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: [
          "alarm",
          "animate-rope",
          "bullhorn",
          "detect-metal",
          "forbidding-ward",
          "haunting-hymn",
          "infectious-enthusiasm",
          "soothe",
        ],
      },
      {
        // Counter Performance and Lingering Composition are focus spells;
        // Courageous Anthem is a cantrip but belongs to the composition group.
        name: "Composition Spells",
        prepared: "focus",
        tradition: "occult",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["counter-performance", "courageous-anthem", "lingering-composition"],
      },
      {
        // The Seer Elf grant names the arcane tradition outright.
        name: "Innate Spells",
        prepared: "innate",
        tradition: "arcane",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["detect-magic"],
      },
    ]);
  });

  test("imports the focus pool state", () => {
    // Two focus points on Demiplane, one currently available.
    expect(result.focus.value).toBe(1);
    expect(result.focus.max).toBe(2);
  });
});
