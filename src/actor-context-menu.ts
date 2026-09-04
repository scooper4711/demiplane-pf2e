import { MODULE_ID } from "./import/types.js";
import type { ImportCharacterFn } from "./sync-flows.js";

/**
 * The actor directory context-menu option ("Update from Demiplane"), extracted
 * from the module entrypoint so its visibility rules and click flow are
 * unit-testable.
 */

export interface ActorContextOption {
  label: string;
  icon: string;
  visible: (li: HTMLElement) => boolean;
  onClick: (event: PointerEvent, li: HTMLElement) => Promise<void>;
}

/** True when the user may open the sync dialog (GMs and owners, mirroring the header button). */
export function canOpenSyncDialog(actor: Actor, user: User | null | undefined): boolean {
  if (!actor.getFlag(MODULE_ID, "characterId")) return false;
  if (!user) return false;
  return Boolean(user.isGM || actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
}

export function buildUpdateFromDemiplaneOption(importCharacter: ImportCharacterFn): ActorContextOption {
  return {
    label: "Update from Demiplane",
    icon: `<i class="fas fa-sync"></i>`,
    visible: (li: HTMLElement) => {
      const actor = game.actors.get(li.dataset.entryId ?? "", { strict: false });
      if (!actor) return false;
      return canOpenSyncDialog(actor, game.user);
    },
    // `onClick` receives (event, target) — the reverse of the deprecated `callback`.
    onClick: async (_event: PointerEvent, li: HTMLElement) => {
      const actor = game.actors.get(li.dataset.entryId ?? "");
      const characterId = actor?.getFlag(MODULE_ID, "characterId");
      if (!actor || typeof characterId !== "string") return;

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

      ui.notifications.info(`Updating ${actor.name} from Demiplane...`);

      const summary = await importCharacter(actor, characterId, token, { wipe: true });
      if (summary.errors.length > 0) {
        ui.notifications.error(`Update errors: ${summary.errors.join("; ")}`);
      } else {
        ui.notifications.info(`Updated "${actor.name}" — ${summary.itemsImported} items.`);
      }
    },
  };
}
