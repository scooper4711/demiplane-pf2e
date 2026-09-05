import { test, expect } from "@playwright/test";
import { loginAsGamemaster, deleteActorsForCharacter, stopCoverage } from "./helpers.js";

const VALEROS_UUID = process.env.VALEROS_L5_UUID ?? "a5884413-857f-444c-a5d6-24d819632c8a";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Valeros Reimport Test";

/**
 * Wipe-and-reimport idempotence: deleting all imported items and importing
 * again must reproduce the same actor (covers deleteImportedItems, which no
 * single import ever executes).
 */
test.describe("Valeros Reimport", () => {
  test.skip(!DEMIPLANE_TOKEN, "DEMIPLANE_TOKEN env var required");

  test("reimport reproduces the same items", async ({ browser }) => {
    const page = await browser.newPage();
    await loginAsGamemaster(page);
    await deleteActorsForCharacter(page, VALEROS_UUID, ACTOR_NAME);

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
      { actorName: ACTOR_NAME, characterId: VALEROS_UUID, token: DEMIPLANE_TOKEN, moduleId: "demiplane-pf2e" }
    );
    expect(first.summary.errors).toHaveLength(0);

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

    await deleteActorsForCharacter(page, VALEROS_UUID, ACTOR_NAME);
    await page.close();
  });
});
