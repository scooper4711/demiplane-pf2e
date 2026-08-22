import { MODULE_ID } from "./import/types.js";
import { DemiplaneClient } from "@scooper4711/demiplane-api";
import { registerSettings } from "./settings.js";
import { ImportOrchestrator } from "./import/index.js";
import { ExportManager } from "./export-manager.js";
import { ConflictResolver } from "./conflict-resolver.js";
import { HookManager } from "./hook-manager.js";
import { SyncTabRenderer } from "./sync-tab-renderer.js";
import { CharacterLinkDialog } from "./character-link-dialog.js";

let client: DemiplaneClient;
let importOrchestrator: ImportOrchestrator;
let exportManager: ExportManager;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- scaffolding for export
let conflictResolver: ConflictResolver;
let hookManager: HookManager;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- scaffolding for sync tab
let syncTabRenderer: SyncTabRenderer;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- scaffolding for link dialog
let characterLinkDialog: CharacterLinkDialog;

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Demiplane PF2e Sync`);
  registerSettings();
  SyncTabRenderer.registerSettingsHook();
});

Hooks.once("ready", async () => {
  console.log(`${MODULE_ID} | Ready`);

  await showPreReleaseWarning();

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
        const token = options?.token || (game.settings.get(MODULE_ID, "demiplaneToken") as string);
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

// Add "Import Demiplane Character" button to the Actors sidebar
Hooks.on("renderActorDirectory", (_app: unknown, html: HTMLElement) => {
  const actionButtons = html.querySelector(".action-buttons");
  if (!actionButtons || actionButtons.querySelector(".demiplane-import-btn")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "demiplane-import-btn";
  button.innerHTML = `<i class="fa-solid fa-download" inert></i><span>Import Demiplane Character</span>`;

  button.addEventListener("click", async () => {
    const input = await Dialog.prompt({
      title: "Import Demiplane Character",
      content: `<form><div class="form-group"><label>Demiplane Character UUID or URL</label>
<input type="text" name="characterRef" placeholder="UUID or https://app.demiplane.com/nexus/pathfinder2e/character-sheet/..." autofocus /></div></form>`,
      label: "Import",
      callback: (html: HTMLElement | JQuery) => {
        const el = html instanceof HTMLElement ? html : (html as JQuery)[0];
        return (el.querySelector("[name=characterRef]") as HTMLInputElement)?.value ?? "";
      },
      rejectClose: false,
    });

    if (!input) return;

    const characterId = extractCharacterId(input.trim());
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
    const summary = await importOrchestrator.importCharacter(actor, characterId, { token });

    if (summary.errors.length > 0) {
      ui.notifications?.error(`Import errors: ${summary.errors.join("; ")}`);
    } else {
      ui.notifications?.info(`Imported "${actor.name}" — ${summary.itemsImported} items.`);
    }
  });

  actionButtons.appendChild(button);
});

function showPreReleaseWarning(): Promise<void> {
  return new Promise((resolve) => {
    new Dialog({
      title: "Demiplane PF2e Sync — Pre-Release Warning",
      content: `
        <p><strong>This module is pre-release software and should only be used for testing.</strong></p>
        <p>Using this module can result in data loss for the Foundry Actor, the Demiplane character, or both.</p>
        <p>Please ensure you have backups before proceeding.</p>
      `,
      buttons: {
        ok: {
          icon: `<i class="fas fa-check"></i>`,
          label: "I Understand",
          callback: () => resolve(),
        },
      },
      close: () => resolve(),
      default: "ok",
    }).render(true);
  });
}

function extractCharacterId(input: string): string | null {
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const match = input.match(uuidPattern);
  return match ? match[0] : null;
}
// Add "Update from Demiplane" to actor right-click context menu
Hooks.on(
  "getActorContextOptions",
  (
    _html: HTMLElement,
    options: Array<{
      name: string;
      icon: string;
      condition: (li: HTMLElement) => boolean;
      callback: (li: HTMLElement) => Promise<void>;
    }>
  ) => {
    options.push({
      name: "Update from Demiplane",
      icon: `<i class="fas fa-sync"></i>`,
      condition: (li: HTMLElement) => {
        const a = game.actors?.get(li.dataset.entryId ?? "", { strict: false });
        return !!a?.getFlag(MODULE_ID, "characterId");
      },
      callback: async (li: HTMLElement) => {
        const actor = game.actors?.get(li.dataset.entryId ?? "");
        if (!actor) return;

        const characterId = actor.getFlag(MODULE_ID, "characterId") as string;
        const token = game.settings.get(MODULE_ID, "demiplaneToken") as string;
        if (!token) {
          ui.notifications?.error("No Demiplane token configured.");
          return;
        }

        const confirmed = await Dialog.confirm({
          title: "Update from Demiplane",
          content: `<p>This will delete all imported items on <strong>${actor.name}</strong> and re-import from Demiplane.</p><p>Manually added items will be preserved.</p>`,
        });
        if (!confirmed) return;

        ui.notifications?.info(`Updating ${actor.name} from Demiplane...`);

        const importedItems = actor.items.filter(
          (i: { flags: Record<string, Record<string, unknown>> }) => i.flags?.[MODULE_ID]?.imported
        );
        if (importedItems.length > 0) {
          await actor.deleteEmbeddedDocuments(
            "Item",
            importedItems.map((i: { id: string }) => i.id)
          );
        }

        const summary = await importOrchestrator.importCharacter(actor, characterId, { token });
        if (summary.errors.length > 0) {
          ui.notifications?.error(`Update errors: ${summary.errors.join("; ")}`);
        } else {
          ui.notifications?.info(`Updated "${actor.name}" — ${summary.itemsImported} items.`);
        }
      },
    });
  }
);
