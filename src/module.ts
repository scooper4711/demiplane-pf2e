import { MODULE_ID } from "./import/types.js";
import { DemiplaneClient } from "@scooper4711/demiplane-api";
import { registerSettings } from "./settings.js";
import { ImportOrchestrator } from "./import/index.js";
import { ExportManager } from "./export-manager.js";
import { HookManager, queueCombatResourceChanges } from "./hook-manager.js";
import { SyncTabRenderer } from "./sync-tab-renderer.js";
import { CharacterLinkDialog } from "./character-link-dialog.js";
import { registerDemiplaneInfoButton } from "./demiplane-info-button.js";

let client: DemiplaneClient;
let importOrchestrator: ImportOrchestrator;
let exportManager: ExportManager;
let hookManager: HookManager;

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Demiplane PF2e Sync`);
  registerSettings();
  SyncTabRenderer.registerSettingsHook();
});

Hooks.once("ready", async () => {
  console.log(`${MODULE_ID} | Ready`);

  await showPreReleaseWarning();

  client = new DemiplaneClient();
  const storedToken = game.settings.get(MODULE_ID, "demiplaneToken") as string;
  if (storedToken) {
    client.setToken(storedToken);
  }

  importOrchestrator = new ImportOrchestrator();
  exportManager = new ExportManager(client);
  hookManager = new HookManager(exportManager);
  void new SyncTabRenderer();
  void new CharacterLinkDialog(client);

  hookManager.register();
  registerDemiplaneInfoButton(importLinkedCharacter, exportLinkedCharacter);

  // Keep the client token in sync when the setting changes
  Hooks.on("updateSetting", (setting: { key: string }) => {
    if (setting.key === `${MODULE_ID}.demiplaneToken`) {
      const newToken = game.settings.get(MODULE_ID, "demiplaneToken") as string;
      if (newToken) {
        client.setToken(newToken);
      }
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
    // DialogV2 wraps `content` in its own <form>, so only the fields are supplied
    // here and the submitted values come back already parsed.
    const result = await foundry.applications.api.DialogV2.input({
      window: { title: "Import Demiplane Character" },
      content: `<div class="form-group"><label>Demiplane Character UUID or URL</label>
<input type="text" name="characterRef" placeholder="UUID or https://app.demiplane.com/nexus/pathfinder2e/character-sheet/..." autofocus /></div>` as foundry.applications.api.DialogV2.Content<{
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

async function importLinkedCharacter(actor: Actor, characterId: string, token: string) {
  exportManager.suspend();
  try {
    return await importOrchestrator.importCharacter(actor, characterId, { token });
  } finally {
    exportManager.resume();
  }
}

async function exportLinkedCharacter(actor: Actor) {
  queueCombatResourceChanges(exportManager, actor);
  const dryRun = game.settings.get(MODULE_ID, "dryRun");
  const result = await exportManager.flush(actor, { dryRun });
  if (dryRun) {
    const count = result.preview?.length ?? 0;
    ui.notifications.info(`Dry run: would push ${String(count)} field(s) to Demiplane.`);
    return result;
  }
  if (result.success) {
    ui.notifications.info(`Pushed HP and hero points for "${actor.name}" to Demiplane.`);
  }
  return result;
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
      return !!actor?.getFlag(MODULE_ID, "characterId");
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

      const importedItems = actor.items.filter((item) => {
        const moduleFlags = item.flags?.[MODULE_ID] as Record<string, unknown> | undefined;
        return moduleFlags !== undefined;
      });
      if (importedItems.length > 0) {
        await actor.deleteEmbeddedDocuments(
          "Item",
          importedItems.map((item) => item.id)
        );
        console.warn(`${MODULE_ID} | [update] Deleted ${importedItems.length} previously imported items`);
      }

      const remainingItems = actor.items.filter(() => true);
      if (remainingItems.length > 0) {
        console.warn(
          `${MODULE_ID} | [update] ${remainingItems.length} items remain on actor after delete:`,
          remainingItems.map((item) => `${item.name} (type=${item.type}, id=${item.id})`).join(", ")
        );
      } else {
        console.warn(`${MODULE_ID} | [update] Actor is clean — all items deleted`);
      }

      const summary = await importLinkedCharacter(actor, characterId, token);
      if (summary.errors.length > 0) {
        ui.notifications.error(`Update errors: ${summary.errors.join("; ")}`);
      } else {
        ui.notifications.info(`Updated "${actor.name}" — ${summary.itemsImported} items.`);
      }
    },
  });
});
