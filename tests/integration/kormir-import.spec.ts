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

const CHARACTER_UUID = process.env.KORMIR_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Kormir Import Test";

type SpellcastingEntry = ImportResult["spellcasting"][number];

/** Order-proof placement comparison: sorted `spell:state` pairs per slot. */
function placed(entry: SpellcastingEntry, slot: string): string[] {
  const list = entry.slots[slot]?.prepared ?? [];
  return list.map((p) => `${p.spell}:${p.expended ? "spent" : "ready"}`).sort();
}

test.describe("Kormir Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Witch suite. Values below snapshot the reference character
  // (level-10 psychic with wizard dedication "Kormir", oscillating-wave
  // amps); update them if the character is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and KORMIR_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    // Archetype feats ride the Free Archetype variant: enable it for the
    // import and restore the world default in afterAll.
    await setFreeArchetype(page, true);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "kormir");
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    await setFreeArchetype(page, false);
    await page.close();
  });

  test("reports no import errors", () => {
    expect(result.summary.itemsSkipped).toBe(0);
    expect(result.summary.errors).toEqual([]);
  });

  test("correct name, level, ancestry, background, class", () => {
    expect(result.name).toBe("Kormir");
    expect(result.level).toBe(10);
    expect(result.ancestry).toBe("Dwarf");
    expect(result.heritage).toBe("Oathkeeper Dwarf");
    expect(result.background).toBe("Total Power");
    expect(result.class).toBe("Psychic");
  });

  test("imports feats", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of [
      "Wizard Dedication",
      "Basic Arcana",
      "Advanced Arcana",
      "Sleepwalker Dedication",
      "Parallel Breakthrough (Daze)",
      "Bone Spikes",
      "Intimidating Glare",
      "Dwarven Doughtiness",
      "Astral Tether",
      "Dubious Knowledge",
      "Mental Balm",
      "Brain Drain",
      "Heroes' Call",
    ]) {
      expect(names).toContain(feat);
    }
  });

  test("imports legal lore and languages", () => {
    expect(result.loreSkills).toEqual(["Legal Lore"]);
    expect(result.languages).toEqual(["common", "dwarven"]);
  });

  test("imports hit points and empty purse", () => {
    // Current HP synced from Demiplane; the max is system-derived.
    expect(result.hp.value).toBe(110);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
  });

  test("files the psychic repertoire in a spontaneous occult entry", () => {
    const repertoire = result.spellcasting.find((e) => e.prepared === "spontaneous" && e.tradition === "occult");
    expect(repertoire).toBeDefined();
    expect(repertoire!.name).toBe("Psychic Spells (Occult)");
    expect(repertoire!.spells).toEqual([
      "agonizing-despair",
      "biting-words",
      "bless",
      "blistering-invective",
      "command",
      "concordant-choir",
      "daze",
      "dirge-of-remembrance",
      "guidance",
      "impending-doom",
      "instant-parade",
      "telekinetic-projectile",
    ]);
  });

  test("applies psychic slots and the signature mark", () => {
    const repertoire = result.spellcasting.find((e) => e.prepared === "spontaneous" && e.tradition === "occult");
    expect(repertoire).toBeDefined();
    // Remastered psychic at 10: three repertoire cantrips, two slots per rank.
    expect(repertoire!.slots.slot0).toMatchObject({ max: 3, value: 3 });
    expect(repertoire!.slots.slot1).toMatchObject({ max: 2, value: 2 });
    expect(repertoire!.slots.slot2).toMatchObject({ max: 2, value: 2 });
    expect(repertoire!.slots.slot3).toMatchObject({ max: 2, value: 2 });
    expect(repertoire!.slots.slot4).toMatchObject({ max: 2, value: 2 });
    expect(repertoire!.slots.slot5).toMatchObject({ max: 2, value: 2 });
    expect(result.signatureSpells).toEqual(["biting-words"]);
  });

  test("files the wizard-archetype spellbook in a prepared arcane entry", () => {
    // The archetype casts exactly like its base class (prepared arcane), so
    // no unknown-source error — but the entry keeps a distinct name.
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "arcane");
    expect(spellbook).toBeDefined();
    expect(spellbook!.name).toBe("Arcane Spells");
    expect(spellbook!.spells).toEqual(["electric-arc", "shield", "tangle-vine", "warp-step"]);
  });

  test("sizes the archetype cantrip slots and leaves them unprepared", () => {
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "arcane");
    expect(spellbook).toBeDefined();
    // NOTE: no cantrip data exists for the archetype feature, so the import
    // counts the four known cantrips (same mirror-Demiplane rule as the
    // summoner). Nothing is prepared on Demiplane, so PF2e shows its empty
    // slot placeholders ("?"), not broken references.
    expect(spellbook!.slots.slot0).toMatchObject({ max: 4, value: 4 });
    expect(placed(spellbook!, "slot0")).toEqual(["?:ready", "?:ready", "?:ready", "?:ready"]);
  });

  test("files feat-granted spells as innate", () => {
    // Glimpse of Weakness rides Parallel Breakthrough; Heroism rides the
    // Heroes' Call feat grant (innate) — neither has a spell engine.
    const innateEntries = result.spellcasting.filter((e) => e.prepared === "innate");
    expect(innateEntries.flatMap((e) => e.spells).sort()).toEqual(["glimpse-weakness", "heroism"]);
  });

  test("files the amps in a focus entry and imports the focus pool", () => {
    // The oscillating-wave amps resolve from bloodline-style definitions;
    // PF2e derives the pool from the focus spells.
    const focusEntry = result.spellcasting.find((e) => e.prepared === "focus");
    expect(focusEntry).toBeDefined();
    expect(focusEntry!.tradition).toBe("occult");
    expect(focusEntry!.spells).toEqual([
      "blazing-bolt",
      "breathe-fire",
      "entropic-wheel",
      "fireball",
      "howling-blizzard",
      "ice-storm",
      "redistribute-potential",
      "thermal-stasis",
    ]);
    expect(result.focus.value).toBe(3);
    expect(result.focus.max).toBe(3);
  });

  test("imports carried gear and lists world gaps as unmapped", () => {
    // NOTE: the bag of holding and the two `-psychic` psi cantrip variants
    // are absent from this world's compendiums (same module gap as the first
    // psychic), so they surface as unmapped rather than vanishing.
    const names = result.equipment.map((i) => i.name);
    expect(names.some((n) => /explorer's clothing/i.test(n))).toBe(true);
    expect(names.some((n) => /clan dagger/i.test(n))).toBe(true);
    expect(names.some((n) => /bag of holding/i.test(n))).toBe(false);
    expect(result.summary.unmapped).toContainEqual({ slug: "bag-of-holding-i", kind: "equipment" });
    expect(result.summary.unmapped).toContainEqual({ slug: "ignition-psychic-rm", kind: "spell" });
    expect(result.summary.unmapped).toContainEqual({ slug: "frostbite-psychic-rm", kind: "spell" });
    expect(result.standaloneSpells).toEqual([]);
  });
});
