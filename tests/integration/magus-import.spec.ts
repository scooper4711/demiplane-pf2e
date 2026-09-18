import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
  type ImportResult,
} from "./helpers.js";

const CHARACTER_UUID = process.env.MAGUS_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Magus Import Test";

type SpellcastingEntry = ImportResult["spellcasting"][number];

/** Order-proof placement comparison: sorted `spell:state` pairs per slot. */
function placed(entry: SpellcastingEntry, slot: string): string[] {
  const list = entry.slots[slot]?.prepared ?? [];
  return list.map((p) => `${p.spell}:${p.expended ? "spent" : "ready"}`).sort();
}

test.describe("Magus Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Psychic suite. Values below snapshot the reference character
  // (level-1 starlit-span magus "FVTT Magus"); update them if the character is
  // rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and MAGUS_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "magus");
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
    expect(result.name).toBe("FVTT Magus");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Automaton");
    expect(result.heritage).toBe("Mage Automaton");
    expect(result.background).toBe("Alkenstar Outlaw");
    expect(result.class).toBe("Magus");
  });

  test("imports feats", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of ["Arcane Communication", "Starlit Span", "Hybrid Study", "Spellstrike", "Arcane Cascade"]) {
      expect(names).toContain(feat);
    }
  });

  test("imports underworld lore and languages", () => {
    expect(result.loreSkills).toEqual(["Underworld Lore"]);
    expect(result.languages).toEqual(["common", "utopian"]);
  });

  test("imports hit points and empty purse", () => {
    // Current HP synced from Demiplane; the max is system-derived.
    expect(result.hp.value).toBe(18);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
  });

  test("files the full spellbook in a prepared arcane entry", () => {
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "arcane");
    expect(spellbook).toBeDefined();
    expect(spellbook!.name).toBe("Magus Spells (Arcane)");
    expect(spellbook!.spells).toEqual([
      "500-toads",
      "acidic-burst",
      "admonishing-ray",
      "agitate",
      "air-bubble",
      "ancient-dust",
      "approximate",
      "artistic-recollection",
      "bramble-bush",
      "bullhorn",
      "caustic-blast",
      "create-earthen-facsimile",
      "daze",
    ]);
  });

  test("applies slot maximums and prepared placements", () => {
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "arcane");
    expect(spellbook).toBeDefined();
    // Level-1 magus: five cantrips plus a single rank-1 slot. The rank-1
    // maximum resolves from the magus's own tagged slot entries (see
    // spell-slot-resolver) — without them the 500 Toads placement would be
    // lost, as the class definition carries no empty-slug ranked entries.
    expect(spellbook!.slots.slot0).toMatchObject({ max: 5, value: 5 });
    expect(spellbook!.slots.slot1).toMatchObject({ max: 1, value: 1 });
    expect(placed(spellbook!, "slot0")).toEqual([
      "ancient-dust:ready",
      "approximate:ready",
      "artistic-recollection:ready",
      "bramble-bush:ready",
      "bullhorn:ready",
    ]);
    expect(placed(spellbook!, "slot1")).toEqual(["500-toads:ready"]);
  });

  test("files the heritage spell as innate", () => {
    // Eat Fire comes from the mage-automaton heritage (a select-spell without
    // a school marker), consistent with dedication cantrips like Root Reading.
    const innateEntries = result.spellcasting.filter((e) => e.prepared === "innate");
    expect(innateEntries).toHaveLength(1);
    expect(innateEntries[0]!.spells).toEqual(["eat-fire"]);
  });

  test("files the conflux spell in a focus entry and imports the focus pool", () => {
    // Shooting Star has no spell engine — it resolves from the conflux
    // definition. Its rank-2 rider (Water Breathing) is gated out: a level-1
    // magus has no rank-2 slots (see feature-spell-resolver rank gating).
    const focusEntry = result.spellcasting.find((e) => e.prepared === "focus");
    expect(focusEntry).toBeDefined();
    expect(focusEntry!.tradition).toBe("arcane");
    expect(focusEntry!.spells).toEqual(["shooting-star"]);
    expect(result.focus.value).toBe(1);
    expect(result.focus.max).toBe(1);
  });

  test("lists the focus grants missing from this world's compendiums", () => {
    // NOTE: Spider Climb and True Strike are granted by the heritage/conflux
    // definitions but neither name is in this world's spell compendium, so
    // they surface as unmapped rather than vanishing.
    expect(result.summary.unmapped).toContainEqual({ slug: "spider-climb", kind: "spell" });
    expect(result.summary.unmapped).toContainEqual({ slug: "true-strike", kind: "spell" });
  });
});
