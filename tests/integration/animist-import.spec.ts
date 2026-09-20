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

const CHARACTER_UUID = process.env.ANIMIST_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Animist Import Test";

type SpellcastingEntry = ImportResult["spellcasting"][number];

/** Order-proof placement comparison: sorted `spell:state` pairs per slot. */
function placed(entry: SpellcastingEntry, slot: string): string[] {
  const list = entry.slots[slot]?.prepared ?? [];
  return list.map((p) => `${p.spell}:${p.expended ? "spent" : "ready"}`).sort();
}

test.describe("Animist Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Magus suite. Values below snapshot the reference character
  // (level-3 liturgist animist "FVTT Animist", attuned Custodian of Groves and
  // Gardens (vessel) + Steward of Stone and Fire); update them if the
  // character is rebuilt on Demiplane. Eidolon-style attunement swapping (and
  // the Foundry animist module for it) is out of scope: the import snapshots
  // the current attunement.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and ANIMIST_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "animist");
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    await page.close();
  });

  test("reports no import errors", () => {
    // Undercommon resolves via the remaster rename table (Sakvroth); the
    // studded leather armor stays unmapped (absent from this world's
    // compendiums) without failing the import.
    expect(result.summary.itemsSkipped).toBe(0);
    expect(result.summary.errors).toEqual([]);
  });

  test("correct name, level, ancestry, background, class", () => {
    expect(result.name).toBe("FVTT Animist");
    expect(result.level).toBe(3);
    expect(result.ancestry).toBe("Human");
    expect(result.heritage).toBe("Versatile Human");
    expect(result.background).toBe("Back-Alley Doctor");
    expect(result.class).toBe("Animist");
  });

  test("imports feats", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of [
      "Incredible Initiative",
      "Risky Surgery",
      "Liturgist",
      "Circle of Spirits",
      "Apparition Attunement",
      "Adapted Cantrip",
      "Battle Medicine",
      "Embodiment of the Balance",
      "Fleet",
    ]) {
      expect(names).toContain(feat);
    }
  });

  test("imports underworld lore and remastered languages", () => {
    expect(result.loreSkills).toEqual(["Underworld Lore"]);
    // Undercommon arrives pre-remaster and resolves via the system's Remaster
    // Changes journal (Sakvroth).
    expect(result.languages).toEqual(["common", "elven", "sakvroth"]);
  });

  test("imports hit points and empty purse", () => {
    // Current HP synced from Demiplane; the max is system-derived.
    expect(result.hp.value).toBe(35);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
  });

  test("files the prepared divine spellbook", () => {
    // NOTE: the sheet's remaining-count display ("1/1", "0/2") understates the
    // maximums; the class data gives 2/2/1 and both rank-1 placements survive
    // (PF2e trims overflow, as the witch's sixth cantrip proves), pinning the
    // maximums.
    expectSpellcastingEntries(result, [
      {
        name: "Animist Spells (Divine)",
        prepared: "prepared",
        tradition: "divine",
        ability: "wis",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["bless", "daze", "detect-magic", "runic-weapon", "spiritual-armament"],
        slots: {
          slot0: { max: 2, value: 2 },
          slot1: { max: 2, value: 2 },
          slot2: { max: 1, value: 1 },
        },
      },
      {
        // Electric Arc comes from Adapted Cantrip (a select-spell without a
        // school marker), consistent with dedication cantrips — filed under
        // the class fallback.
        name: "Adapted Cantrip (Innate)",
        prepared: "innate",
        tradition: "divine",
        ability: "wis",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["electric-arc"],
      },
      {
        // NOTE: the sheet shows the animist and apparition spellbooks side by
        // side, which reads as every rank grouping listed twice — it is two
        // books, not duplication. Base apparition progression at level 3; the
        // rank-2 count is spent on Demiplane (session state). NOTE: as with
        // the main entry, the sheet's "0/2" overstates the rank-2 maximum of
        // 1. All are signature (unlimited).
        name: "Apparition Spells (Divine)",
        prepared: "spontaneous",
        tradition: "divine",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: [
          "exploding-earth",
          "gentle-breeze",
          "harm",
          "heal",
          "ignition",
          "interposing-earth",
          "protector-tree",
          "tangle-vine",
        ],
        slots: {
          slot0: { max: 2, value: 2 },
          slot1: { max: 1, value: 1 },
          slot2: { max: 1, value: 0 },
        },
      },
      {
        // Garden of Healing is the Custodian vessel spell (gated on Custodian
        // being primary) and files as focus.
        name: "Vessel Spells",
        prepared: "focus",
        tradition: "divine",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["garden-of-healing"],
      },
    ]);
  });

  test("applies main-entry cast states", () => {
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "divine");
    expect(spellbook).toBeDefined();
    // NOTE: "cantrips 3/2" counts three known cantrips (daze, detect magic,
    // plus the adapted Electric Arc below) against two slots. Bless and
    // Spiritual Armament carry their spent states.
    expect(placed(spellbook!, "slot0")).toEqual(["daze:ready", "detect-magic:ready"]);
    expect(placed(spellbook!, "slot1")).toEqual(["bless:spent", "runic-weapon:ready"]);
    expect(placed(spellbook!, "slot2")).toEqual(["spiritual-armament:spent"]);
  });

  test("imports the spent focus pool", () => {
    // NOTE: the sheet shows a pool of 2 (base plus the vessel point), but
    // PF2e derives the maximum per focus spell and the vessel point has no
    // Foundry-side mechanism — the import yields 1, spent, matching the
    // sheet's spent state if not its size.
    expect(result.focus.value).toBe(0);
    expect(result.focus.max).toBe(1);
  });

  test("marks every apparition spell signature", () => {
    // NOTE: the sheet shows the animist and apparition spellbooks side by
    // side, which reads as every rank grouping listed twice — it is two
    // books, not duplication. All are signature (unlimited).
    expect(result.signatureSpells).toEqual([
      "exploding-earth",
      "gentle-breeze",
      "harm",
      "heal",
      "ignition",
      "interposing-earth",
      "protector-tree",
      "tangle-vine",
    ]);
  });

  test("imports the heal scroll as an item and flags the missing armor", () => {
    // The rank-1 heal scroll rides on its item (never the prepared entry —
    // the apparition heal is a separate granted spell), and the studded
    // leather armor is unmapped in this world — asserted so the gap stays
    // visible.
    const names = result.equipment.map((i) => i.name);
    expect(names.some((n) => /scroll.*heal/i.test(n))).toBe(true);
    expect(names.some((n) => /studded leather/i.test(n))).toBe(false);
    expect(result.summary.unmapped).toContainEqual({ slug: "studded-leather-rm", kind: "equipment" });
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "divine");
    expect(spellbook!.spells).not.toContain("heal");
  });
});
