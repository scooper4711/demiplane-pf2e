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
const ACTOR_NAME = "Kyra Mutation Test";
const MODULE_ID = "demiplane-pf2e";

/**
 * Full round-trip: mutate every pushable field on a fresh Kyra import, push
 * to Demiplane with auto-sync on, wipe and re-import, and prove every field
 * comes back with the new values. The remote character is snapshotted up
 * front and restored in `finally`, so the suite never leaves Demiplane dirty
 * regardless of outcome.
 *
 * Deliberately NOT mutated (no push path, so nothing could round-trip):
 * actor name, level/XP, abilities, skill ranks, deity (build-derived: the
 * import always resolves Sarenrae from the deity engine, and deity is no
 * longer pushed at all), backstory (no push mapping),
 * sanctification (derived; covered by kyra-import.spec.ts). Two more are
 * excluded because PF2e itself silently drops direct writes to them (proven
 * live: the write resolves but a re-read shows the old value, so the push
 * can never see the new one): `details.languages.value` (PF2e recomputes it
 * from grants on every prepare) and `pfs.characterNumber` (writes ignored
 * while the sibling `playerNumber` persists). Note the import side shares
 * the languages gap: `applyLanguages` claims "+ languages" for ungranted
 * languages that evaporate on the next prepare.
 */
