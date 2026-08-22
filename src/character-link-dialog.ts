import { MODULE_ID } from "./import/types.js";
import type { DemiplaneClient } from "@scooper4711/demiplane-api";
import { parseCharacterLinkInput } from "./character-link-input.js";


/**
 * Renders and manages the per-actor dialog for linking a Demiplane character.
 * Accepts either a bare UUID or a full Demiplane character URL.
 */
export class CharacterLinkDialog {
  private readonly client: DemiplaneClient;

  constructor(client: DemiplaneClient) {
    this.client = client;
  }

  /**
   * Opens a dialog for the user to link a Demiplane character to the given actor.
   */
  async open(actor: Actor): Promise<void> {
    const currentId = actor.getFlag(MODULE_ID, "characterId") as
      | string
      | undefined;

    const content = `
      <form class="demiplane-link-form">
        <div class="form-group">
          <label for="demiplane-character-input">Character UUID or Demiplane URL</label>
          <input
            type="text"
            id="demiplane-character-input"
            name="characterInput"
            value="${currentId ?? ""}"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx or https://app.demiplane.com/nexus/pathfinder2e/character-sheet/..."
          />
          <p class="notes">Enter a Demiplane character UUID or paste the full character sheet URL.</p>
        </div>
      </form>
    `;

    new Dialog({
      title: "Link Demiplane Character",
      content,
      buttons: {
        link: {
          icon: '<i class="fas fa-link"></i>',
          label: "Link Character",
          callback: async (html: JQuery) => {
            const input = html
              .find("#demiplane-character-input")
              .val() as string;
            await this.handleLinkSubmission(actor, input);
          },
        },
        unlink: {
          icon: '<i class="fas fa-unlink"></i>',
          label: "Unlink",
          callback: async () => {
            await actor.unsetFlag(MODULE_ID, "characterId");
            ui.notifications.info("Character unlinked.");
          },
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel",
        },
      },
      default: "link",
    }).render(true);
  }

  private async handleLinkSubmission(
    actor: Actor,
    rawInput: string,
  ): Promise<void> {
    const parseResult = parseCharacterLinkInput(rawInput);

    if (!parseResult.valid) {
      ui.notifications.error(parseResult.error);
      return;
    }

    const uuid = parseResult.uuid;

    try {
      await this.client.fetchCharacterVersion(uuid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ui.notifications.error(
        `Could not access Demiplane character: ${message}`,
      );
      return;
    }

    await actor.setFlag(MODULE_ID, "characterId", uuid);
    ui.notifications.info(`Character linked: ${uuid}`);
  }
}
