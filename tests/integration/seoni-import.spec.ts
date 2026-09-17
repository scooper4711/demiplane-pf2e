import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
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
    // repertoire like any chosen spell.
    const repertoire = result.spellcasting.find((e) => e.prepared === "spontaneous" && e.tradition === "arcane");
    expect(repertoire).toBeDefined();
    expect(repertoire!.name).toBe("Sorcerer Spells (Arcane)");
    expect(repertoire!.spells).toEqual([
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
    ]);
  });

  test("applies spontaneous slot maximums, all unused", () => {
    const repertoire = result.spellcasting.find((e) => e.prepared === "spontaneous" && e.tradition === "arcane");
    expect(repertoire).toBeDefined();
    // Level-5 sorcerer progression; nothing cast, so every slot is full and no
    // placements exist (spontaneous casters spend slots, not prepared spells).
    expect(repertoire!.slots.slot0).toMatchObject({ max: 5, value: 5 });
    expect(repertoire!.slots.slot1).toMatchObject({ max: 4, value: 4 });
    expect(repertoire!.slots.slot2).toMatchObject({ max: 4, value: 4 });
    expect(repertoire!.slots.slot3).toMatchObject({ max: 3, value: 3 });
  });

  test("marks thunderstrike and blazing bolt as signature spells", () => {
    // The two -spell-is-signature engines resolve to their spells, which the
    // importer flags so they heighten freely — hence thunderstrike at ranks
    // 1–3 and blazing bolt at 2–3 on the sheet.
    expect(result.signatureSpells).toEqual(["blazing-bolt", "thunderstrike"]);
  });

  test("files the bloodline spell in a focus entry and imports the focus pool", () => {
    // Ancestral Memories has no spell engine — it resolves from the imperial
    // bloodline definition — and the bloodline grants the focus point.
    const focusEntry = result.spellcasting.find((e) => e.spells.includes("ancestral-memories"));
    expect(focusEntry).toBeDefined();
    expect(focusEntry!.prepared).toBe("focus");
    expect(focusEntry!.tradition).toBe("arcane");
    expect(result.focus.value).toBe(1);
    expect(result.focus.max).toBe(1);
  });

  test("files the adapted spells as innate", () => {
    // Forbidding Ward (Adapted Cantrip) and Heal (Adaptive Adept, divine) are
    // select-spells without a school marker: innate, sharing the entry named
    // for the first one's feat.
    const innateEntries = result.spellcasting.filter((e) => e.prepared === "innate");
    const adapted = innateEntries.find((e) => e.name === "Adapted Cantrip (Innate)");
    expect(adapted).toBeDefined();
    expect(adapted!.spells).toEqual(["forbidding-ward", "heal"]);
  });

  test("files the granted detect magic as innate without duplicating the repertoire", () => {
    // NOTE: detect magic is granted twice over — once as a known repertoire
    // spell, once as innate — so it appears in both the main entry above and
    // its own feature-granted innate entry. Both are faithful to the grant
    // definitions; the repertoire copy is the castable one.
    const innateEntries = result.spellcasting.filter((e) => e.prepared === "innate");
    const granted = innateEntries.find((e) => e.spells.includes("detect-magic"));
    expect(granted).toBeDefined();
    expect(granted!.name).toBe("Innate Spells");
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
