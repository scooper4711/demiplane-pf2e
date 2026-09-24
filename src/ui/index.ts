/**
 * UI shell package: presentation and wiring only (dialogs, buttons, icons,
 * settings, public module API). May depend on any package via its barrel;
 * no package may depend on ui. The composition root src/module.ts
 * is the sole importer. This barrel is the complete public surface.
 */
export { buildUpdateFromDemiplaneOption } from "./actor-context-menu.js";
export { CharacterLinkDialog } from "./character-link-dialog.js";
export { registerDemiplaneInfoButton } from "./demiplane-info-button.js";
export { registerDirectoryIcon } from "./directory-icon.js";
export { canImportCharacters, onImportButtonClick } from "./directory-import.js";
export { registerModuleApi } from "./module-api.js";
export { registerSettings } from "./settings.js";
export { registerTitlebarDot } from "./titlebar-dot.js";
