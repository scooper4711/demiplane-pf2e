import { MODULE_ID } from "./import/types.js";
import { normalizeEquipmentSlug } from "./import/slug-utils.js";
import { debugLog } from "./import/debug-log.js";
import { addExportIssue } from "./sync-issues.js";
import type { CharacterData, CustomEngine, DemiplaneClient } from "@scooper4711/demiplane-api";
import { findCustomEngineByName } from "@scooper4711/demiplane-api";

const DEBOUNCE_MS = 2000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_CALLS = 30;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export interface PendingChange {
  field: string;
  value: number;
  timestamp: number;
}

export type ItemChangeType = "quantity" | "equipped" | "delete";

export interface EquippedState {
  carryType: string;
  handsHeld?: number | undefined;
  inSlot?: boolean | undefined;
}

export interface PendingItemChange {
  itemSlug: string;
  demiplaneSlug: string | undefined;
  changeType: ItemChangeType;
  value: number | string | EquippedState;
  itemType: string | undefined;
  /** True when queued from a user edit (vs. a bulk refresh). Used to gate edit-only warnings. */
  edited?: boolean;
  timestamp: number;
}

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
 */
export class ExportManager {
  private readonly client: DemiplaneClient;
  private readonly pendingChanges: Map<string, Map<string, PendingChange>> = new Map();
  private readonly pendingItemChanges: Map<string, Map<string, PendingItemChange>> = new Map();
  private readonly debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly apiCallTimestamps: Map<string, number[]> = new Map();
  private suspended = false;
  private onConflictHandler: ((actor: Actor) => Promise<void>) | undefined = undefined;

  constructor(client: DemiplaneClient) {
    this.client = client;
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
   * Drops pending exports while import rewrites actor session state, so those
   * Foundry updates are not pushed back to Demiplane mid-import.
   */
  suspend(): void {
    this.suspended = true;
    this.clearDebounceTimers();
    this.pendingChanges.clear();
    this.pendingItemChanges.clear();
  }

  resume(): void {
    this.suspended = false;
  }

  queueChange(actor: Actor, field: string, value: number): void {
    if (this.suspended) return;

    const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
    if (!characterId) return;

    if (!this.pendingChanges.has(characterId)) {
      this.pendingChanges.set(characterId, new Map());
    }

    this.pendingChanges.get(characterId)!.set(field, {
      field,
      value,
      timestamp: Date.now(),
    });

    const existingTimer = this.debounceTimers.get(characterId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(characterId);
      void this.flush(actor);
    }, DEBOUNCE_MS);

    this.debounceTimers.set(characterId, timer);
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
    if (this.suspended) return;

    const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
    if (!characterId) return;

    const key = `${itemSlug}:${changeType}`;
    if (!this.pendingItemChanges.has(characterId)) {
      this.pendingItemChanges.set(characterId, new Map());
    }

    const entry: PendingItemChange = {
      itemSlug,
      demiplaneSlug,
      changeType,
      value,
      itemType,
      timestamp: Date.now(),
    };
    if (edited !== undefined) entry.edited = edited;

    this.pendingItemChanges.get(characterId)!.set(key, entry);
    this.scheduleFlush(actor, characterId);
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
    if (this.suspended || !slot) return;

    const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
    if (!characterId) return;

    const key = `${slot}:delete`;
    if (!this.pendingItemChanges.has(characterId)) {
      this.pendingItemChanges.set(characterId, new Map());
    }
    this.pendingItemChanges.get(characterId)!.set(key, {
      itemSlug: slot,
      demiplaneSlug: slot,
      changeType: "delete",
      value: 0,
      itemType: undefined,
      timestamp: Date.now(),
    });
    this.scheduleFlush(actor, characterId);
  }

  private scheduleFlush(actor: Actor, characterId: string): void {
    const existingTimer = this.debounceTimers.get(characterId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(characterId);
      void this.flush(actor);
    }, DEBOUNCE_MS);

    this.debounceTimers.set(characterId, timer);
  }

  async flush(actor: Actor): Promise<ExportResult> {
    const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;

    if (!characterId) {
      return { success: false, error: "Actor has no linked character ID" };
    }

    this.clearDebounceTimer(characterId);

    const changes = this.pendingChanges.get(characterId);
    const itemChanges = this.pendingItemChanges.get(characterId);
    if ((!changes || changes.size === 0) && (!itemChanges || itemChanges.size === 0)) {
      return { success: true };
    }

    if (!this.isWithinRateLimit(characterId)) {
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
          const error = "Conflict: Demiplane character was updated elsewhere. Re-importing.";
          addExportIssue(actor, error);
          debugLog(
            `[push] conflict detected stored=${storedUpdated} server=${serverUpdated} — aborting push, will re-import`
          );
          // Clear pending changes so we don't retry the stale push
          this.pendingChanges.delete(characterId);
          this.pendingItemChanges.delete(characterId);
          // Trigger conflict recovery (re-import) without blocking the flush return
          if (this.onConflictHandler) {
            void this.onConflictHandler(actor);
          }
          return { success: false, error, conflict: true };
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
    const changes = this.pendingChanges.get(characterId);
    return changes ? Array.from(changes.values()) : [];
  }

  hasPendingChanges(characterId: string): boolean {
    const changes = this.pendingChanges.get(characterId);
    return changes !== undefined && changes.size > 0;
  }

  private clearDebounceTimer(characterId: string): void {
    const timer = this.debounceTimers.get(characterId);
    if (!timer) return;
    clearTimeout(timer);
    this.debounceTimers.delete(characterId);
  }

  private clearDebounceTimers(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
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
      }
    }
    return engines;
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
      this.pendingChanges.delete(characterId);
      this.pendingItemChanges.delete(characterId);
      this.recordApiCall(characterId);
      await this.updateSyncTimestamp(actor);
      // Update stored lastUpdated to new server value; the push should have bumped it
      try {
        const oldUpdated = actor.getFlag(MODULE_ID, "lastUpdated") as string | undefined;
        const newUpdated = await this.client.fetchCharacterUpdated(characterId);
        await actor.setFlag(MODULE_ID, "lastUpdated", newUpdated);
        debugLog(
          `[push] refreshed lastUpdated: old=${oldUpdated ?? "none"} new=${newUpdated} ` +
            `${oldUpdated === newUpdated || !oldUpdated ? "(unchanged)" : "(bumped by push)"}`
        );
      } catch (error) {
        debugLog(`[push] failed to refresh lastUpdated: ${String(error)}`);
        // Non-critical: will be refreshed on next import/fetch
      }
      return;
    }

    addExportIssue(actor, result.error ?? "Push to Demiplane failed unexpectedly");
    this.notifyFailure(result.error);
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

  private isWithinRateLimit(characterId: string): boolean {
    const timestamps = this.apiCallTimestamps.get(characterId) ?? [];
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    const recentCalls = timestamps.filter((t) => t > windowStart);
    this.apiCallTimestamps.set(characterId, recentCalls);
    return recentCalls.length < RATE_LIMIT_MAX_CALLS;
  }

  private recordApiCall(characterId: string): void {
    const timestamps = this.apiCallTimestamps.get(characterId) ?? [];
    timestamps.push(Date.now());
    this.apiCallTimestamps.set(characterId, timestamps);
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
