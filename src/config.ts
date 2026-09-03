import { MODULE_ID } from "./import/types.js";

/** Base URL for a Demiplane character sheet (append `/<characterId>`). */
export const DEMIPLANE_SHEET_BASE = "https://app.demiplane.com/nexus/pathfinder2e/character-sheet";

/** The Demiplane logo, served by Foundry from the module root. Blue = linked. */
export const DEMIPLANE_ICON_SRC = `modules/${MODULE_ID}/assets/demiplane.ico`;

/** Red variant of the logo, shown when an actor has unacknowledged sync issues. */
export const DEMIPLANE_ERROR_ICON_SRC = `modules/${MODULE_ID}/assets/demiplane-error.ico`;

/** Ko-fi donation link shown in the info dialog. */
export const KOFI_URL = "https://ko-fi.com/coop207627";

/** Demiplane GraphQL API endpoint used to fetch character data. */
export const DEMIPLANE_GRAPHQL_URL = "https://apiv4.demiplane.com/v1/graphql";

/** Compendium pack keys referenced across the importer. */
export const SPELLS_PACK = "pf2e.spells-srd";
export const EQUIPMENT_PACK = "pf2e.equipment-srd";
export const DEITIES_PACK = "pf2e.deities";
