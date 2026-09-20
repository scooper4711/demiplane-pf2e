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
    // NOTE: Kyra exports no sanctification choice (holy/unholy) — a legacy
    // remnant of her migrated iconic build; modern builder characters record
    // an explicit `deity-sanctification-*` pick (see the ranger). The Deity
    // ChoiceSet therefore falls back to the first option. Sarenrae sanctifies
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
    // and ritual spells never appear here. Base cleric progression at level
    // 5; nothing cast, so all slots full.
    expectSpellcastingEntries(result, [
      {
        name: "Cleric Spells (Divine)",
        prepared: "prepared",
        tradition: "divine",
        ability: "wis",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: [
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
        ],
        slots: {
          slot0: { max: 5, value: 5 },
          slot1: { max: 3, value: 3 },
          slot2: { max: 3, value: 3 },
          slot3: { max: 2, value: 2 },
        },
      },
      {
        // Healing Font grants four heal slots, cast at heightened rank; they
        // live in their own spontaneous entry, never in the prepared
        // spellbook.
        name: "Divine Font (Healing)",
        prepared: "spontaneous",
        tradition: "divine",
        ability: "wis",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["heal"],
        slots: { slot1: { max: 4, value: 4 } },
      },
      {
        // Fire Ray has no spell engine on Demiplane's side — it resolves from
        // the Fire domain definition, which declares the Domain Spells focus
        // entry — and the domain grants the focus point.
        name: "Domain Spells",
        prepared: "focus",
        tradition: "divine",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["fire-ray"],
      },
    ]);
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

  test("places font heals with spent states in the font entry", () => {
    const font = result.spellcasting.find((e) => e.name === "Divine Font (Healing)");
    expect(font).toBeDefined();
    expect(placed(font!, "slot1")).toEqual(["heal:ready", "heal:ready", "heal:ready", "heal:ready"]);
  });

  test("imports the focus pool", () => {
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
