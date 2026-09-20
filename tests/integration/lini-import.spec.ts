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

  test("reports no import errors", () => {
    // The Druidic Order (Animal) and Voice of Nature (Animal Empathy) picks
    // resolve via the feature-pick matcher from their chosen engines — no
    // guesses, no fallbacks.
    expect(result.summary.itemsSkipped).toBe(0);
    expect(result.summary.errors).toEqual([]);
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
    // wand, or ritual spells on a level-1 druid. Level-1 druid: five
    // cantrips, two rank-1 slots; nothing cast.
    expectSpellcastingEntries(result, [
      {
        name: "Druid Spells (Primal)",
        prepared: "prepared",
        tradition: "primal",
        ability: "wis",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["detect-magic", "electric-arc", "heal", "ignition", "runic-body", "stabilize", "tangle-vine"],
        slots: { slot0: { max: 5, value: 5 }, slot1: { max: 2, value: 2 } },
      },
      {
        // Heal Animal resolves from the Animal order definition (no spell
        // engine), and the order grants the single focus point.
        name: "Order Spells",
        prepared: "focus",
        tradition: "primal",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["heal-animal"],
      },
    ]);
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

  test("imports the focus pool", () => {
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
