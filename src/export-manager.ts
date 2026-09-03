import { MODULE_ID } from "./import/types.js";
import { debugLog } from "./import/debug-log.js";
import { addExportIssue } from "./sync-issues.js";
import type { DemiplaneClient } from "@scooper4711/demiplane-api";
import { computeEngineSig } from "./engine-sig";
import { beginSyncPause, endSyncPause, isRemoteSyncActive } from "./sync-pause.js";
import { isClientElectedWriter } from "./sync-election.js";
import { ChangeBuffer, type EquippedState, type ItemChangeType, type PendingChange } from "./export/change-buffer.js";
import { PushPayloadBuilder, type FetchedCharacter } from "./export/push-payload-builder.js";
import { ConflictResolver } from "./export/conflict-resolver.js";

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

  queueChange(actor: Actor, field: string, value: number | string): void {
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

  /**
   * Exports a Campaign Notes change (biography.campaignNotes) as a Demiplane
   * "Campaign" journal entry. Finds the existing journal and updates it, or
   * creates one when none exists.
   *
   * Runs inside the cross-client concurrency lock (beginSyncPause/endSyncPause)
   * like every other push, so the journal write cannot race a concurrent import
   * or push into an optimistic-concurrency conflict. If a *different* client is
   * already mid-sync, we skip rather than pile on.
   */
  async exportCampaignNotes(actor: Actor, notes: string): Promise<void> {
    const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
    if (!characterId) return;
    if (!this.client.isAuthenticated()) return;

    // Defer to a sync already in progress on another client; that client's
    // import/push is authoritative and would otherwise conflict with our write.
    if (isRemoteSyncActive(actor)) {
      debugLog(`[push] remote sync in progress for ${characterId}; skipping Campaign journal export`);
      return;
    }

    await beginSyncPause(actor);
    try {
      await this.writeCampaignJournal(characterId, notes);
    } catch (error) {
      debugLog(`[push] journal export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await endSyncPause(actor);
    }
  }

  /** Creates or updates the "Campaign" journal entry with the given body. */
  private async writeCampaignJournal(characterId: string, notes: string): Promise<void> {
    const journals = await this.client.fetchCharacterJournals(characterId);
    const existing = journals.find((journal) => journal.title === "Campaign");

    if (existing) {
      await this.client.updateCharacterJournal(existing.objectID, characterId, "Campaign", notes);
      debugLog(`[push] updated Campaign journal entry`);
    } else {
      await this.client.createCharacterJournal(characterId, "Campaign", notes);
      debugLog(`[push] created Campaign journal entry`);
    }
  }

  async flush(actor: Actor, opts: { enforceElection?: boolean } = {}): Promise<ExportResult> {
    const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
    if (!characterId) {
      return { success: false, error: "Actor has no linked character ID" };
    }

    const blocked = this.checkFlushBlocked(actor, characterId, opts);
    if (blocked) return blocked;

    this.changeBuffer.clearDebounceTimer(characterId);

    if (!this.changeBuffer.hasPendingWork(characterId)) {
      return { success: true };
    }

    const readinessError = this.checkPushReadiness(actor, characterId);
    if (readinessError) return { success: false, error: readinessError };

    const conflict = await this.checkForConflict(actor, characterId);
    if (conflict) return conflict;

    const fetched = await this.buildPushPayload(characterId);
    if (!fetched) {
      const error = "Failed to fetch character data";
      addExportIssue(actor, error);
      return { success: false, error };
    }

    debugLog(`[push] starting push`);
    const result = await this.pushWithRetry(characterId, fetched);
    await this.handlePushResult(result, characterId, actor);
    debugLog(`[push] push resolved with success=${result.success}`);
    return result;
  }

  /**
   * Guard clauses that abort a flush before any work is done: this client must be
   * the elected writer when enforced, and no other client may be mid-sync for the
   * same character. Returns null when the flush may proceed.
   */
  private checkFlushBlocked(
    actor: Actor,
    characterId: string,
    opts: { enforceElection?: boolean }
  ): ExportResult | null {
    // Only the single elected writer may push a coordinated auto-push; otherwise
    // every client duplicates the write. Drop our own pending changes if we are
    // not elected — the elected client pushes the authoritative state.
    if (opts.enforceElection && !isClientElectedWriter(actor)) {
      debugLog(`[push] not the elected writer for ${characterId}; skipping auto-push`);
      this.changeBuffer.clear(characterId);
      return { success: true };
    }

    // Defer rather than race another client importing/pushing this character, then
    // re-arm the timer so the pending changes are pushed once the remote sync settles.
    if (isRemoteSyncActive(actor)) {
      debugLog(`[push] remote sync in progress for ${characterId}; deferring flush`);
      this.changeBuffer.rearmFlush(actor, characterId);
      return { success: true };
    }

    return null;
  }

  /** Combines the rate-limit and authentication gates into a single error string (or null). */
  private checkPushReadiness(actor: Actor, characterId: string): string | null {
    const rateLimitError = this.checkRateLimit(actor, characterId);
    if (rateLimitError) return rateLimitError;
    return this.checkAuthentication(actor);
  }

  private checkRateLimit(actor: Actor, characterId: string): string | null {
    if (this.changeBuffer.isWithinRateLimit(characterId)) return null;
    const error = "Rate limit exceeded: maximum 30 API calls per 60 seconds";
    addExportIssue(actor, error);
    return error;
  }

  private checkAuthentication(actor: Actor): string | null {
    if (this.client.isAuthenticated()) return null;
    const error = "No Demiplane token configured. Ask your GM to set it in module settings.";
    addExportIssue(actor, error);
    this.notifyFailure(error);
    return error;
  }

  /**
   * Optimistic concurrency: if Demiplane has been updated since the last import,
   * clears the stale pending changes and triggers conflict recovery (re-import).
   * Returns a failed `ExportResult` on conflict, or null when the push may proceed.
   */
  private async checkForConflict(actor: Actor, characterId: string): Promise<ExportResult | null> {
    const conflict = await this.conflictResolver.checkConflict(characterId, actor);
    if (conflict.status !== "conflict") return null;
    this.changeBuffer.clear(characterId);
    if (this.onConflictHandler) {
      void this.onConflictHandler(actor);
    }
    return { success: false, error: conflict.error, conflict: true };
  }

  /**
   * Keeps the session alive and assembles the Demiplane payload for the buffered
   * changes. Returns null if the character data could not be fetched.
   */
  private async buildPushPayload(characterId: string): Promise<FetchedCharacter | null> {
    try {
      await this.client.updateLastAccess();
      debugLog(`[push] updateLastAccess succeeded`);
    } catch (error) {
      debugLog(`[push] updateLastAccess failed: ${String(error)}`);
    }
    const { changes, itemChanges } = this.changeBuffer.peek(characterId);
    return this.payloadBuilder.buildUpdatedCharacterData(characterId, changes ?? new Map(), itemChanges ?? new Map());
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
