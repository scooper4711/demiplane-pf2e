import { MODULE_ID } from "./import/types.js";
import type { ImportSummary } from "./import/types.js";
import { debugLog } from "./import/debug-log.js";
import { deleteImportedItems } from "./import/reconcile.js";
import type { ExportManager, ExportResult } from "./export-manager.js";
import { queueAllItemChanges, queueAllDetailChanges, queueCombatResourceChanges } from "./hook-manager.js";
import { characterSystem } from "./pf2e-types.js";
import { beginSyncPause, endSyncPause, clearSyncPause } from "./sync-pause.js";
import { resetImportIssues, addImportIssue, setUnmappedSlugs } from "./sync-issues.js";

// Re-exported so wiring and tests share one definition.
export type { ExportResult };

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
  await beginSyncPause(actor);
  try {
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
    for (const error of summary.errors) addImportIssue(actor, error);
    return summary;
  } finally {
    await endSyncPause(actor);
    deps.exportManager.resume(characterId);
  }
}

export async function exportLinkedCharacter(actor: Actor, deps: SyncFlowDeps): Promise<ExportResult> {
  // Auto-sync is the master write switch. When it is off the push would be a
  // no-op, so tell the user plainly rather than doing the work and reporting a
  // misleading "pushed" success.
  if (!game.settings.get(MODULE_ID, "autoSync")) {
    ui.notifications.warn(
      `Auto-sync is off, so nothing was pushed for "${actor.name}". Enable it in the module settings to sync to Demiplane.`
    );
    return { success: false, error: "Auto-sync is off" };
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
  await beginSyncPause(actor);
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
    await endSyncPause(actor);
  }
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
