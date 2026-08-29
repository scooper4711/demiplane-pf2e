import { MODULE_ID } from "./import/types.js";
import { debugLog } from "./import/debug-log.js";
import { addExportIssue } from "./sync-issues.js";
import type { DemiplaneClient } from "@scooper4711/demiplane-api";
import { computeEngineSig } from "./engine-sig";
import { isRemoteSyncActive } from "./sync-pause.js";
import { ChangeBuffer, type EquippedState, type ItemChangeType, type PendingChange } from "./export/change-buffer.js";
import { PushPayloadBuilder, type FetchedCharacter } from "./export/push-payload-builder.js";

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export type { EquippedState, ItemChangeType, PendingChange, PendingItemChange } from "./export/change-buffer.js";
export type { FetchedCharacter } from "./export/push-payload-builder.js";

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
 * The per-character pending change buffer (`ChangeBuffer`) and the payload
 * builder (`PushPayloadBuilder`) have been extracted; the optimistic-concurrency
 * check and flush orchestration/retry still live here.
 */
export class ExportManager {
  private readonly client: DemiplaneClient;
  private readonly changeBuffer: ChangeBuffer;
  private readonly payloadBuilder: PushPayloadBuilder;
  private onConflictHandler: ((actor: Actor) => Promise<void>) | undefined = undefined;

  constructor(client: DemiplaneClient) {
    this.client = client;
    this.changeBuffer = new ChangeBuffer((actor) => {
      void this.flush(actor);
    });
    this.payloadBuilder = new PushPayloadBuilder(client);
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
