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

const CHARACTER_UUID = process.env.PSYCHIC_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Psychic Import Test";

type SpellcastingEntry = ImportResult["spellcasting"][number];

/** Order-proof placement comparison: sorted `spell:state` pairs per slot. */
function placed(entry: SpellcastingEntry, slot: string): string[] {
  const list = entry.slots[slot]?.prepared ?? [];
  return list.map((p) => `${p.spell}:${p.expended ? "spent" : "ready"}`).sort();
}

test.describe("Psychic Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Magus suite. Values below snapshot the reference character
  // (level-4 unbound-step psychic "FVTT Psychic"); update them if the
  // character is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and PSYCHIC_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "psychic");
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
    expect(result.name).toBe("FVTT Psychic");
    expect(result.level).toBe(4);
    expect(result.ancestry).toBe("Kitsune");
    expect(result.heritage).toBe("Empty Sky Kitsune");
    expect(result.background).toBe("Attention Addict");
    expect(result.class).toBe("Psychic");
  });

  test("imports feats", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of [
      "Foxfire",
      "Emotional Acceptance",
      "The Unbound Step",
      "Godless Healing",
      "Efficient Explorer",
      "Prescient Planner",
      "Wizard Dedication",
      "Basic Wizard Spellcasting",
    ]) {
      expect(names).toContain(feat);
    }
  });

  test("imports gladiatorial lore and languages", () => {
    expect(result.loreSkills).toEqual(["Gladiatorial Lore"]);
    expect(result.languages).toEqual(["common"]);
  });

  test("imports hit points and empty purse", () => {
    // Current HP synced from Demiplane; the max is system-derived.
    expect(result.hp.value).toBe(36);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
  });

  test("files the repertoire in a spontaneous occult entry", () => {
    // Only the ranked repertoire resolves; the psi cantrips are unmapped
    // (module gap, asserted below). Level-4 progression; nothing cast, so
    // every slot is full and no placements exist (spontaneous casters spend
    // slots, not prepared spells).
    expectSpellcastingEntries(result, [
      {
        name: "Psychic Spells (Occult)",
        prepared: "spontaneous",
        tradition: "occult",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["animated-assault", "bee-mans-summons", "biting-words", "bullhorn", "charm"],
        slots: { slot1: { max: 2, value: 2 }, slot2: { max: 2, value: 2 } },
      },
      {
        // NOTE: the unremastered kitsune definition grants Ghost Sound; the
        // remaster renamed it Figment, so the mapping editor renames this item
        // to Figment on a mapped world. The raw import carries the granted
        // name. The divine tradition comes straight from the feat grant.
        name: "Innate Spells",
        prepared: "innate",
        tradition: "divine",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["daze", "forbidding-ward", "ghost-sound"],
      },
      {
        // Distortion Lens, Enlarge, and Thoughtful Gift have no spell engines
        // — they resolve from the unbound-step definition as focus amps — and
        // the class grants both focus points, currently available.
        name: "School Spells",
        prepared: "focus",
        tradition: "occult",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["distortion-lens", "enlarge", "thoughtful-gift"],
      },
      {
        // The archetype casts exactly like its base class (prepared arcane),
        // so no unknown-source error — but the entry keeps a distinct name.
        // Cantrip maximum from the wizard-dedication definition; rank 1 from
        // Basic Wizard Spellcasting. Both match the sheet with no overrides.
        name: "Arcane Spells",
        prepared: "prepared",
        tradition: "arcane",
        ability: "int",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["ancient-dust", "camel-spit", "carryall", "figment", "frostbite", "frosts-touch"],
        slots: { slot0: { max: 2, value: 2 }, slot1: { max: 1, value: 1 } },
      },
    ]);
  });

  test("imports the focus pool", () => {
    // The class grants both focus points, currently available.
    expect(result.focus.value).toBe(2);
    expect(result.focus.max).toBe(2);
  });

  test("lists the unmapped psi cantrips", () => {
    // NOTE: Demiplane is still working on remastered psychic spells, and the
    // `-psychic` psi cantrip variants aren't in this world's compendiums, so
    // four of the five cantrips can't resolve. They surface as unmapped rather
    // than vanishing.
    expect(result.summary.unmapped).toContainEqual({ slug: "shield-psychic-rm", kind: "spell" });
    expect(result.summary.unmapped).toContainEqual({ slug: "telekinetic-hand-psychic-rm", kind: "spell" });
    expect(result.summary.unmapped).toContainEqual({ slug: "phase-bolt-psychic-rm", kind: "spell" });
    expect(result.summary.unmapped).toContainEqual({ slug: "warp-step-psychic-rm", kind: "spell" });
  });

  test("applies archetype prepared placements", () => {
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "arcane");
    expect(spellbook).toBeDefined();
    expect(placed(spellbook!, "slot0")).toEqual(["frostbite:ready", "frosts-touch:ready"]);
    expect(placed(spellbook!, "slot1")).toEqual(["camel-spit:ready"]);
  });
});
