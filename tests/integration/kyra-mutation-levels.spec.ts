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
const ACTOR_NAME = "Kyra Levels Test";
const MODULE_ID = "demiplane-pf2e";

/**
 * Write-level gates: at each tier, mutations gated above it must not reach
 * Demiplane, while mutations at or below it must. One actor walks the tiers
 * in order (none → text → text-quantity → delete-gate), so each phase's
 * remote diff proves exactly what its tier permits. The top tier's
 * hard-delete path is covered by kyra-mutation.spec.ts; soft-delete by
 * kyra-mutation-soft-delete.spec.ts.
 */
test.describe("Kyra Write Levels", () => {
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and KYRA_UUID env vars required");

  test("lower tiers block what they must, pass what they may", async ({ browser }) => {
    test.setTimeout(900_000);

    const client = new DemiplaneClient();
    client.setToken(DEMIPLANE_TOKEN);
    const saved = await withApiRetry("snapshot engines", () => client.fetchCharacterData(CHARACTER_UUID));
    const sig = (engines: Array<{ name?: string; value?: unknown }>) =>
      Object.fromEntries(engines.map((e) => [e.name, JSON.stringify(e.value)]));
    const diffNames = (before: Record<string, string>, after: Record<string, string>) =>
      Object.keys(after).filter((k) => before[k] !== after[k]);
    const savedSig = sig(saved.engines);
    const savedHp = saved.engines.find((e) => e.name === "character_hit-points_current")?.value;

    let page: Page | undefined;
    let savedSettings: { level: string | undefined; softDelete: boolean | undefined } | undefined;
    try {
      page = await browser.newPage();
      await loginAsGamemaster(page);
      await deleteAllActors(page);
      await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME);
      const imported = await createAndImportCharacter(page, ACTOR_NAME, CHARACTER_UUID, DEMIPLANE_TOKEN);
      expect(imported.summary.errors).toHaveLength(1);
      // Adopt the guesses so later re-imports apply silently instead of
      // re-flagging; correctness of picks is covered by reimport.spec.ts.
      await storeGuessedPicks(page, CHARACTER_UUID, imported.summary.unresolvedChoices);
      // Imports hold the export suspension for seconds AFTER returning; any
      // mutation inside that window loses its hook queues (deletes
      // unrecoverably), so wait it out before touching the actor.
      await waitForSyncRelease(page, CHARACTER_UUID);

      const mutate = (
        update: Record<string, unknown>,
        itemUpdates?: Array<{ id: string; update: Record<string, unknown> }>
      ) =>
        page!.evaluate(
          async ({ characterId, moduleId, update, itemUpdates }) => {
            // @ts-expect-error Foundry global
            const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
            await actor.update(update);
            for (const { id, update: u } of itemUpdates ?? []) {
              await actor.items.get(id).update(u);
            }
          },
          { characterId: CHARACTER_UUID, moduleId: MODULE_ID, update, itemUpdates: itemUpdates ?? [] },
          { timeout: 120_000 }
        );

      const push = () =>
        page!.evaluate(
          async ({ characterId, moduleId }) => {
            // @ts-expect-error Foundry global
            const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
            // @ts-expect-error Foundry global
            return await game.modules.get(moduleId).api.exportNow(actor);
          },
          { characterId: CHARACTER_UUID, moduleId: MODULE_ID },
          { timeout: 120_000 }
        );

      const remoteSig = async () =>
        sig((await withApiRetry("fetch engines", () => client.fetchCharacterData(CHARACTER_UUID))).engines);

      const itemTargets = await page.evaluate(
        ({ characterId, moduleId }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
          return [...actor.items].map(
            (i: {
              id: string;
              name: string;
              type: string;
              system: {
                slug?: string;
                quantity?: number;
                containerId?: string | null;
                equipped?: { carryType?: string };
              };
            }) => ({
              id: i.id,
              name: i.name,
              type: i.type,
              slug: i.system.slug,
              quantity: i.system.quantity,
              carryType: i.system.equipped?.carryType,
              containerId: i.system.containerId ?? null,
            })
          );
        },
        { characterId: CHARACTER_UUID, moduleId: MODULE_ID }
      );
      const gold = itemTargets.find((i) => i.slug === "gold-pieces");
      const qtyItem = itemTargets.find(
        (i) =>
          ["weapon", "equipment", "consumable"].includes(i.type) && typeof i.quantity === "number" && i.id !== gold?.id
      );
      const equipItem =
        itemTargets.find((i) => i.type === "weapon" && typeof i.carryType === "string" && i.id !== qtyItem?.id) ??
        qtyItem;
      const deleteItem = itemTargets.find(
        (i) =>
          ["consumable", "equipment", "weapon"].includes(i.type) &&
          typeof i.slug === "string" &&
          i.id !== qtyItem?.id &&
          i.id !== equipItem?.id &&
          i.containerId === null &&
          // Unique name: the resurrection check matches by name, so a shared
          // name would false-pass.
          itemTargets.filter((j) => j.name === i.name).length === 1
      );
      if (!gold || !qtyItem || !equipItem || !deleteItem) {
        throw new Error("Missing mutation target for levels matrix");
      }
      const equipHeldNow = await page.evaluate(
        ({ characterId, moduleId, equipId }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
          return actor.items.get(equipId).system.equipped.carryType === "held";
        },
        { characterId: CHARACTER_UUID, moduleId: MODULE_ID, equipId: equipItem.id }
      );
      const equipCarry = equipHeldNow ? "worn" : "held";
      const equipHands = equipHeldNow ? 0 : 1;

      // ---- Phase 1: none — exportNow refuses, remote untouched. ----
      savedSettings = await setWriteLevel(page, "none", false);
      await mutate({ "system.attributes.hp.value": 3, "system.details.gender.value": "MUT-gender" }, [
        { id: gold.id, update: { "system.quantity": (gold.quantity as number) + 111 } },
      ]);
      const noneResult = (await push()) as { success: boolean; error?: string };
      expect(noneResult.success).toBe(false);
      expect(noneResult.error ?? "").toMatch(/off/i);
      expect(await remoteSig()).toEqual(savedSig);

      // ---- Phase 2: text — text lands, quantity/equipped do not. ----
      await setWriteLevel(page, "text", false);
      await mutate({ "system.attributes.hp.value": 3, "system.details.gender.value": "MUT-gender" }, [
        { id: gold.id, update: { "system.quantity": (gold.quantity as number) + 111 } },
        { id: qtyItem.id, update: { "system.quantity": (qtyItem.quantity as number) + 3 } },
        {
          id: equipItem.id,
          update: { "system.equipped.carryType": equipCarry, "system.equipped.handsHeld": equipHands },
        },
      ]);
      const textResult = (await push()) as { success: boolean };
      expect(textResult.success).toBe(true);
      const afterText = await remoteSig();
      const textDiff = diffNames(savedSig, afterText);
      expect(textDiff).toContain("character_hit-points_current");
      expect(textDiff).toContain("character_appearance_gender");
      expect(afterText["character_hit-points_current"]).toBe(JSON.stringify(3));
      // Currency is text-tier, so it lands here too.
      expect(afterText["character_currency_gold"]).toBe(JSON.stringify((gold.quantity as number) + 111));
      // Quantity/equipped-gated engines must be byte-identical to baseline.
      const gated = (s: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(s).filter(
            ([k]) => k.endsWith("--quantity") || k.endsWith("-is-equipped") || k.includes("_equipped-id")
          )
        );
      expect(gated(afterText)).toEqual(gated(savedSig));

      // ---- Phase 3: text-quantity — quantity and equipped land too. ----
      // Absolute values (not increments): prior phases left local state that
      // never reached Demiplane, so expectations must not depend on it.
      await setWriteLevel(page, "text-quantity", false);
      const backpackWant = (qtyItem.quantity as number) + 10;
      await mutate({}, [
        { id: qtyItem.id, update: { "system.quantity": backpackWant } },
        {
          id: equipItem.id,
          update: { "system.equipped.carryType": equipCarry, "system.equipped.handsHeld": equipHands },
        },
      ]);
      const qtyResult = (await push()) as { success: boolean };
      expect(qtyResult.success).toBe(true);
      // Prove it from the Demiplane side: wipe and re-import, then read the
      // actor (gold asserted the text tier above; it persists untouched).
      const reimported = await page.evaluate(
        async ({ characterId, moduleId, token, qtyName, equipName }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
          // @ts-expect-error Foundry global
          await game.modules.get(moduleId).api.importCharacter(actor, { token, wipe: true });
          const qty = [...actor.items].find((i: { name: string }) => i.name === qtyName);
          const equip = [...actor.items].find((i: { name: string }) => i.name === equipName);
          const goldItem = [...actor.items].find((i: { system: { slug?: string } }) => i.system.slug === "gold-pieces");
          return {
            qty: (qty as { system: { quantity: number } } | undefined)?.system.quantity,
            carry: (equip as { system: { equipped: { carryType: string } } } | undefined)?.system.equipped.carryType,
            hands: (equip as { system: { equipped: { handsHeld: number } } } | undefined)?.system.equipped.handsHeld,
            gold: (goldItem as { system: { quantity: number } } | undefined)?.system.quantity,
          };
        },
        {
          characterId: CHARACTER_UUID,
          moduleId: MODULE_ID,
          token: DEMIPLANE_TOKEN,
          qtyName: qtyItem.name,
          equipName: equipItem.name,
        },
        { timeout: 180_000 }
      );
      expect(reimported.qty).toBe(backpackWant);
      expect(reimported.carry).toBe(equipCarry);
      expect(reimported.hands).toBe(equipHands);
      expect(reimported.gold).toBe((gold.quantity as number) + 111);
      // The re-import holds its own grace window; the phase-4 delete must
      // reach the hook, or the gate test passes for the wrong reason.
      await waitForSyncRelease(page, CHARACTER_UUID);

      // ---- Phase 4: deletes stay local below the deletion tier. ----
      // No confirmation dialog may appear here: the gate rejects the delete
      // before any prompt. The target is re-resolved by (unique) name: the
      // phase-3 re-import replaced every document ID.
      await page.evaluate(
        async ({ characterId, moduleId, deleteName }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
          const target = [...actor.items].find((i: { name: string }) => i.name === deleteName);
          if (!target) throw new Error(`delete target gone before delete phase: ${deleteName}`);
          await target.delete();
        },
        { characterId: CHARACTER_UUID, moduleId: MODULE_ID, deleteName: deleteItem.name },
        { timeout: 120_000 }
      );
      // The gate rejects the delete before any prompt, so no dialog may
      // appear. The delete hook runs synchronously inside delete(), so only
      // the dialog's own async render needs flushing — two animation frames,
      // no fixed sleep.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await expect(page.getByRole("button", { name: "Delete on Demiplane" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Set quantity to 0 on Demiplane" })).toHaveCount(0);
      const stillThere = await page.evaluate(
        ({ characterId, moduleId, deleteName }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
          return [...actor.items].some((i: { name: string }) => i.name === deleteName);
        },
        { characterId: CHARACTER_UUID, moduleId: MODULE_ID, deleteName: deleteItem.name }
      );
      expect(stillThere).toBe(false);
      const gatePush = (await push()) as { success: boolean };
      expect(gatePush.success).toBe(true);
      // The item's base engine must still be on Demiplane (same slug match
      // the push itself uses: name-derived, -rm stripped).
      const slugOf = (engineName: string) =>
        (engineName.split("/").pop() ?? "").replace(/\.eng$/, "").replace(/-rm$/, "");
      const afterGate = await withApiRetry("fetch engines", () => client.fetchCharacterData(CHARACTER_UUID));
      const basePresent = afterGate.engines.some(
        (e) => e.name.startsWith("tabula/item/") && slugOf(e.name) === deleteItem.slug
      );
      expect(basePresent).toBe(true);
      // A wipe re-import resurrects it locally (remote never lost it).
      const resurrected = await page.evaluate(
        async ({ characterId, moduleId, token, deleteName }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
          // @ts-expect-error Foundry global
          await game.modules.get(moduleId).api.importCharacter(actor, { token, wipe: true });
          return [...actor.items].some((i: { name: string }) => i.name === deleteName);
        },
        { characterId: CHARACTER_UUID, moduleId: MODULE_ID, token: DEMIPLANE_TOKEN, deleteName: deleteItem.name },
        { timeout: 180_000 }
      );
      expect(resurrected).toBe(true);
      await stopCoverage(page, "kyra-levels");
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
      const sig2 = (engines: Array<{ name?: string; value?: unknown }>) =>
        Object.fromEntries(engines.map((e) => [e.name, JSON.stringify(e.value)]));
      expect(sig2(after.engines)).toEqual(sig2(saved.engines));
      expect(after.engines.find((e) => e.name === "character_hit-points_current")?.value).toBe(savedHp);
      if (page) {
        await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME).catch(() => {});
        await page.close().catch(() => {});
      }
    }
  });
});
