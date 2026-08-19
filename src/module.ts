import { DemiplaneClient } from "@scooper4711/demiplane-api";
import { registerSettings } from "./settings.js";
import { ExportManager } from "./export-manager.js";
import { HookManager } from "./hook-manager.js";

const MODULE_ID = "foundry-demiplane-pf2e";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing Demiplane PF2e Sync`);
  registerSettings();
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready`);

  const client = new DemiplaneClient();
  const exportManager = new ExportManager(client);
  const hookManager = new HookManager(exportManager);
  hookManager.register();
});
