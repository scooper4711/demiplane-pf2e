import { MODULE_ID } from "./import/types.js";
import type { ImportCharacterFn } from "./sync-flows.js";
import { isSyncActive } from "./sync-pause.js";

/**
 * The actor directory context-menu option ("Update from Demiplane"), extracted
 * from the module entrypoint so its visibility rules and click flow are
 * unit-testable.
 */

export interface ActorContextOption {
  label: string;
  icon: string;
  /**
   * Extra CSS classes for the rendered `<li>`. Foundry reads `classes` but has
   * no native `disabled` for context entries, so the greyed look comes from
   * our own stylesheet (`.demiplane-sync-disabled`) paired with the click
   * guard below.
   */
  classes?: string;
  visible: (li: HTMLElement) => boolean;
  onClick: (event: PointerEvent, li: HTMLElement) => Promise<void>;
}

/** True when the user may open the sync dialog (GMs and owners, mirroring the header button). */
export function canOpenSyncDialog(actor: Actor, user: User | null | undefined): boolean {
  if (!actor.getFlag(MODULE_ID, "characterId")) return false;
  if (!user) return false;
  return Boolean(user.isGM || actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
}

function actorForEntry(li: HTMLElement): Actor | undefined {
  return game.actors.get(li.dataset.entryId ?? "", { strict: false });
}

export function buildUpdateFromDemiplaneOption(importCharacter: ImportCharacterFn): ActorContextOption {
  // Foundry reads `classes` off this shared object at menu render, *after*
  // calling `visible(li)` — so `visible` refreshes it as a side effect (the
  // only per-open, per-target hook point available). A context menu shows one
  // entry at a time, so the shared write cannot leak across entries.
  const option: ActorContextOption = {
    label: "Update from Demiplane",
    icon: `<i class="fas fa-sync"></i>`,
    // Greyed, not hidden, while a sync is in flight for this actor — the menu
    // is rebuilt on every right-click, so this is always fresh.
    classes: "",
    visible: (li: HTMLElement) => {
      const actor = actorForEntry(li);
      if (!actor) return false;
      const eligible = canOpenSyncDialog(actor, game.user);
      option.classes = eligible && isSyncActive(actor) ? "demiplane-sync-disabled" : "";
      return eligible;
    },
    // `onClick` receives (event, target) — the reverse of the deprecated `callback`.
    onClick: async (_event: PointerEvent, li: HTMLElement) => {
      const actor = actorForEntry(li);
      const characterId = actor?.getFlag(MODULE_ID, "characterId");
      if (!actor || typeof characterId !== "string") return;

      // Silent backstop: the entry is already greyed and pointer-transparent
      // while syncing (see classes + module.css), so this only fires if CSS
      // failed to load. A second import of the same actor would race the
      // first (concurrent wipes, interleaved pushes), so refuse without noise.
      if (isSyncActive(actor)) return;

      const token = game.settings.get(MODULE_ID, "demiplaneToken");
      if (typeof token !== "string" || !token) {
        ui.notifications.error("No Demiplane token configured.");
        return;
      }

      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Update from Demiplane" },
        content: `<p>This will delete all imported items on <strong>${actor.name}</strong> and re-import from Demiplane.</p><p>Manually added items will be preserved.</p>`,
      });
      if (!confirmed) return;

      // Start ("importing, don't modify…") and completion/error toasts come from
      // importLinkedCharacter, shared by every import path.
      await importCharacter(actor, characterId, token, { wipe: true });
    },
  };
  return option;
}
