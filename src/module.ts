import { MODULE_ID } from "./import/types.js";
import { debugLog } from "./import/debug-log.js";
import { DemiplaneClient } from "@scooper4711/demiplane-api";
import { registerSettings } from "./settings.js";
import { ImportOrchestrator } from "./import/index.js";
import { ExportManager } from "./export-manager.js";
import { HookManager } from "./hook-manager.js";
import { CharacterLinkDialog } from "./character-link-dialog.js";
import { registerDemiplaneInfoButton } from "./demiplane-info-button.js";
import { registerTitlebarDot } from "./titlebar-dot.js";
import { registerDirectoryIcon } from "./directory-icon.js";
import { registerDemiplaneMappingTemplates, registerMappingSyncHook } from "./demiplane-mapping-app.js";
import { reconcileDuplicateLink } from "./actor-link.js";
import {
  exportLinkedCharacter,
  importLinkedCharacter,
  recoverStaleSyncPauses,
  reimportActorOnConflict,
} from "./sync-flows.js";
import type { ExportCharacterFn, ImportCharacterFn, SyncFlowDeps } from "./sync-flows.js";
import { buildUpdateFromDemiplaneOption } from "./actor-context-menu.js";
import { canImportCharacters, onImportButtonClick } from "./directory-import.js";
import { registerModuleApi } from "./module-api.js";

let client: DemiplaneClient;
let importOrchestrator: ImportOrchestrator;
let exportManager: ExportManager;
let hookManager: HookManager;

// Bound flow functions. They read the singletons at call time (hooks fire
// after `initializeModule` assigns them), so registration order doesn't matter.
const importFn: ImportCharacterFn = (actor, characterId, token, options) =>
  importLinkedCharacter(actor, characterId, token, flowDeps(), options);
const exportFn: ExportCharacterFn = (actor) => exportLinkedCharacter(actor, flowDeps());

function flowDeps(): SyncFlowDeps {
  return { exportManager, importOrchestrator };
}

Hooks.once("init", () => {
  registerDemiplaneMappingTemplates();
  debugLog(`Initializing Demiplane PF2e Sync`);
  registerSettings();
});

Hooks.once("ready", async () => {
  await initializeModule();
});

async function initializeModule(): Promise<void> {
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

  importOrchestrator = new ImportOrchestrator(client);
  exportManager = new ExportManager(client);
  exportManager.setOnConflictHandler((actor) => reimportActorOnConflict(actor, flowDeps()));
  hookManager = new HookManager(exportManager);
  new CharacterLinkDialog(client);

  hookManager.register();
  registerDuplicateLinkGuard();
  registerDemiplaneInfoButton(importFn, exportFn);
  registerTitlebarDot();
  registerDirectoryIcon(importFn, exportFn);

  // Recover from a previous session that crashed mid-sync, which would otherwise
  // leave a stale sync mark blocking all pushes for the affected character.
  recoverStaleSyncPauses();

  registerTokenSyncHooks();
  registerMappingSyncHook();
  registerModuleApi(importFn, exportFn);

  debugLog(`API registered`);
}

/**
 * Keeps the client token in sync when the setting changes, and re-shows the
 * pre-release warning whenever auto-sync is switched on.
 */
/**
 * Backstop for the duplicate-link problem: native Foundry operations (JSON
 * import, Duplicate, copy/paste, compendium import, backup restore) copy the
 * `characterId` flag onto a second actor without running the module's link code.
 * These hooks detect that and unlink the arriving copy so two actors never push
 * to the same Demiplane character. createActor/updateActor fire on the GM
 * client, so the repair runs once, there.
 */
function registerDuplicateLinkGuard(): void {
  Hooks.on("createActor", ((actor: Actor) => {
    void reconcileDuplicateLink(actor);
  }) as (...args: unknown[]) => void);
  Hooks.on("updateActor", ((actor: Actor, changes: Record<string, unknown>) => {
    // Only react when the module's flags were part of the update, so we don't
    // scan on every unrelated actor edit.
    const flags = changes.flags as Record<string, unknown> | undefined;
    if (!flags || !(MODULE_ID in flags)) return;
    void reconcileDuplicateLink(actor);
  }) as (...args: unknown[]) => void);
}

function registerTokenSyncHooks(): void {
  Hooks.on("updateSetting", ((setting: { key: string }) => {
    if (setting.key === `${MODULE_ID}.demiplaneToken`) {
      const newToken = game.settings.get(MODULE_ID, "demiplaneToken") as string;
      if (newToken) {
        client.setToken(newToken);
      }
    }

    // The pre-release warning is tied to the write feature (auto-sync). Show it
    // whenever auto-sync is switched on so users are re-warned before writing.
    if (setting.key === `${MODULE_ID}.autoSync` && game.settings.get(MODULE_ID, "autoSync")) {
      showPreReleaseWarning();
    }
  }) as (...args: unknown[]) => void);
}

// Add "Import Demiplane Character" button to the Actors sidebar
Hooks.on("renderActorDirectory", (_app: unknown, html: HTMLElement) => {
  const actionButtons = html.querySelector(".action-buttons");
  if (!actionButtons || actionButtons.querySelector(".demiplane-import-btn")) return;

  // Only GMs (including Assistant GMs) or users able to create actors may import.
  if (!canImportCharacters(game.user)) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "demiplane-import-btn";
  button.innerHTML = `<i class="fa-solid fa-download" inert></i><span>Import Demiplane Character</span>`;

  button.addEventListener("click", () => void onImportButtonClick(importFn));

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

// Add "Update from Demiplane" to actor right-click context menu
// Parameter types are inferred from the hook registry: v14 passes the directory
// application (not its markup) plus the mutable context menu entries.
Hooks.on("getActorContextOptions", ((_directory: unknown, menuItems: unknown) => {
  if (!Array.isArray(menuItems)) return;
  menuItems.push(buildUpdateFromDemiplaneOption(importFn));
}) as (...args: unknown[]) => void);
