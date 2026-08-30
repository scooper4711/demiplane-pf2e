import { MODULE_ID } from "./import/types.js";
import { debugLog } from "./import/debug-log.js";
import { DemiplaneClient } from "@scooper4711/demiplane-api";
import { registerSettings } from "./settings.js";
import { ImportOrchestrator } from "./import/index.js";
import { deleteImportedItems } from "./import/reconcile.js";
import { ExportManager } from "./export-manager.js";
import { HookManager, queueAllItemChanges, queueCombatResourceChanges } from "./hook-manager.js";
import { beginSyncPause, endSyncPause, clearSyncPause } from "./sync-pause.js";
import { CharacterLinkDialog } from "./character-link-dialog.js";
import { registerDemiplaneInfoButton } from "./demiplane-info-button.js";
import { registerTitlebarDot } from "./titlebar-dot.js";
import { resetImportIssues, addImportIssue, setUnmappedSlugs } from "./sync-issues.js";
import { DEMIPLANE_SHEET_BASE } from "./config.js";

let client: DemiplaneClient;
let importOrchestrator: ImportOrchestrator;
let exportManager: ExportManager;
let hookManager: HookManager;

Hooks.once("init", () => {
  debugLog(`Initializing Demiplane PF2e Sync`);
  registerSettings();
});

Hooks.once("ready", async () => {
  debugLog(`Ready`);

  // Pre-release warning only applies once the write feature (auto-sync) is enabled.
  if (game.settings.get(MODULE_ID, "autoSync")) {
    await showPreReleaseWarning();
  }

  client = new DemiplaneClient();
  const storedToken = game.settings.get(MODULE_ID, "demiplaneToken") as string;
  if (storedToken) {
    client.setToken(storedToken);
  }

  importOrchestrator = new ImportOrchestrator();
  exportManager = new ExportManager(client);
  exportManager.setOnConflictHandler((actor) => reimportActorOnConflict(actor));
  hookManager = new HookManager(exportManager);
  void new CharacterLinkDialog(client);

  hookManager.register();
  registerDemiplaneInfoButton(importLinkedCharacter, exportLinkedCharacter);
  registerTitlebarDot();

  // Recover from a previous session that crashed mid-sync, which would otherwise
  // leave a stale sync mark blocking all pushes for the affected character.
  void recoverStaleSyncPauses();

  // Keep the client token in sync when the setting changes
  Hooks.on("updateSetting", (setting: { key: string }) => {
    if (setting.key === `${MODULE_ID}.demiplaneToken`) {
      const newToken = game.settings.get(MODULE_ID, "demiplaneToken") as string;
      if (newToken) {
        client.setToken(newToken);
      }
    }

    // The pre-release warning is tied to the write feature (auto-sync). Show it
    // whenever auto-sync is switched on so users are re-warned before writing.
    if (setting.key === `${MODULE_ID}.autoSync` && game.settings.get(MODULE_ID, "autoSync")) {
      void showPreReleaseWarning();
    }
  });

  // Expose module API for external access and testing
  const module = game.modules.get(MODULE_ID);
  if (module) {
    (module as unknown as { api: Record<string, unknown> }).api = {
      importCharacter: async (actor: Actor, options?: { token?: string }) => {
        const characterId = actor.getFlag(MODULE_ID, "characterId") as string;
        if (!characterId) {
          ui.notifications.error("No Demiplane character linked to this actor.");
          return null;
        }
        const token = options?.token || (game.settings.get(MODULE_ID, "demiplaneToken") as string);
        if (!token) {
          ui.notifications.error("No Demiplane token configured. Set it in module settings.");
          return null;
        }
        return importLinkedCharacter(actor, characterId, token);
      },
      exportNow: (actor: Actor) => exportLinkedCharacter(actor),
    };
  }

  debugLog(`API registered`);
});

// Add "Import Demiplane Character" button to the Actors sidebar
Hooks.on("renderActorDirectory", (_app: unknown, html: HTMLElement) => {
  const actionButtons = html.querySelector(".action-buttons");
  if (!actionButtons || actionButtons.querySelector(".demiplane-import-btn")) return;

  // Only GMs (including Assistant GMs) or users able to create actors may import.
  if (!(game.user?.isGM || game.user?.can("ACTOR_CREATE"))) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "demiplane-import-btn";
  button.innerHTML = `<i class="fa-solid fa-download" inert></i><span>Import Demiplane Character</span>`;

  button.addEventListener("click", async () => {
    // DialogV2 wraps `content` in its own <form>, so only the fields are supplied
    // here and the submitted values come back already parsed.
    const result = await foundry.applications.api.DialogV2.input({
      window: { title: "Import Demiplane Character" },
      content: `<div class="form-group"><label>Demiplane Character UUID or URL</label>
<input type="text" name="characterRef" placeholder="UUID or ${DEMIPLANE_SHEET_BASE}/..." autofocus /></div>` as foundry.applications.api.DialogV2.Content<{
        characterRef: string;
      }>,
      ok: { label: "Import" },
    });

    if (!result) return;

    const characterId = extractCharacterId(result.characterRef.trim());
    if (!characterId) {
      ui.notifications?.error("Invalid Demiplane character UUID or URL.");
      return;
    }

    const token = game.settings.get(MODULE_ID, "demiplaneToken") as string;
    if (!token) {
      ui.notifications?.error("No Demiplane token configured. Set it in module settings.");
      return;
    }

    ui.notifications?.info("Importing character from Demiplane...");

    const actor = await Actor.create({ name: "Importing...", type: "character" });
    if (!actor) return;

    await actor.setFlag(MODULE_ID, "characterId", characterId);
    const summary = await importLinkedCharacter(actor, characterId, token);

    if (summary.errors.length > 0) {
      ui.notifications?.error(`Import errors: ${summary.errors.join("; ")}`);
    } else {
      ui.notifications?.info(`Imported "${actor.name}" — ${summary.itemsImported} items.`);
    }
  });

  actionButtons.appendChild(button);
});

