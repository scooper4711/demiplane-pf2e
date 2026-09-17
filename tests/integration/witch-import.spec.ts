import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  setFreeArchetype,
  stopCoverage,
  type ImportResult,
} from "./helpers.js";

const CHARACTER_UUID = process.env.WITCH_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Witch Import Test";

type SpellcastingEntry = ImportResult["spellcasting"][number];

/** Order-proof placement comparison: sorted `spell:state` pairs per slot. */
function placed(entry: SpellcastingEntry, slot: string): string[] {
  const list = entry.slots[slot]?.prepared ?? [];
  return list.map((p) => `${p.spell}:${p.expended ? "spent" : "ready"}`).sort();
}

/** The four hexes this witch has: patron (Nudge Fate), a selected hex (Phase
 *  Familiar), the Cackle feat, and the Lesson of Vengeance hex. */
const EXPECTED_HEXES = ["cackle", "needle-of-vengeance", "nudge-fate", "phase-familiar"];

/**
 * The witch's non-hex granted spells: the patron's free familiar spell (Sure
 * Strike) and the lesson's accompanying spell (Phantom Pain). These join the
 * prepared witch spell list, never the Hexes focus entry.
 */
const GRANTED_WITCH_SPELLS = ["phantom-pain", "sure-strike"];

test.describe("Witch Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Bard suite. Snapshots the reference witch (level-5 "FVTT
  // Witch"); update the expectations if the character is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and WITCH_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    // This witch uses the Free Archetype variant (Runescarred); enable it for
    // the import and restore the world default in afterAll.
    await setFreeArchetype(page, true);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "witch");
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    await setFreeArchetype(page, false);
    await page.close();
  });

  test("flags the unknown spell-runes source as a sync error", () => {
    // The sheet shows Mystic Armor in an extra slot from the Spell Runes feat,
    // but its `spell-runes-spellcasting` feature has no CLASS_SPELLCASTING
    // entry. Unknown sources must be loud, not silent (see spell-importer), so
    // the import carries exactly one sync error naming the source and the
    // skipped spell — and drops nothing else.
    expect(result.summary.itemsSkipped).toBe(0);
    expect(result.summary.errors).toHaveLength(1);
    expect(result.summary.errors[0]).toContain("spell-runes-spellcasting");
    expect(result.summary.errors[0]).toContain("mystic-armor");
  });

  test("correct name, level, ancestry, background, class", () => {
    // Renamed on Demiplane to mark this character as an integration fixture.
    expect(result.name).toBe("FVTT Witch");
    expect(result.level).toBe(5);
    expect(result.ancestry).toBe("Human");
    expect(result.heritage).toBe("Versatile Human");
    expect(result.background).toBe("Cursed");
    expect(result.class).toBe("Witch");
  });

  test("imports feats", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of [
      "Cackle",
      "Basic Lesson",
      "Lesson of Vengeance",
      "Runescarred Dedication",
      "Spell Runes",
      "Adapted Cantrip",
      "Clever Improviser",
      "Fleet",
      "Untrained Improvisation",
      "Dubious Knowledge",
      "Experienced Professional",
      "Canny Acumen (Perception)",
    ]) {
      expect(names).toContain(feat);
    }
  });

  test("imports curse lore and languages", () => {
    expect(result.loreSkills).toEqual(["Curse Lore"]);
    expect(result.languages).toEqual(["common"]);
  });

  test("imports hit points and currency", () => {
    // Current HP synced from Demiplane; the max is system-derived.
    expect(result.hp.value).toBe(53);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 95, sp: 3, cp: 8 });
  });

  test("files the full spellbook in a prepared occult entry", () => {
    // Timber (adapted cantrip) lives in innate instead; everything else known
    // is filed here.
    const witchEntry = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "occult");
    expect(witchEntry).toBeDefined();
    expect(witchEntry!.name).toBe("Witch Spells (Occult)");
    expect(witchEntry!.spells).toEqual([
      "bane",
      "befuddle",
      "bless",
      "cutting-insult",
      "enfeeble",
      "force-barrage",
      "friendfetch",
      "grim-tendrils",
      "haunting-hymn",
      "inside-ropes",
      "loose-times-arrow",
      "message",
      "murder-of-crows",
      "needle-darts",
      "phantom-pain",
      "phase-bolt",
      "prestidigitation",
      "rouse-skeletons",
      "sigil",
      "spirit-sense",
      "sure-strike",
      "telekinetic-hand",
      "telekinetic-projectile",
      "time-jump",
      "warp-step",
    ]);
  });

  test("applies main-entry slot maximums and remaining counts", () => {
    const witchEntry = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "occult");
    expect(witchEntry).toBeDefined();
    // Base witch progression at level 5; nothing cast, so all slots full.
    expect(witchEntry!.slots.slot0).toMatchObject({ max: 5, value: 5 });
    expect(witchEntry!.slots.slot1).toMatchObject({ max: 3, value: 3 });
    expect(witchEntry!.slots.slot2).toMatchObject({ max: 3, value: 3 });
    expect(witchEntry!.slots.slot3).toMatchObject({ max: 2, value: 2 });
  });

  test("places prepared spells with spent states in the main entry", () => {
    const witchEntry = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "occult");
    expect(witchEntry).toBeDefined();
    // NOTE: six cantrips are prepared on Demiplane but a level-5 witch has
    // five cantrip slots — the import writes all six and PF2e keeps the first
    // five, so prestidigitation stays known-but-unplaced. Rank 1: bane,
    // befuddle, bless. Rank 2: loose time's arrow, murder of crows, spirit
    // sense. Rank 3: rouse skeletons, time jump — all ready.
    expect(placed(witchEntry!, "slot0")).toEqual([
      "haunting-hymn:ready",
      "inside-ropes:ready",
      "message:ready",
      "needle-darts:ready",
      "phase-bolt:ready",
    ]);
    expect(placed(witchEntry!, "slot1")).toEqual(["bane:ready", "befuddle:ready", "bless:ready"]);
    expect(placed(witchEntry!, "slot2")).toEqual([
      "loose-times-arrow:ready",
      "murder-of-crows:ready",
      "spirit-sense:ready",
    ]);
    expect(placed(witchEntry!, "slot3")).toEqual(["rouse-skeletons:ready", "time-jump:ready"]);
  });

  test("collects exactly the four hexes into a focus Hexes entry", () => {
    const hexes = result.spellcasting.find((e) => e.name === "Hexes");
    expect(hexes).toBeDefined();
    expect(hexes!.prepared).toBe("focus");
    expect(hexes!.tradition).toBe("occult");
    expect(hexes!.spells).toEqual(EXPECTED_HEXES);
  });

  test("does not leak the patron/lesson familiar spells into the Hexes entry", () => {
    const hexes = result.spellcasting.find((e) => e.name === "Hexes");
    for (const leaked of GRANTED_WITCH_SPELLS) {
      expect(hexes!.spells).not.toContain(leaked);
    }
  });

  test("files the granted familiar spells in the prepared witch spell list", () => {
    // The witch's own occult prepared entry holds its spellbook plus the
    // patron/lesson familiar spells (Sure Strike, Phantom Pain).
    const witchEntry = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "occult");
    expect(witchEntry).toBeDefined();
    for (const granted of GRANTED_WITCH_SPELLS) {
      expect(witchEntry!.spells).toContain(granted);
    }
  });

  test("files Root Reading and Timber as innate spells", () => {
    // Root Reading (runescarred dedication) and Timber (adapted cantrip) are
    // select-spells without a school marker, so both land in innate — the
    // entry takes its name from the first one's feat.
    // NOTE: the entry reads tradition arcane (runescarred) even though Timber
    // is the witch's occult adapted cantrip — innate entries carry one
    // tradition and the importer names/traditions from the first spell.
    const innateEntries = result.spellcasting.filter((e) => e.prepared === "innate");
    expect(innateEntries).toHaveLength(1);
    expect(innateEntries[0]!.name).toBe("Runescarred Dedication (Innate)");
    expect(innateEntries[0]!.spells).toEqual(["root-reading", "timber"]);
    // Dedication spells, never hexes.
    const hexes = result.spellcasting.find((e) => e.name === "Hexes");
    expect(hexes!.spells).not.toContain("root-reading");
    expect(hexes!.spells).not.toContain("timber");
  });

  test("imports the three-point focus pool", () => {
    expect(result.focus.value).toBe(3);
    expect(result.focus.max).toBe(3);
  });

  test("leaves mystic armor out until runes spellcasting is taught", () => {
    // The skipped runes spell is nowhere: not in the spellbook, not
    // standalone. (The sync error above is its paper trail.)
    const witchEntry = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "occult");
    expect(witchEntry!.spells).not.toContain("mystic-armor");
    expect(result.standaloneSpells).not.toContain("mystic-armor");
  });
});
