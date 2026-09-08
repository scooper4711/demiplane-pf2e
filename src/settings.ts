import { MODULE_ID } from "./import/types.js";
import { DemiplaneClient } from "@scooper4711/demiplane-api";
import { registerSlugMappingSettings } from "./slug-mapping.js";
import { getDemiplaneMappingAppClass } from "./demiplane-mapping-app.js";
import { WRITE_LEVEL_SETTING, WRITE_LEVEL_LABELS, DEFAULT_WRITE_LEVEL, SOFT_DELETE_SETTING } from "./write-level.js";

interface SettingsHtml extends HTMLElement {
  querySelector(selector: string): HTMLElement | null;
}

export function registerSettings(): void {
  registerSlugMappingSettings();

  game.settings.register(MODULE_ID, WRITE_LEVEL_SETTING, {
    name: "Write to Demiplane",
    hint: "How much of a linked character to push back to Demiplane as you edit it. Each level includes the ones before it. Deleting an item from a character's inventory is the most invasive write, so it requires the highest level and always asks for confirmation before removing the item on Demiplane. (Deity is build-derived and never pushed.)",
    scope: "world",
    config: true,
    type: String,
    choices: WRITE_LEVEL_LABELS,
    default: DEFAULT_WRITE_LEVEL,
  });

  game.settings.register(MODULE_ID, SOFT_DELETE_SETTING, {
    name: "Soft-delete items (set quantity to 0)",
    hint: "Only applies when the Write to Demiplane level includes item deletions. When on, deleting an item sets its Demiplane quantity to 0 instead of removing it, so it can be restored later by raising the quantity again; the importer then skips quantity-0 items so a soft-deleted item stays gone. Has no effect at lower write levels, where deletions are not written at all.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "demiplaneToken", {
    name: "Demiplane Authorization Token",
    hint: "Token used for Demiplane API requests. See the module README for how to obtain it. Only the GM can enter or change this value.",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "debugImport", {
    name: "Debug Import Logging",
    hint: "Log detailed import lifecycle information to the browser console. Useful for troubleshooting import issues.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  // GM-only submenu; the app itself is the UI, so the setting is config: false.
  game.settings.registerMenu(MODULE_ID, "slugMapper", {
    name: "Demiplane Mapping",
    label: "Demiplane Mapping",
    hint: "Match Demiplane names that don't resolve onto real Foundry items.",
    icon: "fa-solid fa-link",
    type: getDemiplaneMappingAppClass(),
    restricted: true,
  });

  Hooks.on("renderSettingsConfig", ((_app: unknown, html: SettingsHtml) => {
    hideTokenSettingFromPlayers(html);
    addTokenValidationButton(html);
  }) as (...args: unknown[]) => void);
}

function hideTokenSettingFromPlayers(html: SettingsHtml): void {
  if (game.user?.isGM) return;

  const tokenSetting = findTokenSetting(html);
  tokenSetting?.remove();
}

function addTokenValidationButton(html: SettingsHtml): void {
  if (!game.user?.isGM) return;

  const tokenSetting = findTokenSetting(html);
  if (!tokenSetting || tokenSetting.querySelector(".demiplane-token-validation")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "demiplane-token-validation";
  button.innerHTML = '<i class="fas fa-check-circle" inert></i> Validate token';
  button.addEventListener("click", () => {
    // Validate the value currently in the input, not the saved setting, so the
    // GM can paste a new token and validate it before clicking Save.
    const input = tokenSetting.querySelector<HTMLInputElement>(`input[name="${MODULE_ID}.demiplaneToken"]`);
    const token = input?.value ?? (game.settings.get(MODULE_ID, "demiplaneToken") as string);
    void validateDemiplaneToken(token);
  });
  tokenSetting.querySelector(".form-fields")?.appendChild(button);
}

function findTokenSetting(html: SettingsHtml): HTMLElement | null {
  const tokenInput = html.querySelector(`input[name="${MODULE_ID}.demiplaneToken"]`);
  return tokenInput?.closest(".form-group") ?? null;
}

async function validateDemiplaneToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) {
    await showTokenValidationDialog("No token entered", "Enter a Demiplane authorization token before validating.");
    return;
  }

  const client = new DemiplaneClient();
  client.setToken(trimmed);

  try {
    await client.validateToken();
    await showTokenValidationDialog(
      "Token validated",
      "The Demiplane authorization token is valid and was accepted by the API."
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The API rejected the token.";
    await showTokenValidationDialog("Token rejected", `The token could not be validated: ${message}`);
  }
}

async function showTokenValidationDialog(title: string, message: string): Promise<void> {
  await foundry.applications.api.DialogV2.prompt({
    window: { title },
    content: `<p>${message}</p>`,
    ok: { label: "Close" },
  });
}
