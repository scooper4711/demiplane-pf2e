import { MODULE_ID } from "./import/types.js";
import type { ImportSummary } from "./import/types.js";
import { debugLog } from "./import/debug-log.js";
import { deleteImportedItems } from "./import/reconcile.js";
import type { ExportManager, ExportResult } from "./export-manager.js";
import { queueAllItemChanges, queueAllDetailChanges, queueCombatResourceChanges } from "./hook-manager.js";
import { characterSystem } from "./pf2e-types.js";
import { beginSyncPause, endSyncPause, clearSyncPause, isSyncActive } from "./sync-pause.js";
import { resetImportIssues, addImportIssues, setUnmappedSlugs } from "./sync-issues.js";
import { canWriteText } from "./write-level.js";

// Re-exported so wiring and tests share one definition.
export type { ExportResult };

/**
 * How long to keep the sync guard active AFTER an import's writes finish.
 *
 * Import creates/deletes items via createEmbeddedDocuments/deleteEmbeddedDocuments,
 * but Foundry fires the resulting item hooks — and PF2e re-prepares derived data
 * (which can itself delete/recreate embedded items) — on later ticks, after the
 * import promise has already resolved. If the guard released the instant the
 * import returned, one of those late `deleteItem` hooks would be seen as a user
 * edit, queue an item delete, and the debounced push would DELETE the item on
 * Demiplane. Holding the guard past the export debounce window closes that hole.
 *
 * Must be greater than the export debounce (2s) so any push a late hook schedules
 * is still suppressed when it tries to flush.
 */
const SYNC_RELEASE_GRACE_MS = 5000;

/**
 * The import side of the sync flows. Structural so tests can substitute a
 * fake; the real `ImportOrchestrator` satisfies it.
 */
export interface ImportOrchestratorLike {
  importCharacter(actor: Actor, characterId: string, options: { token: string }): Promise<ImportSummary>;
}

/** Collaborators the flows need. Built once in `module.ts` from the real singletons. */
export interface SyncFlowDeps {
  exportManager: ExportManager;
  importOrchestrator: ImportOrchestratorLike;
}

/** Import a linked character, with `wipe` for full re-imports. */
export type ImportCharacterFn = (
  actor: Actor,
  characterId: string,
  token: string,
  options?: { wipe?: boolean }
) => Promise<ImportSummary>;

/** Push local changes for a linked actor to Demiplane. */
export type ExportCharacterFn = (actor: Actor) => Promise<ExportResult>;

export async function importLinkedCharacter(
  actor: Actor,
  characterId: string,
  token: string,
  deps: SyncFlowDeps,
  options: { wipe?: boolean } = {}
): Promise<ImportSummary> {
  resetImportIssues(actor);
  deps.exportManager.suspend(characterId);
  // Mark the character as syncing so every connected client (including this one)
  // pauses its pushes while the import rewrites the actor. This prevents the
  // import's own actor updates from echoing back to Demiplane via other clients.
  // beginSyncPause sits inside the try so a throw can't strand the suspension
  // (a stuck suspend silently drops every later queued change), and its token
  // is threaded through so overlapping syncs clear exactly their own mark.
  let syncToken: string | undefined;
  try {
    syncToken = await beginSyncPause(actor);
    // Wiping has to happen inside the pause: the delete hook would otherwise read
    // these removals as user edits and queue them for push, deleting the real
    // items on Demiplane and advancing its timestamp into a false conflict.
    if (options.wipe) {
      try {
        const deleted = await deleteImportedItems(actor);
        if (deleted > 0) {
          debugLog(`[update] Deleted ${deleted} previously imported items`);
        }
      } catch (error) {
        debugLog(`[update] failed to delete imported items before import: ${String(error)}`);
      }
    }

    const summary = await deps.importOrchestrator.importCharacter(actor, characterId, { token });
    setUnmappedSlugs(actor, summary.unmapped);
    await addImportIssues(actor, summary.errors);
    return summary;
  } finally {
    // Release the guard AFTER a grace window, not immediately: the import's own
    // item hooks and PF2e's post-import re-preparation fire on later ticks, and
    // releasing now would let one of those late `deleteItem` events push a
    // deletion to Demiplane. Scheduled (not awaited) so the import still returns
    // promptly; the suspend ref-count and the sync token stay held meanwhile.
    scheduleSyncRelease(actor, characterId, syncToken, deps.exportManager);
  }
}

/**
 * Releases the import sync guard (`endSyncPause` + `exportManager.resume`) after
 * {@link SYNC_RELEASE_GRACE_MS}, so item hooks the import triggers on later ticks
 * remain suppressed and cannot push item deletions back to Demiplane.
 */
