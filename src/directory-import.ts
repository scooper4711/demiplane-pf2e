import { MODULE_ID } from "./import/types.js";
import { DEMIPLANE_SHEET_BASE } from "./config.js";
import { findActorLinkedTo } from "./actor-link.js";
import type { ImportCharacterFn } from "./sync-flows.js";

/**
 * The "Import Demiplane Character" sidebar button flow, extracted from the
 * module entrypoint so the branching (invalid input, already linked, missing
 * token, cancelled dialog, import errors) is unit-testable without Foundry.
 */

export function extractCharacterId(input: string): string | null {
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const match = uuidPattern.exec(input);
  return match ? match[0] : null;
}

/** Dialog body for the import prompt. The submitted `characterRef` comes back parsed. */
export function buildImportPromptContent(): string {
  return `<div class="form-group"><label>Demiplane Character UUID or URL</label>
<input type="text" name="characterRef" placeholder="UUID or ${DEMIPLANE_SHEET_BASE}/..." autofocus /></div>`;
}

/** Whether the current user may import (GMs, including assistants, or actor creators). */
export function canImportCharacters(user: User | null | undefined): boolean {
  return Boolean(user?.isGM || user?.can?.("ACTOR_CREATE"));
}

/**
 * Runs the click flow for the sidebar import button: prompts for a character
 * reference, validates and de-duplicates it, creates the actor, links it, and
 * reports the import outcome. Every branch notifies and returns, so there is
 * no fall-through.
 */
export async function onImportButtonClick(importCharacter: ImportCharacterFn): Promise<void> {
  // DialogV2 wraps `content` in its own <form>, so only the fields are supplied
  // here and the submitted values come back already parsed.
  const result = await foundry.applications.api.DialogV2.input<{ characterRef: string }>({
    window: { title: "Import Demiplane Character" },
    content: buildImportPromptContent(),
    ok: { label: "Import" },
  });

  if (!result) return;

  const characterId = extractCharacterId(result.characterRef.trim());
  if (!characterId) {
    ui.notifications?.error("Invalid Demiplane character UUID or URL.");
    return;
  }

  const alreadyLinked = findActorLinkedTo(characterId);
  if (alreadyLinked) {
    ui.notifications?.error(
      `That Demiplane character is already linked to "${alreadyLinked.name}". ` +
        `Use "Update from Demiplane" on that actor instead of importing again.`
    );
    return;
  }

  const token = game.settings.get(MODULE_ID, "demiplaneToken") as string;
  if (!token) {
    ui.notifications?.error("No Demiplane token configured. Set it in module settings.");
    return;
  }

  ui.notifications?.info("Importing character from Demiplane...");

  const actor = await Actor.create({ name: "Importing...", type: "character" });
  if (!actor) return;

  await actor.setFlag(MODULE_ID, "characterId", characterId);
  const summary = await importCharacter(actor, characterId, token);

  if (summary.errors.length > 0) {
    ui.notifications?.error(`Import errors: ${summary.errors.join("; ")}`);
  } else {
    ui.notifications?.info(`Imported "${actor.name}" — ${summary.itemsImported} items.`);
  }
}
