import { test, expect } from "@playwright/test";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
  type ImportResult,
} from "./helpers.js";

const CHARACTER_UUID = process.env.NECROMANCER_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Necromancer Import Test";

type SpellcastingEntry = ImportResult["spellcasting"][number];

/** Order-proof placement comparison: sorted `spell:state` pairs per slot. */
function placed(entry: SpellcastingEntry, slot: string): string[] {
  const list = entry.slots[slot]?.prepared ?? [];
  return list.map((p) => `${p.spell}:${p.expended ? "spent" : "ready"}`).sort();
}

test.describe("Necromancer Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Bard suite. Values below snapshot the reference character
  // (level-1 flesh necromancer "FVTT Necromancer"); update them if the
  // character is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and NECROMANCER_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "necromancer");
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
    expect(result.name).toBe("FVTT Necromancer");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Tripkee");
    expect(result.heritage).toBe("Poisonhide Tripkee");
    expect(result.background).toBe("Acolyte");
    expect(result.class).toBe("Necromancer");
  });

  test("imports the ancestry feat", () => {
    const names = result.feats.map((f) => f.name);
    expect(names).toContain("Nocturnal Tripkee");
  });

  test("files the full dirge in a prepared occult entry", () => {
    // The eight chosen cantrips plus the five rank-1 spells. Harm has no
    // spell engine — it resolves from the necromancer-spellcasting definition
    // as a granted known spell — joining the book like any chosen spell.
    const dirge = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "occult");
    expect(dirge).toBeDefined();
    expect(dirge!.name).toBe("Necromancer Spells (Occult)");
    expect(dirge!.spells).toEqual([
      "concordant-choir",
      "connective-current",
      "cradle-aloft",
      "curse-of-recoil",
      "harm",
      "haunting-hymn",
      "illuminate",
      "infectious-enthusiasm",
      "inside-ropes",
      "invoke-true-name",
      "join-pasts",
      "message",
      "needle-darts",
    ]);
  });

  test("applies main-entry slot maximums, all unused", () => {
    const dirge = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "occult");
    expect(dirge).toBeDefined();
    // Level-1 necromancer progression: five cantrips, one rank-1 slot.
    // Nothing cast, so every slot is full.
    expect(dirge!.slots.slot0).toMatchObject({ max: 5, value: 5 });
    expect(dirge!.slots.slot1).toMatchObject({ max: 1, value: 1 });
  });

  test("places prepared spells with spent states in the main entry", () => {
    const dirge = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "occult");
    expect(dirge).toBeDefined();
    // Five cantrips prepared on Demiplane against five slots; rank 1 has only
    // Concordant Choir prepared. Harm is known-but-unprepared (granted, so it
    // joins the book without occupying a slot). All ready.
    expect(placed(dirge!, "slot0")).toEqual([
      "haunting-hymn:ready",
      "illuminate:ready",
      "infectious-enthusiasm:ready",
      "inside-ropes:ready",
      "invoke-true-name:ready",
    ]);
    expect(placed(dirge!, "slot1")).toEqual(["concordant-choir:ready"]);
  });

  test("collects the grave spells into a focus Grave Spells entry", () => {
    // Create Thrall and Thrall Charge (grave-cantrips grants shaped like
    // repertoire grants, split by their definitions' focus flags), Necrotic
    // Bomb (shares its engine with the grave focus point), and Dead Weight
    // (parented at the grave focus group by the Flesh fascination).
    const grave = result.spellcasting.find((e) => e.name === "Grave Spells");
    expect(grave).toBeDefined();
    expect(grave!.prepared).toBe("focus");
    expect(grave!.tradition).toBe("occult");
    expect(grave!.spells).toEqual(["create-thrall", "dead-weight", "necrotic-bomb", "thrall-charge"]);
  });

  test("does not leak the granted harm into the focus entry", () => {
    const grave = result.spellcasting.find((e) => e.name === "Grave Spells");
    expect(grave).toBeDefined();
    expect(grave!.spells).not.toContain("harm");
  });

  test("imports the focus pool", () => {
    // Two focus points on Demiplane (grave spells plus the Flesh
    // fascination), both currently available.
    expect(result.focus.value).toBe(2);
    expect(result.focus.max).toBe(2);
  });
});
