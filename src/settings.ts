import { MODULE_ID } from "./import/types.js";
import { DemiplaneClient, normalizeBearerToken } from "@scooper4711/demiplane-api";
import { registerSlugMappingSettings } from "./slug-mapping.js";
import { getDemiplaneMappingAppClass } from "./demiplane-mapping-app.js";
import {
  WRITE_LEVEL_SETTING,
  WRITE_LEVEL_LABELS,
  WRITE_LEVEL_DESCRIPTIONS,
  DEFAULT_WRITE_LEVEL,
} from "./write-level.js";
import { TOKEN_HELP_URL, toUserFacingSyncError } from "./token.js";

interface SettingsHtml extends HTMLElement {
  querySelector(selector: string): HTMLElement | null;
}

export function registerSettings(): void {
  registerSlugMappingSettings();

  game.settings.register(MODULE_ID, WRITE_LEVEL_SETTING, {
    name: "Write to Demiplane",
    // Static fallback — replaced live on renderSettingsConfig so the hint always
    // describes the *currently selected* value, not the last-saved one. Keep it
    // short; the old wall of text is now per-level. The registered hint is still
    // used as the first paint before the live hook runs.
    hint: WRITE_LEVEL_DESCRIPTIONS[DEFAULT_WRITE_LEVEL]!,
    scope: "world",
    config: true,
    type: String,
    choices: WRITE_LEVEL_LABELS,
    default: DEFAULT_WRITE_LEVEL,
  });

  game.settings.register(MODULE_ID, "demiplaneToken", {
    name: "Demiplane Authorization Token",
    // Plain text: Foundry escapes hint strings, so markup here would show as
    // source. The how-to link is appended live by enhanceTokenHint below.
    hint: "Token used for Demiplane API requests. Only the GM can enter or change this value.",
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
    enhanceTokenHint(html);
    enhanceWriteLevelHint(html);
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

/**
 * Appends a "How to get your token" link to the token hint. Done in the DOM —
 * not in the registered hint string, which Foundry escapes — so non-technical
 * GMs are one click from the README instructions.
 */
function enhanceTokenHint(html: SettingsHtml): void {
  if (!game.user?.isGM) return;
  const tokenSetting = findTokenSetting(html);
  if (!tokenSetting) return;
  const hint = tokenSetting.querySelector(".hint, .notes, p.hint") as HTMLElement | null;
  if (!hint || typeof hint.appendChild !== "function" || hint.dataset.tokenHelpEnhanced === "true") return;
  // eslint-disable-next-line no-restricted-syntax -- document is an untyped DOM global outside PF2e seams
  const doc = document as unknown as {
    createElement?: (tag: string) => HTMLAnchorElement;
    createTextNode?: (text: string) => Text;
  };
  if (typeof document === "undefined" || typeof doc.createElement !== "function") return;
  const link = doc.createElement("a");
  link.href = TOKEN_HELP_URL;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "How to get your token";
  if (typeof doc.createTextNode === "function") hint.appendChild(doc.createTextNode(" "));
  hint.appendChild(link);
  hint.dataset.tokenHelpEnhanced = "true";
}

function enhanceWriteLevelHint(html: SettingsHtml): void {
  const select = html.querySelector(`select[name="${MODULE_ID}.${WRITE_LEVEL_SETTING}"]`) as HTMLSelectElement | null;
  if (!select) return;
  const formGroup = select.closest(".form-group") as HTMLElement | null;
  if (!formGroup) return;
  // Foundry renders the hint as p.hint / p.notes / .hint — be permissive.
  const hint = formGroup.querySelector(".hint, .notes, p.hint") as HTMLElement | null;
  if (!hint) return;

  const update = () => {
    const val = (select.value ?? DEFAULT_WRITE_LEVEL) as keyof typeof WRITE_LEVEL_DESCRIPTIONS;
    const desc = WRITE_LEVEL_DESCRIPTIONS[val] ?? WRITE_LEVEL_DESCRIPTIONS[DEFAULT_WRITE_LEVEL]!;
    // Render with line breaks so multi-line hints (Session) break where
    // intended. Keep it as DOM nodes rather than raw innerHTML so the
    // description stays plain text. Fall back to plain text in test stubs
    // where document/hint DOM APIs are not fully mocked.
    // eslint-disable-next-line no-restricted-syntax -- document is an untyped DOM global outside PF2e seams
    const docCreateTextNode = (document as unknown as { createTextNode?: (t: string) => Text }).createTextNode;
    const canBuild =
      typeof document !== "undefined" &&
      typeof document.createElement === "function" &&
      typeof docCreateTextNode === "function" &&
      typeof hint.appendChild === "function";
    if (canBuild) {
      hint.textContent = "";
      for (const [i, line] of desc.split("\n").entries()) {
        if (i > 0) hint.appendChild(document.createElement("br"));
        hint.appendChild(document.createTextNode(line));
      }
    } else {
      hint.textContent = desc;
    }
    // Small affordance for tests / styling: exposes which level is displayed.
    hint.dataset.writeLevel = val;
  };

  // Avoid double-binding if Foundry re-renders the same DOM node.
  if ((select as HTMLSelectElement & { dataset: DOMStringMap }).dataset.writeLevelHintEnhanced === "true") {
    update();
    return;
  }
  (select as HTMLSelectElement & { dataset: DOMStringMap }).dataset.writeLevelHintEnhanced = "true";
  select.addEventListener("change", update);
  select.addEventListener("input", update);
  update();
}

async function validateDemiplaneToken(token: string): Promise<void> {
  // Normalize to decide emptiness (a scheme-only paste counts as "no token");
  // setToken normalizes again for the value it actually stores.
  if (!normalizeBearerToken(token)) {
    await showTokenValidationDialog("No token entered", "Enter a Demiplane authorization token before validating.");
    return;
  }

  const client = new DemiplaneClient();
  client.setToken(token);

  try {
    await client.validateToken();
    await showTokenValidationDialog(
      "Token validated",
      "The Demiplane authorization token is valid and was accepted by the API."
    );
  } catch (error) {
    await showTokenValidationDialog(
      "Token rejected",
      `The token could not be validated: ${toUserFacingSyncError(error)}`
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
