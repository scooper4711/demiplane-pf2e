import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  expectSpellcastingEntries,
  setFreeArchetype,
  setGradualBoosts,
  setMythicRules,
  stopCoverage,
} from "./helpers.js";

const CHARACTER_UUID = process.env.EXEMPLAR_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Exemplar Import Test";

test.describe("Exemplar Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Bard suite. Values below snapshot the reference character
  // (level-2 mythic kitsune exemplar "FVTT Mythic Examplar"); update them if
  // the character is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and EXEMPLAR_UUID env vars required");

  let result: Awaited<ReturnType<typeof createAndImportCharacter>>;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    // This exemplar uses the Gradual Boosts, Mythic Rules, and Free Archetype
    // variants; enable them for the import and restore the world defaults in
    // afterAll.
    await setGradualBoosts(page, true);
    await setMythicRules(page, "enabled");
    await setFreeArchetype(page, true);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "exemplar");
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    await setGradualBoosts(page, false);
    await setMythicRules(page, "disabled");
    await setFreeArchetype(page, false);
    await page.close();
  });

  test("reports only the ikon-item guesses as import errors", () => {
    // Each ikon asks whether to grant a new item or use an existing one — a
    // Foundry-side question with no Demiplane signal — so the import guesses
    // and says so. Nothing else is loud: the variant rules the character uses
    // are enabled for this import.
    expect(result.summary.itemsSkipped).toBe(1);
    expect(result.summary.errors).toHaveLength(3);
    for (const error of result.summary.errors) {
      expect(error).toMatch(/Couldn't determine the choice for "(Barrow's Edge|Mortal Harvest|Victor's Wreath)"/);
    }
  });

  test("correct name, level, ancestry, background, class", () => {
    expect(result.name).toBe("FVTT Mythic Examplar");
    expect(result.level).toBe(2);
    expect(result.ancestry).toBe("Kitsune");
    expect(result.heritage).toBe("Empty Sky Kitsune");
    expect(result.background).toBe("Alloysmith");
    expect(result.class).toBe("Exemplar");
  });

  test("imports feats", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of [
      "Energized Spark (Cold)",
      "Foxfire",
      "Slippery Prey",
      "Runelord's Calling",
      "Ears That Hear the Truth",
      "Mortal Harvest",
      "Barrow's Edge",
      "Victor's Wreath",
    ]) {
      expect(names).toContain(feat);
    }
  });

  test("files the mythic calling and feat in their dedicated slots", () => {
    const byName = new Map(result.feats.map((f) => [f.name, f]));
    expect(byName.get("Runelord's Calling")).toMatchObject({ location: "mythic-calling" });
    expect(byName.get("Ears That Hear the Truth")).toMatchObject({ location: "mythic-2" });
  });

  test("files the kitsune spells as innate", () => {
    // Same unremastered Empty Sky chain as the psychic's (Ghost Sound, not
    // Figment): divine grants resolved through the granted feat.
    expectSpellcastingEntries(result, [
      {
        name: "Innate Spells",
        prepared: "innate",
        tradition: "divine",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["daze", "forbidding-ward", "ghost-sound"],
      },
    ]);
  });

  test("flags the unmapped lightning swap feat", () => {
    // Absent from this world's compendiums — asserted so the gap stays visible.
    expect(result.summary.unmapped).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: "lightning-swap-exemplar-rm", kind: "feat" })])
    );
  });

  test("guesses granted ikon items, flagging each for review", () => {
    // Each ikon asks whether to grant a new item or use an existing one — a
    // Foundry-side question with no Demiplane signal, so the import guesses
    // "granted" and records every one for review. Nothing is lost: the ikons
    // themselves import either way.
    expect(result.summary.unresolvedChoices).toEqual([
      expect.objectContaining({ key: "barrows-edge::barrowsEdge", guessedValue: "granted" }),
      expect.objectContaining({ key: "mortal-harvest::mortalHarvest", guessedValue: "granted" }),
      expect.objectContaining({ key: "victors-wreath::victorsWreath", guessedValue: "granted" }),
    ]);
  });

  test("imports plane-of-metal lore and languages", () => {
    expect(result.loreSkills).toEqual(["Plane of Metal Lore"]);
    expect(result.languages).toEqual(["common"]);
  });

  test("imports hit points and empty purse", () => {
    expect(result.hp.value).toBe(30);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
  });
});
