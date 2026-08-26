import { MODULE_ID } from "./import/types.js";
import type { ImportSummary } from "./import/types.js";
import type { PendingChange } from "./export-manager.js";

export interface UnresolvedSlug {
  demiplaneSlug: string;
  derivedFoundrySlug: string;
}

export interface SyncTabData {
  characterId: string;
  lastSyncTimestamp: number | undefined;
  pendingChanges: PendingChange[];
  unresolvedSlugs: UnresolvedSlug[];
  lastImportSummary: ImportSummary | undefined;
  dryRunEnabled: boolean;
  operationInProgress: boolean;
}

/**
 * Renders the Sync tab on actor sheets for linked characters.
 * Displays sync status, pending changes, unresolved issues,
 * and provides import/export action buttons.
 */
export class SyncTabRenderer {
  private operationInProgress = false;

  /**
   * Registers a Foundry settings change hook that re-renders any open actor
   * sheets when the dryRun setting changes.
   * This ensures button labels and the dry run indicator update immediately
   * without requiring a page reload.
   */
  static registerSettingsHook(): void {
    Hooks.on("updateSetting", (setting: { key: string }) => {
      if (setting.key === `${MODULE_ID}.dryRun`) {
        for (const window of Object.values(ui.windows)) {
          if (window instanceof ActorSheet) {
            window.render(false);
          }
        }
      }
    });
  }

  renderTab(sheet: ActorSheet, html: JQuery, data: SyncTabData): void {
    const characterId = data.characterId;
    if (!characterId) return;

    const tabNav = this.buildTabNavigation();
    const tabContent = this.buildTabContent(data);

    html.find(".sheet-tabs").append(tabNav);
    html.find(".sheet-body").append(tabContent);

    this.bindEventHandlers(html, sheet);
  }

  shouldRender(actor: Actor): boolean {
    const characterId = actor.getFlag(MODULE_ID, "characterId");
    return characterId !== undefined && characterId !== null;
  }

  setOperationInProgress(inProgress: boolean): void {
    this.operationInProgress = inProgress;
  }

  private buildTabNavigation(): string {
    return `<a class="item" data-tab="demiplane-sync">
      <i class="fas fa-sync-alt"></i> Sync
    </a>`;
  }

  private buildTabContent(data: SyncTabData): string {
    const sections = [
      this.buildStatusSection(data),
      this.buildDryRunIndicator(data),
      this.buildPendingChangesSection(data),
      this.buildUnresolvedSlugsSection(data),
      this.buildImportSummarySection(data),
      this.buildActionButtons(data),
    ].filter(Boolean);

    return `<div class="tab" data-group="primary" data-tab="demiplane-sync">
      <div class="demiplane-sync-tab">
        ${sections.join("\n")}
      </div>
    </div>`;
  }

  private buildStatusSection(data: SyncTabData): string {
    const timestamp = data.lastSyncTimestamp ? new Date(data.lastSyncTimestamp).toLocaleString() : "Never";

    return `<section class="sync-status">
      <h3>Sync Status</h3>
      <dl>
        <dt>Character UUID</dt>
        <dd class="character-uuid">${data.characterId}</dd>
        <dt>Last Sync</dt>
        <dd>${timestamp}</dd>
      </dl>
    </section>`;
  }

  private buildDryRunIndicator(data: SyncTabData): string {
    if (!data.dryRunEnabled) return "";
    return `<div class="dry-run-indicator notification warning">
      <i class="fas fa-eye"></i>
      <strong>Dry Run Mode Active</strong> — No changes will be written to Foundry or Demiplane.
    </div>`;
  }

  private buildPendingChangesSection(data: SyncTabData): string {
    if (data.pendingChanges.length === 0) return "";

    const rows = data.pendingChanges
      .map((change) => `<tr><td>${change.field}</td><td>${String(change.value)}</td></tr>`)
      .join("\n");

    return `<section class="pending-changes">
      <h3>Pending Changes</h3>
      <table>
        <thead><tr><th>Field</th><th>Value</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }

  private buildUnresolvedSlugsSection(data: SyncTabData): string {
    if (data.unresolvedSlugs.length === 0) return "";

    const rows = data.unresolvedSlugs
      .map((slug) => `<tr><td>${slug.demiplaneSlug}</td><td>${slug.derivedFoundrySlug}</td></tr>`)
      .join("\n");

    return `<section class="unresolved-slugs">
      <h3>Unresolved Items</h3>
      <table>
        <thead><tr><th>Demiplane Slug</th><th>Derived Foundry Slug</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }

  private buildImportSummarySection(data: SyncTabData): string {
    if (!data.lastImportSummary) return "";

    const summary = data.lastImportSummary;
    const previewLabel = summary.preview ? " (Preview)" : "";

    let errorsHtml = "";
    if (summary.errors.length > 0) {
      const errorItems = summary.errors.map((e) => `<li>${e}</li>`).join("");
      errorsHtml = `<ul class="import-errors">${errorItems}</ul>`;
    }

    return `<section class="import-summary">
      <h3>Last Import${previewLabel}</h3>
      <dl>
        <dt>Items Imported</dt>
        <dd>${String(summary.itemsImported)}</dd>
        <dt>Items Skipped</dt>
        <dd>${String(summary.itemsSkipped)}</dd>
        <dt>Errors</dt>
        <dd>${String(summary.errors.length)}</dd>
      </dl>
      ${errorsHtml}
    </section>`;
  }

  private buildActionButtons(data: SyncTabData): string {
    const importLabel = data.dryRunEnabled ? "Preview Import" : "Import from Demiplane";
    const pushLabel = data.dryRunEnabled ? "Preview Push" : "Push to Demiplane";
    const disabled = data.operationInProgress ? "disabled" : "";
    const spinner = data.operationInProgress ? `<i class="fas fa-spinner fa-spin"></i> ` : "";

    return `<section class="sync-actions">
      <button class="sync-import" type="button" ${disabled}>
        ${spinner}<i class="fas fa-download"></i> ${importLabel}
      </button>
      <button class="sync-push" type="button" ${disabled}>
        ${spinner}<i class="fas fa-upload"></i> ${pushLabel}
      </button>
    </section>`;
  }

  private bindEventHandlers(html: JQuery, sheet: ActorSheet): void {
    html.find(".sync-import").on("click", () => {
      if (this.operationInProgress) return;
      sheet.element.trigger("demiplane-import");
    });

    html.find(".sync-push").on("click", () => {
      if (this.operationInProgress) return;
      sheet.element.trigger("demiplane-push");
    });
  }
}
