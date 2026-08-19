const MODULE_ID = "foundry-demiplane-pf2e";

export function registerSettings(): void {
  game.settings.register(MODULE_ID, "demiplaneEmail", {
    name: "Demiplane Email",
    hint: "Email address for authenticating with the Demiplane API. Optional if only syncing public characters.",
    scope: "client",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "demiplanePassword", {
    name: "Demiplane Password",
    hint: "Password for authenticating with the Demiplane API. Optional if only syncing public characters.",
    scope: "client",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "autoSync", {
    name: "Auto-sync on Actor Update",
    hint: "Automatically push HP, currency, and consumable changes back to Demiplane",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "dryRun", {
    name: "Dry Run Mode",
    hint: "Preview import/export changes without writing to Foundry or Demiplane. When enabled, sync operations show what would change without applying anything.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
}
