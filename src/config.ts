import { MODULE_ID } from "./import/types.js";

/** Base URL for a Demiplane character sheet (append `/<characterId>`). */
export const DEMIPLANE_SHEET_BASE = "https://app.demiplane.com/nexus/pathfinder2e/character-sheet";

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

/** Demiplane GraphQL API endpoint used to fetch character data. */
export const DEMIPLANE_GRAPHQL_URL = "https://apiv4.demiplane.com/v1/graphql";

/** Compendium pack keys referenced across the importer. */
export const SPELLS_PACK = "pf2e.spells-srd";
export const EQUIPMENT_PACK = "pf2e.equipment-srd";
export const DEITIES_PACK = "pf2e.deities";
