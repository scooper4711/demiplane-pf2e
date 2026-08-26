import { MODULE_ID } from "./import/types.js";
import { DemiplaneClient } from "@scooper4711/demiplane-api";

interface SettingsHtml extends HTMLElement {
  querySelector(selector: string): HTMLElement | null;
}

export function registerSettings(): void {
  game.settings.register(MODULE_ID, "autoSync", {
    name: "Auto-sync on Actor Update",
    hint: "Automatically push HP, currency, and consumable changes back to Demiplane",
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

  game.settings.register(MODULE_ID, "dryRun", {
    name: "Dry Run Mode",
    hint: "Preview import/export changes without writing to Foundry or Demiplane. When enabled, sync operations show what would change without applying anything.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "debugImport", {
    name: "Debug Import Logging",
    hint: "Log detailed import lifecycle information to the browser console. Useful for troubleshooting import issues.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  Hooks.on("renderSettingsConfig", (_app: unknown, html: SettingsHtml) => {
    hideTokenSettingFromPlayers(html);
    addTokenValidationButton(html);
  });
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
    void validateDemiplaneToken();
  });
  tokenSetting.querySelector(".form-fields")?.appendChild(button);
}

function findTokenSetting(html: SettingsHtml): HTMLElement | null {
  const tokenInput = html.querySelector(`input[name="${MODULE_ID}.demiplaneToken"]`);
  return tokenInput?.closest(".form-group") ?? null;
}

async function validateDemiplaneToken(): Promise<void> {
  const token = game.settings.get(MODULE_ID, "demiplaneToken") as string;
  const client = new DemiplaneClient();
  client.setToken(token);

  try {
    await client.validateToken();
    await showTokenValidationDialog(
      "Token validated",
      "The Demiplane authorization token is valid and was accepted by the API."
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The API rejected the token.";
    await showTokenValidationDialog(
      "Token rejected",
      `The token could not be validated: ${message}<br><br><strong>If you changed the token, save the settings before clicking Validate token.</strong>`
    );
  }
}

async function showTokenValidationDialog(title: string, message: string): Promise<void> {
  await foundry.applications.api.DialogV2.prompt({
    window: { title },
    content: `<p>${message}</p>`,
    ok: { label: "Close" },
  });
}
