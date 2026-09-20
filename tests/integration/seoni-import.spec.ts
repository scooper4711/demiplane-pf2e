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

const CHARACTER_UUID = process.env.SEONI_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Seoni Import Test";

test.describe("Seoni Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Witch suite. Values below snapshot the reference character
  // (level-5 imperial sorcerer "FVTT Seoni"); update them if the character is
  // rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and SEONI_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "seoni");
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
    // Copied from the player's Seoni into this integration fixture slot.
    expect(result.name).toBe("FVTT Seoni");
    expect(result.level).toBe(5);
    expect(result.ancestry).toBe("Human");
    expect(result.heritage).toBe("Skilled Human (Arcana)");
    expect(result.background).toBe("Nomad");
    expect(result.class).toBe("Sorcerer");
  });

  test("imports feats", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of [
      "Assurance (Survival)",
      "Recognize Spell",
      "Arcane Sense",
      "Adapted Cantrip",
      "Cantrip Expansion",
      "Multilingual",
      "Arcane Evolution",
      "Adaptive Adept",
      "Bloodline: Imperial",
    ]) {
      expect(names).toContain(feat);
    }
  });

  test("imports hills lore and languages", () => {
    expect(result.loreSkills).toEqual(["Hills"]);
    expect(result.languages).toEqual(["common", "draconic", "varisian", "sakvroth", "goblin"]);
  });

  test("imports hit points and currency", () => {
    // Current HP synced from Demiplane; the max is system-derived.
    expect(result.hp.value).toBe(48);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 1, gp: 130, sp: 91, cp: 111 });
  });

  test("files the full repertoire in a spontaneous arcane entry", () => {
    // NOTE: detect magic, force barrage, dispel magic, and haste have no spell
    // engines — they resolve from the bloodline/feat definitions as granted
    // known spells (the sheet shows no trash can for them), joining the
    // repertoire like any chosen spell. Level-5 sorcerer progression; nothing
    // cast, so every slot is full and no placements exist (spontaneous
    // casters spend slots, not prepared spells).
    expectSpellcastingEntries(result, [
      {
        name: "Sorcerer Spells (Arcane)",
        prepared: "spontaneous",
        tradition: "arcane",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: [
          "animated-assault",
          "blazing-bolt",
          "caustic-blast",
          "detect-magic",
          "dispel-magic",
          "dizzying-colors",
          "electric-arc",
          "fireball",
          "force-barrage",
          "frostbite",
          "haste",
          "heat-metal",
          "live-wire",
          "ooze-form",
          "shield",
          "sleep",
          "thunderstrike",
        ],
        slots: {
          slot0: { max: 5, value: 5 },
          slot1: { max: 4, value: 4 },
          slot2: { max: 4, value: 4 },
          slot3: { max: 3, value: 3 },
        },
      },
      {
        // Ancestral Memories has no spell engine — it resolves from the
        // imperial bloodline definition, which declares the Bloodline Spells
        // focus entry — and the bloodline grants the focus point.
        name: "Bloodline Spells",
        prepared: "focus",
        tradition: "arcane",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["ancestral-memories"],
      },
      {
        // Forbidding Ward (Adapted Cantrip) and Heal (Adaptive Adept, divine)
        // are select-spells without a school marker: innate, sharing the entry
        // named for the first one's feat.
        name: "Adapted Cantrip (Innate)",
        prepared: "innate",
        tradition: "arcane",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["forbidding-ward", "heal"],
      },
      {
        // NOTE: detect magic is granted twice over — once as a known
        // repertoire spell, once as innate — so it appears in both the main
        // entry above and its own feature-granted innate entry. Both are
        // faithful to the grant definitions; the repertoire copy is castable.
        name: "Innate Spells",
        prepared: "innate",
        tradition: "arcane",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["detect-magic"],
      },
    ]);
  });

  test("marks thunderstrike and blazing bolt as signature spells", () => {
    // The two -spell-is-signature engines resolve to their spells, which the
    // importer flags so they heighten freely — hence thunderstrike at ranks
    // 1–3 and blazing bolt at 2–3 on the sheet.
    expect(result.signatureSpells).toEqual(["blazing-bolt", "thunderstrike"]);
  });

  test("imports the focus pool", () => {
    expect(result.focus.value).toBe(1);
    expect(result.focus.max).toBe(1);
  });

  test("imports staves and wand as items with no phantom spells", () => {
    // The generic staff, staff of water, and wand of heal import as items; the
    // staffs grant no spells of their own.
    const names = result.equipment.map((i) => i.name);
    expect(names.some((n) => /^staff$/i.test(n))).toBe(true);
    expect(names.some((n) => /staff of water/i.test(n))).toBe(true);
    expect(names.some((n) => /wand of heal/i.test(n))).toBe(true);
    expect(names.some((n) => /crossbow/i.test(n))).toBe(true);
    expect(names.some((n) => /healing potion/i.test(n))).toBe(true);
    expect(names.some((n) => /elixir of life/i.test(n))).toBe(true);
    expect(result.standaloneSpells).toEqual([]);
  });
});
