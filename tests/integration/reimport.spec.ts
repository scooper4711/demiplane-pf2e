import { test, expect } from "@playwright/test";
import { loginAsGamemaster, deleteActorsForCharacter, deleteAllActors, stopCoverage } from "./helpers.js";

const KYRA_UUID = process.env.KYRA_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Kyra Reimport Test";

/**
 * Wipe-and-reimport idempotence: deleting all imported items and importing
 * again must reproduce the same actor (covers deleteImportedItems, which no
 * single import ever executes). Uses Kyra because her first import guesses
 * the unexported sanctification — then the test stores that guess as the
 * user's pick and proves the reimport honors it silently instead of
 * re-flagging, exercising the full choice-override loop.
 */
test.describe("Kyra Reimport", () => {
  test.skip(!DEMIPLANE_TOKEN || !KYRA_UUID, "DEMIPLANE_TOKEN and KYRA_UUID env vars required");

  test("reimport reproduces the same items without repeating warnings", async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteAllActors(page);
    await deleteActorsForCharacter(page, KYRA_UUID, ACTOR_NAME);

    const first = await page.evaluate(
      async ({ actorName, characterId, token, moduleId }) => {
        // @ts-expect-error Foundry global
        const actor = await Actor.create({ name: actorName, type: "character" });
        // @ts-expect-error Foundry global
        await actor.setFlag(moduleId, "characterId", characterId);
        // @ts-expect-error Foundry global
        const mod = game.modules.get(moduleId);
        const summary = await mod.api.importCharacter(actor, { token });
        const items = [...actor.items].map((i: { name: string; type: string }) => `${i.type}:${i.name}`).sort();
        return { actorId: actor.id as string, summary, items };
      },
      { actorName: ACTOR_NAME, characterId: KYRA_UUID, token: DEMIPLANE_TOKEN, moduleId: "demiplane-pf2e" }
    );
    expect(first.summary.errors).toHaveLength(1);
    expect(first.summary.errors[0]).toMatch(/couldn't determine the choice for/i);

    // Store a pick for the guessed ChoiceSet (as the sync dialog would),
    // choosing a non-first option to prove the override — not the guess —
    // is what the reimport applies.
    const record = first.summary.unresolvedChoices[0];
    const picked = record.options.length > 1 ? record.options[1].value : record.options[0].value;
    await page.evaluate(
      async ({ actorId, moduleId, key, value }) => {
        // @ts-expect-error Foundry global
        const actor = game.actors.get(actorId);
        // @ts-expect-error Foundry global
        const current = (actor.getFlag(moduleId, "choiceOverrides") ?? {}) as Record<string, string>;
        // @ts-expect-error Foundry global
        await actor.setFlag(moduleId, "choiceOverrides", { ...current, [key]: value });
      },
      { actorId: first.actorId, moduleId: "demiplane-pf2e", key: record.key, value: picked }
    );

    const second = await page.evaluate(
      async ({ actorId, token, moduleId }) => {
        // @ts-expect-error Foundry global
        const actor = game.actors.get(actorId);
        // @ts-expect-error Foundry global
        const mod = game.modules.get(moduleId);
        const summary = await mod.api.importCharacter(actor, { token, wipe: true });
        const items = [...actor.items].map((i: { name: string; type: string }) => `${i.type}:${i.name}`).sort();
        return { summary, items };
      },
      { actorId: first.actorId, token: DEMIPLANE_TOKEN, moduleId: "demiplane-pf2e" },
      { timeout: 120_000 }
    );
    await stopCoverage(page, "reimport");

    expect(second.summary.errors).toHaveLength(0);
    expect(second.items).toEqual(first.items);

    await deleteActorsForCharacter(page, KYRA_UUID, ACTOR_NAME);
    await page.close();
  });
});
