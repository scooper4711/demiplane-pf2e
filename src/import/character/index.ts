/**
 * Actor-profile import package: biography, attributes, and languages.
 * Depends only on core, shared, and mapping — always via their barrels.
 */
export { applyAttributeBoosts, applyLanguages, applySkillProficiencies } from "./attribute-language-importer.js";
export { applyBiography } from "./biography-importer.js";
