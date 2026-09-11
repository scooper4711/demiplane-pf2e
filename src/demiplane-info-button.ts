import type { DialogV2Button } from "@client/applications/api/dialog.mjs";
import { MODULE_ID, formatUnmapped } from "./import/types.js";
import type { ChoiceOverrides, ImportSummary, UnresolvedChoice } from "./import/types.js";
import { canWriteText } from "./write-level.js";
import { isSyncActive } from "./sync-pause.js";
import { localizeChoiceLabel } from "./import/choice-overrides.js";
import {
  acknowledgeIssues,
  getChoiceOverrides,
  getExportIssues,
  getImportIssues,
  getUnmappedSlugs,
  getUnresolvedChoices,
  removeChoiceOverride,
  setChoiceOverride,
  shouldShowIndicator,
} from "./sync-issues.js";
import { getDemiplaneMappingAppClass } from "./demiplane-mapping-app.js";
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
  const unresolved = getUnresolvedChoices(actor);
  const overrides = getChoiceOverrides(actor);
  const unresolvedChoicesSection = buildUnresolvedChoicesSection(unresolved, overrides);
  const choicePicksSection = buildChoicePicksSection(unresolved, overrides);
  const unmappedItemsSection = buildUnmappedItemsSection(unmappedItems);

  const manualItems = actor.items.filter(isUnmanagedManualItem);
  const manualItemsSection = buildManualItemsSection(manualItems);

  const content = buildDialogContent({
    sheetUrl,
    lastImportDisplay,
    lastExportDisplay,
    syncIssuesSection,
    unresolvedChoicesSection,
    choicePicksSection,
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
      attachChoicesSelects(actor, dialog);
      attachChoiceDeletes(actor, dialog);
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
      // Greyed while this actor is syncing: a second import would race the
      // first (concurrent wipes, interleaved pushes). The dialog closes on
      // submit, so no toggle is needed — a reopened dialog re-reads the state.
      disabled: isSyncActive(actor),
      tooltip: isSyncActive(actor) ? "An import or push is already in progress for this character." : "",
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
 * The "Push to Demiplane" button. Disabled when writing is off (pushing would
 * be a no-op) or while a sync is already in flight for the actor (a second
 * push would race it) — each with a tooltip explaining why, so the button
 * reads as inactive rather than broken.
 */
function buildPushButton(actor: Actor, exportCharacter: ExportCharacterFn): DialogV2Button {
  const writingOn = canWriteText();
  const syncing = isSyncActive(actor);
  const tooltip = !writingOn
    ? "Set a “Write to Demiplane” level in the module settings to push to Demiplane."
    : syncing
      ? "An import or push is already in progress for this character."
      : "";
  return {
    action: "push",
    label: "Push to Demiplane",
    icon: "fa-solid fa-upload",
    disabled: !writingOn || syncing,
    tooltip,
    callback: () => exportCharacter(actor),
  };
}

interface DialogContentOptions {
  sheetUrl: string;
  lastImportDisplay: string;
  lastExportDisplay: string;
  syncIssuesSection: string;
  unresolvedChoicesSection: string;
  choicePicksSection: string;
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
      ${opts.unresolvedChoicesSection}
      ${opts.choicePicksSection}
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
 * Renders one dropdown per ChoiceSet the last import guessed at. Each lists
 * the ChoiceSet's options plus an explicit "not chosen" empty state, so a
 * blind `choices[0]` guess is never presented as the user's decision; a
 * stored override pre-selects. Absent when nothing needs input.
 */
function buildUnresolvedChoicesSection(records: UnresolvedChoice[], overrides: ChoiceOverrides): string {
  const pending = records.filter((r) => r.source === "guess");
  if (pending.length === 0) return "";

  const selects = pending
    .map((record) => {
      const current = overrides[record.key];
      const options = record.options
        .map((option) => {
          const selected = option.value === current ? " selected" : "";
          return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(localizeChoiceLabel(option.label))}</option>`;
        })
        .join("");
      const guessedLabel = record.options.find((o) => o.value === record.guessedValue)?.label ?? record.guessedValue;
      return `
      <p><strong>${escapeHtml(localizeChoiceLabel(record.prompt))}:</strong>
        <select class="demiplane-choice-select" data-choice-key="${escapeHtml(record.key)}">
          <option value="">— choose —</option>${options}
        </select>
      </p>
      <p class="hint">Guessed "${escapeHtml(localizeChoiceLabel(guessedLabel ?? "?"))}" on import. Pick the right one, then Update from Demiplane to apply it.</p>`;
    })
    .join("\n");

  return `
    <hr>
    <section class="demiplane-choices">
      <p><strong>Choices needing your input</strong> (${String(pending.length)}):</p>
      ${selects}
    </section>`;
}

/**
 * Renders every stored pick — the ChoiceSets resolving from user overrides
 * plus stale picks whose ChoiceSet no longer fails (auto-resolves now, or is
 * gone). Each row names what is in effect and offers a delete button: deleting
 * is the manual garbage collection (the next import then guesses and
 * re-reports the ChoiceSet for a fresh pick). Absent when no picks are stored.
 */
function buildChoicePicksSection(records: UnresolvedChoice[], overrides: ChoiceOverrides): string {
  const keys = Object.keys(overrides);
  if (keys.length === 0) return "";

  const rows = keys
    .map((key) => {
      const record = records.find((r) => r.key === key);
      const stored = overrides[key] ?? "";
      let detail: string;
      if (!record) {
        detail = `value "${escapeHtml(stored)}" <span class="hint">(stale — no longer applies to any ChoiceSet)</span>`;
      } else if (record.source === "override") {
        const selectedLabel = record.options.find((o) => o.value === stored)?.label ?? stored;
        const guessLabel = record.options.find((o) => o.value === record.guessedValue)?.label ?? record.guessedValue;
        detail = `your pick "${escapeHtml(localizeChoiceLabel(selectedLabel))}" is in effect (would have guessed "${escapeHtml(localizeChoiceLabel(guessLabel ?? "?"))}")`;
      } else {
        detail = `stored pick "${escapeHtml(stored)}" is stale — the ChoiceSet offered different options`;
      }
      const label = record ? escapeHtml(localizeChoiceLabel(record.prompt)) : escapeHtml(key);
      return `<li>${label}: ${detail}
        <button type="button" class="demiplane-choice-delete" data-choice-key="${escapeHtml(key)}" title="Delete this pick">
          <i class="fa-solid fa-trash" inert></i> Delete
        </button></li>`;
    })
    .join("\n");

  return `
    <hr>
    <section class="demiplane-choices-applied">
      <p><strong>Your picks in effect</strong> (${String(keys.length)}):</p>
      <ul>${rows}</ul>
      <p class="hint">Delete a pick, then Update from Demiplane to re-resolve it.</p>
    </section>`;
}

/**
 * Wires each choice `<select>` to persist the player's pick immediately (like
 * the sanctification selector). The pick applies on the next "Update from
 * Demiplane", which consults stored overrides before guessing. Choosing the
 * empty option removes a previously stored pick.
 */
function attachChoicesSelects(actor: Actor, dialog: foundry.applications.api.DialogV2): void {
  dialog.element.querySelectorAll<HTMLSelectElement>(".demiplane-choice-select").forEach((select) => {
    select.addEventListener("change", () => {
      const key = select.dataset.choiceKey;
      if (!key) return;
      if (select.value === "") removeChoiceOverride(actor, key);
      else setChoiceOverride(actor, key, select.value);
    });
  });
}

/**
 * Wires each pick's delete button to drop the stored override and remove its
 * row (plus the section if it was the last row). The pick stops applying on
 * the next Update from Demiplane, which falls back to guessing and re-reports
 * the ChoiceSet for a fresh pick.
 */
function attachChoiceDeletes(actor: Actor, dialog: foundry.applications.api.DialogV2): void {
  dialog.element.querySelectorAll<HTMLButtonElement>(".demiplane-choice-delete").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.choiceKey;
      if (!key) return;
      removeChoiceOverride(actor, key);
      button.closest("li")?.remove();
      const section = dialog.element.querySelector(".demiplane-choices-applied");
      if (section && section.querySelectorAll("li").length === 0) section.remove();
    });
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

  // Start ("importing, don't modify…") and completion/error toasts come from
  // importLinkedCharacter, shared by every import path.
  await importCharacter(actor, characterId, token, { wipe: true });
}
