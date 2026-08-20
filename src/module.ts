import { DemiplaneClient } from "@scooper4711/demiplane-api";
import { registerSettings } from "./settings.js";
import { ImportOrchestrator } from "./import/index.js";
import { ExportManager } from "./export-manager.js";
import { ConflictResolver } from "./conflict-resolver.js";
import { HookManager } from "./hook-manager.js";
import { SyncTabRenderer } from "./sync-tab-renderer.js";
import { CharacterLinkDialog } from "./character-link-dialog.js";

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
  importOrchestrator = new ImportOrchestrator();
  exportManager = new ExportManager(client);
  conflictResolver = new ConflictResolver(client);
  hookManager = new HookManager(exportManager);
  syncTabRenderer = new SyncTabRenderer();
  characterLinkDialog = new CharacterLinkDialog(client);

  hookManager.register();

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
        const token = options?.token || game.settings.get(MODULE_ID, "demiplaneToken") as string;
        if (!token) {
          ui.notifications.error("No Demiplane token configured. Set it in module settings.");
          return null;
        }
        const summary = await importOrchestrator.importCharacter(actor, characterId, { token });
        return summary;
      },
      getOrchestrator: () => importOrchestrator,
      getClient: () => client,
    };
  }

  console.log(`${MODULE_ID} | API registered`);
});
