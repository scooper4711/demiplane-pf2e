import { MODULE_ID } from "./import/types.js";
import type { ExportCharacterFn, ImportCharacterFn } from "./sync-flows.js";

/**
 * Exposes the module API for external access and testing. Extracted from the
 * module entrypoint so the guards (unlinked actor, missing token) are
 * unit-testable.
 */
export function registerModuleApi(importCharacter: ImportCharacterFn, exportCharacter: ExportCharacterFn): void {
  const module = game.modules.get(MODULE_ID);
  if (!module) return;

  // eslint-disable-next-line no-restricted-syntax -- attaching a module API surface Foundry's Module type doesn't model; single site
  (module as unknown as { api: Record<string, unknown> }).api = {
    importCharacter: async (actor: Actor, options?: { token?: string; wipe?: boolean }) => {
      const characterId = actor.getFlag(MODULE_ID, "characterId") as string;
      if (!characterId) {
        ui.notifications.error("No Demiplane character linked to this actor.");
        return null;
      }
      const token = options?.token || (game.settings.get(MODULE_ID, "demiplaneToken") as string);
      if (!token) {
        ui.notifications.error("No Demiplane token configured. Set it in module settings.");
        return null;
      }
      const wipe = options?.wipe === true;
      return importCharacter(actor, characterId, token, wipe ? { wipe } : undefined);
    },
    exportNow: (actor: Actor) => exportCharacter(actor),
  };
}