function showPreReleaseWarning(): Promise<void> {
  return foundry.applications.api.DialogV2.prompt({
    window: { title: "Demiplane PF2e Sync — Pre-Release Warning" },
    content: `
      <p><strong>This module is pre-release software and should only be used for testing.</strong></p>
      <p>Using this module can result in data loss for the Foundry Actor, the Demiplane character, or both.</p>
      <p>Please ensure you have backups before proceeding.</p>
    `,
    ok: { label: "I Understand" },
  }).then(() => undefined);
}

function extractCharacterId(input: string): string | null {
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const match = input.match(uuidPattern);
  return match ? match[0] : null;
}

/**
 * Clears any `syncActiveTokens` marks left on actors by a session that crashed
 * mid-sync, so they don't permanently block pushes for those characters.
 */
async function recoverStaleSyncPauses(): Promise<void> {
  for (const actor of game.actors.contents) {
    const tokens = actor.getFlag(MODULE_ID, "syncActiveTokens") as string[] | undefined;
    if (Array.isArray(tokens) && tokens.length > 0) {
      await clearSyncPause(actor);
    }
  }
}

async function importLinkedCharacter(
  actor: Actor,
  characterId: string,
  token: string,
  options: { wipe?: boolean } = {}
) {
  resetImportIssues(actor);
  exportManager.suspend(characterId);
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

    const summary = await importOrchestrator.importCharacter(actor, characterId, { token });
    setUnmappedSlugs(actor, summary.unmapped);
    for (const error of summary.errors) addImportIssue(actor, error);
    return summary;
  } finally {
    await endSyncPause(actor);
    exportManager.resume(characterId);
  }
}

async function exportLinkedCharacter(actor: Actor) {
  // Pause other clients' pushes for the duration of our push so we don't race a
  // concurrent import/push into an optimistic-concurrency conflict.
  await beginSyncPause(actor);
  try {
    queueCombatResourceChanges(exportManager, actor);
    queueAllItemChanges(exportManager, actor);
    const result = await exportManager.flush(actor);
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
async function reimportActorOnConflict(actor: Actor) {
  const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
  const token = game.settings.get(MODULE_ID, "demiplaneToken") as string | undefined;
  if (!characterId || !token) {
    ui.notifications.warn(`Unable to re-import "${actor.name}": missing character link or token.`);
    return;
  }
  const summary = await importLinkedCharacter(actor, characterId, token, { wipe: true });
  ui.notifications.info(`Re-imported "${actor.name}" from Demiplane — ${summary.itemsImported} items.`);
}
// Add "Update from Demiplane" to actor right-click context menu
// Parameter types are inferred from the hook registry: v14 passes the directory
// application (not its markup) plus the mutable context menu entries.
Hooks.on("getActorContextOptions", (_directory, menuItems) => {
  menuItems.push({
    label: "Update from Demiplane",
    icon: `<i class="fas fa-sync"></i>`,
    visible: (li) => {
      const actor = game.actors.get(li.dataset.entryId ?? "", { strict: false });
      if (!actor?.getFlag(MODULE_ID, "characterId")) return false;
      const user = game.user;
      if (!user) return false;
      // Only GMs (including Assistant GMs) or users with OWNER permission on the actor.
      return user.isGM || actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
    },
    // `onClick` receives (event, target) — the reverse of the deprecated `callback`.
    onClick: async (_event, li) => {
      const actor = game.actors.get(li.dataset.entryId ?? "");
      const characterId = actor?.getFlag(MODULE_ID, "characterId");
      if (!actor || !characterId) return;

      const token = game.settings.get(MODULE_ID, "demiplaneToken");
      if (!token) {
        ui.notifications.error("No Demiplane token configured.");
        return;
      }

      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Update from Demiplane" },
        content: `<p>This will delete all imported items on <strong>${actor.name}</strong> and re-import from Demiplane.</p><p>Manually added items will be preserved.</p>`,
      });
      if (!confirmed) return;

      ui.notifications.info(`Updating ${actor.name} from Demiplane...`);

      const summary = await importLinkedCharacter(actor, characterId, token, { wipe: true });
      if (summary.errors.length > 0) {
        ui.notifications.error(`Update errors: ${summary.errors.join("; ")}`);
      } else {
        ui.notifications.info(`Updated "${actor.name}" — ${summary.itemsImported} items.`);
      }
    },
  });
});
