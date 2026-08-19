const MODULE_ID = "demiplane-pf2e";

export function registerSettings(): void {
  game.settings.register(MODULE_ID, "demiplaneSessionCookie", {
    name: "Demiplane Session Cookie",
    hint: "Session cookie for authenticating with the Demiplane API",
    scope: "client",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "autoSyncOnUpdate", {
    name: "Auto-sync on Actor Update",
    hint: "Automatically push HP, currency, and consumable changes back to Demiplane",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
}
