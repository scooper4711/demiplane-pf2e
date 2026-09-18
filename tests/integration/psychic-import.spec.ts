import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
  type ImportResult,
} from "./helpers.js";

const CHARACTER_UUID = process.env.PSYCHIC_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Psychic Import Test";

test.describe("Psychic Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Magus suite. Values below snapshot the reference character
  // (level-4 unbound-step psychic "FVTT Psychic"); update them if the
  // character is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and PSYCHIC_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "psychic");
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
    expect(result.name).toBe("FVTT Psychic");
    expect(result.level).toBe(4);
    expect(result.ancestry).toBe("Kitsune");
    expect(result.heritage).toBe("Empty Sky Kitsune");
    expect(result.background).toBe("Attention Addict");
    expect(result.class).toBe("Psychic");
  });

  test("imports feats", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of [
      "Foxfire",
      "Emotional Acceptance",
      "The Unbound Step",
      "Wellspring Control",
      "Efficient Explorer",
      "Godless Healing",
      "Prescient Planner",
    ]) {
      expect(names).toContain(feat);
    }
  });

  test("imports gladiatorial lore and languages", () => {
    expect(result.loreSkills).toEqual(["Gladiatorial Lore"]);
    expect(result.languages).toEqual(["common"]);
  });

  test("imports hit points and empty purse", () => {
    // Current HP synced from Demiplane; the max is system-derived.
    expect(result.hp.value).toBe(36);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
  });

  test("files the repertoire in a spontaneous occult entry", () => {
    // Only the ranked repertoire resolves; the psi cantrips are unmapped
    // (module gap, asserted below) and the amps live in focus.
    const repertoire = result.spellcasting.find((e) => e.prepared === "spontaneous" && e.tradition === "occult");
    expect(repertoire).toBeDefined();
    expect(repertoire!.name).toBe("Psychic Spells (Occult)");
    expect(repertoire!.spells).toEqual(["animated-assault", "bee-mans-summons", "biting-words", "charm"]);
  });

  test("applies spontaneous slot maximums, all unused", () => {
    const repertoire = result.spellcasting.find((e) => e.prepared === "spontaneous" && e.tradition === "occult");
    expect(repertoire).toBeDefined();
    // NOTE: the class data suggests 2/2 and the table likely agrees, but the
    // builder shows 1/1 and explicit player overrides pin it there while
    // Demiplane finishes the psychic remaster — the import honors the
    // overrides (same mechanism as the wizard's rank-2 override). Revisit if
    // the remaster numbers land.
    expect(repertoire!.slots.slot1).toMatchObject({ max: 1, value: 1 });
    expect(repertoire!.slots.slot2).toMatchObject({ max: 1, value: 1 });
  });

  test("files the kitsune spells as innate", () => {
    // NOTE: the unremastered kitsune definition grants Ghost Sound; the
    // remaster renamed it Figment, so the mapping editor renames this item to
    // Figment on a mapped world. The raw import carries the granted name.
    const innateEntries = result.spellcasting.filter((e) => e.prepared === "innate");
    expect(innateEntries).toHaveLength(1);
    expect(innateEntries[0]!.spells).toEqual(["daze", "forbidding-ward", "ghost-sound"]);
  });

  test("files the amps in a focus entry and imports the focus pool", () => {
    // Distortion Lens, Enlarge, and Thoughtful Gift have no spell engines —
    // they resolve from the unbound-step definition as focus amps — and the
    // class grants both focus points, currently available.
    const focusEntry = result.spellcasting.find((e) => e.prepared === "focus");
    expect(focusEntry).toBeDefined();
    expect(focusEntry!.tradition).toBe("occult");
    expect(focusEntry!.spells).toEqual(["distortion-lens", "enlarge", "thoughtful-gift"]);
    expect(result.focus.value).toBe(2);
    expect(result.focus.max).toBe(2);
  });

  test("lists the unmapped psi cantrips", () => {
    // NOTE: Demiplane is still working on remastered psychic spells, and the
    // `-psychic` psi cantrip variants aren't in this world's compendiums, so
    // four of the five cantrips can't resolve. They surface as unmapped rather
    // than vanishing.
    expect(result.summary.unmapped).toContainEqual({ slug: "shield-psychic-rm", kind: "spell" });
    expect(result.summary.unmapped).toContainEqual({ slug: "telekinetic-hand-psychic-rm", kind: "spell" });
    expect(result.summary.unmapped).toContainEqual({ slug: "phase-bolt-psychic-rm", kind: "spell" });
    expect(result.summary.unmapped).toContainEqual({ slug: "warp-step-psychic-rm", kind: "spell" });
  });
});
