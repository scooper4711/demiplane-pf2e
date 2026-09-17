import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
  type ImportResult,
} from "./helpers.js";

const CHARACTER_UUID = process.env.LINI_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Lini Import Test";

type SpellcastingEntry = ImportResult["spellcasting"][number];

/** Order-proof placement comparison: sorted `spell:state` pairs per slot. */
function placed(entry: SpellcastingEntry, slot: string): string[] {
  const list = entry.slots[slot]?.prepared ?? [];
  return list.map((p) => `${p.spell}:${p.expended ? "spent" : "ready"}`).sort();
}

test.describe("Lini Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Kyra suite. Values below snapshot the reference character
  // (level-1 animal-order druid "FVTT Lini"); update them if the character is
  // rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and LINI_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
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

  test("reports only the two known order-guess gaps", () => {
    // NOTE: neither the Druidic Order pick (Animal) nor the Voice of Nature
    // pick (Animal Empathy, dictated by the Animal order) matches a ChoiceSet
    // strategy, so both fall back to the first option. Animal happens to be
    // first alphabetically, so the guesses are right — but they still surface
    // for the GM to confirm. A non-Animal order would mis-resolve; that matcher
    // gap is follow-up work, not this sweep.
    expect(result.summary.itemsSkipped).toBe(0);
    expect(result.summary.errors).toHaveLength(2);
    expect(result.summary.errors[0]).toContain("Druidic Order");
    expect(result.summary.errors[0]).toContain("Animal Order");
    expect(result.summary.errors[1]).toContain("Voice of Nature");
    expect(result.summary.errors[1]).toContain("Animal Empathy");
  });

  test("correct name, level, ancestry, background, class", () => {
    // Renamed on Demiplane to mark this character as an integration fixture.
    expect(result.name).toBe("FVTT Lini");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Gnome");
    expect(result.heritage).toBe("Sensate Gnome");
    expect(result.background).toBe("Herbalist");
    expect(result.class).toBe("Druid");
  });

  test("imports feats", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of [
      "Gnome Obsession",
      "Additional Lore",
      "Assurance (Athletics)",
      "Natural Medicine",
      // Animal order grants the companion and its empathy feat.
      "Animal Companion",
      "Animal Empathy",
      "Animal Order",
      "Druidic Order",
      "Shield Block",
    ]) {
      expect(names).toContain(feat);
    }
  });

  test("imports forest and herbalism lore and languages", () => {
    expect([...result.loreSkills].sort()).toEqual(["Forest Lore", "Herbalism Lore"]);
    expect(result.languages).toEqual(["common", "fey", "gnomish", "wildsong"]);
  });

  test("imports hit points and currency", () => {
    // Current HP synced from Demiplane; the max is system-derived.
    expect(result.hp.value).toBe(18);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 4, cp: 9 });
  });

  test("files the full spellbook in a prepared primal entry", () => {
    // Five cantrips plus the two rank-1 prepared spells; no font, scroll,
    // wand, or ritual spells on a level-1 druid.
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "primal");
    expect(spellbook).toBeDefined();
    expect(spellbook!.name).toBe("Druid Spells (Primal)");
    expect(spellbook!.spells).toEqual([
      "detect-magic",
      "electric-arc",
      "heal",
      "ignition",
      "runic-body",
      "stabilize",
      "tangle-vine",
    ]);
  });

  test("applies main-entry slot maximums and remaining counts", () => {
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "primal");
    expect(spellbook).toBeDefined();
    // Level-1 druid: five cantrips, two rank-1 slots; nothing cast.
    expect(spellbook!.slots.slot0).toMatchObject({ max: 5, value: 5 });
    expect(spellbook!.slots.slot1).toMatchObject({ max: 2, value: 2 });
  });

  test("places prepared spells with spent states in the main entry", () => {
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "primal");
    expect(spellbook).toBeDefined();
    // Rank 1: heal and runic body, both ready.
    expect(placed(spellbook!, "slot0")).toEqual([
      "detect-magic:ready",
      "electric-arc:ready",
      "ignition:ready",
      "stabilize:ready",
      "tangle-vine:ready",
    ]);
    expect(placed(spellbook!, "slot1")).toEqual(["heal:ready", "runic-body:ready"]);
  });

  test("files the order spell in a focus entry and imports the focus pool", () => {
    // Heal Animal resolves from the Animal order definition (no spell engine),
    // and the order grants the single focus point.
    const focusEntry = result.spellcasting.find((e) => e.spells.includes("heal-animal"));
    expect(focusEntry).toBeDefined();
    expect(focusEntry!.prepared).toBe("focus");
    expect(focusEntry!.tradition).toBe("primal");
    expect(result.focus.value).toBe(1);
    expect(result.focus.max).toBe(1);
  });

  test("imports starting gear and no standalone spells", () => {
    const names = result.equipment.map((i) => i.name);
    for (const item of ["Sickle", "Buckler", "Padded Armor", "Healer's Toolkit", "Sling"]) {
      expect(names).toContain(item);
    }
    // No rituals, scrolls, or wands: nothing filed outside an entry.
    expect(result.standaloneSpells).toEqual([]);
  });
});
