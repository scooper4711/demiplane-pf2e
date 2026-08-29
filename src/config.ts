import { STREAM_ENGINES_URL } from "./import/stream-engines.js";

/** Base URL for a Demiplane character sheet (append `/<characterId>`). */
export const DEMIPLANE_SHEET_BASE = "https://app.demiplane.com/nexus/pathfinder2e/character-sheet";

/** Ko-fi donation link shown in the info dialog. */
export const KOFI_URL = "https://ko-fi.com/coop207627";

/** Demiplane GraphQL API endpoint used to fetch character data. */
export const DEMIPLANE_GRAPHQL_URL = "https://apiv4.demiplane.com/v1/graphql";

/** Compendium pack keys referenced across the importer. */
export const SPELLS_PACK = "pf2e.spells-srd";
export const EQUIPMENT_PACK = "pf2e.equipment-srd";
export const DEITIES_PACK = "pf2e.deities";

/** Re-export so every external endpoint lives in one module. */
export { STREAM_ENGINES_URL };
