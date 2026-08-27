import { MODULE_ID } from "./import/types.js";
import { ISSUES_CHANGED_EVENT, hasActiveIssues } from "./sync-issues.js";

export const SYNC_ISSUES_CLASS = "has-sync-errors";

/**
 * Shows a red notification dot on linked actor sheet titlebars whenever the
 * actor has outstanding sync issues (import or export).
 *
 * The dot is rendered as a CSS `::after` pseudo-element on the Demiplane header
 * button: the button carries no extra class when issues are clear and the
 * `has-sync-errors` class when there are active issues. All placement (before /
 * after / superscript) is controlled purely by CSS in `module.css`, so tweaking
 * the indicator never requires touching the DOM logic.
 */
export function registerTitlebarDot(): void {
  Hooks.on("renderActorSheet", (sheet: ActorSheet) => {
    const actor = sheet.actor;
    if (!actor) return;
    if (!actor.getFlag(MODULE_ID, "characterId")) return;

    const button = findDemiplaneButton(sheet);
    if (button) applyIndicator(button, actor);
  });

  Hooks.on(ISSUES_CHANGED_EVENT, (actor: Actor) => {
    for (const sheet of getOpenSheetsFor(actor)) {
      const button = findDemiplaneButton(sheet);
      if (button) applyIndicator(button, actor);
    }
  });
}

function applyIndicator(button: HTMLElement, actor: Actor): void {
  button.classList.toggle(SYNC_ISSUES_CLASS, hasActiveIssues(actor));
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
