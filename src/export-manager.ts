import { MODULE_ID } from "./import/types.js";
import { debugLog } from "./import/debug-log.js";
import { addExportIssue } from "./sync-issues.js";
import type { DemiplaneClient } from "@scooper4711/demiplane-api";
import { computeEngineSig } from "./engine-sig";
import { isRemoteSyncActive } from "./sync-pause.js";
import { isClientElectedWriter } from "./sync-election.js";
import {
  ChangeBuffer,
  type EquippedState,
  type ItemChangeType,
  type PendingChange,
  type PendingItemChange,
} from "./export/change-buffer.js";
import { PushPayloadBuilder, type FetchedCharacter } from "./export/push-payload-builder.js";
import { ConflictResolver } from "./export/conflict-resolver.js";

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export type { EquippedState, ItemChangeType, PendingChange, PendingItemChange, FetchedCharacter };

export interface ExportResult {
  success: boolean;
  error?: string;
  conflict?: boolean;
}

/**
 * Handles debounced session state export from Foundry to Demiplane.
 *
 * Accumulates field changes within a 2-second debounce window and
 * batches them into a single API call. Rate-limited to 30 API calls
 * per 60-second rolling window per character. Retries up to 3 times
 * with exponential backoff on failure.
 *
 * The heavy lifting is delegated to collaborators:
 * - `ChangeBuffer` owns the per-character pending change maps, debounce timers,
 *   and rate-limit tracking.
 * - `PushPayloadBuilder` turns the buffered changes into the Demiplane payload.
 * - `ConflictResolver` performs the optimistic-concurrency content check.
 *
 * `ExportManager` keeps only orchestration (the flush flow), retry/backoff, and
 * the wiring of those collaborators.
 */
export class ExportManager {
  private readonly client: DemiplaneClient;
  private readonly changeBuffer: ChangeBuffer;
  private readonly payloadBuilder: PushPayloadBuilder;
  private readonly conflictResolver: ConflictResolver;
  private onConflictHandler: ((actor: Actor) => Promise<void>) | undefined = undefined;

  constructor(client: DemiplaneClient) {
    this.client = client;
    this.changeBuffer = new ChangeBuffer((actor) => {
      void this.flush(actor, { enforceElection: true });
    });
    this.payloadBuilder = new PushPayloadBuilder(client);
    this.conflictResolver = new ConflictResolver(client);
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

  async flush(actor: Actor, opts: { enforceElection?: boolean } = {}): Promise<ExportResult> {
    const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;

    if (!characterId) {
      return { success: false, error: "Actor has no linked character ID" };
    }

    // When an auto-push is coordinated across multiple connected clients, only the
    // single elected writer may push — otherwise every client duplicates the write.
    // Drop our own pending changes if we are not the elected writer; the elected
    // client will push the authoritative state.
    if (opts.enforceElection && !isClientElectedWriter(actor)) {
      debugLog(`[push] not the elected writer for ${characterId}; skipping auto-push`);
      this.changeBuffer.clear(characterId);
      return { success: true };
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
    const conflict = await this.conflictResolver.checkConflict(characterId, actor);
    if (conflict.status === "conflict") {
      // Clear pending changes so we don't retry the stale push
      this.changeBuffer.clear(characterId);
      // Trigger conflict recovery (re-import) without blocking the flush return
      if (this.onConflictHandler) {
        void this.onConflictHandler(actor);
      }
      return { success: false, error: conflict.error, conflict: true };
    }

    // Keep session alive
    try {
      await this.client.updateLastAccess();
      debugLog(`[push] updateLastAccess succeeded`);
    } catch (error) {
      debugLog(`[push] updateLastAccess failed: ${String(error)}`);
      // Non-critical: ignore failure to update last access
    }

    const fetched = await this.payloadBuilder.buildUpdatedCharacterData(
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

    debugLog(`[push] starting push`);
    const result = await this.pushWithRetry(characterId, fetched);
    await this.handlePushResult(result, characterId, actor);
    debugLog(`[push] push resolved ${result.success ? "success" : "failure"}`);
    return result;
  }

  getPendingChanges(characterId: string): PendingChange[] {
    return this.changeBuffer.getPendingChanges(characterId);
  }

  hasPendingChanges(characterId: string): boolean {
    return this.changeBuffer.hasPendingChanges(characterId);
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
