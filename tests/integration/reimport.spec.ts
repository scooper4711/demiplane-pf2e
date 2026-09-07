import { test, expect } from "@playwright/test";
import { loginAsGamemaster, deleteActorsForCharacter, deleteAllActors, stopCoverage } from "./helpers.js";

const KYRA_UUID = process.env.KYRA_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Kyra Reimport Test";

/**
 * Wipe-and-reimport idempotence: deleting all imported items and importing
 * again must reproduce the same actor (covers deleteImportedItems, which no
 * single import ever executes). Uses Kyra because her first import reports
 * the sanctification default exactly once — the reimport must NOT repeat
 * it, proving derived state survives the wipe.
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
    expect(first.summary.errors[0]).toMatch(/sanctification/i);

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
