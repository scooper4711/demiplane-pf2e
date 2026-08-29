import { MODULE_ID } from "./import/types.js";
import { normalizeEquipmentSlug } from "./import/slug-utils.js";
import { debugLog } from "./import/debug-log.js";
import { addExportIssue } from "./sync-issues.js";
import type { CharacterData, CustomEngine, DemiplaneClient } from "@scooper4711/demiplane-api";
import { findCustomEngineByName } from "@scooper4711/demiplane-api";
import { computeEngineSig } from "./engine-sig";
import { isRemoteSyncActive } from "./sync-pause.js";
import {
  ChangeBuffer,
  type EquippedState,
  type ItemChangeType,
  type PendingChange,
  type PendingItemChange,
} from "./export/change-buffer.js";

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export type { EquippedState, ItemChangeType, PendingChange, PendingItemChange } from "./export/change-buffer.js";

export interface ExportResult {
  success: boolean;
  error?: string;
  conflict?: boolean;
}

interface CharacterMetadata {
  name?: string | undefined;
  level?: number | undefined;
  avatarUrl?: string | undefined;
  viewPermission?: number | undefined;
  editPermission?: number | undefined;
}

interface FetchedCharacter {
  data: CharacterData;
  meta: CharacterMetadata;
}

interface ResolvedItemChange {
  change: PendingItemChange;
  demiplaneId: string;
}

/**
 * Handles debounced session state export from Foundry to Demiplane.
 *
 * Accumulates field changes within a 2-second debounce window and
 * batches them into a single API call. Rate-limited to 30 API calls
 * per 60-second rolling window per character. Retries up to 3 times
 * with exponential backoff on failure.
 *
 * The per-character pending change buffer has been extracted into `ChangeBuffer`;
 * the remaining payload-building, optimistic-concurrency check, retry, and flush
 * orchestration still live here.
 */
export class ExportManager {
  private readonly client: DemiplaneClient;
  private readonly changeBuffer: ChangeBuffer;
  private onConflictHandler: ((actor: Actor) => Promise<void>) | undefined = undefined;

  constructor(client: DemiplaneClient) {
    this.client = client;
    this.changeBuffer = new ChangeBuffer((actor) => {
      void this.flush(actor);
    });
  }

  /**
   * Registers a callback invoked when a push is aborted because the server
   * character was updated elsewhere (optimistic-concurrency conflict). The
   * handler typically re-imports the actor to refresh its state and the stored
   * `lastUpdated` timestamp.
   *
   * @param handler - Async callback receiving the conflicting actor.
   */
  setOnConflictHandler(handler: (actor: Actor) => Promise<void>): void {
    this.onConflictHandler = handler;
  }

  /**
   * Suppresses pushes for a single character while it is being re-imported, so
   * items created/deleted by the import are not echoed back to Demiplane.
   * Ref-counted and keyed per character so concurrent imports of different
   * actors (or an import racing a manual push) cannot prematurely resume
   * another character's exports.
   */
  suspend(characterId: string): void {
    this.changeBuffer.suspend(characterId);
  }

  resume(characterId: string): void {
    this.changeBuffer.resume(characterId);
  }

  queueChange(actor: Actor, field: string, value: number): void {
    this.changeBuffer.queueChange(actor, field, value);
  }

  queueItemChange(
    actor: Actor,
    itemSlug: string,
    demiplaneSlug: string | undefined,
    changeType: ItemChangeType,
    value: number | string | EquippedState,
    itemType?: string,
    edited?: boolean
  ): void {
    this.changeBuffer.queueItemChange(actor, itemSlug, demiplaneSlug, changeType, value, itemType, edited);
  }

  /**
   * Queues the deletion of an item from Demiplane when it is removed from a
   * linked Foundry actor. The matching engine (and its related custom engines)
   * are stripped from the character data on the next push.
   *
   * @param actor - The linked actor the item was removed from.
   * @param slot - The demiplane/equipment slug of the deleted item.
   */
  queueItemDelete(actor: Actor, slot: string): void {
    this.changeBuffer.queueItemDelete(actor, slot);
  }

