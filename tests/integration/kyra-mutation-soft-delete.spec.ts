import { test, expect, type Page } from "@playwright/test";
import { DemiplaneClient } from "@scooper4711/demiplane-api";
import {
  loginAsGamemaster,
  deleteActorsForCharacter,
  deleteAllActors,
  createAndImportCharacter,
  stopCoverage,
  withApiRetry,
  setWriteLevel,
  restoreWriteLevel,
  waitForSyncRelease,
  storeGuessedPicks,
} from "./helpers.js";

const CHARACTER_UUID = process.env.KYRA_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Kyra Soft Delete Test";
const MODULE_ID = "demiplane-pf2e";

/**
 * Session soft-delete (session mode): deleting a Demiplane-controlled item
 * sets its remote quantity to 0 without prompting, and the importer then
 * skips quantity-0 items at session level so the item stays gone locally
 * until topped back up. At every other level a quantity of 0 is a real
 * quantity and imports as-is (including at full sync, where hard delete
 * removes the engine outright). Hard deletes at full sync are covered by
 * kyra-mutation.spec.ts; lower-tier gates by kyra-mutation-levels.spec.ts.
 */
test.describe("Kyra Soft Delete", () => {
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and KYRA_UUID env vars required");

  test("session delete zeroes remote quantity and re-import skips the item", async ({ browser }) => {
    test.setTimeout(600_000);

    const client = new DemiplaneClient();
    client.setToken(DEMIPLANE_TOKEN);
    const saved = await withApiRetry("snapshot engines", () => client.fetchCharacterData(CHARACTER_UUID));
    const savedJournals = await withApiRetry("snapshot journals", () => client.fetchCharacterJournals(CHARACTER_UUID));
    const savedCampaign = savedJournals.find((j) => j.title === "Campaign");
    const sig = (engines: Array<{ name?: string; value?: unknown }>) =>
      Object.fromEntries(engines.map((e) => [e.name, JSON.stringify(e.value)]));
    const slugOf = (engineName: string) =>
      (engineName.split("/").pop() ?? "").replace(/\.eng$/, "").replace(/-rm$/, "");

    let page: Page | undefined;
    let savedSettings: { level: string | undefined } | undefined;
    try {
      page = await browser.newPage();
      await loginAsGamemaster(page);
      await deleteAllActors(page);
      await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
      const imported = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
      expect(imported.summary.errors).toHaveLength(1);
      await storeGuessedPicks(page, CHARACTER_UUID, imported.summary.unresolvedChoices);
      await waitForSyncRelease(page, CHARACTER_UUID);

      savedSettings = await setWriteLevel(page, "session");

      const targets = await page.evaluate(
        ({ characterId, moduleId }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
          return [...actor.items].map(
            (i: {
              id: string;
              name: string;
              type: string;
              system: { slug?: string; containerId?: string | null };
            }) => ({
              id: i.id,
              name: i.name,
              type: i.type,
              slug: i.system.slug,
              containerId: i.system.containerId ?? null,
            })
          );
        },
        { characterId: CHARACTER_UUID, moduleId: MODULE_ID }
      );
      const deleteItem = targets.find(
        (i) =>
          ["consumable", "equipment", "weapon"].includes(i.type) &&
          typeof i.slug === "string" &&
          i.containerId === null &&
          targets.filter((j) => j.name === i.name).length === 1
      );
      if (!deleteItem) throw new Error("Missing soft-delete target with a unique name");
      console.log(`Soft-delete target: ${deleteItem.name} (${deleteItem.slug})`);

      await page.evaluate(
        async ({ characterId, moduleId, deleteName }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
          await actor.update({ "system.attributes.hp.value": 3 });
          const target = [...actor.items].find((i: { name: string }) => i.name === deleteName);
          if (!target) throw new Error(`delete target gone before delete: ${deleteName}`);
          await target.delete();
        },
        { characterId: CHARACTER_UUID, moduleId: MODULE_ID, deleteName: deleteItem.name },
        { timeout: 120_000 }
      );

      // Session soft-delete is reversible, so it deliberately prompts nothing:
      // the quantity-0 change queues immediately. Assert no dialog appears (a
      // prompt here would mean soft-delete regressed to hard-delete).
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await expect(page.getByRole("button", { name: "Delete on Demiplane" })).toHaveCount(0);

      const pushResult = await page.evaluate(
        async ({ characterId, moduleId }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
          // @ts-expect-error Foundry global
          return await game.modules.get(moduleId).api.exportNow(actor);
        },
        { characterId: CHARACTER_UUID, moduleId: MODULE_ID },
        { timeout: 120_000 }
      );
      expect(pushResult.success).toBe(true);

      const after = await withApiRetry("fetch engines", () => client.fetchCharacterData(CHARACTER_UUID));
      expect(after.engines.find((e) => e.name === "character_hit-points_current")?.value).toBe(3);
      // Base engine still present (no hard delete)…
      const base = after.engines.find((e) => e.name.startsWith("tabula/item/") && slugOf(e.name) === deleteItem.slug);
      expect(base, "base item engine survives soft delete").toBeDefined();
      // …with its quantity engine zeroed.
      const qty = after.engines.find((e) => e.name === `${base!.demiplaneEngineId}--quantity`);
      expect(qty?.value).toBe(0);

      // A wipe re-import at session skips the zero-quantity item: it stays gone.
      const names = await page.evaluate(
        async ({ characterId, moduleId, token }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
          // @ts-expect-error Foundry global
          await game.modules.get(moduleId).api.importCharacter(actor, { token, wipe: true });
          return [...actor.items].map((i: { name: string }) => i.name);
        },
        { characterId: CHARACTER_UUID, moduleId: MODULE_ID, token: DEMIPLANE_TOKEN },
        { timeout: 180_000 }
      );
      expect(names).not.toContain(deleteItem.name);
      await stopCoverage(page, "kyra-soft-delete");
    } finally {
      if (page && savedSettings) {
        await restoreWriteLevel(page, savedSettings);
      }
      const restore = await withApiRetry("restore engines", async () => {
        const res = await client.updateCharacter({
          id: CHARACTER_UUID,
          data: { engines: saved.engines, engineCacheIdsBySource: saved.engineCacheIdsBySource ?? {} },
          name: saved.name,
          level: saved.level,
          avatarUrl: saved.avatarUrl,
          viewPermission: saved.viewPermission,
          editPermission: saved.editPermission,
        });
        if (!res.success && /rate.?limit|too many requests|\b429\b/i.test(res.message ?? "")) {
          throw Object.assign(new Error(res.message ?? "rate limited"), { statusCode: 429 });
        }
        return res;
      });
      expect(restore.success, restore.message ?? "restore write failed").toBe(true);
      const after = await withApiRetry("verify engines", () => client.fetchCharacterData(CHARACTER_UUID));
      expect(sig(after.engines)).toEqual(sig(saved.engines));
      if (savedCampaign) {
        const text = savedCampaign.description || savedCampaign.content;
        await withApiRetry("restore journal", () =>
          client.updateCharacterJournal(savedCampaign.objectID, CHARACTER_UUID, "Campaign", text)
        );
        const afterJournals = await withApiRetry("verify journal", () => client.fetchCharacterJournals(CHARACTER_UUID));
        expect(afterJournals.find((j) => j.title === "Campaign")?.description).toBe(savedCampaign.description);
      }
      if (page) {
        await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME).catch(() => {});
        await page.close().catch(() => {});
      }
    }
  });

  test("full sync hard-deletes at quantity 0 and does not skip on re-import", async ({ browser }) => {
    test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and KYRA_UUID env vars required");
    test.setTimeout(600_000);

    const client = new DemiplaneClient();
    client.setToken(DEMIPLANE_TOKEN);
    const saved = await withApiRetry("snapshot engines", () => client.fetchCharacterData(CHARACTER_UUID));
    const sig = (engines: Array<{ name?: string; value?: unknown }>) =>
      Object.fromEntries(engines.map((e) => [e.name, JSON.stringify(e.value)]));
    const slugOf = (engineName: string) =>
      (engineName.split("/").pop() ?? "").replace(/\.eng$/, "").replace(/-rm$/, "");

    let page: Page | undefined;
    let savedSettings: { level: string | undefined } | undefined;
    try {
      page = await browser.newPage();
      await loginAsGamemaster(page);
      await deleteAllActors(page);
      await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
      const imported = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
      expect(imported.summary.errors).toHaveLength(1);
      await storeGuessedPicks(page, CHARACTER_UUID, imported.summary.unresolvedChoices);
      await waitForSyncRelease(page, CHARACTER_UUID);

      // At full sync with a hard-delete-eligible item, setting quantity 0
      // via an item update should import as-is (not be skipped) because
      // shouldSkipZeroQuantityItems() is only true at session level.
      // First, prove full-sync deletion prompts and removes the engine.
      savedSettings = await setWriteLevel(page, "full");

      const targets = await page.evaluate(
        ({ characterId, moduleId }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
          return [...actor.items].map(
            (i: { id: string; name: string; type: string; system: { slug?: string; quantity?: number } }) => ({
              id: i.id,
              name: i.name,
              type: i.type,
              slug: i.system.slug,
              quantity: i.system.quantity,
            })
          );
        },
        { characterId: CHARACTER_UUID, moduleId: MODULE_ID }
      );
      const qtyItem = targets.find(
        (i) => ["consumable", "equipment"].includes(i.type) && typeof i.quantity === "number"
      );
      if (!qtyItem) throw new Error("Missing quantity target for full-sync check");

      // Set quantity to 0 via item update and push — at full sync this is a
      // real quantity 0, not a soft-delete marker.
      await page.evaluate(
        async ({ characterId, moduleId, qtyId }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
          await actor.items.get(qtyId).update({ "system.quantity": 0 });
        },
        { characterId: CHARACTER_UUID, moduleId: MODULE_ID, qtyId: qtyItem.id },
        { timeout: 120_000 }
      );
      const pushResult = await page.evaluate(
        async ({ characterId, moduleId }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
          // @ts-expect-error Foundry global
          return await game.modules.get(moduleId).api.exportNow(actor);
        },
        { characterId: CHARACTER_UUID, moduleId: MODULE_ID },
        { timeout: 120_000 }
      );
      expect(pushResult.success).toBe(true);
      const after = await withApiRetry("fetch engines", () => client.fetchCharacterData(CHARACTER_UUID));
      const base = after.engines.find((e) => e.name.startsWith("tabula/item/") && slugOf(e.name) === qtyItem.slug);
      expect(base, "base still present after quantity 0 at full sync").toBeDefined();
      const qty = after.engines.find((e) => e.name === `${base!.demiplaneEngineId}--quantity`);
      expect(qty?.value).toBe(0);

      // Wipe re-import at full sync should NOT skip: quantity 0 is a real
      // quantity there, so the item stays.
      const names = await page.evaluate(
        async ({ characterId, moduleId, token }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
          // @ts-expect-error Foundry global
          await game.modules.get(moduleId).api.importCharacter(actor, { token, wipe: true });
          return [...actor.items].map((i: { name: string }) => i.name);
        },
        { characterId: CHARACTER_UUID, moduleId: MODULE_ID, token: DEMIPLANE_TOKEN },
        { timeout: 180_000 }
      );
      expect(names).toContain(qtyItem.name);
    } finally {
      if (page && savedSettings) await restoreWriteLevel(page, savedSettings);
      const restore = await withApiRetry("restore engines", async () => {
        const res = await client.updateCharacter({
          id: CHARACTER_UUID,
          data: { engines: saved.engines, engineCacheIdsBySource: saved.engineCacheIdsBySource ?? {} },
          name: saved.name,
          level: saved.level,
          avatarUrl: saved.avatarUrl,
          viewPermission: saved.viewPermission,
          editPermission: saved.editPermission,
        });
        if (!res.success && /rate.?limit|too many requests|\b429\b/i.test(res.message ?? "")) {
          throw Object.assign(new Error(res.message ?? "rate limited"), { statusCode: 429 });
        }
        return res;
      });
      expect(restore.success, restore.message ?? "restore write failed").toBe(true);
      const after = await withApiRetry("verify engines", () => client.fetchCharacterData(CHARACTER_UUID));
      expect(sig(after.engines)).toEqual(sig(saved.engines));
      if (page) {
        await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME).catch(() => {});
        await page.close().catch(() => {});
      }
    }
  });
});
