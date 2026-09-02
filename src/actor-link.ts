import { MODULE_ID } from "./import/types.js";
import { debugLog } from "./import/debug-log.js";

/**
 * Helpers for the actor↔Demiplane-character link stored in
 * `flags.demiplane-pf2e.characterId`.
 *
 * The link is a plain actor flag, so it can be duplicated onto a second actor by
 * native Foundry operations that never run the module's linking code (JSON
 * export/import, Duplicate, copy/paste, compendium import, world-backup restore).
 * Two actors sharing a characterId collide in the export buffer (which is keyed
 * solely by characterId) and clobber each other's pushes. These helpers are the
 * single source of truth for reading the link and detecting duplicates.
 */

/** Reads the linked Demiplane character UUID from an actor, or undefined. */
export function getLinkedCharacterId(actor: Actor): string | undefined {
  return actor.getFlag(MODULE_ID, "characterId") as string | undefined;
}

/**
 * Finds another actor already linked to `characterId`, excluding the actor whose
 * id is `exceptActorId`. Returns undefined when no other actor holds the link.
 *
 * @param characterId - The Demiplane character UUID to search for.
 * @param exceptActorId - The id of the actor to exclude from the search (the one
 *   being linked). Pass the actor's own id so it doesn't match itself.
 */
export function findActorLinkedTo(characterId: string, exceptActorId?: string | null): Actor | undefined {
  if (typeof game === "undefined" || !game.actors) return undefined;
  return game.actors.contents.find(
    (candidate) => candidate.id !== exceptActorId && getLinkedCharacterId(candidate) === characterId
  );
}

/**
 * If `actor` carries a characterId that another actor already owns, strip the
 * link from THIS actor (the arriving copy) and warn. The original actor stays
 * authoritative because it has the matching import baseline
 * (lastUpdated/engineSig); the copy has none, so unlinking the copy is the safe
 * direction and avoids two actors pushing to the same Demiplane character.
 *
 * Detect-and-repair, not prevent: the duplicate briefly exists until this runs.
 * That is acceptable under Foundry's last-write-wins model and is the only
 * mechanism that covers native flag-copying operations (JSON import, Duplicate,
 * paste, compendium import, backup restore).
 */
export async function reconcileDuplicateLink(actor: Actor): Promise<void> {
  const characterId = getLinkedCharacterId(actor);
  if (!characterId) return;

  const other = findActorLinkedTo(characterId, actor.id);
  if (!other) return;

  debugLog(
    `[link] duplicate characterId ${characterId} on "${actor.name}" (already on "${other.name}"); unlinking the copy`
  );
  try {
    await actor.unsetFlag(MODULE_ID, "characterId");
  } catch (error) {
    debugLog(`[link] failed to unlink duplicate on "${actor.name}": ${String(error)}`);
    return;
  }
  if (typeof ui !== "undefined" && ui.notifications) {
    ui.notifications.warn(
      `"${actor.name}" was linked to the same Demiplane character as "${other.name}". ` +
        `The duplicate link on "${actor.name}" was removed.`
    );
  }
}
