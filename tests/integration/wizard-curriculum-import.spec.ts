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

const CHARACTER_UUID = process.env.WIZARD_CURRICULUM_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Wizard Curriculum Import Test";

type SpellcastingEntry = ImportResult["spellcasting"][number];

/** Order-proof placement comparison: sorted `spell:state` pairs per slot. */
function placed(entry: SpellcastingEntry, slot: string): string[] {
  const list = entry.slots[slot]?.prepared ?? [];
  return list.map((p) => `${p.spell}:${p.expended ? "spent" : "ready"}`).sort();
}

test.describe("Wizard Curriculum Import", () => {
  // Live Demiplane API required — skipped (not removed) without credentials,
  // matching the Lini suite. Values below snapshot the reference character
  // (level-1 ars-grammatica wizard "FVTT Wizard"); update them if the
  // character is rebuilt on Demiplane.
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and WIZARD_CURRICULUM_UUID env vars required");

  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
    await stopCoverage(page, "wizard-curriculum");
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
    await page.close();
  });

  test("reports no import errors", () => {
    // The sheet once carried a leftover test language
    // ("zz-invalid-test-language") that the importer correctly reported and
    // skipped; it has since been removed on Demiplane, so this is strict.
    expect(result.summary.itemsSkipped).toBe(0);
    expect(result.summary.errors).toEqual([]);
  });

  test("correct name, level, ancestry, background, class", () => {
    // Renamed on Demiplane to mark this character as an integration fixture.
    expect(result.name).toBe("FVTT Wizard");
    expect(result.level).toBe(1);
    expect(result.ancestry).toBe("Goblin");
    expect(result.heritage).toBe("Razortooth Goblin");
    expect(result.background).toBe("Academic Scion");
    expect(result.class).toBe("Wizard");
  });

  test("imports feats", () => {
    const names = result.feats.map((f) => f.name);
    for (const feat of [
      // Granted by the Academic Scion background, not a Demiplane feat pick.
      "Arcane Sense",
      "Burn It!",
      "School of Ars Grammatica",
    ]) {
      expect(names).toContain(feat);
    }
  });

  test("imports academia lore and languages", () => {
    expect(result.loreSkills).toEqual(["Academia Lore"]);
    expect(result.languages).toEqual(["common", "goblin", "osiriani", "diabolic"]);
  });

  test("imports hit points and empty purse", () => {
    // Current HP synced from Demiplane; the max is system-derived. A fresh
    // level-1 with no gear engines carries no coin.
    expect(result.hp.value).toBe(14);
    expect(result.hp.max).toBeGreaterThan(0);
    expect(result.currency).toEqual({ pp: 0, gp: 0, sp: 0, cp: 0 });
    expect(result.equipment).toEqual([]);
  });

  test("files the full spellbook in a prepared arcane entry", () => {
    // The main entry holds every known spell, including the school spells
    // (which additionally get their own curriculum entry below). Level-1
    // wizard: five cantrips, two rank-1 slots. The rank-2 maximum (1) is a
    // player override on Demiplane holding the heightened acidic burst.
    expectSpellcastingEntries(result, [
      {
        name: "Wizard Spells (Arcane)",
        prepared: "prepared",
        tradition: "arcane",
        ability: "int",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: [
          "acidic-burst",
          "air-bubble",
          "animate-rope",
          "befuddle",
          "bone-shield",
          "caustic-blast",
          "command",
          "daze",
          "deep-breath",
          "detect-metal",
          "dispel-magic",
          "electric-arc",
          "enthrall",
          "figment",
          "frostbite",
          "gale-blast",
          "glass-shield",
          "infectious-enthusiasm",
          "message",
          "runic-body",
        ],
        slots: {
          slot0: { max: 5, value: 5 },
          slot1: { max: 2, value: 2 },
          slot2: { max: 1, value: 1 },
        },
      },
      {
        // One school cantrip (message), two rank-1 (command known, runic body
        // prepared), plus the known-but-uncastable dispel magic and enthrall.
        // A level-1 wizard has school slots for cantrips and rank 1 only; the
        // rank-2/3 school spells are known, not placed.
        name: "Ars Grammatica Curriculum Spells",
        prepared: "prepared",
        tradition: "arcane",
        ability: "int",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["command", "dispel-magic", "enthrall", "message", "runic-body"],
        slots: { slot0: { max: 1, value: 1 }, slot1: { max: 1, value: 1 } },
      },
      {
        // Protective Wards has no spell engine on Demiplane's side — it
        // resolves from the ars-grammatica school definition.
        name: "School Spells",
        prepared: "focus",
        tradition: "arcane",
        ability: "cha",
        proficiency: 1,
        flexible: false,
        dcMechanic: "spell-attack",
        spells: ["protective-wards"],
      },
    ]);
  });

  test("places prepared spells with spent states in the main entry", () => {
    const spellbook = result.spellcasting.find((e) => e.prepared === "prepared" && e.tradition === "arcane");
    expect(spellbook).toBeDefined();
    // Message is prepared but school-slotted, so it lands in the curriculum
    // entry below — the main cantrip slots hold the other five. Likewise
    // runic body (school) leaves air bubble and acidic burst in rank 1.
    expect(placed(spellbook!, "slot0")).toEqual([
      "caustic-blast:ready",
      "deep-breath:ready",
      "electric-arc:ready",
      "figment:ready",
      "frostbite:ready",
    ]);
    expect(placed(spellbook!, "slot1")).toEqual(["acidic-burst:ready", "air-bubble:ready"]);
    expect(placed(spellbook!, "slot2")).toEqual(["acidic-burst:ready"]);
  });

  test("places school spells with spent states in the school entry", () => {
    const school = result.spellcasting.find((e) => e.name === "Ars Grammatica Curriculum Spells");
    expect(school).toBeDefined();
    // Each school slot holds a school spell; the spent rank-2 force barrage
    // carries its expended state.
    expect(placed(school!, "slot0")).toEqual(["message:ready"]);
    expect(placed(school!, "slot1")).toEqual(["runic-body:ready"]);
  });

  test("imports the focus pool", () => {
    expect(result.focus.value).toBe(1);
    expect(result.focus.max).toBe(1);
  });
});
