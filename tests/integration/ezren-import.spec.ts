import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
  type ImportResult,
} from "./helpers.js";

const CHARACTER_UUID = process.env.EZREN_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Ezren Import Test";

type SpellcastingEntry = ImportResult["spellcasting"][number];

/** Order-proof placement comparison: sorted `spell:state` pairs per slot. */
function placed(entry: SpellcastingEntry, slot: string): string[] {
  const list = entry.slots[slot]?.prepared ?? [];
  return list.map((p) => `${p.spell}:${p.expended ? "spent" : "ready"}`).sort();
}

test.describe("Ezren Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Valeros suite. Values below snapshot the reference character
  // (level-5 battle-magic wizard "FVTT Ezren"); update them if the character
  // is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and EZREN_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "ezren");
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

  test("correct name, level, ancestry, background, class", () => {
    // Renamed on Demiplane to mark this character as an integration fixture.
    expect(result.name).toBe("FVTT Ezren");
    expect(result.level).toBe(5);
    expect(result.ancestry).toBe("Human");
    expect(result.heritage).toContain("Skilled Human");
    expect(result.background).toBe("Scholar (Arcana)");
    expect(result.class).toBe("Wizard");
  });

  test("imports feats", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of [
      "Cooperative Nature",
      "Eyes of the City",
      "Familiar",
      "Incredible Initiative",
      "Magical Shorthand",
      "Adapted Cantrip",
      "Linked Focus",
    ]) {
      expect(names).toContain(feat);
    }
  });

  test("imports background lore and languages", () => {
    expect(result.loreSkills.length).toBeGreaterThan(0);
    expect(result.languages).toEqual(["common", "draconic", "dwarven", "halfling", "sakvroth", "varisian"]);
  });

  test("imports hit points and currency", () => {
    // Current HP synced from Demiplane; the max is system-derived.
    expect(result.hp.value).toBe(52);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 110, sp: 22, cp: 98 });
  });

  test("files the full spellbook in a prepared arcane entry", () => {
    // The main entry holds every known spell, including school spells (which
    // additionally get their own school entry below). The adapted-cantrip
    // Stabilize is selected, not spellbook, so it lives in innate instead.
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "arcane");
    expect(spellbook).toBeDefined();
    expect(spellbook!.name).toBe("Wizard Spells (Arcane)");
    expect(spellbook!.spells).toEqual([
      "acid-grip",
      "brine-dragon-bile",
      "charm",
      "detect-magic",
      "echo-jump",
      "electric-arc",
      "fireball",
      "force-barrage",
      "glass-shield",
      "gouging-claw",
      "grease",
      "haste",
      "illusory-object",
      "infectious-enthusiasm",
      "interposing-earth",
      "laughing-fit",
      "light",
      "message",
      "mist",
      "mystic-armor",
      "puff-of-poison",
      "resist-energy",
      "runic-weapon",
      "shield",
      "splinter-volley",
      "summon-animal",
      "summon-undead",
      "tangle-vine",
      "telekinetic-projectile",
      "warping-pull",
    ]);
  });

  test("applies main-entry slot maximums and remaining counts", () => {
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "arcane");
    expect(spellbook).toBeDefined();
    // Base wizard progression at level 5 (school slots live separately below).
    expect(spellbook!.slots.slot1).toMatchObject({ max: 3 });
    expect(spellbook!.slots.slot2).toMatchObject({ max: 3 });
    expect(spellbook!.slots.slot3).toMatchObject({ max: 2 });
    // Remaining counts imported from Demiplane session state.
    expect(spellbook!.slots.slot1?.value).toBe(3);
    // NOTE: Demiplane's own rank-2 remaining value (3) disagrees with its
    // is-cast flags (3 of 4 spent); the import applies the value faithfully.
    expect(spellbook!.slots.slot2?.value).toBe(3);
    expect(spellbook!.slots.slot3?.value).toBe(2);
  });

  test("places prepared spells with spent states in the main entry", () => {
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "arcane");
    expect(spellbook).toBeDefined();
    // Rank 1: three greases, one spent. Rank 2: two summon undead (one spent)
    // plus a spent summon animal. Rank 3: haste and summon undead, both ready.
    // (Rank-1 force barrage and rank-2 force barrage / rank-3 fireball are
    // school-slot placements in the school entry below.)
    expect(placed(spellbook!, "slot1")).toEqual(["grease:ready", "grease:ready", "grease:spent"]);
    expect(placed(spellbook!, "slot2")).toEqual(["summon-animal:spent", "summon-undead:ready", "summon-undead:spent"]);
    expect(placed(spellbook!, "slot3")).toEqual(["haste:ready", "summon-undead:ready"]);
  });

  test("files school spells in their own curriculum entry", () => {
    // The battle-magic school spellbook holds only school spells (which also
    // appear in the main spellbook above).
    const school = result.spellcasting.find((e) => e.name === "Battle Magic Curriculum Spells");
    expect(school).toBeDefined();
    expect(school!.prepared).toBe("prepared");
    expect(school!.tradition).toBe("arcane");
    expect(school!.spells).toEqual([
      "fireball",
      "force-barrage",
      "mist",
      "mystic-armor",
      "shield",
      "telekinetic-projectile",
    ]);
  });

  test("gives the school entry one slot per rank with school placements", () => {
    const school = result.spellcasting.find((e) => e.name === "Battle Magic Curriculum Spells");
    expect(school).toBeDefined();
    expect(school!.slots.slot1).toMatchObject({ max: 1 });
    expect(school!.slots.slot2).toMatchObject({ max: 1 });
    expect(school!.slots.slot3).toMatchObject({ max: 1 });
    // Each school slot holds a school spell; the spent rank-2 force barrage
    // carries its expended state.
    expect(placed(school!, "slot1")).toEqual(["force-barrage:ready"]);
    expect(placed(school!, "slot2")).toEqual(["force-barrage:spent"]);
    expect(placed(school!, "slot3")).toEqual(["fireball:spent"]);
  });

  test("files the school focus spell in a focus entry, never Hexes", () => {
    // Force Bolt shares its engine with an add-focus-point: a focus-pool spell
    // by definition, despite carrying saveDC machinery (hex signal) and a
    // concrete tradition (repertoire signal).
    const focusEntry = result.spellcasting.find((e) => e.spells.includes("force-bolt"));
    expect(focusEntry).toBeDefined();
    expect(focusEntry!.prepared).toBe("focus");
    expect(result.spellcasting.find((e) => e.name === "Hexes")).toBeUndefined();
  });

  test("files the adapted cantrip as innate", () => {
    // Stabilize comes from the Adapted Cantrip feat (a select-spell without a
    // school marker), consistent with dedication cantrips like Root Reading.
    const innateEntries = result.spellcasting.filter((e) => e.prepared === "innate");
    expect(innateEntries.flatMap((e) => e.spells)).toEqual(["stabilize"]);
  });

  test("imports the focus pool state", () => {
    // One focus point on Demiplane, currently available.
    expect(result.focus.value).toBe(1);
    expect(result.focus.max).toBe(1);
  });

  test("imports scrolls, wand, and staff as items without standalone spells", () => {
    // Wall of Fire / Weapon Storm scrolls and the pampered-pet wand import as
    // items; their spells ride along embedded, never as spellbook entries. The
    // staff of air grants no spells at all.
    const names = result.equipment.map((i) => i.name);
    expect(names.some((n) => /wall of fire/i.test(n))).toBe(true);
    expect(names.some((n) => /weapon storm/i.test(n))).toBe(true);
    expect(names.some((n) => /pampered pet/i.test(n))).toBe(true);
    expect(names.some((n) => /staff of air/i.test(n))).toBe(true);
    for (const spell of ["wall-of-fire", "weapon-storm", "sound-body", "pet-cache"]) {
      expect(result.spellcasting.every((e) => !e.spells.includes(spell))).toBe(true);
    }
  });
});
