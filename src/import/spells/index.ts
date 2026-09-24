/**
 * Spell import package: spell grouping, compendium matching, spellcasting
 * entries, slot resolution, and feature-granted spells (e.g. divine font).
 * Depends only on core and shared (via its barrel).
 */
export { applyFeatureGrantedSpells } from "./feature-spell-resolver.js";
export { applySpells } from "./spell-importer.js";
