import { MODULE_ID } from "./import/types.js";

/** Base URL for a Demiplane character sheet (append `/<characterId>`). */
export const DEMIPLANE_SHEET_BASE = "https://app.demiplane.com/nexus/pathfinder2e/character-sheet";

/**
 * Placeholder name a new actor is created with before its Demiplane data
 * arrives. The import renames the actor, and also renames its prototype token
 * only if the token still carries this placeholder — leaving a user-shortened
 * token name (e.g. for the battle map) untouched.
 */
export const IMPORT_PLACEHOLDER_NAME = "Importing...";

/**
 * The Demiplane logo, served by Foundry from the module root. Blue = linked.
 * A transparent PNG (not the ICO): the dark tile is keyed out so the badge is
 * just the "D" and its blue ring, matching the transparent error variant.
 */
export const DEMIPLANE_ICON_SRC = `modules/${MODULE_ID}/assets/demiplane.png`;

/**
 * Red variant of the logo, shown when an actor has unacknowledged sync issues.
 * A transparent PNG (not the ICO): the dark tile is keyed out so the badge is
 * just the red "D" and blue ring, which lets its pulsing glow follow the
 * circular artwork instead of a square bounding box.
 */
export const DEMIPLANE_ERROR_ICON_SRC = `modules/${MODULE_ID}/assets/demiplane-error.png`;

/** Ko-fi donation link shown in the info dialog. */
export const KOFI_URL = "https://ko-fi.com/coop207627";

/**
 * Demiplane engine cache source for PF2e v2 characters. Its id list includes
 * every engine the character can access — including indirectly granted feats
 * that never appear in the `engines` selection array — so it is both the source
 * key sent to stream-engines and the lookup set for resolving `add-feat` grants.
 */
export const PF2E_ENGINE_SOURCE = "pathfinder2e-v2";

/** Compendium pack keys referenced across the importer. */
export const SPELLS_PACK = "pf2e.spells-srd";
export const EQUIPMENT_PACK = "pf2e.equipment-srd";
export const DEITIES_PACK = "pf2e.deities";
