import { MODULE_ID } from "./import/types.js";
import type { CharacterData, CustomEngine, DemiplaneClient } from "@scooper4711/demiplane-api";
import { findCustomEngineByName } from "@scooper4711/demiplane-api";

const DEBOUNCE_MS = 2000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_CALLS = 30;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export interface ExportOptions {
  dryRun?: boolean;
}

export interface PendingChange {
  field: string;
  value: number;
  timestamp: number;
}

export type ItemChangeType = "quantity" | "equipped";

export interface PendingItemChange {
  itemSlug: string;
  changeType: ItemChangeType;
  value: number | string;
  timestamp: number;
}

export interface ExportResult {
  success: boolean;
  error?: string;
  preview?: PendingChange[];
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

  queueItemChange(actor: Actor, itemSlug: string, changeType: ItemChangeType, value: number | string): void {
    if (this.suspended) return;

    const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
    if (!characterId) return;

    const key = `${itemSlug}:${changeType}`;
    if (!this.pendingItemChanges.has(characterId)) {
      this.pendingItemChanges.set(characterId, new Map());
    }

    this.pendingItemChanges.get(characterId)!.set(key, {
      itemSlug,
      changeType,
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

  async flush(actor: Actor, options: ExportOptions = {}): Promise<ExportResult> {
    const dryRun = this.resolveDryRun(options);
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

    if (dryRun) {
      return {
        success: true,
        preview: changes ? Array.from(changes.values()) : [],
      };
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

  private resolveDryRun(options: ExportOptions): boolean {
    if (options.dryRun !== undefined) return options.dryRun;
    if (typeof game === "undefined") return false;
    return game.settings.get(MODULE_ID, "dryRun");
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

    for (const itemChange of itemChanges.values()) {
      const itemEngine = fetched.engines.find(
        (e) =>
          e.type === "DemiplaneEngine" &&
          e.name.startsWith("tabula/item/") &&
          (e.args?.slug as string) === itemChange.itemSlug
      );
      if (!itemEngine) continue;

      const demiplaneId = itemEngine.demiplaneEngineId;
      if (itemChange.changeType === "quantity") {
        const qtyName = `${demiplaneId}--quantity`;
        const existing = findCustomEngineByName(updatedEngines, qtyName);
        if (existing) {
          updatedEngines = updatedEngines.map((e) => (e === existing ? { ...e, value: itemChange.value } : e));
        }
      } else if (itemChange.changeType === "equipped") {
        const equipped = itemChange.value as string;
        const equippedName = `${demiplaneId}-is-equipped`;
        const existingEquipped = findCustomEngineByName(updatedEngines, equippedName);

        if (equipped === "worn" || equipped === "held") {
          if (existingEquipped) {
            updatedEngines = updatedEngines.map((e) => (e === existingEquipped ? { ...e, value: 1 } : e));
          }
        } else if (existingEquipped) {
          updatedEngines = updatedEngines.map((e) => (e === existingEquipped ? { ...e, value: 0 } : e));
        }
      }
    }

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