  async flush(actor: Actor): Promise<ExportResult> {
    const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;

    if (!characterId) {
      return { success: false, error: "Actor has no linked character ID" };
    }

    // If another client is importing/pushing this character, defer our flush
    // rather than racing it into a conflict. Re-arm the timer so the pending
    // changes are pushed once the remote sync settles.
    if (isRemoteSyncActive(actor)) {
      debugLog(`[push] remote sync in progress for ${characterId}; deferring flush`);
      this.changeBuffer.rearmFlush(actor, characterId);
      return { success: true };
    }

    this.changeBuffer.clearDebounceTimer(characterId);

    const { changes, itemChanges } = this.changeBuffer.peek(characterId);
    if ((!changes || changes.size === 0) && (!itemChanges || itemChanges.size === 0)) {
      return { success: true };
    }

    if (!this.changeBuffer.isWithinRateLimit(characterId)) {
      const error = "Rate limit exceeded: maximum 30 API calls per 60 seconds";
      addExportIssue(actor, error);
      return {
        success: false,
        error,
      };
    }

    if (!this.client.isAuthenticated()) {
      const error = "No Demiplane token configured. Ask your GM to set it in module settings.";
      addExportIssue(actor, error);
      this.notifyFailure(error);
      return { success: false, error };
    }

    // Optimistic concurrency: check if Demiplane has been updated since last import
    const storedUpdated = actor.getFlag(MODULE_ID, "lastUpdated") as string | undefined;
    const startedAt = Date.now();
    if (storedUpdated) {
      debugLog(`[push] conflict check: stored lastUpdated=${storedUpdated}`);
      try {
        const serverUpdated = await this.client.fetchCharacterUpdated(characterId);
        const matched = serverUpdated === storedUpdated;
        debugLog(
          `[push] conflict check: server updated=${serverUpdated} (took ${Date.now() - startedAt}ms) ` +
            `${matched ? "MATCH" : "MISMATCH"}`
        );
        if (!matched) {
          // `updated` advanced, but that alone isn't proof of a conflicting edit: the
          // Demiplane sheet (or an autosave) can bump `updated` without changing any
          // content. Verify the character's actual engine content changed before we
          // abort the push and trigger a re-import.
          const contentChanged = await this.isRemoteContentChanged(characterId, actor);
          if (!contentChanged) {
            debugLog(
              `[push] updated mismatch but engine content unchanged — benign bump; ` +
                `proceeding with push and refreshing lastUpdated`
            );
            await actor.setFlag(MODULE_ID, "lastUpdated", serverUpdated);
            // fall through to the push below
          } else {
            const error = "Conflict: Demiplane character was updated elsewhere. Re-importing.";
            addExportIssue(actor, error);
            debugLog(
              `[push] conflict detected stored=${storedUpdated} server=${serverUpdated} — aborting push, will re-import`
            );
            // Clear pending changes so we don't retry the stale push
            this.changeBuffer.clear(characterId);
            // Trigger conflict recovery (re-import) without blocking the flush return
            if (this.onConflictHandler) {
              void this.onConflictHandler(actor);
            }
            return { success: false, error, conflict: true };
          }
        }
      } catch (error) {
        debugLog(`[push] failed to fetch updated for conflict check: ${String(error)}`);
        // If we can't fetch updated, proceed with push but log
      }
    } else {
      debugLog(`[push] no stored lastUpdated flag — skipping optimistic concurrency check`);
    }

    // Keep session alive
    try {
      await this.client.updateLastAccess();
      debugLog(`[push] updateLastAccess succeeded (took ${Date.now() - startedAt}ms)`);
    } catch (error) {
      debugLog(`[push] updateLastAccess failed: ${String(error)}`);
      // Non-critical: ignore failure to update last access
    }

    const fetched = await this.buildUpdatedCharacterData(
      characterId,
      actor,
      changes ?? new Map(),
      itemChanges ?? new Map()
    );
    if (!fetched) {
      const error = "Failed to fetch character data";
      addExportIssue(actor, error);
      return { success: false, error };
    }

    debugLog(`[push] starting push (build took ${Date.now() - startedAt}ms)`);
    const result = await this.pushWithRetry(characterId, fetched);
    await this.handlePushResult(result, characterId, actor);
    debugLog(`[push] push resolved ${result.success ? "success" : "failure"} (took ${Date.now() - startedAt}ms)`);
    return result;
  }

