import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
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
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "divine");
    expect(spellbook).toBeDefined();
    expect(spellbook!.name).toBe("Animist Spells (Divine)");
    expect(spellbook!.spells).toEqual(["bless", "daze", "detect-magic", "runic-weapon", "spiritual-armament"]);
  });

  test("applies main-entry slots and cast states", () => {
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "divine");
    expect(spellbook).toBeDefined();
    // NOTE: the sheet's remaining-count display ("1/1", "0/2") understates the
    // maximums; the class data gives 2/2/1 and both rank-1 placements survive
    // (PF2e trims overflow, as the witch's sixth cantrip proves), pinning the
    // maximums. Bless and Spiritual Armament carry their spent states.
    expect(spellbook!.slots.slot0).toMatchObject({ max: 2, value: 2 });
    expect(spellbook!.slots.slot1).toMatchObject({ max: 2, value: 2 });
    expect(spellbook!.slots.slot2).toMatchObject({ max: 1, value: 1 });
    // NOTE: "cantrips 3/2" counts three known cantrips (daze, detect magic,
    // plus the adapted Electric Arc below) against two slots.
    expect(placed(spellbook!, "slot0")).toEqual(["daze:ready", "detect-magic:ready"]);
    expect(placed(spellbook!, "slot1")).toEqual(["bless:spent", "runic-weapon:ready"]);
    expect(placed(spellbook!, "slot2")).toEqual(["spiritual-armament:spent"]);
  });

  test("files the adapted cantrip as innate", () => {
    // Electric Arc comes from Adapted Cantrip (a select-spell without a
    // school marker), consistent with dedication cantrips like Root Reading.
    const innateEntries = result.spellcasting.filter((e) => e.prepared === "innate");
    expect(innateEntries.flatMap((e) => e.spells)).toEqual(["electric-arc"]);
  });

  test("files the apparition repertoire in its own spontaneous entry", () => {
    // NOTE: the sheet shows the animist and apparition spellbooks side by
    // side, which reads as every rank grouping listed twice — it is two
    // books, not duplication. Custodian grants tangle vine, protector tree,
    // and gentle breeze (rank 3); Steward grants ignition, interposing earth,
    // and exploding earth; Embodiment of the Balance grants heal and harm. All
    // are signature (unlimited). The Avatar grant arriving through a
    // granted-feat chain is gated out: a level-3 caster with rank-2 slots
    // cannot cast a rank-10 spell.
    const apparition = result.spellcasting.find((e) => e.name === "Apparition Spells (Divine)");
    expect(apparition).toBeDefined();
    expect(apparition!.prepared).toBe("spontaneous");
    expect(apparition!.tradition).toBe("divine");
    expect(apparition!.spells).toEqual([
      "exploding-earth",
      "gentle-breeze",
      "harm",
      "heal",
      "ignition",
      "interposing-earth",
      "protector-tree",
      "tangle-vine",
    ]);
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

  test("applies apparition slot maximums and remaining counts", () => {
    const apparition = result.spellcasting.find((e) => e.name === "Apparition Spells (Divine)");
    expect(apparition).toBeDefined();
    // Base apparition progression at level 3; the rank-2 count is spent on
    // Demiplane (session state), so only its maximum is asserted structurally.
    // NOTE: as with the main entry, the sheet's "0/2" overstates the rank-2
    // maximum of 1.
    expect(apparition!.slots.slot0).toMatchObject({ max: 2, value: 2 });
    expect(apparition!.slots.slot1).toMatchObject({ max: 1, value: 1 });
    expect(apparition!.slots.slot2).toMatchObject({ max: 1, value: 0 });
  });

  test("files the vessel spell in a focus entry and imports the spent pool", () => {
    // Garden of Healing is the Custodian vessel spell (gated on Custodian
    // being primary) and files as focus. NOTE: the sheet shows a pool of 2
    // (base plus the vessel point), but PF2e derives the maximum per focus
    // spell and the vessel point has no Foundry-side mechanism — the import
    // yields 1, spent, matching the sheet's spent state if not its size.
    const focusEntry = result.spellcasting.find((e) => e.spells.includes("garden-of-healing"));
    expect(focusEntry).toBeDefined();
    expect(focusEntry!.name).toBe("Vessel Spells");
    expect(focusEntry!.prepared).toBe("focus");
    expect(focusEntry!.tradition).toBe("divine");
    expect(result.focus.value).toBe(0);
    expect(result.focus.max).toBe(1);
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
