import { MODULE_ID, formatUnmapped } from "./import/types.js";
import type { ImportSummary } from "./import/types.js";
import { getExportIssues, getImportIssues, getUnmappedSlugs, clearAllIssues } from "./sync-issues.js";
import { DEMIPLANE_SHEET_BASE, KOFI_URL } from "./config.js";

type ImportCharacterFn = (
  actor: Actor,
  characterId: string,
  token: string,
  options?: { wipe?: boolean }
) => Promise<ImportSummary>;
type ExportCharacterFn = (actor: Actor) => Promise<unknown>;

/**
 * Registers a header button on linked actor sheets that opens
 * a Demiplane info dialog with sync actions and useful links.
 */
export function registerDemiplaneInfoButton(
  importCharacter: ImportCharacterFn,
  exportCharacter: ExportCharacterFn
): void {
  Hooks.on("getActorSheetHeaderButtons", (sheet: ActorSheet, buttons: Application.HeaderButton[]) => {
    const actor = sheet.actor;
    const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
    if (!characterId) return;

    const user = game.user;
    if (!user || !(user.isGM || actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER))) return;

    buttons.unshift({
      label: "Demiplane",
      class: "demiplane-info-btn",
      icon: "fa-solid fa-link",
      tooltip: "Linked to Demiplane",
      onclick: () => showDemiplaneInfoDialog(actor, characterId, importCharacter, exportCharacter),
    });
  });
}

export async function showDemiplaneInfoDialog(
  actor: Actor,
  characterId: string,
  importCharacter: ImportCharacterFn,
  exportCharacter: ExportCharacterFn
): Promise<void> {
  const sheetUrl = `${DEMIPLANE_SHEET_BASE}/${characterId}`;
  const lastImport = actor.getFlag(MODULE_ID, "lastImportTimestamp") as number | undefined;
  const lastExport = actor.getFlag(MODULE_ID, "lastExportTimestamp") as number | undefined;
  const lastImportDisplay = lastImport ? new Date(lastImport).toLocaleString() : "Never";
  const lastExportDisplay = lastExport ? new Date(lastExport).toLocaleString() : "Never";

  // Unmapped slugs are stored as structured records; their display text is
  // derived here rather than persisted, so there is only ever one source of truth.
  const importIssues = [...getUnmappedSlugs(actor).map(formatUnmapped), ...getImportIssues(actor)];
  const exportIssues = [...getExportIssues(actor)];
  const hasIssues = importIssues.length + exportIssues.length > 0;
  const issuesSection = buildIssuesSection(importIssues, exportIssues);

  const manualItems = actor.items.filter((item) => {
    const moduleFlags = item.flags?.[MODULE_ID] as Record<string, unknown> | undefined;
    return moduleFlags === undefined;
  });
  const manualItemsSection = buildManualItemsSection(manualItems);

  const content = buildDialogContent({
    sheetUrl,
    lastImportDisplay,
    lastExportDisplay,
    issuesSection,
    manualItemsSection,
  });

  await foundry.applications.api.DialogV2.wait({
    window: { title: `Demiplane — ${actor.name}` },
    classes: hasIssues ? ["demiplane-sync-dialog", "has-sync-errors"] : ["demiplane-sync-dialog"],
    content,
    buttons: buildDialogButtons(actor, characterId, importCharacter, exportCharacter, hasIssues),
  });
}

function buildDialogButtons(
  actor: Actor,
  characterId: string,
  importCharacter: ImportCharacterFn,
  exportCharacter: ExportCharacterFn,
  hasIssues: boolean
): Array<foundry.applications.api.DialogV2.Button> {
  return [
    {
      action: "update",
      label: "Update from Demiplane",
      icon: "fa-solid fa-sync",
      callback: () => performUpdate(actor, characterId, importCharacter),
    },
    {
      action: "push",
      label: "Push to Demiplane",
      icon: "fa-solid fa-upload",
      callback: () => exportCharacter(actor),
    },
    {
      // Deliberately not "close": DialogV2 treats that action as a plain
      // dismissal and never invokes the callback, so the issues stayed set.
      action: "dismiss",
      label: hasIssues ? "Dismiss" : "Close",
      default: true,
      callback: () => {
        if (hasIssues) clearAllIssues(actor);
      },
    },
  ];
}

interface DialogContentOptions {
  sheetUrl: string;
  lastImportDisplay: string;
  lastExportDisplay: string;
  issuesSection: string;
  manualItemsSection: string;
}

function buildDialogContent(opts: DialogContentOptions): string {
  return `
    <div class="demiplane-info-dialog">
      <section>
        <p><strong>Last import from Demiplane:</strong> ${opts.lastImportDisplay}</p>
        <p><strong>Last push to Demiplane:</strong> ${opts.lastExportDisplay}</p>
        <p><a href="${opts.sheetUrl}" target="_blank" rel="noopener">Open sheet on Demiplane ↗</a></p>
      </section>
      ${opts.issuesSection}
      ${opts.manualItemsSection}
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
}

function buildIssuesSection(importIssues: string[], exportIssues: string[]): string {
  if (importIssues.length === 0 && exportIssues.length === 0) return "";
  const rows = [
    ...importIssues.map((m) => ({ kind: "Import", message: m })),
    ...exportIssues.map((m) => ({ kind: "Export", message: m })),
  ];
  const list = rows.map((r) => `<li><span class="kind-tag">${r.kind}</span> ${escapeHtml(r.message)}</li>`).join("\n");
  return `
    <hr>
    <section>
      <p><strong class="sync-issues-heading">Sync issues</strong> (${String(rows.length)}):</p>
      <ul class="demiplane-sync-issues">${list}</ul>
      <p class="hint">The red indicator clears once you dismiss this dialog. Foundry-only items are listed below.</p>
    </section>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

async function performUpdate(actor: Actor, characterId: string, importCharacter: ImportCharacterFn): Promise<void> {
  const token = game.settings.get(MODULE_ID, "demiplaneToken") as string;
  if (!token) {
    ui.notifications.error("No Demiplane token configured. Ask your GM to set it in module settings.");
    return;
  }

  ui.notifications.info(`Updating ${actor.name} from Demiplane...`);

  const summary = await importCharacter(actor, characterId, token, { wipe: true });
  if (summary.errors.length > 0) {
    ui.notifications.error(`Update errors: ${summary.errors.join("; ")}`);
  } else {
    ui.notifications.info(`Updated "${actor.name}" — ${summary.itemsImported} items.`);
  }
}