  getPendingChanges(characterId: string): PendingChange[] {
    return this.changeBuffer.getPendingChanges(characterId);
  }

  hasPendingChanges(characterId: string): boolean {
    return this.changeBuffer.hasPendingChanges(characterId);
  }

  private async buildUpdatedCharacterData(
    characterId: string,
    actor: Actor,
    changes: Map<string, PendingChange>,
    itemChanges: Map<string, PendingItemChange>
  ): Promise<FetchedCharacter | null> {
    let fetched: CharacterData;
    try {
      fetched = await this.client.fetchCharacterData(characterId);
    } catch {
      return null;
    }

    let updatedEngines: CustomEngine[] = fetched.engines as CustomEngine[];

    updatedEngines = this.applyFieldChanges(updatedEngines, changes);
    const resolved = this.resolveItemChanges(fetched, itemChanges);
    updatedEngines = this.applyItemChangeEngines(updatedEngines, resolved, actor);
    updatedEngines = this.applyHandSlotAssignment(updatedEngines, resolved);

    return {
      data: {
        engines: updatedEngines,
        engineCacheIdsBySource: fetched.engineCacheIdsBySource ?? {},
      },
      meta: {
        name: fetched.name,
        level: fetched.level,
        avatarUrl: fetched.avatarUrl,
        viewPermission: fetched.viewPermission,
        editPermission: fetched.editPermission,
      },
    };
  }

  private applyFieldChanges(updatedEngines: CustomEngine[], changes: Map<string, PendingChange>): CustomEngine[] {
    let engines = updatedEngines;
    for (const change of changes.values()) {
      const existing = findCustomEngineByName(engines, change.field);
      if (existing) {
        engines = engines.map((e) => (e === existing ? { ...e, value: change.value } : e));
      } else {
        // The character has no override engine for this field yet (e.g. hit points,
        // hero points, or a currency that Demiplane stores only as a computed value).
        // Create one so the push actually reflects the change instead of being
        // silently dropped — Demiplane accepts a CustomDemiplaneEngine override.
        const created = this.createOverrideEngine(change.field, change.value);
        engines = [...engines, created];
        debugLog(`[push] created override engine ${change.field} with value ${String(change.value)}`);
      }
    }
    return engines;
  }

  private createOverrideEngine(name: string, value: number): CustomEngine {
    return {
      id: `custom_${name}`,
      name,
      value,
      type: "CustomDemiplaneEngine",
      saveType: "CharacterSheet",
      storeType: "override",
      demiplaneEngineId: crypto.randomUUID(),
      args: { id: null },
    };
  }

  private resolveItemChanges(
    fetched: CharacterData,
    itemChanges: Map<string, PendingItemChange>
  ): ResolvedItemChange[] {
    const resolved: ResolvedItemChange[] = [];
    for (const itemChange of itemChanges.values()) {
      const matchSlug = itemChange.demiplaneSlug ?? itemChange.itemSlug;
      const itemEngine = fetched.engines.find((e) => {
        if (e.type !== "DemiplaneEngine" || !e.name.startsWith("tabula/item/")) return false;
        const engineSlug = (e.args?.slug as string) ?? "";
        return normalizeEquipmentSlug(engineSlug) === normalizeEquipmentSlug(matchSlug);
      });
      if (!itemEngine) continue;
      resolved.push({ change: itemChange, demiplaneId: itemEngine.demiplaneEngineId });
    }

    debugLog(
      `[push] resolved ${String(resolved.length)} item change(s) of ${String(itemChanges.size)} pending:`,
      resolved.map(({ change, demiplaneId }) => ({
        slug: change.itemSlug,
        demiplaneSlug: change.demiplaneSlug,
        changeType: change.changeType,
        value: change.value,
        demiplaneId,
      }))
    );

    return resolved;
  }

