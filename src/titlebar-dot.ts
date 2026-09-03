import { MODULE_ID } from "./import/types.js";
import { ISSUES_CHANGED_EVENT, shouldShowIndicator } from "./sync-issues.js";

export const SYNC_ISSUES_CLASS = "has-sync-errors";

/**
 * Controls the colour of the Demiplane logo on linked actor sheet titlebars.
 * The logo itself is drawn by CSS as a `::before` on the `.demiplane-info-btn`
 * header button (blue by default); this module toggles the `has-sync-errors`
 * class on that button to switch it to the red variant when the most recent
 * sync produced issues no one has acknowledged yet. Dismissing the sync dialog
 * acknowledges them and returns the logo to blue (the issues themselves stay
 * available — see `shouldShowIndicator`).
 */
export function registerTitlebarDot(): void {
  Hooks.on("renderActorSheet", (sheet: ActorSheet) => {
    const actor = sheet.actor;
    if (!actor) return;
    if (!actor.getFlag(MODULE_ID, "characterId")) return;

    applyToSheet(sheet, actor);
  });

  Hooks.on(ISSUES_CHANGED_EVENT, (actor: Actor) => {
    for (const sheet of getOpenSheetsFor(actor)) applyToSheet(sheet, actor);
  });

  // `updateActor` fires once a flag write has landed, so `shouldShowIndicator`
  // reads the settled value — the authoritative refresh, mirroring the sidebar
  // badge. (The issues-changed event above is a synchronous best-effort path.)
  Hooks.on("updateActor", (actor: Actor, changes: Record<string, unknown>) => {
    if (!moduleFlagsChanged(changes)) return;
    for (const sheet of getOpenSheetsFor(actor)) applyToSheet(sheet, actor);
  });
}

function applyToSheet(sheet: ActorSheet, actor: Actor): void {
  const button = findDemiplaneButton(sheet);
  if (button) button.classList.toggle(SYNC_ISSUES_CLASS, shouldShowIndicator(actor));
}

/** True when an actor update touched this module's flags (the indicator's inputs). */
function moduleFlagsChanged(changes: Record<string, unknown>): boolean {
  const flags = changes.flags as Record<string, unknown> | undefined;
  return flags != null && MODULE_ID in flags;
}

function findDemiplaneButton(sheet: ActorSheet): HTMLElement | undefined {
  const element = (sheet.element as JQuery<HTMLElement>)[0];
  return element?.querySelector(".demiplane-info-btn") as HTMLElement | undefined;
}

function getOpenSheetsFor(actor: Actor): ActorSheet[] {
  if (typeof ui === "undefined" || !ui.windows) return [];
  const sheets: ActorSheet[] = [];
  for (const window of Object.values(ui.windows)) {
    const app = window as { rendered?: boolean; object?: { id?: string } } | undefined;
    if (app && app.rendered && app.object?.id === actor.id) sheets.push(window as unknown as ActorSheet);
  }
  return sheets;
}
