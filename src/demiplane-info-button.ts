import type { DialogV2Button } from "@client/applications/api/dialog.mjs";
import { MODULE_ID, formatUnmapped } from "./import/types.js";
import type { ImportSummary } from "./import/types.js";
import { canWriteText } from "./write-level.js";
import {
  getExportIssues,
  getImportIssues,
  getUnmappedSlugs,
  acknowledgeIssues,
  shouldShowIndicator,
} from "./sync-issues.js";
import { getDemiplaneMappingAppClass } from "./demiplane-mapping-app.js";
import {
  getSanctification,
  setSanctificationSelection,
  isSanctification,
  type Sanctification,
} from "./sanctification.js";
import { DEMIPLANE_SHEET_BASE, KOFI_URL } from "./config.js";

/** Human-readable labels for the sanctification select options. */
const SANCTIFICATION_LABELS: Record<Sanctification, string> = {
  holy: "Holy",
  unholy: "Unholy",
  none: "None",
};

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
  Hooks.on("getActorSheetHeaderButtons", ((sheet: ActorSheet, buttons: Application.HeaderButton[]) => {
    const actor = sheet.actor;
    const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
    if (!characterId) return;

    const user = game.user;
    if (!user || !(user.isGM || actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER))) return;

    buttons.unshift({
      label: "Demiplane",
      class: "demiplane-info-btn",
      // The Demiplane logo is drawn by CSS as a `::before` on `.demiplane-info-btn`
      // (blue, or red when `titlebar-dot.ts` adds `has-sync-errors`). No Font
      // Awesome glyph, so the icon field is left empty.
      icon: "",
      tooltip: "Linked to Demiplane",
      onclick: () => showDemiplaneInfoDialog(actor, characterId, importCharacter, exportCharacter),
    });
  }) as (...args: unknown[]) => void);
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

  // Sync issues are genuine failures the user can't fix themselves (invalid
  // token, rate limits, failed pushes). Unmapped items are Demiplane names that
  // didn't resolve to a compendium item — routine and fixable via the mapping
  // editor — so they are shown separately and never flagged as an error.
  const syncIssues = [...getImportIssues(actor), ...getExportIssues(actor)];
  const unmappedItems = getUnmappedSlugs(actor).map(formatUnmapped);
  // The dot reflects unacknowledged issues; the sections render whenever the
  // data exists, so a second open still shows everything.
  const indicatorActive = shouldShowIndicator(actor);

  const syncIssuesSection = buildSyncIssuesSection(syncIssues);
  const sanctificationSection = buildSanctificationSection(actor);
  const unmappedItemsSection = buildUnmappedItemsSection(unmappedItems);

  const manualItems = actor.items.filter(isUnmanagedManualItem);
  const manualItemsSection = buildManualItemsSection(manualItems);

  const content = buildDialogContent({
    sheetUrl,
    lastImportDisplay,
    lastExportDisplay,
    syncIssuesSection,
    sanctificationSection,
    unmappedItemsSection,
    manualItemsSection,
  });

  await foundry.applications.api.DialogV2.wait({
    window: { title: `Demiplane — ${actor.name}` },
    classes: indicatorActive ? ["demiplane-sync-dialog", "has-sync-errors"] : ["demiplane-sync-dialog"],
    content,
    buttons: buildDialogButtons(actor, characterId, importCharacter, exportCharacter, indicatorActive),
    render: (event, dialog) => {
      attachMappingEditorButton(event, dialog);
      attachSanctificationSelect(actor, dialog);
    },
  });
}

/**
 * Wires the "Open mapping editor" button (GM view of the unmapped-items
 * section) to open the mapping app. Done in the dialog's render callback
 * because DialogV2 content is static HTML with no per-element handlers. The
 * title-bar logo is drawn by CSS (`::before` on `.window-title`), driven by the
 * dialog's `has-sync-errors` class, so no DOM injection is needed here.
 */
