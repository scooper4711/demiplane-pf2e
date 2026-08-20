import { test, expect } from "@playwright/test";
import { loginAsGamemaster, deleteActorByName, createAndImportCharacter, type ImportResult } from "./helpers.js";

const VALEROS_UUID = process.env.VALEROS_L5_UUID ?? "a5884413-857f-444c-a5d6-24d819632c8a";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Valeros Import Test";

test.describe("Valeros Level 5 Import", () => {
  test.skip(!DEMIPLANE_TOKEN, "DEMIPLANE_TOKEN env var required");

  // Import once, share result across all tests in this suite
  let result: ImportResult;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorByName(page, ACTOR_NAME);
    result = await createAndImportCharacter(page, ACTOR_NAME, VALEROS_UUID, DEMIPLANE_TOKEN);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorByName(page, ACTOR_NAME);
    await page.close();
  });

  test("no import errors", () => {
    expect(result.summary.errors).toHaveLength(0);
    expect(result.summary.itemsSkipped).toBe(0);
  });

  test("correct name and level", () => {
    expect(result.name).toBe("Valeros");
    expect(result.level).toBe(5);
  });

  test("correct ancestry, heritage, background, class", () => {
    expect(result.ancestry).toBe("Human");
    expect(result.heritage).toContain("Skilled Human");
    expect(result.background).toBe("Farmhand");
    expect(result.class).toBe("Fighter");
  });

  test("class feats in correct slots", () => {
    const feats = result.feats;
    expect(feats.find(f => f.name === "Double Slice")?.location).toBe("class-1");
    expect(feats.find(f => f.name === "Double Slice")?.taken).toBe(1);
    expect(feats.find(f => f.name === "Aggressive Block")?.location).toBe("class-2");
    expect(feats.find(f => f.name === "Aggressive Block")?.taken).toBe(2);
    expect(feats.find(f => f.name === "Powerful Shove")?.location).toBe("class-4");
    expect(feats.find(f => f.name === "Powerful Shove")?.taken).toBe(4);
  });

  test("ancestry feats in correct slots", () => {
    const feats = result.feats;
    expect(feats.find(f => f.name === "Natural Ambition")?.location).toBe("ancestry-1");
    expect(feats.find(f => f.name === "Natural Ambition")?.taken).toBe(1);
    expect(feats.find(f => f.name === "Haughty Obstinacy")?.location).toBe("ancestry-5");
    expect(feats.find(f => f.name === "Haughty Obstinacy")?.taken).toBe(5);
  });

  test("skill and general feats in correct slots", () => {
    const feats = result.feats;
    expect(feats.find(f => f.name === "Combat Climber")?.location).toBe("skill-2");
    expect(feats.find(f => f.name === "Combat Climber")?.taken).toBe(2);
    expect(feats.find(f => f.name === "Powerful Leap")?.location).toBe("skill-4");
    expect(feats.find(f => f.name === "Powerful Leap")?.taken).toBe(4);
    expect(feats.find(f => f.name === "Toughness")?.location).toBe("general-3");
    expect(feats.find(f => f.name === "Toughness")?.taken).toBe(3);
  });

  test.fixme("grants Reactive Shield via Natural Ambition ChoiceSet", () => {
    expect(result.feats.find(f => f.name === "Reactive Shield")).toBeDefined();
  });

  test("auto-grants class features via Grant Chain", () => {
    const feats = result.feats;
    expect(feats.find(f => f.name === "Reactive Strike")).toBeDefined();
    expect(feats.find(f => f.name === "Bravery")).toBeDefined();
    expect(feats.find(f => f.name === "Fighter Weapon Mastery")).toBeDefined();
  });
  test("applies correct languages", () => {
    expect(result.languages).toContain("common");
    expect(result.languages).toContain("goblin");
    expect(result.languages).toContain("kelish");
    expect(result.languages).toHaveLength(3);
  });

  test("applies correct skill proficiencies", () => {
    expect(result.skills.acrobatics).toBe(2);   // Heritage (Skilled Human) + override to Expert
    expect(result.skills.athletics).toBe(2);    // Skill increase at L3
    expect(result.skills.crafting).toBe(1);     // Initial proficiencies
    expect(result.skills.diplomacy).toBe(1);    // Fighter skill training
    expect(result.skills.intimidation).toBe(2); // Override to Expert
    expect(result.skills.occultism).toBe(1);    // Fighter skill training
    expect(result.skills.survival).toBeUndefined(); // Override to untrained (0)
  });

  test("applies correct attribute modifiers", () => {
    expect(result.abilities.str).toBe(4);
    expect(result.abilities.dex).toBe(2);
    expect(result.abilities.con).toBe(3);
    expect(result.abilities.int).toBe(1);
    expect(result.abilities.wis).toBe(1);
    expect(result.abilities.cha).toBe(1);
  });
});
