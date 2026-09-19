import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
  type ImportResult,
} from "./helpers.js";

const CHARACTER_UUID = process.env.KYRA_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Kyra Import Test";

type SpellcastingEntry = ImportResult["spellcasting"][number];

/** Order-proof placement comparison: sorted `spell:state` pairs per slot. */
function placed(entry: SpellcastingEntry, slot: string): string[] {
  const list = entry.slots[slot]?.prepared ?? [];
  return list.map((p) => `${p.spell}:${p.expended ? "spent" : "ready"}`).sort();
}

test.describe("Kyra Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Ezren suite. Values below snapshot the reference character
  // (level-5 cloistered cleric of Sarenrae "Kyra"); update them if the
  // character is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and KYRA_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "kyra");
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    await page.close();
  });

  test("reports only the known sanctification gap", () => {
    // NOTE: Demiplane doesn't export cleric sanctification (holy/unholy), so
    // the Deity ChoiceSet falls back to the first option. Sarenrae sanctifies
    // holy, so the guess is right — but it still surfaces for the GM to
    // confirm. Everything else imports cleanly.
    expect(result.summary.itemsSkipped).toBe(0);
    expect(result.summary.errors).toHaveLength(1);
    expect(result.summary.errors[0]).toContain("Deity (Cleric)");
    expect(result.summary.errors[0]).toContain("Holy");
  });

  test("correct name, level, ancestry, background, class, deity", () => {
    // Renamed on Demiplane to mark this character as an integration fixture.
    expect(result.name).toBe("FVTT Kyra");
    expect(result.level).toBe(5);
    expect(result.ancestry).toBe("Human");
    expect(result.heritage).toBe("Versatile Human");
    expect(result.background).toBe("Acolyte");
    expect(result.class).toBe("Cleric");
    expect(result.deity).toBe("Sarenrae");
  });

  test("imports feats", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of [
      "Haughty Obstinacy",
      "Armor Proficiency (Light)",
      "Healing Hands",
      "Group Impression",
      "Communal Healing",
      "Battle Medicine",
      "Cooperative Nature",
      // Granted by the Acolyte background, not a Demiplane feat pick.
      "Student of the Canon",
      // Domain Initiate grants the Fire domain behind the focus entry below.
      "Domain Initiate (Fire)",
      "Deity (Cleric) (Sarenrae)",
    ]) {
      expect(names).toContain(feat);
    }
  });

  test("imports scribing lore and languages", () => {
    expect(result.loreSkills).toEqual(["Scribing Lore"]);
    expect(result.languages).toEqual(["common", "kelish"]);
  });

  test("imports hit points and currency", () => {
    // Current HP synced from Demiplane; the max is system-derived.
    expect(result.hp.value).toBe(48);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 19, sp: 9, cp: 9 });
  });

  test("files the full spellbook in a prepared divine entry", () => {
    // The main entry holds every known spell: five cantrips plus the ranked
    // prepared spells. Font heals live in the font entry below; scroll, wand,
    // and ritual spells never appear here.
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "divine");
    expect(spellbook).toBeDefined();
    expect(spellbook!.name).toBe("Cleric Spells (Divine)");
    expect(spellbook!.spells).toEqual([
      "bless",
      "cleanse-affliction",
      "daze",
      "dispel-magic",
      "divine-lance",
      "guidance",
      "heroism",
      "holy-light",
      "light",
      "sanctuary",
      "spirit-link",
      "spiritual-armament",
      "stabilize",
    ]);
  });

  test("applies main-entry slot maximums and remaining counts", () => {
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "divine");
    expect(spellbook).toBeDefined();
    // Base cleric progression at level 5; nothing cast, so all slots full.
    expect(spellbook!.slots.slot0).toMatchObject({ max: 5, value: 5 });
    expect(spellbook!.slots.slot1).toMatchObject({ max: 3, value: 3 });
    expect(spellbook!.slots.slot2).toMatchObject({ max: 3, value: 3 });
    expect(spellbook!.slots.slot3).toMatchObject({ max: 2, value: 2 });
  });

  test("places prepared spells with spent states in the main entry", () => {
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "divine");
    expect(spellbook).toBeDefined();
    // Rank 1: bless, sanctuary, spirit link. Rank 2: dispel magic, spiritual
    // armament, cleanse affliction. Rank 3: heroism, holy light — all ready.
    expect(placed(spellbook!, "slot0")).toEqual([
      "daze:ready",
      "divine-lance:ready",
      "guidance:ready",
      "light:ready",
      "stabilize:ready",
    ]);
    expect(placed(spellbook!, "slot1")).toEqual(["bless:ready", "sanctuary:ready", "spirit-link:ready"]);
    expect(placed(spellbook!, "slot2")).toEqual([
      "cleanse-affliction:ready",
      "dispel-magic:ready",
      "spiritual-armament:ready",
    ]);
    expect(placed(spellbook!, "slot3")).toEqual(["heroism:ready", "holy-light:ready"]);
  });

  test("files the four font heals in a Divine Font entry", () => {
    // Healing Font grants four heal slots, cast at heightened rank; they live
    // in their own spontaneous entry, never in the prepared spellbook.
    const font = result.spellcasting.find((e) => e.name === "Divine Font (Healing)");
    expect(font).toBeDefined();
    expect(font!.prepared).toBe("spontaneous");
    expect(font!.tradition).toBe("divine");
    expect(font!.spells).toEqual(["heal"]);
    expect(font!.slots.slot1).toMatchObject({ max: 4, value: 4 });
    expect(placed(font!, "slot1")).toEqual(["heal:ready", "heal:ready", "heal:ready", "heal:ready"]);
  });

  test("files the domain spell in a focus entry and imports the focus pool", () => {
    // Fire Ray has no spell engine on Demiplane's side — it resolves from the
    // Fire domain definition — and the domain grants the focus point.
    const focusEntry = result.spellcasting.find((e) => e.spells.includes("fire-ray"));
    expect(focusEntry).toBeDefined();
    expect(focusEntry!.prepared).toBe("focus");
    expect(focusEntry!.tradition).toBe("divine");
    expect(result.focus.value).toBe(1);
    expect(result.focus.max).toBe(1);
  });

  test("imports scrolls and wand as items without standalone spells", () => {
    // The clear-mind, resist-energy, and acid-grip scrolls plus the mending
    // wand import as items; their spells ride along embedded, never as
    // spellbook entries.
    const names = result.equipment.map((i) => i.name);
    expect(names.some((n) => /clear mind/i.test(n))).toBe(true);
    expect(names.some((n) => /resist energy/i.test(n))).toBe(true);
    expect(names.some((n) => /acid grip/i.test(n))).toBe(true);
    expect(names.some((n) => /mending/i.test(n))).toBe(true);
    for (const spell of ["clear-mind", "resist-energy", "acid-grip", "mending"]) {
      expect(result.spellcasting.every((e) => !e.spells.includes(spell))).toBe(true);
    }
  });

  test("imports the wish ritual as a standalone spell", () => {
    // Rituals belong to no spellcasting entry — the rank-10 wish imports as a
    // plain ritual-trait spell item PF2e gathers ephemerally.
    expect(result.standaloneSpells).toContain("wish");
  });
});
