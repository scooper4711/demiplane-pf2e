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
} from "./helpers.js";

const CHARACTER_UUID = process.env.KYRA_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Kyra Soft Delete Test";
const MODULE_ID = "demiplane-pf2e";

/**
 * Soft-delete mode (top write level + "set quantity to 0" enabled): deleting
 * a Demiplane-controlled item sets its remote quantity to 0 instead of
 * removing the item, and the importer then skips quantity-0 items so the
 * item stays gone locally until topped back up. Hard deletes at the top
 * level are covered by kyra-mutation.spec.ts; lower tiers by
 * kyra-mutation-levels.spec.ts.
 */
test.describe("Kyra Soft Delete", () => {
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and KYRA_UUID env vars required");

  test("delete zeroes remote quantity and re-import skips the item", async ({ browser }) => {
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
    let savedSettings: { level: string | undefined; softDelete: boolean | undefined } | undefined;
    try {
      page = await browser.newPage();
      await loginAsGamemaster(page);
      await deleteAllActors(page);
      await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
      const imported = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
      expect(imported.summary.errors).toHaveLength(1);
      // Imports hold the export suspension for seconds AFTER returning; any
      // mutation inside that window loses its hook queues (deletes
      // unrecoverably), so wait it out before touching the actor.
      await waitForSyncRelease(page, CHARACTER_UUID);

      savedSettings = await setWriteLevel(page, "text-quantity-delete", true);

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

      // Soft-delete is reversible, so it deliberately prompts nothing: the
      // quantity-0 change queues immediately. Assert no dialog appears (a
      // prompt here would mean the skip regressed), then push. The delete
      // hook runs synchronously inside delete(), so only the dialog's own
      // async render needs flushing — two animation frames, no fixed sleep.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await expect(page.getByRole("button", { name: "Set quantity to 0 on Demiplane" })).toHaveCount(0);
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

      // A wipe re-import skips the zero-quantity item: it stays gone locally.
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
      await new Promise((r) => setTimeout(r, 5000));
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
});
