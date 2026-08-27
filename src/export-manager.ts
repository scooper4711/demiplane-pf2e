import { MODULE_ID } from "./import/types.js";
import { normalizeEquipmentSlug } from "./import/slug-utils.js";
import { debugLog } from "./import/debug-log.js";
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

export type ItemChangeType = "quantity" | "equipped";

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
  timestamp: number;
}

export interface ExportResult {
  success: boolean;
  error?: string;
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

  constructor(client: DemiplaneClient) {
    this.client = client;
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
    itemType?: string
  ): void {
    if (this.suspended) return;

    const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
    if (!characterId) return;

    const key = `${itemSlug}:${changeType}`;
    if (!this.pendingItemChanges.has(characterId)) {
      this.pendingItemChanges.set(characterId, new Map());
    }

    this.pendingItemChanges.get(characterId)!.set(key, {
      itemSlug,
      demiplaneSlug,
      changeType,
      value,
      itemType,
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
      return {
        success: false,
        error: "Rate limit exceeded: maximum 30 API calls per 60 seconds",
      };
    }

    if (!this.client.isAuthenticated()) {
      const error = "No Demiplane token configured. Ask your GM to set it in module settings.";
      this.notifyFailure(error);
      return { success: false, error };
    }

    const fetched = await this.buildUpdatedCharacterData(characterId, changes ?? new Map(), itemChanges ?? new Map());
    if (!fetched) {
      return { success: false, error: "Failed to fetch character data" };
    }

    const result = await this.pushWithRetry(characterId, fetched);
    await this.handlePushResult(result, characterId, actor);
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

  // eslint-disable-next-line complexity -- monolith assembling field + item + hand-slot engines for the push payload
  private async buildUpdatedCharacterData(
    characterId: string,
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

    for (const change of changes.values()) {
      const existing = findCustomEngineByName(fetched.engines, change.field);
      if (existing) {
        updatedEngines = updatedEngines.map((e) => (e === existing ? { ...e, value: change.value } : e));
      }
    }

    interface ResolvedItemChange {
      change: PendingItemChange;
      demiplaneId: string;
    }
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

    for (const { change: itemChange, demiplaneId } of resolved) {
      if (itemChange.changeType === "quantity") {
        const qtyName = `${demiplaneId}--quantity`;
        const existing = findCustomEngineByName(updatedEngines, qtyName);
        if (existing) {
          updatedEngines = updatedEngines.map((e) =>
            e === existing ? { ...e, value: itemChange.value as number } : e
          );
        }
      } else if (itemChange.changeType === "equipped") {
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
        if (existingEquipped) {
          updatedEngines = updatedEngines.map((e) =>
            e === existingEquipped ? { ...e, value: isEquipped ? 1 : 0 } : e
          );
        }
      }
    }

    const primaryHandName = "character_hand_primary_equipped-id";
    const offhandName = "character_hand_offhand_equipped-id";
    const bothHandsName = "character_hand_both_equipped-id";
    const existingPrimary = findCustomEngineByName(updatedEngines, primaryHandName);
    const existingOffhand = findCustomEngineByName(updatedEngines, offhandName);
    const existingBoth = findCustomEngineByName(updatedEngines, bothHandsName);
    debugLog(
      `[push] hand engines found: primary=${existingPrimary !== undefined}, offhand=${existingOffhand !== undefined}, both=${existingBoth !== undefined}; values before: primary=${existingPrimary?.value}, offhand=${existingOffhand?.value}, both=${existingBoth?.value}`
    );

    const setPrimary = (id: string) => {
      if (existingPrimary)
        updatedEngines = updatedEngines.map((e) => (e === existingPrimary ? { ...e, value: id } : e));
    };
    const setOffhand = (id: string) => {
      if (existingOffhand)
        updatedEngines = updatedEngines.map((e) => (e === existingOffhand ? { ...e, value: id } : e));
    };
    const setBoth = (id: string) => {
      if (existingBoth) updatedEngines = updatedEngines.map((e) => (e === existingBoth ? { ...e, value: id } : e));
    };
    const clearAllHands = (id: string) => {
      if (existingPrimary && existingPrimary.value === id)
        updatedEngines = updatedEngines.map((e) => (e === existingPrimary ? { ...e, value: "na" } : e));
      if (existingOffhand && existingOffhand.value === id)
        updatedEngines = updatedEngines.map((e) => (e === existingOffhand ? { ...e, value: "na" } : e));
      if (existingBoth && existingBoth.value === id)
        updatedEngines = updatedEngines.map((e) => (e === existingBoth ? { ...e, value: "na" } : e));
    };

    const heldEquipped = resolved.filter(({ change }) => {
      if (change.changeType !== "equipped") return false;
      const equippedState = change.value as EquippedState;
      return equippedState.carryType === "held" && change.itemType !== "armor";
    });
    const heldIds = heldEquipped.map(({ demiplaneId: id }) => id);
    const heldHandValues = heldEquipped.map(({ change }) => {
      const equippedState = change.value as EquippedState;
      return typeof equippedState.handsHeld === "number" ? equippedState.handsHeld : 1;
    });

    let primaryUsed = false;
    let offhandUsed = false;
    let bothUsed = false;

    for (let i = 0; i < heldIds.length; i++) {
      const id = heldIds[i]!;
      const handsHeld = heldHandValues[i]!;
      if (bothUsed) continue;

      if (handsHeld >= 2) {
        if (primaryUsed) continue;
        setBoth(id);
        bothUsed = true;
        continue;
      }

      if (!primaryUsed) {
        setPrimary(id);
        primaryUsed = true;
      } else if (!offhandUsed) {
        setOffhand(id);
        offhandUsed = true;
      }
    }

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

  private async handlePushResult(result: ExportResult, characterId: string, actor: Actor): Promise<void> {
    if (result.success) {
      // eslint-disable-next-line no-console -- single always-on log per push
      console.info(`${MODULE_ID} | Pushed character data to Demiplane (${characterId})`);
      this.pendingChanges.delete(characterId);
      this.pendingItemChanges.delete(characterId);
      this.recordApiCall(characterId);
      await this.updateSyncTimestamp(actor);
      return;
    }

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