function attachMappingEditorButton(_event: Event, dialog: foundry.applications.api.DialogV2): void {
  const button = dialog.element.querySelector<HTMLButtonElement>(".demiplane-open-mapping");
  button?.addEventListener("click", () => {
    void new (getDemiplaneMappingAppClass())().render({ force: true });
  });
}

function buildDialogButtons(
  actor: Actor,
  characterId: string,
  importCharacter: ImportCharacterFn,
  exportCharacter: ExportCharacterFn,
  indicatorActive: boolean
): Array<DialogV2Button> {
  return [
    {
      action: "update",
      label: "Update from Demiplane",
      icon: "fa-solid fa-sync",
      callback: () => performUpdate(actor, characterId, importCharacter),
    },
    buildPushButton(actor, exportCharacter),
    {
      // Deliberately not "close": DialogV2 treats that action as a plain
      // dismissal and never invokes the callback, so the dot would stay lit.
      // Acknowledging clears the dot but keeps the issues, so the user can
      // reopen the dialog and the mapping editor still has the unmapped slugs.
      action: "dismiss",
      label: indicatorActive ? "Dismiss" : "Close",
      default: true,
      callback: () => {
        if (indicatorActive) acknowledgeIssues(actor);
      },
    },
  ];
}

/**
 * The "Push to Demiplane" button. Auto-sync is the master write switch, so when
 * it is off the button is disabled with a tooltip explaining why — pushing would
 * be a no-op, so it is better to prevent the click than to report a misleading
 * "pushed" success.
 */
function buildPushButton(actor: Actor, exportCharacter: ExportCharacterFn): DialogV2Button {
  const writingOn = canWriteText();
  return {
    action: "push",
    label: "Push to Demiplane",
    icon: "fa-solid fa-upload",
    disabled: !writingOn,
    tooltip: writingOn ? "" : "Set a “Write to Demiplane” level in the module settings to push to Demiplane.",
    callback: () => exportCharacter(actor),
  };
}

interface DialogContentOptions {
  sheetUrl: string;
  lastImportDisplay: string;
  lastExportDisplay: string;
  syncIssuesSection: string;
  sanctificationSection: string;
  unmappedItemsSection: string;
  manualItemsSection: string;
}

/**
 * Wraps the sync-issues and unmapped-items sections in a single scrollable
 * region so that, together, they stay bounded: a long combination of issues
 * and unmapped names scrolls as one panel between the dividers rather than
 * stretching the dialog. Renders nothing when both sections are empty.
 */
function buildScrollableIssues(syncIssuesSection: string, unmappedItemsSection: string): string {
  if (syncIssuesSection === "" && unmappedItemsSection === "") return "";
  return `
    <hr>
    <div class="demiplane-scroll-region">
      ${syncIssuesSection}
      ${unmappedItemsSection}
    </div>`;
}