  private applyItemChangeEngines(
    updatedEngines: CustomEngine[],
    resolved: ResolvedItemChange[],
    _actor: Actor
  ): CustomEngine[] {
    let engines = updatedEngines;
    for (const { change: itemChange, demiplaneId } of resolved) {
      if (itemChange.changeType === "delete") {
        engines = this.applyItemDelete(engines, itemChange, demiplaneId);
      } else if (itemChange.changeType === "quantity") {
        const qtyName = `${demiplaneId}--quantity`;
        const existing = findCustomEngineByName(engines, qtyName);
        if (existing) {
          engines = engines.map((e) => (e === existing ? { ...e, value: itemChange.value as number } : e));
        } else {
          const newEngine: CustomEngine = {
            id: `custom_${qtyName}`,
            name: qtyName,
            value: itemChange.value as number,
            type: "CustomDemiplaneEngine",
            saveType: "CharacterSheet",
            storeType: "override",
            demiplaneEngineId: crypto.randomUUID(),
            args: { id: null, parentEngine: demiplaneId },
          };
          engines = [...engines, newEngine];
          if (itemChange.edited) {
            debugLog(`[push] created new quantity engine ${qtyName} with value ${String(itemChange.value)}`);
          }
        }
      } else if (itemChange.changeType === "equipped") {
        engines = this.applyEquippedEngine(engines, itemChange, demiplaneId);
      }
    }
    return engines;
  }

  /**
   * Removes an item from the engine list, including its base engine and any
   * custom engines tied to it (quantity, equipped state), so the item is
   * deleted from the Demiplane character on the next push.
   *
   * @param engines - Current engine list.
   * @param itemChange - The pending delete change.
   * @param demiplaneId - The resolved Demiplane engine ID of the deleted item.
   * @returns The engine list without the deleted item's engines.
   */
  private applyItemDelete(engines: CustomEngine[], itemChange: PendingItemChange, demiplaneId: string): CustomEngine[] {
    const matchSlug = itemChange.demiplaneSlug ?? itemChange.itemSlug;
    const kept = engines.filter((e) => {
      // Remove the base item engine matching the deleted slug.
      if (e.name.startsWith("tabula/item/") && e.args?.slug) {
        if (normalizeEquipmentSlug(String(e.args.slug)) === normalizeEquipmentSlug(matchSlug)) return false;
      }
      // Remove any custom engine owned by this item's engine id.
      const name = e.name ?? "";
      return name !== `${demiplaneId}--quantity` && name !== `${demiplaneId}-is-equipped`;
    });

    debugLog(
      `[push] delete ${matchSlug}: removed ${String(engines.length - kept.length)} engine(s) ` +
        `(demiplaneId=${demiplaneId})`
    );
    return kept;
  }

  private applyEquippedEngine(
    updatedEngines: CustomEngine[],
    itemChange: PendingItemChange,
    demiplaneId: string
  ): CustomEngine[] {
    const equippedState = itemChange.value as EquippedState;
    const carryType = equippedState.carryType;
    const isArmor = itemChange.itemType === "armor";
    const isEquipped = isArmor
      ? carryType === "worn" && equippedState.inSlot !== false
      : carryType === "worn" || carryType === "held";

    const equippedName = `${demiplaneId}-is-equipped`;
    const existingEquipped = findCustomEngineByName(updatedEngines, equippedName);
    debugLog(
      `[push] equipped state for ${itemChange.itemSlug}: carryType=${carryType}, inSlot=${equippedState.inSlot}, isArmor=${isArmor}, isEquipped=${isEquipped}, engine=${equippedName} found=${existingEquipped !== undefined}`
    );
    if (!existingEquipped) return updatedEngines;
    return updatedEngines.map((e) => (e === existingEquipped ? { ...e, value: isEquipped ? 1 : 0 } : e));
  }

