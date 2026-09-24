/**
 * Mapping package: slug → compendium-UUID store, compendium discovery
 * seams, share helpers, and the GM editor app. Depends on core and sync
 * (issue store) only. This barrel is the complete public surface.
 */
export {
  getDemiplaneMappingAppClass,
  registerDemiplaneMappingTemplates,
  registerMappingSyncHook,
} from "./demiplane-mapping-app.js";
export { findPacksWithItemTypes } from "./pack-discovery.js";
export { PackIndex, getPackIndex } from "./pack-index.js";
export { getMapping, recordResolvedMapping, registerSlugMappingSettings, resolveMappedItem } from "./slug-mapping.js";
