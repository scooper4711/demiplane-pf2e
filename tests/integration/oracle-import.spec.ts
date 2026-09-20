import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  expectSpellcastingEntries,
  stopCoverage,
} from "./helpers.js";

const CHARACTER_UUID = process.env.ORACLE_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Oracle Import Test";

test.describe("Oracle Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Bard suite. Values below snapshot the reference character
  // (level-1 Ashes oracle "FVTT Oracle"); update them if the character is
  // rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and ORACLE_UUID env vars required");

  let result: Awaited<ReturnType<typeof createAndImportCharacter>>;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "oracle");
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
    expect(result.name).toBe("FVTT Oracle");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Tengu");
    expect(result.heritage).toBe("Skyborn Tengu");
    expect(result.background).toBe("Astrologer");
    expect(result.class).toBe("Oracle");
  });

  test("files the repertoire in a spontaneous divine entry", () => {
    // Player-chosen cantrips (rank 0) and rank-1 spells plus the Ashes
    // mystery grants (ignition cantrip, breathe fire rank 1) all join one
    // spontaneous divine repertoire. Level-1 oracle progression (5 cantrips,
    // 3 rank-1); nothing cast, so every slot is full.
    expectSpellcastingEntries(result, [
      {
        name: "Oracle Spells (Divine)",
        prepared: "spontaneous",
        tradition: "divine",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: [
          "breathe-fire",
          "defended-by-spirits",
          "detect-poison",
          "guidance",
          "haunting-hymn",
          "ignition",
          "illuminate",
          "inside-ropes",
          "invoke-true-name",
        ],
        slots: { slot0: { max: 5, value: 5 }, slot1: { max: 3, value: 3 } },
      },
      {
        // Ashen Wind is the Ashes initial revelation spell — the only focus
        // spell from that feature. The mystery's repertoire grants (ignition,
        // breathe fire) belong in the spontaneous entry above, never here.
        name: "Revelation Spells",
        prepared: "focus",
        tradition: "divine",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["ashen-wind"],
      },
    ]);
  });

  test("does not leak repertoire spells into the focus entry", () => {
    const revelations = result.spellcasting.find((e) => e.name === "Revelation Spells");
    expect(revelations).toBeDefined();
    for (const leaked of ["breathe-fire", "ignition"]) {
      expect(revelations!.spells).not.toContain(leaked);
    }
  });

  test("imports the focus pool", () => {
    expect(result.focus.value).toBe(1);
    expect(result.focus.max).toBe(1);
  });
});
