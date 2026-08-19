import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { loginAs, loginToFoundry, resetTestWorld, createTestActor, getUserId } from "./helpers.js";

const MODULE_ID = "foundry-demiplane-pf2e";

const VALEROS_UUID_L5 =
  process.env.VALEROS_L5_UUID ?? "a5884413-857f-444c-a5d6-24d819632c8a";

interface ActorValidation {
  name: string;
  level: number;
  ancestry: string;
  class: string;
  hp: { max: number };
  attributes: Record<string, number>;
  skills: Record<string, number>;
}

/**
 * Expected reference data for Valeros Level 5 (Fighter).
 * Values should match Foundry PF2e's built-in Valeros pregen.
 */
const VALEROS_L5: ActorValidation = {
  name: "Valeros",
  level: 5,
  ancestry: "Human",
  class: "Fighter",
  hp: { max: 56 },
  attributes: { str: 19, dex: 14, con: 12, int: 10, wis: 14, cha: 10 },
  skills: { athletics: 2, intimidation: 1, acrobatics: 1 },
};

async function linkCharacterToActor(
  page: Page,
  actorId: string,
  characterUuid: string,
): Promise<void> {
  await page.evaluate(
    async ({ actorId, characterUuid, moduleId }) => {
      // @ts-expect-error Foundry global
      const actor = game.actors.get(actorId);
      if (!actor) throw new Error(`Actor ${actorId} not found`);
      await actor.setFlag(moduleId, "characterId", characterUuid);
    },
    { actorId, characterUuid, moduleId: MODULE_ID },
  );
}

async function triggerImport(page: Page, actorId: string): Promise<void> {
  await page.evaluate(
    async ({ actorId, moduleId }) => {
      // @ts-expect-error Foundry global
      const actor = game.actors.get(actorId);
      if (!actor) throw new Error(`Actor ${actorId} not found`);

      // @ts-expect-error Module global
      const module = game.modules.get(moduleId);
      if (!module?.api?.importCharacter) {
        throw new Error("Module API not available — is the module enabled?");
      }
      await module.api.importCharacter(actor);
    },
    { actorId, moduleId: MODULE_ID },
  );

  // Wait for import to complete (lastSyncTimestamp flag set)
  await page.waitForFunction(
    ({ actorId, moduleId }) => {
      // @ts-expect-error Foundry global
      const actor = game.actors.get(actorId);
      return actor?.getFlag(moduleId, "lastSyncTimestamp") != null;
    },
    { actorId, moduleId: MODULE_ID },
    { timeout: 30_000 },
  );
}

async function getActorData(
  page: Page,
  actorId: string,
): Promise<Record<string, unknown>> {
  return await page.evaluate(async (id: string) => {
    // @ts-expect-error Foundry global
    const actor = game.actors.get(id);
    if (!actor) throw new Error(`Actor ${id} not found`);
    return {
      name: actor.name,
      level: actor.system.details.level.value,
      ancestry: actor.items.find(
        (i: { type: string }) => i.type === "ancestry",
      )?.name,
      class: actor.items.find((i: { type: string }) => i.type === "class")
        ?.name,
      hp: { max: actor.system.attributes.hp.max },
      attributes: {
        str: actor.system.abilities.str.value,
        dex: actor.system.abilities.dex.value,
        con: actor.system.abilities.con.value,
        int: actor.system.abilities.int.value,
        wis: actor.system.abilities.wis.value,
        cha: actor.system.abilities.cha.value,
      },
      skills: Object.fromEntries(
        Object.entries(actor.system.skills)
          .filter(
            ([_, data]: [string, unknown]) =>
              (data as { rank: number }).rank > 0,
          )
          .map(([key, data]: [string, unknown]) => [
            key,
            (data as { rank: number }).rank,
          ]),
      ),
      feats: actor.items
        .filter((i: { type: string }) => i.type === "feat")
        .map((i: { name: string }) => i.name),
    };
  }, actorId);
}

function validateActor(
  actual: Record<string, unknown>,
  expected: ActorValidation,
): void {
  expect(actual.name).toBe(expected.name);
  expect(actual.level).toBe(expected.level);
  expect(actual.ancestry).toBe(expected.ancestry);
  expect(actual.class).toBe(expected.class);
  expect((actual.hp as { max: number }).max).toBe(expected.hp.max);

  const actualAttributes = actual.attributes as Record<string, number>;
  for (const [attr, value] of Object.entries(expected.attributes)) {
    expect(actualAttributes[attr], `Attribute ${attr}`).toBe(value);
  }

  const actualSkills = actual.skills as Record<string, number>;
  for (const [skill, rank] of Object.entries(expected.skills)) {
    expect(actualSkills[skill], `Skill ${skill}`).toBeGreaterThanOrEqual(rank);
  }
}

// ============================================================
// Tests as Gamemaster
// ============================================================

test.describe("Valeros Import — Gamemaster", () => {
  test.beforeEach(async ({ page }) => {
    await loginToFoundry(page);
    await resetTestWorld(page);
  });

  test("Level 5 Valeros import matches reference (GM)", async ({ page }) => {
    const actorId = await createTestActor(page, "GM Valeros L5");
    await linkCharacterToActor(page, actorId, VALEROS_UUID_L5);
    await triggerImport(page, actorId);

    const actorData = await getActorData(page, actorId);
    validateActor(actorData, VALEROS_L5);
  });
});

// ============================================================
// Tests as Player
// ============================================================

test.describe("Valeros Import — Player", () => {
  test.beforeEach(async ({ page }) => {
    // Setup as GM first: create actor owned by player
    await loginToFoundry(page);
    await resetTestWorld(page);
  });

  test("Level 5 Valeros import matches reference (Player)", async ({ page }) => {
    // Create actor owned by the player, then switch to player session
    const playerId = await getUserId(page, "TestPlayer");
    const actorId = await createTestActor(page, "Player Valeros L5", playerId);
    await linkCharacterToActor(page, actorId, VALEROS_UUID_L5);

    // Now log in as the player and trigger import from their perspective
    await loginAs(page, "TestPlayer");
    await triggerImport(page, actorId);

    const actorData = await getActorData(page, actorId);
    validateActor(actorData, VALEROS_L5);
  });
});
