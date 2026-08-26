import { MODULE_ID } from "./import/types.js";
import type { ImportOrchestrator } from "./import/index.js";

const DEMIPLANE_SHEET_BASE = "https://app.demiplane.com/nexus/pathfinder2e/character-sheet";
const KOFI_URL = "https://ko-fi.com/coop207627";

/**
 * Registers a header button on linked actor sheets that opens
 * a Demiplane info dialog with sync actions and useful links.
 */
export function registerDemiplaneInfoButton(importOrchestrator: ImportOrchestrator): void {
  Hooks.on("getActorSheetHeaderButtons", (sheet: ActorSheet, buttons: Application.HeaderButton[]) => {
    const actor = sheet.actor;
    const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
    if (!characterId) return;

    buttons.unshift({
      label: "Demiplane",
      class: "demiplane-info-btn",
      icon: "fa-solid fa-link",
      tooltip: "Linked to Demiplane",
      onclick: () => showDemiplaneInfoDialog(actor, characterId, importOrchestrator),
    });
  });
}

async function showDemiplaneInfoDialog(
  actor: Actor,
  characterId: string,
  importOrchestrator: ImportOrchestrator
): Promise<void> {
  const sheetUrl = `${DEMIPLANE_SHEET_BASE}/${characterId}`;
  const lastImport = actor.getFlag(MODULE_ID, "lastImportTimestamp") as number | undefined;
  const lastExport = actor.getFlag(MODULE_ID, "lastExportTimestamp") as number | undefined;
  const lastImportDisplay = lastImport ? new Date(lastImport).toLocaleString() : "Never";
  const lastExportDisplay = lastExport ? new Date(lastExport).toLocaleString() : "Never";

  const manualItems = actor.items.filter((item) => {
    return item.getFlag(MODULE_ID, "imported") !== true;
  });
  const manualItemsSection = buildManualItemsSection(manualItems);

  const content = `
    <div class="demiplane-info-dialog">
      <section>
        <p><strong>Last import from Demiplane:</strong> ${lastImportDisplay}</p>
        <p><strong>Last push to Demiplane:</strong> ${lastExportDisplay}</p>
        <p><a href="${sheetUrl}" target="_blank" rel="noopener">Open sheet on Demiplane ↗</a></p>
      </section>
      ${manualItemsSection}
      <hr>
      <section>
        <p>Does this module save you time at the table?</p>
        <p>
          <a href="${KOFI_URL}" target="_blank" rel="noopener">
            <i class="fa-solid fa-mug-hot"></i> Support me on Ko-fi
          </a>
        </p>
      </section>
    </div>`;

  await foundry.applications.api.DialogV2.confirm({
    window: { title: `Demiplane — ${actor.name}` },
    content,
    yes: {
      label: "Update from Demiplane",
      icon: "fa-solid fa-sync",
      callback: () => performUpdate(actor, characterId, importOrchestrator),
    },
    no: { label: "Close" },
  });
}

function buildManualItemsSection(items: Item[]): string {
  if (items.length === 0) return "";

  const itemList = items.map((item) => `<li>${item.name} <span class="type-tag">(${item.type})</span></li>`).join("\n");

  return `
      <hr>
      <section>
        <p><strong>Items not from Demiplane</strong> (${String(items.length)}):</p>
        <ul class="demiplane-manual-items">${itemList}</ul>
        <p class="hint">These items are preserved during sync.</p>
      </section>`;
}

async function performUpdate(actor: Actor, characterId: string, importOrchestrator: ImportOrchestrator): Promise<void> {
  const token = game.settings.get(MODULE_ID, "demiplaneToken") as string;
  if (!token) {
    ui.notifications.error("No Demiplane token configured. Ask your GM to set it in module settings.");
    return;
  }

  ui.notifications.info(`Updating ${actor.name} from Demiplane...`);

  const importedItems = actor.items.filter((item) => item.getFlag(MODULE_ID, "imported") === true);
  if (importedItems.length > 0) {
    await actor.deleteEmbeddedDocuments(
      "Item",
      importedItems.map((item) => item.id)
    );
  }

  const summary = await importOrchestrator.importCharacter(actor, characterId, { token });
  if (summary.errors.length > 0) {
    ui.notifications.error(`Update errors: ${summary.errors.join("; ")}`);
  } else {
    ui.notifications.info(`Updated "${actor.name}" — ${summary.itemsImported} items.`);
  }
}
