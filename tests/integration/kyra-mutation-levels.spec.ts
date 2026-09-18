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
  skipMutationTestsIfFlagged,
} from "./helpers.js";

skipMutationTestsIfFlagged();

const CHARACTER_UUID = process.env.KYRA_UUID ?? "";
const DEMIPLANE_TOKEN = process.env.DEMIPLANE_TOKEN ?? "";
const ACTOR_NAME = "Kyra Levels Test";
const MODULE_ID = "demiplane-pf2e";

/**
 * Write-level gates: at each tier, mutations gated above it must not reach
 * Demiplane, while mutations at or below it must. One actor walks the tiers
 * in order (read-only → story → session → delete-gate at story), so each
 * phase's remote diff proves exactly what its tier permits. Hard deletes
 * (full sync) are covered by kyra-mutation.spec.ts; session soft-deletes by
 * kyra-mutation-soft-delete.spec.ts.
 *
 * New tiers:
 * - read-only (default): nothing pushes; exportNow refuses.
 * - story: biography/appearance/personality/campaign, languages, organized
 *   play, campaign notes — but not inventory/currency and not anything ending
 *   in "points" (HP, temp HP, hero points, focus).
 * - session: story plus hit/temp/hero/focus points, currency, item quantity/
 *   equipped/container, spell slots, and soft-delete (quantity 0, no prompt).
 * - full: session plus hard delete (engine removed, confirmation prompt).
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

      // ---- Phase 1: read-only — exportNow refuses, remote untouched. ----
      savedSettings = await setWriteLevel(page, "read-only");
      await mutate({ "system.attributes.hp.value": 3, "system.details.gender.value": "MUT-gender" }, [
        { id: gold.id, update: { "system.quantity": (gold.quantity as number) + 111 } },
      ]);
      const noneResult = (await push()) as { success: boolean; error?: string };
      expect(noneResult.success).toBe(false);
      expect(noneResult.error ?? "").toMatch(/off/i);
      expect(await remoteSig()).toEqual(savedSig);

      // ---- Phase 2: story — biography lands, but points/currency/quantity/equipped do not. ----
      await setWriteLevel(page, "story");
      await mutate({ "system.attributes.hp.value": 3, "system.details.gender.value": "MUT-gender" }, [
        { id: gold.id, update: { "system.quantity": (gold.quantity as number) + 111 } },
        { id: qtyItem.id, update: { "system.quantity": (qtyItem.quantity as number) + 3 } },
        {
          id: equipItem.id,
          update: { "system.equipped.carryType": equipCarry, "system.equipped.handsHeld": equipHands },
        },
      ]);
      const storyResult = (await push()) as { success: boolean };
      expect(storyResult.success).toBe(true);
      const afterStory = await remoteSig();
      const storyDiff = diffNames(savedSig, afterStory);
      expect(storyDiff).toContain("character_appearance_gender");
      expect(afterStory["character_appearance_gender"]).toBe(JSON.stringify("MUT-gender"));
      // Points and currency are session-tier, so they must not land at story.
      expect(afterStory["character_hit-points_current"]).toBe(savedSig["character_hit-points_current"]);
      expect(afterStory["character_currency_gold"]).toBe(savedSig["character_currency_gold"]);
      // Quantity/equipped-gated engines must be byte-identical to baseline.
      const gated = (s: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(s).filter(
            ([k]) => k.endsWith("--quantity") || k.endsWith("-is-equipped") || k.includes("_equipped-id")
          )
        );
      expect(gated(afterStory)).toEqual(gated(savedSig));

      // ---- Phase 3: session — quantity, equipped, currency, and points land too. ----
      // Absolute values (not increments): prior phases left local state that
      // never reached Demiplane, so expectations must not depend on it.
      await setWriteLevel(page, "session");
      const backpackWant = (qtyItem.quantity as number) + 10;
      const goldWant = (gold.quantity as number) + 111;
      await mutate({ "system.attributes.hp.value": 3 }, [
        { id: gold.id, update: { "system.quantity": goldWant } },
        { id: qtyItem.id, update: { "system.quantity": backpackWant } },
        {
          id: equipItem.id,
          update: { "system.equipped.carryType": equipCarry, "system.equipped.handsHeld": equipHands },
        },
      ]);
      const sessionResult = (await push()) as { success: boolean };
      expect(sessionResult.success).toBe(true);
      // Prove it from the Demiplane side: wipe and re-import, then read the
      // actor (gender from story persists too).
      const reimported = await page.evaluate(
        async ({ characterId, moduleId, token, qtyName, equipName }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find((a) => a.getFlag(moduleId, "characterId") === characterId);
          // @ts-expect-error Foundry global
          await game.modules.get(moduleId).api.importCharacter(actor, { token, wipe: true });
          const qty = [...actor.items].find((i: { name: string }) => i.name === qtyName);
          const equip = [...actor.items].find((i: { name: string }) => i.name === equipName);
          const goldItem = [...actor.items].find((i: { system: { slug?: string } }) => i.system.slug === "gold-pieces");
          const hp = actor.system.attributes.hp.value as number;
          const gender = actor.system.details.gender.value as string;
          return {
            qty: (qty as { system: { quantity: number } } | undefined)?.system.quantity,
            carry: (equip as { system: { equipped: { carryType: string } } } | undefined)?.system.equipped.carryType,
            hands: (equip as { system: { equipped: { handsHeld: number } } } | undefined)?.system.equipped.handsHeld,
            gold: (goldItem as { system: { quantity: number } } | undefined)?.system.quantity,
            hp,
            gender,
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
      expect(reimported.gold).toBe(goldWant);
      expect(reimported.hp).toBe(3);
      expect(reimported.gender).toBe("MUT-gender");
      await waitForSyncRelease(page, CHARACTER_UUID);

      // ---- Phase 4: deletes stay local below session (story/read-only). ----
      // The gate rejects the delete before any prompt. Target re-resolved by
      // (unique) name: the phase-3 re-import replaced every document ID.
      // We drop back to story to prove the gate: a session delete would
      // soft-delete (quantity 0) and stay gone, but a story delete stays local.
      await setWriteLevel(page, "story");
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
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await expect(page.getByRole("button", { name: "Delete on Demiplane" })).toHaveCount(0);
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
      const slugOf = (engineName: string) =>
        (engineName.split("/").pop() ?? "").replace(/\.eng$/, "").replace(/-rm$/, "");
      const afterGate = await withApiRetry("fetch engines", () => client.fetchCharacterData(CHARACTER_UUID));
      const basePresent = afterGate.engines.some(
        (e) => e.name.startsWith("tabula/item/") && slugOf(e.name) === deleteItem.slug
      );
      expect(basePresent).toBe(true);
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
