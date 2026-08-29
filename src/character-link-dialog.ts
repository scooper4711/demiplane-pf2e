import { MODULE_ID } from "./import/types.js";
import type { DemiplaneClient } from "@scooper4711/demiplane-api";
import { parseCharacterLinkInput } from "./character-link-input.js";
import { DEMIPLANE_SHEET_BASE } from "./config.js";

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
    const currentId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;

    const content = `
      <div class="form-group">
        <label for="demiplane-character-input">Character UUID or Demiplane URL</label>
        <input
          type="text"
          id="demiplane-character-input"
          name="characterInput"
          value="${currentId ?? ""}"
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx or ${DEMIPLANE_SHEET_BASE}/..."
        />
        <p class="notes">Enter a Demiplane character UUID or paste the full character sheet URL.</p>
      </div>
    `;

    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: "Link Demiplane Character" },
      content,
      buttons: [
        {
          action: "link",
          label: "Link Character",
          icon: "fas fa-link",
          default: true,
          callback: (_event, _button, dialog) => {
            const input = dialog.element.querySelector<HTMLInputElement>("#demiplane-character-input");
            return input?.value ?? "";
          },
        },
        {
          action: "unlink",
          label: "Unlink",
          icon: "fas fa-unlink",
          callback: async () => {
            await actor.unsetFlag(MODULE_ID, "characterId");
            ui.notifications.info("Character unlinked.");
            return "unlinked";
          },
        },
        {
          action: "cancel",
          label: "Cancel",
          icon: "fas fa-times",
        },
      ],
    });

    if (result === "cancel" || result === null) return;
    if (result === "unlinked" || result === "unlink") return;

    // The "link" callback returns the input value as a string
    await this.handleLinkSubmission(actor, String(result));
  }

  private async handleLinkSubmission(actor: Actor, rawInput: string): Promise<void> {
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
      ui.notifications.error(`Could not access Demiplane character: ${message}`);
      return;
    }

    await actor.setFlag(MODULE_ID, "characterId", uuid);
    ui.notifications.info(`Character linked: ${uuid}`);
  }
}