  private applyHandSlotAssignment(updatedEngines: CustomEngine[], resolved: ResolvedItemChange[]): CustomEngine[] {
    let engines = updatedEngines;
    const existingPrimary = findCustomEngineByName(engines, "character_hand_primary_equipped-id");
    const existingOffhand = findCustomEngineByName(engines, "character_hand_offhand_equipped-id");
    const existingBoth = findCustomEngineByName(engines, "character_hand_both_equipped-id");

    debugLog(
      `[push] hand engines found: primary=${existingPrimary !== undefined}, offhand=${existingOffhand !== undefined}, both=${existingBoth !== undefined}; values before: primary=${existingPrimary?.value}, offhand=${existingOffhand?.value}, both=${existingBoth?.value}`
    );

    const setPrimary = (id: string) => {
      if (existingPrimary) engines = engines.map((e) => (e === existingPrimary ? { ...e, value: id } : e));
    };
    const setOffhand = (id: string) => {
      if (existingOffhand) engines = engines.map((e) => (e === existingOffhand ? { ...e, value: id } : e));
    };
    const setBoth = (id: string) => {
      if (existingBoth) engines = engines.map((e) => (e === existingBoth ? { ...e, value: id } : e));
    };
    const clearAllHands = (id: string) => {
      if (existingPrimary && existingPrimary.value === id)
        engines = engines.map((e) => (e === existingPrimary ? { ...e, value: "na" } : e));
      if (existingOffhand && existingOffhand.value === id)
        engines = engines.map((e) => (e === existingOffhand ? { ...e, value: "na" } : e));
      if (existingBoth && existingBoth.value === id)
        engines = engines.map((e) => (e === existingBoth ? { ...e, value: "na" } : e));
    };

    const assignments = this.computeHandAssignments(this.heldHandItems(resolved));
    if (assignments.primary) setPrimary(assignments.primary);
    if (assignments.offhand) setOffhand(assignments.offhand);
    if (assignments.both) setBoth(assignments.both);

    for (const { change: itemChange, demiplaneId: id } of resolved) {
      if (itemChange.changeType !== "equipped") continue;
      const equippedState = itemChange.value as EquippedState;
      const isArmor = itemChange.itemType === "armor";
      if (equippedState.carryType !== "held" || isArmor) {
        clearAllHands(id);
      }
    }

    debugLog(
      `[push] hand values after: primary=${existingPrimary?.value}, offhand=${existingOffhand?.value}, both=${existingBoth?.value}`
    );

    return engines;
  }

  private heldHandItems(resolved: ResolvedItemChange[]): { id: string; handsHeld: number }[] {
    return resolved
      .filter(({ change }) => {
        if (change.changeType !== "equipped") return false;
        const equippedState = change.value as EquippedState;
        return equippedState.carryType === "held" && change.itemType !== "armor";
      })
      .map(({ change, demiplaneId }) => ({
        id: demiplaneId,
        handsHeld:
          typeof (change.value as EquippedState).handsHeld === "number"
            ? (change.value as EquippedState).handsHeld!
            : 1,
      }));
  }

  private computeHandAssignments(heldItems: { id: string; handsHeld: number }[]): {
    primary?: string;
    offhand?: string;
    both?: string;
  } {
    const assignments: { primary?: string; offhand?: string; both?: string } = {};
    let primaryUsed = false;
    let offhandUsed = false;
    let bothUsed = false;

    for (const item of heldItems) {
      if (bothUsed) continue;
      if (item.handsHeld >= 2) {
        if (primaryUsed) continue;
        assignments.both = item.id;
        bothUsed = true;
        continue;
      }
      if (!primaryUsed) {
        assignments.primary = item.id;
        primaryUsed = true;
      } else if (!offhandUsed) {
        assignments.offhand = item.id;
        offhandUsed = true;
      }
    }

    return assignments;
  }

