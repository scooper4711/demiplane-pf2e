import { MODULE_ID } from "./import/types.js";
import type { ImportSummary } from "./import/types.js";
import { showDemiplaneInfoDialog } from "./demiplane-info-button.js";
import { ISSUES_CHANGED_EVENT, shouldShowIndicator } from "./sync-issues.js";
import { DEMIPLANE_ICON_SRC, DEMIPLANE_ERROR_ICON_SRC } from "./config.js";

// Foundry v14 fires `activate{Document}Directory` when a sidebar tab is
// switched to. @dfreds/foundry-types only declares overloads for a fixed set
// of hooks, so anything else (including `activate*` and this module's custom
// events) falls through to the generic `HookParameters<string, unknown[]>`
// overload whose callback takes `unknown[]`. The casts below adapt our typed
// callbacks to that boundary; Foundry guarantees the runtime shapes.

type ImportCharacterFn = (
  actor: Actor,
  characterId: string,
  token: string,
  options?: { wipe?: boolean }
) => Promise<ImportSummary>;
type ExportCharacterFn = (actor: Actor) => Promise<unknown>;

/** Marker class so an entry is only decorated once and can be found again. */
const DIRECTORY_ICON_CLASS = "demiplane-directory-icon";

/**
 * Shows the Demiplane logo on a linked character's row in the Actors sidebar,
 * right-justified at the end of the row alongside any icons other modules add.
 * Clicking it opens the same Demiplane info dialog as the actor sheet's
 * "Demiplane" header button.
 *
 * The icon is only added for actors that are synced with Demiplane (they carry
 * a `characterId` flag) and only for users who could use that header button
 * (GMs and owners). It is sized in CSS (`module.css`) to match the name's
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

  Hooks.on("renderActorDirectory", ((_app: unknown, element: unknown) => {
    decorateAll(resolveRoot(element));
  }) as (...args: unknown[]) => void);

  Hooks.on("activateActorDirectory", ((app: unknown) => {
    decorateAll(elementOf(app));
  }) as (...args: unknown[]) => void);

  // Keep the badge colour live. The issues-changed event fires synchronously
  // right after a fire-and-forget `setFlag`, so `shouldShowIndicator` can still
  // read the pre-write value here. `updateActor` fires once the flag write has
  // landed (on every client), so it is the authoritative refresh; the event is
  // kept as a fast-path best effort.
  Hooks.on(ISSUES_CHANGED_EVENT, ((actor: Actor) => {
    refreshEntryIcon(actor);
  }) as (...args: unknown[]) => void);

  Hooks.on("updateActor", ((actor: Actor, changes: Record<string, unknown>) => {
    if (moduleFlagsChanged(changes)) refreshEntryIcon(actor);
  }) as (...args: unknown[]) => void);

  decorateAll(currentDirectoryRoot());
}

function decorateEntry(
  entry: HTMLElement,
  importCharacter: ImportCharacterFn,
  exportCharacter: ExportCharacterFn
): void {
  const actorId = entry.dataset.entryId;
  if (!actorId) return;

  const actor = game.actors?.get(actorId);
  const characterId = actor?.getFlag(MODULE_ID, "characterId") as string | undefined;
  if (!actor || characterId == null) return;

  // The icon is only shown to users who can open the sync dialog (GMs and
  // owners), matching who sees the actor sheet's Demiplane header button.
  if (!canOpenDialog(actor)) return;

  // On a directory re-render the row's DOM is replaced, but this function may
  // also run against a row we already decorated. If the icon is present, just
  // refresh its colour to the current sync-issue state rather than adding a
  // second one — this is what keeps the badge in step after an import.
  const existing = entry.querySelector<HTMLImageElement>(`:scope > .${DIRECTORY_ICON_CLASS}`);
  if (existing) {
    applyIconVariant(existing, actor);
    return;
  }

  // Append to the row itself (not inside `.entry-name`), so the icon shares the
  // flex row with the name and any icons other modules add (e.g. Permissions
  // Viewer). `.entry-name` grows to fill the row, pushing trailing icons to the
  // right, which keeps ours right-justified without disturbing the others.
  const icon = buildIcon(actor);
  makeClickable(icon, actor, characterId, importCharacter, exportCharacter);
  entry.append(icon);
}

/**
 * Updates the actor's already-rendered directory badge to the normal or error
 * variant after its sync-issue state changes. No-op if the row isn't decorated
 * (directory not rendered, or actor not linked/visible to this user).
 */
function refreshEntryIcon(actor: Actor): void {
  const root = currentDirectoryRoot();
  const icon = root?.querySelector<HTMLImageElement>(
    `li.directory-item.actor[data-entry-id="${actor.id}"] > .${DIRECTORY_ICON_CLASS}`
  );
  if (icon) applyIconVariant(icon, actor);
}

/** True when an actor update touched this module's flags (the badge's inputs). */
function moduleFlagsChanged(changes: Record<string, unknown>): boolean {
  const flags = changes.flags as Record<string, unknown> | undefined;
  return flags != null && MODULE_ID in flags;
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

function buildIcon(actor: Actor): HTMLImageElement {
  const icon = document.createElement("img");
  icon.className = DIRECTORY_ICON_CLASS;
  icon.loading = "lazy";
  applyIconVariant(icon, actor);
  return icon;
}

/**
 * Points the badge at the red error icon when the actor has unacknowledged sync
 * issues, and the normal blue icon otherwise, keeping the tooltip/alt in step.
 */
function applyIconVariant(icon: HTMLImageElement, actor: Actor): void {
  const hasIssues = shouldShowIndicator(actor);
  icon.src = hasIssues ? DEMIPLANE_ERROR_ICON_SRC : DEMIPLANE_ICON_SRC;
  const label = hasIssues ? "Demiplane sync issues — click to review" : "Synced with Demiplane";
  icon.alt = label;
  icon.title = label;
}
