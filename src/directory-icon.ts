import { MODULE_ID } from "./import/types.js";
import type { ImportSummary } from "./import/types.js";
import { showDemiplaneInfoDialog } from "./demiplane-info-button.js";

type ImportCharacterFn = (
  actor: Actor,
  characterId: string,
  token: string,
  options?: { wipe?: boolean }
) => Promise<ImportSummary>;
type ExportCharacterFn = (actor: Actor) => Promise<unknown>;

/** Path (served by Foundry from the module root) to the Demiplane favicon. */
const DEMIPLANE_ICON_SRC = `modules/${MODULE_ID}/assets/demiplane.ico`;

/** Marker class so an entry is only decorated once and can be found again. */
const DIRECTORY_ICON_CLASS = "demiplane-directory-icon";

/**
 * Shows the Demiplane logo on every linked character's row in the Actors
 * sidebar, right-justified at the end of the row alongside any icons other
 * modules add. Clicking it opens the same Demiplane info dialog as the actor
 * sheet's "Demiplane" header button, for users who could use that button
 * (GMs and owners); for everyone else it stays a passive sync indicator.
 *
 * The icon is only added for actors that are synced with Demiplane (they carry
 * a `characterId` flag) and is sized in CSS (`module.css`) to match the name's
 * height, so the visual tweaking lives alongside the module's other styles.
 *
 * In Foundry v14 the sidebar is an ApplicationV2. Its `render*` hook only fires
 * on an actual (re-)render — the initial one happens during setup, before this
 * module's `ready` handler runs — while switching to the tab fires only the
 * `activate*` hook (with no element). We therefore decorate on render, on
 * activate, and once immediately at registration to cover the already-rendered
 * directory.
 */
export function registerDirectoryIcon(importCharacter: ImportCharacterFn, exportCharacter: ExportCharacterFn): void {
  const decorateAll = (root: HTMLElement | undefined): void => {
    if (!root) return;
    const entries = root.querySelectorAll<HTMLElement>("li.directory-item.actor[data-entry-id]");
    entries.forEach((entry) => decorateEntry(entry, importCharacter, exportCharacter));
  };

  Hooks.on("renderActorDirectory", (_app: unknown, element: unknown) => {
    decorateAll(resolveRoot(element));
  });

  Hooks.on("activateActorDirectory", (app: unknown) => {
    decorateAll(elementOf(app));
  });

  decorateAll(currentDirectoryRoot());
}

function decorateEntry(
  entry: HTMLElement,
  importCharacter: ImportCharacterFn,
  exportCharacter: ExportCharacterFn
): void {
  if (entry.querySelector(`:scope > .${DIRECTORY_ICON_CLASS}`)) return;

  const actorId = entry.dataset.entryId;
  if (!actorId) return;

  const actor = game.actors?.get(actorId);
  const characterId = actor?.getFlag(MODULE_ID, "characterId") as string | undefined;
  if (!actor || characterId == null) return;

  // Append to the row itself (not inside `.entry-name`), so the icon shares the
  // flex row with the name and any icons other modules add (e.g. Permissions
  // Viewer). `.entry-name` grows to fill the row, pushing trailing icons to the
  // right, which keeps ours right-justified without disturbing the others.
  const icon = buildIcon();
  if (canOpenDialog(actor)) {
    makeClickable(icon, actor, characterId, importCharacter, exportCharacter);
  }
  entry.append(icon);
}

/** Mirrors the header button's gate: only GMs and owners open the dialog. */
function canOpenDialog(actor: Actor): boolean {
  const user = game.user;
  if (!user) return false;
  return user.isGM || actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
}

function makeClickable(
  icon: HTMLImageElement,
  actor: Actor,
  characterId: string,
  importCharacter: ImportCharacterFn,
  exportCharacter: ExportCharacterFn
): void {
  icon.classList.add("clickable");
  icon.title = "Open Demiplane sync";
  icon.addEventListener("click", (event) => {
    // The row's own click activates/opens the actor; keep the icon's action
    // separate so it only opens the Demiplane dialog.
    event.preventDefault();
    event.stopPropagation();
    void showDemiplaneInfoDialog(actor, characterId, importCharacter, exportCharacter);
  });
}

/** The live Actors sidebar directory root element, if it is rendered. */
function currentDirectoryRoot(): HTMLElement | undefined {
  return elementOf((ui as { actors?: unknown } | undefined)?.actors);
}

/** The `renderActorDirectory` hook passes the root element directly. */
function resolveRoot(element: unknown): HTMLElement | undefined {
  return element instanceof HTMLElement ? element : undefined;
}

/** Reads the ApplicationV2 root element off a sidebar-directory instance. */
function elementOf(app: unknown): HTMLElement | undefined {
  const element = (app as { element?: unknown } | undefined)?.element;
  return element instanceof HTMLElement ? element : undefined;
}

function buildIcon(): HTMLImageElement {
  const icon = document.createElement("img");
  icon.className = DIRECTORY_ICON_CLASS;
  icon.src = DEMIPLANE_ICON_SRC;
  icon.alt = "Synced with Demiplane";
  icon.title = "Synced with Demiplane";
  icon.loading = "lazy";
  return icon;
}