  private async handlePushResult(result: ExportResult, characterId: string, actor: Actor): Promise<void> {
    if (result.success) {
      // eslint-disable-next-line no-console -- single always-on log per push
      console.info(`${MODULE_ID} | Pushed character data to Demiplane (${characterId})`);
      this.changeBuffer.clear(characterId);
      this.changeBuffer.recordApiCall(characterId);
      await this.syncConflictBaseline(actor);
      await this.updateSyncTimestamp(actor);
      return;
    }

    addExportIssue(actor, result.error ?? "Push to Demiplane failed unexpectedly");
    this.notifyFailure(result.error);
  }

  /**
   * After a successful push, re-baseline the conflict state from the SERVER's
   * actual stored character rather than our locally-built engines.
   *
   * The server normalizes engine content on write, so a signature computed from
   * the engines we *sent* would not match what `isRemoteContentChanged` reads back
   * on the next push — that false mismatch is what triggered needless re-imports.
   * Re-fetching the authoritative state fixes both the `engineSig` baseline and
   * the `lastUpdated` timestamp in one round trip.
   */
  private async syncConflictBaseline(actor: Actor): Promise<void> {
    const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
    if (!characterId) return;
    try {
      const data = await this.client.fetchCharacterData(characterId);
      const serverSig = computeEngineSig((data.engines as Array<{ name?: string; value?: unknown }>) ?? []);
      await actor.setFlag(MODULE_ID, "engineSig", serverSig);
      const serverUpdated = data.updated;
      if (serverUpdated) {
        await actor.setFlag(MODULE_ID, "lastUpdated", serverUpdated);
      }
      debugLog(
        `[push] re-baselined conflict state after successful push (engineSig + lastUpdated=${serverUpdated ?? "n/a"})`
      );
    } catch (error) {
      debugLog(`[push] failed to re-baseline conflict state after push: ${String(error)}`);
    }
  }

  /**
   * Determines whether the character's engine content on Demiplane differs from
   * the content we last synced. Used to tell a genuine remote edit apart from a
   * benign `updated` bump so we don't needlessly abort pushes / re-import.
   * Returns `true` (conflict) when content can't be compared, to stay safe.
   */
  private async isRemoteContentChanged(characterId: string, actor: Actor): Promise<boolean> {
    try {
      const data = await this.client.fetchCharacterData(characterId);
      const currentSig = computeEngineSig((data.engines as Array<{ name?: string; value?: unknown }>) ?? []);
      const storedSig = actor.getFlag(MODULE_ID, "engineSig") as string | undefined;
      if (!storedSig) return true; // no baseline — be conservative
      const changed = currentSig !== storedSig;
      debugLog(
        `[push] content compare: ${changed ? "CONTENT CHANGED (real conflict)" : "content unchanged (benign bump)"}`
      );
      return changed;
    } catch (error) {
      debugLog(`[push] failed to compare remote content: ${String(error)} — assuming conflict`);
      return true;
    }
  }

  private async updateSyncTimestamp(actor: Actor): Promise<void> {
    try {
      await actor.setFlag(MODULE_ID, "lastExportTimestamp", Date.now());
    } catch {
      // Non-critical: timestamp tracking failure doesn't invalidate the push
    }
  }

  private notifyFailure(error: string | undefined): void {
    if (typeof ui !== "undefined" && ui.notifications) {
      ui.notifications.error(`Demiplane sync failed: ${error ?? "Unknown error"}`);
    }
  }

  private async pushWithRetry(characterId: string, fetched: FetchedCharacter): Promise<ExportResult> {
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await this.sleep(backoffMs);
      }

      try {
        const response = await this.client.updateCharacter({
          id: characterId,
          data: fetched.data,
          ...fetched.meta,
        });

        if (response.success) {
          return { success: true };
        }

        lastError = response.message ?? "Mutation returned success: false";
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
        console.error(`${MODULE_ID} | Push attempt ${attempt + 1} threw:`, lastError);
      }
    }

    return {
      success: false,
      error: `All ${String(MAX_RETRIES + 1)} attempts failed. Last error: ${lastError}`,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
