import { DemiplaneClient } from "@scooper4711/demiplane-api";
import { registerSettings } from "./settings.js";
import { SlugMapper } from "./slug-mapper.js";
import { ImportOrchestrator } from "./import-orchestrator.js";
import { ExportManager } from "./export-manager.js";
import { ConflictResolver } from "./conflict-resolver.js";
import { HookManager } from "./hook-manager.js";
import { SyncTabRenderer } from "./sync-tab-renderer.js";
import { CharacterLinkDialog } from "./character-link-dialog.js";
import type { SyncTabData } from "./sync-tab-renderer.js";

const MODULE_ID = "foundry-demiplane-pf2e";

let client: DemiplaneClient;
let importOrchestrator: ImportOrchestrator;
let exportManager: ExportManager;
let conflictResolver: ConflictResolver;
let hookManager: HookManager;
let syncTabRenderer: SyncTabRenderer;
let characterLinkDialog: CharacterLinkDialog;

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Demiplane PF2e Sync`);
  registerSettings();
  SyncTabRenderer.registerSettingsHook();
});

Hooks.once("ready", async () => {
  console.log(`${MODULE_ID} | Ready`);

  client = new DemiplaneClient();
  const slugMapper = new SlugMapper();

  const email = game.settings.get(MODULE_ID, "demiplaneEmail") as string;
  const password = game.settings.get(MODULE_ID, "demiplanePassword") as string;

  if (email && password) {
    try {
      await client.authenticate(email, password);
      console.log(`${MODULE_ID} | Authenticated with Demiplane`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${MODULE_ID} | Authentication failed: ${message}`);
      ui.notifications.warn(
        `Demiplane authentication failed: ${message}. Public characters are still accessible.`,
      );
    }
  }

  exportManager = new ExportManager(client);
  conflictResolver = new ConflictResolver(client);
  importOrchestrator = new ImportOrchestrator(client, slugMapper);
  hookManager = new HookManager(exportManager);
  syncTabRenderer = new SyncTabRenderer();
  characterLinkDialog = new CharacterLinkDialog(client);

  hookManager.register();

  Hooks.on("renderActorSheet", onRenderActorSheet);
});

function onRenderActorSheet(sheet: ActorSheet, html: JQuery): void {
  const actor = sheet.actor;
  if (!syncTabRenderer.shouldRender(actor)) return;

  const characterId = actor.getFlag(MODULE_ID, "characterId") as string;
  const dryRun = game.settings.get(MODULE_ID, "dryRun") as boolean;

  const data: SyncTabData = {
    characterId,
    lastSyncTimestamp: actor.getFlag(MODULE_ID, "lastSyncTimestamp") as
      | number
      | undefined,
    lastKnownVersion: actor.getFlag(MODULE_ID, "lastKnownVersion") as
      | number
      | undefined,
    remoteVersion: undefined,
    pendingChanges: exportManager.getPendingChanges(characterId),
    unresolvedSlugs:
      (actor.getFlag(MODULE_ID, "unresolvedSlugs") as
        | SyncTabData["unresolvedSlugs"]
        | undefined) ?? [],
    lastImportSummary: actor.getFlag(MODULE_ID, "lastImportSummary") as
      | SyncTabData["lastImportSummary"]
      | undefined,
    conflictDetected: false,
    localVersion: actor.getFlag(MODULE_ID, "lastKnownVersion") as
      | number
      | undefined,
    remoteConflictVersion: undefined,
    dryRunEnabled: dryRun,
    operationInProgress: false,
  };

  syncTabRenderer.renderTab(sheet, html, data);

  sheet.element.on("demiplane-import", () => {
    void handleImport(actor, characterId, dryRun);
  });

  sheet.element.on("demiplane-push", () => {
    void handlePush(actor, dryRun);
  });

  sheet.element.on(
    "demiplane-conflict-resolve",
    (_event: unknown, resolution: string) => {
      void handleConflictResolution(
        actor,
        resolution as "reimport" | "force-push" | "cancel",
      );
    },
  );
}

async function handleImport(
  actor: Actor,
  characterId: string,
  dryRun: boolean,
): Promise<void> {
  syncTabRenderer.setOperationInProgress(true);
  try {
    const summary = await importOrchestrator.importCharacter(
      actor,
      characterId,
      { dryRun },
    );
    await actor.setFlag(MODULE_ID, "lastImportSummary", summary);

    if (summary.errors.length > 0) {
      ui.notifications.warn(
        `Import completed with ${String(summary.errors.length)} error(s).`,
      );
    } else {
      const label = dryRun ? "Preview" : "Import";
      ui.notifications.info(
        `${label} complete: ${String(summary.itemsImported)} items.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.notifications.error(`Import failed: ${message}`);
  } finally {
    syncTabRenderer.setOperationInProgress(false);
  }
}

async function handlePush(actor: Actor, dryRun: boolean): Promise<void> {
  syncTabRenderer.setOperationInProgress(true);
  try {
    const result = await exportManager.flush(actor, { dryRun });
    if (result.success) {
      if (dryRun && result.preview) {
        ui.notifications.info(
          `Preview: ${String(result.preview.length)} changes would be pushed.`,
        );
      } else {
        ui.notifications.info("Changes pushed to Demiplane.");
      }
    } else if (result.error) {
      ui.notifications.error(`Push failed: ${result.error}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.notifications.error(`Push failed: ${message}`);
  } finally {
    syncTabRenderer.setOperationInProgress(false);
  }
}

async function handleConflictResolution(
  actor: Actor,
  resolution: "reimport" | "force-push" | "cancel",
): Promise<void> {
  const characterId = actor.getFlag(MODULE_ID, "characterId") as string;
  if (!characterId) return;

  const localSessionState = new Map<string, number>();
  for (const change of exportManager.getPendingChanges(characterId)) {
    localSessionState.set(change.field, change.value);
  }

  let localEngines: import("@scooper4711/demiplane-api").CharacterEngine[] = [];
  try {
    const data = await client.fetchCharacterData(characterId);
    localEngines = data.engines;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.notifications.error(`Conflict resolution failed: ${message}`);
    return;
  }

  const result = await conflictResolver.resolveConflict(
    actor,
    resolution,
    localEngines,
    localSessionState,
  );

  if (result.success) {
    ui.notifications.info(`Conflict resolved via ${resolution}.`);
  } else {
    ui.notifications.error(
      `Conflict resolution failed: ${result.error ?? "Unknown error"}`,
    );
  }
}

export function getCharacterLinkDialog(): CharacterLinkDialog {
  return characterLinkDialog;
}
