/**
 * UI shell package: presentation and wiring only (dialogs, buttons, icons,
 * settings, public module API). May depend on any package; no package may
 * depend on ui. The composition root src/module.ts is the sole importer.
 */
export * from "./actor-context-menu.js";
export * from "./character-link-dialog.js";
export * from "./character-link-input.js";
export * from "./demiplane-info-button.js";
export * from "./directory-icon.js";
export * from "./directory-import.js";
export * from "./titlebar-dot.js";
export * from "./settings.js";
export * from "./module-api.js";