function scheduleSyncRelease(
  actor: Actor,
  characterId: string,
  syncToken: string | undefined,
  exportManager: ExportManager
): void {
  setTimeout(() => {
    void endSyncPause(actor, syncToken);
    exportManager.resume(characterId);
  }, SYNC_RELEASE_GRACE_MS);
}

export async function exportLinkedCharacter(actor: Actor, deps: SyncFlowDeps): Promise<ExportResult> {
  // The write level is the master write switch. At "none" the push would be a
  // no-op, so tell the user plainly rather than doing the work and reporting a
  // misleading "pushed" success.
  if (!canWriteText()) {
    ui.notifications.warn(
      `Writing to Demiplane is off, so nothing was pushed for "${actor.name}". Set a write level in the module settings to sync to Demiplane.`
    );
    return { success: false, error: "Writing to Demiplane is off" };
  }

  const result = await pushCharacterEngines(actor, deps);

  // Campaign Notes is a Demiplane *journal* entry, not an engine value, so it is
  // written through its own push (`exportCampaignNotes`), which opens its own
  // sync pause. Run it *after* the engine push has released the pause — nesting
  // the two pauses on one client would orphan the outer sync token and wedge the
  // debounce timer in a defer/re-arm loop.
  if (result.success) {
    const notes = characterSystem(actor).details.biography?.campaignNotes;
    if (typeof notes === "string") await deps.exportManager.exportCampaignNotes(actor, notes);
  }

  return result;
}

/**
 * Pushes every engine-backed field (combat resources, items, and character
 * details) in a single flush, wrapped in the cross-client sync pause so it
 * cannot race a concurrent import/push into an optimistic-concurrency conflict.
 */
export async function pushCharacterEngines(actor: Actor, deps: SyncFlowDeps): Promise<ExportResult> {
  // The manual/API path must not silently defer: `flush` reports fake success
  // when another sync is in flight (the debounced path retries via re-arm, but
  // there is no retry here — and a later import would suspend away the
  // buffered changes entirely). Wait out in-flight syncs (bounded) so the
  // push below really lands; fail honestly on timeout instead.
  if (!(await waitForSyncIdle(actor))) {
    return { success: false, error: "Timed out waiting for an in-flight sync to finish; nothing was pushed." };
  }
  const syncToken = await beginSyncPause(actor);
  try {
    queueCombatResourceChanges(deps.exportManager, actor);
    queueAllItemChanges(deps.exportManager, actor);
    queueAllDetailChanges(deps.exportManager, actor);
    const result = await deps.exportManager.flush(actor);
    if (result.success) {
      ui.notifications.info(`Pushed character data for "${actor.name}" to Demiplane.`);
    } else if (result.conflict) {
      ui.notifications.warn(
        `Demiplane character changed on the server since last import — re-importing "${actor.name}" to avoid overwriting. Your pending changes were not pushed; please re-apply them after the re-import.`
      );
      // Re-import is performed by the registered conflict handler.
    }
    return result;
  } finally {
    await endSyncPause(actor, syncToken);
  }
}

/**
 * Waits until no sync (own or remote) is in flight for the actor's character
 * (or the deadline passes). Campaign-notes edits trigger a floating journal
 * push that holds the sync mark for a second or two — pushing through it
 * would defer with fake success, so the manual path waits it out instead.
 * Uses isSyncActive (any pause) rather than isRemoteSyncActive: our own
 * overlapping syncs count as busy here.
 */
async function waitForSyncIdle(actor: Actor, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isSyncActive(actor)) {
    if (Date.now() >= deadline) {
      debugLog(`[push] waitForSyncIdle timed out; proceeding anyway`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return true;
}

/**
 * Re-imports an actor from Demiplane after an optimistic-concurrency conflict,
 * refreshing both its actor state and the stored `lastUpdated` timestamp.
 * Registered on the ExportManager so that both manual exports and debounced
 * auto-pushes recover identically on conflict.
 */
export async function reimportActorOnConflict(actor: Actor, deps: SyncFlowDeps): Promise<void> {
  const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
  const token = game.settings.get(MODULE_ID, "demiplaneToken") as string | undefined;
  if (!characterId || !token) {
    ui.notifications.warn(`Unable to re-import "${actor.name}": missing character link or token.`);
    return;
  }
  const summary = await importLinkedCharacter(actor, characterId, token, deps, { wipe: true });
  ui.notifications.info(`Re-imported "${actor.name}" from Demiplane — ${summary.itemsImported} items.`);
}

/**
 * Clears any `syncActiveTokens` marks left on actors by a session that crashed
 * mid-sync, so they don't permanently block pushes for those characters.
 */
export async function recoverStaleSyncPauses(): Promise<void> {
  for (const actor of game.actors.contents) {
    const tokens = actor.getFlag(MODULE_ID, "syncActiveTokens") as string[] | undefined;
    if (Array.isArray(tokens) && tokens.length > 0) {
      await clearSyncPause(actor);
    }
  }
}
