/**
 * Foundation package: shared constants, pure utilities, and Foundry adapters.
 * Depends on nothing inside src/ — every other package may depend on core,
 * core never depends on them. This barrel is the complete public surface.
 */
export {
  DEITIES_PACK,
  DEMIPLANE_ERROR_ICON_SRC,
  DEMIPLANE_ICON_SRC,
  DEMIPLANE_SHEET_BASE,
  EQUIPMENT_PACK,
  IMPORT_PLACEHOLDER_NAME,
  KOFI_URL,
  PF2E_ENGINE_SOURCE,
  SPELLS_PACK,
} from "./config.js";
export { debugLog } from "./debug-log.js";
export { computeEngineSig } from "./engine-sig.js";
export { WrappedFn, getLibWrapper, registerWrapper, unregisterWrapper } from "./libwrapper.js";
export {
  Pf2eItemSystem,
  Pf2eSize,
  Pf2eSpellSlotRank,
  actorNaturalSize,
  builtinRuleElement,
  characterSystem,
  compendiumSource,
  documentSystem,
  itemSourceId,
  itemSystem,
  localizeLanguage,
  pf2eLanguages,
  pf2ePredicate,
  sourceRules,
  toPlainData,
} from "./pf2e-types.js";
export {
  categorizeEngine,
  describeFeatSlot,
  generateSlugCandidates,
  genericConsumableSlug,
  getSlug,
  isFormulaEngine,
  isGrantedByElement,
  normalizeEquipmentSlug,
  parseFeatSlot,
  parseRankedConsumable,
  rawEquipmentSlug,
  slugifyFreeText,
  stripHtmlTags,
  stripTrailingWord,
  toFoundrySlug,
} from "./slug-utils.js";
export { readConfiguredToken, syncClientToken } from "./token-source.js";
export { TOKEN_HELP_URL, toUserFacingSyncError } from "./token.js";
export {
  ChoiceKey,
  ChoiceOverrides,
  DemiplaneEngineEntry,
  EXPECTED_TYPES,
  INVENTORY_ITEM_TYPES,
  ImportOptions,
  ImportSummary,
  ItemCategory,
  MODULE_ID,
  PACKS,
  SlugKind,
  UnmappedSlug,
  UnresolvedChoice,
  formatUnmapped,
  stampImported,
} from "./types.js";