test.describe("Kyra Mutation Round-Trip", () => {
  test.skip(!DEMIPLANE_TOKEN || !CHARACTER_UUID, "DEMIPLANE_TOKEN and KYRA_UUID env vars required");

  test("mutate, push, re-import, restore", async ({ browser }) => {
    test.setTimeout(600_000);

    const client = new DemiplaneClient();
    client.setToken(DEMIPLANE_TOKEN);
    const saved = await withApiRetry("snapshot engines", () => client.fetchCharacterData(CHARACTER_UUID));
    const savedHp = saved.engines.find((e) => e.name === "character_hit-points_current")?.value;
    const savedOrgPlayId = saved.engines.find((e) => e.name === "character_organizedplayid")?.value;
    // Campaign notes live in a journal, not the engines — snapshot it too.
    const savedJournals = await withApiRetry("snapshot journals", () => client.fetchCharacterJournals(CHARACTER_UUID));
    const savedCampaign = savedJournals.find((j) => j.title === "Campaign");
    if (savedCampaign?.description.includes("MUT-")) {
      console.warn("WARNING: Campaign journal baseline already contains test data — restore will preserve it.");
    }

    // Declared outside `try` so `finally` can always clean up, even when the
    // failure happened before these were assigned. A masking finally-error
    // that skips the restore is data loss — never let that happen again.
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

      // Discover mutation targets from the live actor (no hardcoded items).
      // Looked up by characterId flag: the import renames the actor to the
      // Demiplane character name, so the created name is already stale.
      const items = await page.evaluate(
        ({ characterId, moduleId }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find(
            // @ts-expect-error Foundry global
            (a) => a.getFlag(moduleId, "characterId") === characterId
          );
          return [...actor.items].map(
            (i: {
              id: string;
              name: string;
              type: string;
              system: {
                slug?: string;
                quantity?: number;
                containerId?: string | null;
                equipped?: { carryType?: string; handsHeld?: number };
              };
              flags?: Record<string, { demiplaneSlug?: unknown } | undefined>;
            }) => ({
              id: i.id,
              name: i.name,
              type: i.type,
              slug: i.system.slug,
              quantity: i.system.quantity,
              carryType: i.system.equipped?.carryType,
              handsHeld: i.system.equipped?.handsHeld,
              containerId: i.system.containerId ?? null,
              hasDpSlug: typeof i.flags?.[moduleId]?.demiplaneSlug === "string",
            })
          );
        },
        { characterId: CHARACTER_UUID, moduleId: MODULE_ID }
      );

      const CURRENCY_SLUGS = ["gold-pieces", "silver-pieces", "copper-pieces", "platinum-pieces"];
      const currency = items.find((i) => CURRENCY_SLUGS.includes(i.slug ?? ""));
      const GEAR_TYPES = ["weapon", "equipment", "consumable", "armor", "backpack", "ammo"];
      const qtyItem = items.find((i) => GEAR_TYPES.includes(i.type) && typeof i.quantity === "number");
      // Held ⇄ worn is the only carry round-trip: the push records hand-slot
      // assignment and the equipped flag, while the import defaults anything
      // else to worn — so an arbitrary carryType (stowed/carried) can never
      // survive a re-import. Require a weapon (armor can never be held).
      const equipItem =
        items.find((i) => i.type === "weapon" && typeof i.carryType === "string" && i.id !== qtyItem?.id) ??
        items.find(
          (i) =>
            (i.type === "shield" || i.type === "equipment") && typeof i.carryType === "string" && i.id !== qtyItem?.id
        );
      const DELETE_TYPES = [...GEAR_TYPES, "treasure", "book", "kit"];
      const deleteItem = items.find(
        (i) =>
          DELETE_TYPES.includes(i.type) &&
          !CURRENCY_SLUGS.includes(i.slug ?? "") &&
          i.id !== qtyItem?.id &&
          i.id !== equipItem?.id &&
          i.containerId === null
      );
      if (!currency || !qtyItem || !equipItem || !deleteItem) {
        throw new Error(
          `Missing mutation target: currency=${currency?.name} qty=${qtyItem?.name} equip=${equipItem?.name} delete=${deleteItem?.name}`
        );
      }
      console.log(
        `Mutation targets: currency=${currency.name} qty=${qtyItem.name} equip=${equipItem.name} delete=${deleteItem.name}`
      );

      // Full writing (deletion tier, hard deletes) for the push.
      savedSettings = await setWriteLevel(page, "text-quantity-delete", false);

      // Mutate every pushable field, then read back the actor state as the
      // expectations ( guards against Foundry clamping anything we sent).
      const expected = await page.evaluate(
        async ({ characterId, moduleId, currencyId, qtyItemId, equipItemId, deleteItemId }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find(
            // @ts-expect-error Foundry global
            (a) => a.getFlag(moduleId, "characterId") === characterId
          );
          const T = (v: string) => `MUT-${v}`;
          const heroNow = actor.system.resources?.heroPoints?.value as number;
          const heroPoints = heroNow === 2 ? 1 : 2;
          const currencyItem = actor.items.get(currencyId);
          const currencyQty = (currencyItem.system.quantity as number) + 111;
          const qtyTarget = actor.items.get(qtyItemId);
          const qtyQty = (qtyTarget.system.quantity as number) + 3;
          const equipTarget = actor.items.get(equipItemId);
          const heldNow = equipTarget.system.equipped.carryType === "held";
          const carryNew = heldNow ? "worn" : "held";
          const handsNew = heldNow ? 0 : 1;
          const deleteTarget = actor.items.get(deleteItemId);

          await actor.update({
            "system.attributes.hp.value": 3,
            "system.attributes.hp.temp": 7,
            "system.resources.heroPoints.value": heroPoints,
            "system.details.gender.value": T("gender"),
            "system.details.age.value": T("age-777"),
            "system.details.ethnicity.value": T("ethnicity"),
            "system.details.nationality.value": T("nationality"),
            "system.details.height.value": T("height"),
            "system.details.weight.value": T("weight"),
            "system.details.biography.birthPlace": T("birthplace"),
            "system.details.biography.appearance": T("appearance"),
            "system.details.biography.catchphrases": T("catchphrase"),
            "system.details.biography.attitude": T("attitude"),
            "system.details.biography.likes": T("likes"),
            "system.details.biography.dislikes": T("dislikes"),
            "system.details.biography.allies": T("allies"),
            "system.details.biography.enemies": T("enemies"),
            "system.details.biography.organizations": T("organizations"),
            "system.details.biography.edicts": ["MUT edict one", "MUT edict two"],
            "system.details.biography.anathema": ["MUT anathema one"],
            "system.details.biography.campaignNotes": T("campaign-notes"),
            "system.pfs.playerNumber": 54321,
          });
          await currencyItem.update({ "system.quantity": currencyQty });
          await qtyTarget.update({ "system.quantity": qtyQty });
          await equipTarget.update({ "system.equipped.carryType": carryNew, "system.equipped.handsHeld": handsNew });
          await deleteTarget.delete();

          const read = (path: string) =>
            path.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)?.[p], actor);
          return {
            hpValue: read("system.attributes.hp.value"),
            hpTemp: read("system.attributes.hp.temp"),
            heroPoints: read("system.resources.heroPoints.value"),
            gender: read("system.details.gender.value"),
            age: read("system.details.age.value"),
            ethnicity: read("system.details.ethnicity.value"),
            nationality: read("system.details.nationality.value"),
            height: read("system.details.height.value"),
            weight: read("system.details.weight.value"),
            birthPlace: read("system.details.biography.birthPlace"),
            appearance: read("system.details.biography.appearance"),
            catchphrases: read("system.details.biography.catchphrases"),
            attitude: read("system.details.biography.attitude"),
            likes: read("system.details.biography.likes"),
            dislikes: read("system.details.biography.dislikes"),
            allies: read("system.details.biography.allies"),
            enemies: read("system.details.biography.enemies"),
            organizations: read("system.details.biography.organizations"),
            edicts: read("system.details.biography.edicts"),
            anathema: read("system.details.biography.anathema"),
            campaignNotes: read("system.details.biography.campaignNotes"),
            playerNumber: read("system.pfs.playerNumber"),
            currencyQty: currencyItem.system.quantity,
            qtyQty: qtyTarget.system.quantity,
            equipCarry: equipTarget.system.equipped.carryType,
            equipHands: equipTarget.system.equipped.handsHeld,
            qtyItemName: qtyTarget.name,
            equipItemName: equipTarget.name,
            currencySlug: currencyItem.system.slug,
            // Item IDs prove the delete: type:name strings collide when two
            // copies of an item exist, but a deleted document ID can never
            // reappear (a resurrected item gets a fresh ID).
            deletedId: deleteItemId,
            itemIds: [...actor.items].map((i: { id: string }) => i.id),
            itemSig: [...actor.items].map((i: { name: string; type: string }) => `${i.type}:${i.name}`).sort(),
          };
        },
        {
          characterId: CHARACTER_UUID,
          moduleId: MODULE_ID,
          currencyId: currency.id,
          qtyItemId: qtyItem.id,
          equipItemId: equipItem.id,
          deleteItemId: deleteItem.id,
        },
        { timeout: 120_000 }
      );

      // Deleting at the deletion tier always asks for confirmation — accept
      // it so the removal is actually queued before pushing. The dialog must
      // appear: its absence means the confirmation gate regressed.
      const confirmDelete = page.getByRole("button", { name: "Delete on Demiplane" });
      await confirmDelete.waitFor({ state: "visible", timeout: 15_000 });
      await confirmDelete.click();

      const pushResult = await page.evaluate(
        async ({ characterId, moduleId }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find(
            // @ts-expect-error Foundry global
            (a) => a.getFlag(moduleId, "characterId") === characterId
          );
          // @ts-expect-error Foundry global
          return await game.modules.get(moduleId).api.exportNow(actor);
        },
        { characterId: CHARACTER_UUID, moduleId: MODULE_ID },
        { timeout: 120_000 }
      );
      expect(pushResult.success).toBe(true);

      // Bisect push vs import: prove the push actually persisted before the
      // re-import reads it back. A failure here is a push bug; a failure in
      // the actor asserts below with these passing is an import bug. Polls
      // briefly: under full-suite load the API can lag a successful write.
      const remoteWants: Record<string, unknown> = {
        "character_hit-points_current": expected.hpValue,
        "character_hero-points": expected.heroPoints,
        character_organizedplayid: `${expected.playerNumber}-${String(savedOrgPlayId).split("-").pop()}`,
        character_appearance_gender: expected.gender,
      };
      let remote: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 6; attempt++) {
        const data = await withApiRetry("poll push", () => client.fetchCharacterData(CHARACTER_UUID));
        remote = Object.fromEntries(data.engines.map((e) => [e.name, e.value]));
        if (Object.entries(remoteWants).every(([k, v]) => JSON.stringify(remote[k]) === JSON.stringify(v))) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      expect(remote["character_hit-points_current"], "remote hp persisted").toBe(expected.hpValue);
      expect(remote["character_hero-points"], "remote hero points persisted").toBe(expected.heroPoints);
      expect(remote["character_organizedplayid"], "remote org play id persisted").toBe(
        `${expected.playerNumber}-${String(savedOrgPlayId).split("-").pop()}`
      );
      expect(remote["character_appearance_gender"], "remote gender persisted").toBe(expected.gender);

      const actual = await page.evaluate(
        async ({ characterId, moduleId, token, qtyItemName, equipItemName, currencySlug }) => {
          // @ts-expect-error Foundry global
          const actor = game.actors.contents.find(
            // @ts-expect-error Foundry global
            (a) => a.getFlag(moduleId, "characterId") === characterId
          );
          // @ts-expect-error Foundry global
          const summary = await game.modules.get(moduleId).api.importCharacter(actor, { token, wipe: true });
          const read = (path: string) =>
            path.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)?.[p], actor);
          const find = (pred: (i: { name: string; type: string; system: { slug?: string } }) => boolean) =>
            [...actor.items].find(pred) as
              { system: { quantity: number; equipped: { carryType: string; handsHeld: number } } } | undefined;
          return {
            errors: summary.errors as string[],
            hpValue: read("system.attributes.hp.value"),
            hpTemp: read("system.attributes.hp.temp"),
            heroPoints: read("system.resources.heroPoints.value"),
            gender: read("system.details.gender.value"),
            age: read("system.details.age.value"),
            ethnicity: read("system.details.ethnicity.value"),
            nationality: read("system.details.nationality.value"),
            height: read("system.details.height.value"),
            weight: read("system.details.weight.value"),
            birthPlace: read("system.details.biography.birthPlace"),
            appearance: read("system.details.biography.appearance"),
            catchphrases: read("system.details.biography.catchphrases"),
            attitude: read("system.details.biography.attitude"),
            likes: read("system.details.biography.likes"),
            dislikes: read("system.details.biography.dislikes"),
            allies: read("system.details.biography.allies"),
            enemies: read("system.details.biography.enemies"),
            organizations: read("system.details.biography.organizations"),
            edicts: read("system.details.biography.edicts"),
            anathema: read("system.details.biography.anathema"),
            campaignNotes: read("system.details.biography.campaignNotes"),
            playerNumber: read("system.pfs.playerNumber"),
            currencyQty: find((i) => i.system.slug === currencySlug)?.system.quantity,
            qtyQty: find((i) => i.name === qtyItemName)?.system.quantity,
            equipCarry: find((i) => i.name === equipItemName)?.system.equipped.carryType,
            equipHands: find((i) => i.name === equipItemName)?.system.equipped.handsHeld,
            itemIds: [...actor.items].map((i: { id: string }) => i.id),
            itemSig: [...actor.items].map((i: { name: string; type: string }) => `${i.type}:${i.name}`).sort(),
          };
        },
        {
          characterId: CHARACTER_UUID,
          moduleId: MODULE_ID,
          token: DEMIPLANE_TOKEN,
          qtyItemName: expected.qtyItemName,
          equipItemName: expected.equipItemName,
          currencySlug: expected.currencySlug,
        },
        { timeout: 180_000 }
      );
      await stopCoverage(page, "kyra-mutation");

      // Every mutated field survived the round-trip to Demiplane and back.
      expect(actual.errors).toHaveLength(0);
      for (const field of [
        "hpValue",
        "hpTemp",
        "heroPoints",
        "gender",
        "age",
        "ethnicity",
        "nationality",
        "height",
        "weight",
        "birthPlace",
        "appearance",
        "catchphrases",
        "attitude",
        "likes",
        "dislikes",
        "allies",
        "enemies",
        "organizations",
        "edicts",
        "anathema",
        "campaignNotes",
        "playerNumber",
        "currencyQty",
        "qtyQty",
        "equipCarry",
        "equipHands",
      ] as const) {
        expect(actual[field], field).toEqual(expected[field]);
      }
      // The pushed delete propagated: the deleted document ID stays gone
      // after re-import (a resurrected item would return with a fresh ID).
      expect(actual.itemSig).toEqual(expected.itemSig);
      expect(actual.itemIds).not.toContain(expected.deletedId);
    } finally {
      // Restore the remote character no matter what — the test deliberately
      // corrupts it, so a failure here is data loss, not noise. Mirror the
      // module's own push shape exactly: narrow `{engines,
      // engineCacheIdsBySource}` data plus the REAL fetched meta. All-null
      // meta makes the server reject the write ("unexpected null value for
      // type 'Int'"), and a full-CharacterData `data` blob is not accepted.
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
        // updateCharacter reports rate limiting as success:false instead of
        // throwing — convert it so the retry helper waits it out.
        if (!res.success && /rate.?limit|too many requests|\b429\b/i.test(res.message ?? "")) {
          throw Object.assign(new Error(res.message ?? "rate limited"), { statusCode: 429 });
        }
        return res;
      });
      expect(restore.success, restore.message ?? "restore write failed").toBe(true);
      if (savedCampaign) {
        // The importer reads `description`, and the server mirrors a content
        // write into it (leaving `content` itself empty) — so restore by
        // writing the saved description back. The mutation response echo is
        // unreliable; the re-fetch below is the real verification.
        const text = savedCampaign.description || savedCampaign.content;
        await withApiRetry("restore journal", () =>
          client.updateCharacterJournal(savedCampaign.objectID, CHARACTER_UUID, "Campaign", text)
        );
      }
      const after = await withApiRetry("verify engines", () => client.fetchCharacterData(CHARACTER_UUID));
      expect(after.engines.find((e) => e.name === "character_hit-points_current")?.value).toBe(savedHp);
      expect(after.engines.find((e) => e.name === "character_organizedplayid")?.value).toBe(savedOrgPlayId);
      // Byte-identical restoration (compared as name→value so server-side
      // ordering can't false-fail): proves this run left nothing behind even
      // if the baseline itself contained test-like values.
      const sig = (engines: Array<{ name?: string; value?: unknown }>) =>
        Object.fromEntries(engines.map((e) => [e.name, JSON.stringify(e.value)]));
      expect(sig(after.engines)).toEqual(sig(saved.engines));
      if (savedCampaign) {
        const afterJournals = await withApiRetry("verify journal", () => client.fetchCharacterJournals(CHARACTER_UUID));
        // The importer reads `description` (the server mirrors content into
        // it), so that is the field that must hold the original text.
        expect(afterJournals.find((j) => j.title === "Campaign")?.description).toBe(savedCampaign.description);
      }
      if (page) {
        await deleteActorsForCharacter(page, CHARACTER_UUID, ACTOR_NAME).catch(() => {});
        await page.close().catch(() => {});
      }
    }
  });
});
