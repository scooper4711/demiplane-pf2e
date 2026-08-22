import { MODULE_ID } from "./import/types.js";
import type {
  DemiplaneClient,
  CharacterEngine,
} from "@scooper4711/demiplane-api";
import { updateCustomEngineValue } from "@scooper4711/demiplane-api";

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

export interface ExportResult {
  success: boolean;
  newVersion?: number;
  error?: string;
  conflictDetected?: boolean;
  preview?: PendingChange[];
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
  private readonly pendingChanges: Map<string, Map<string, PendingChange>> =
    new Map();
  private readonly debounceTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();
  private readonly apiCallTimestamps: Map<string, number[]> = new Map();

  constructor(client: DemiplaneClient) {
    this.client = client;
  }

  queueChange(actor: Actor, field: string, value: number): void {
    const characterId = actor.getFlag(MODULE_ID, "characterId") as
      | string
      | undefined;
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

  async flush(
    actor: Actor,
    options: ExportOptions = {},
  ): Promise<ExportResult> {
    const { dryRun = false } = options;
    const characterId = actor.getFlag(MODULE_ID, "characterId") as
      | string
      | undefined;

    if (!characterId) {
      return { success: false, error: "Actor has no linked character ID" };
    }

    const changes = this.pendingChanges.get(characterId);
    if (!changes || changes.size === 0) {
      return { success: true };
    }

    if (dryRun) {
      const conflictDetected = await this.detectConflict(actor, characterId);
      return {
        success: true,
        preview: Array.from(changes.values()),
        conflictDetected,
      };
    }

    if (!this.isWithinRateLimit(characterId)) {
      return {
        success: false,
        error: "Rate limit exceeded: maximum 30 API calls per 60 seconds",
      };
    }

    const updatedEngines = await this.buildUpdatedEngines(characterId, changes);
    if (!updatedEngines) {
      return { success: false, error: this.lastFetchError };
    }

    const result = await this.pushWithRetry(characterId, updatedEngines);
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

  private lastFetchError = "";

  private async buildUpdatedEngines(
    characterId: string,
    changes: Map<string, PendingChange>,
  ): Promise<CharacterEngine[] | null> {
    let engines: CharacterEngine[];
    try {
      const data = await this.client.fetchCharacterData(characterId);
      engines = data.engines;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastFetchError = `Failed to fetch character data: ${message}`;
      return null;
    }

    let updatedEngines = engines;
    for (const change of changes.values()) {
      updatedEngines = updateCustomEngineValue(
        updatedEngines,
        change.field,
        change.value,
      );
    }
    return updatedEngines;
  }

  private async handlePushResult(
    result: ExportResult,
    characterId: string,
    actor: Actor,
  ): Promise<void> {
    if (result.success) {
      this.pendingChanges.delete(characterId);
      this.recordApiCall(characterId);
      await this.updateVersionFlags(actor, result.newVersion);
      return;
    }

    this.notifyFailure(result.error);
  }

  private async updateVersionFlags(
    actor: Actor,
    newVersion: number | undefined,
  ): Promise<void> {
    if (newVersion === undefined) return;
    try {
      await actor.setFlag(MODULE_ID, "lastKnownVersion", newVersion);
      await actor.setFlag(MODULE_ID, "lastSyncTimestamp", Date.now());
    } catch {
      // Non-critical: version tracking failure doesn't invalidate the push
    }
  }

  private notifyFailure(error: string | undefined): void {
    if (typeof ui !== "undefined" && ui.notifications) {
      ui.notifications.error(
        `Demiplane sync failed: ${error ?? "Unknown error"}`,
      );
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

  private async pushWithRetry(
    characterId: string,
    updatedEngines: CharacterEngine[],
  ): Promise<ExportResult> {
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await this.sleep(backoffMs);
      }

      try {
        const success = await this.client.updateCharacter({
          id: characterId,
          data: {
            engines: updatedEngines,
            engineCacheIdsBySource: {},
          },
        });

        if (success) {
          return this.fetchVersionAfterPush(characterId);
        }

        lastError = "Mutation returned success: false";
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      success: false,
      error: `All ${String(MAX_RETRIES + 1)} attempts failed. Last error: ${lastError}`,
    };
  }

  private async fetchVersionAfterPush(
    characterId: string,
  ): Promise<ExportResult> {
    try {
      const version = await this.client.fetchCharacterVersion(characterId);
      return { success: true, newVersion: version.version };
    } catch {
      return { success: true };
    }
  }

  private async detectConflict(
    actor: Actor,
    characterId: string,
  ): Promise<boolean> {
    try {
      const storedVersion = actor.getFlag(MODULE_ID, "lastKnownVersion") as
        | number
        | undefined;
      if (storedVersion === undefined) {
        return false;
      }
      const remote = await this.client.fetchCharacterVersion(characterId);
      return remote.version > storedVersion;
    } catch {
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
