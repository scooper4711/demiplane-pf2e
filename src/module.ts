import { registerSettings } from "./settings.js";
import { registerHooks } from "./hooks.js";

const MODULE_ID = "demiplane-pf2e";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Demiplane PF2e Sync`);
  registerSettings();
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready`);
  registerHooks();
});