function buildDialogContent(opts: DialogContentOptions): string {
  return `
    <div class="demiplane-info-dialog">
      <section>
        <p><strong>Last import from Demiplane:</strong> ${opts.lastImportDisplay}</p>
        <p><strong>Last push to Demiplane:</strong> ${opts.lastExportDisplay}</p>
        <p><a href="${opts.sheetUrl}" target="_blank" rel="noopener">Open sheet on Demiplane ↗</a></p>
      </section>
      ${buildScrollableIssues(opts.syncIssuesSection, opts.unmappedItemsSection)}
      ${opts.sanctificationSection}
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

/**
 * Genuine sync failures the user usually can't resolve on their own: an invalid
 * or missing token, rate limits, or a push that failed. These carry the red
 * indicator and clear on dismiss.
 */
function buildSyncIssuesSection(issues: string[]): string {
  if (issues.length === 0) return "";
  const list = issues.map((message) => `<li>${escapeHtml(message)}</li>`).join("\n");
  return `
    <section>
      <p><strong class="sync-issues-heading">Sync issues</strong> (${String(issues.length)}):</p>
      <ul class="demiplane-sync-issues">${list}</ul>
      <p class="hint">The red indicator clears once you dismiss this dialog.</p>
    </section>`;
}

/**
 * Demiplane names that didn't resolve to a compendium item. These are routine
 * and fixable through the mapping editor, so they are never flagged as an
 * error. A GM gets a button to open the editor directly; everyone else is told
 * their GM can fix the mapping.
 */
function buildUnmappedItemsSection(items: string[]): string {
  if (items.length === 0) return "";
  const list = items.map((message) => `<li>${escapeHtml(message)}</li>`).join("\n");
  return `
    <section>
      <p><strong>Unmapped items</strong> (${String(items.length)}):</p>
      <ul class="demiplane-unmapped-items">${list}</ul>
      ${buildUnmappedItemsAction()}
    </section>`;
}

function buildUnmappedItemsAction(): string {
  if (game.user?.isGM) {
    return `
      <button type="button" class="demiplane-open-mapping">
        <i class="fa-solid fa-link" inert></i> Open mapping editor
      </button>`;
  }
  return `<p class="hint">Your GM can map these to Foundry items so they import next time.</p>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Renders the sanctification selector — only for characters whose deity presents
 * a real holy/unholy/none choice (a "can be" deity). Demiplane doesn't export
 * the choice, so the import guesses; this lets the player correct it. Absent for
 * "must be" deities (deterministic) and non-deity classes, so the section simply
 * doesn't render for them.
 */
function buildSanctificationSection(actor: Actor): string {
  const state = getSanctification(actor);
  if (!state) return "";

  const options = state.options
    .map((value) => {
      const selected = value === state.selected ? " selected" : "";
      return `<option value="${value}"${selected}>${escapeHtml(SANCTIFICATION_LABELS[value])}</option>`;
    })
    .join("");

  return `
    <hr>
    <section class="demiplane-sanctification">
      <p><strong>Sanctification:</strong>
        <select class="demiplane-sanctification-select">${options}</select>
      </p>
      <p class="hint">Demiplane doesn't export this, so it was guessed on import. Set it here, then Update from Demiplane to apply it.</p>
    </section>`;
}

/**
 * Wires the sanctification `<select>` to persist the player's choice. The choice
 * is applied on the next "Update from Demiplane": the import honors the stored
 * preference and stops flagging it. (Applying it live would mean rewriting the
 * deity feature's ChoiceSet rules array, which is error-prone, so we defer to
 * the import that already sets sanctification correctly.)
 */
function attachSanctificationSelect(actor: Actor, dialog: foundry.applications.api.DialogV2): void {
  const select = dialog.element.querySelector<HTMLSelectElement>(".demiplane-sanctification-select");
  select?.addEventListener("change", () => {
    const value = select.value;
    if (!isSanctification(value)) return;
    void setSanctificationSelection(actor, value);
  });
}

/**
 * PF2e item types this module never imports and doesn't sync, so they should not
 * appear in the "not from Demiplane" list. Actions cover exploration, downtime,
 * and encounter (combat) activities — a player may copy many onto their sheet,
 * and none are Demiplane-managed. Effects and conditions are transient state,
 * likewise never synced.
 */
const UNSYNCED_ITEM_TYPES = new Set(["action", "effect", "condition"]);

/**
 * Whether an item should be listed as "not from Demiplane". Excludes items this
 * module created (they carry its flag) and item types it never manages (see
 * {@link UNSYNCED_ITEM_TYPES}), so a sheet full of copied activities doesn't
 * flood the list with things the sync will never touch.
 */
function isUnmanagedManualItem(item: { type: string; flags?: Record<string, unknown> }): boolean {
  const moduleFlags = item.flags?.[MODULE_ID] as Record<string, unknown> | undefined;
  if (moduleFlags !== undefined) return false;
  return !UNSYNCED_ITEM_TYPES.has(item.type);
}

function buildManualItemsSection(items: Array<{ name: string; type: string }>): string {
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
