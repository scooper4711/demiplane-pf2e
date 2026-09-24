/**
 * Shared import infrastructure: compendium resolution, Demiplane
 * engine-stream reading, and rank helpers. Consumed by the domain
 * sub-packages via this barrel; depends on core and mapping only.
 */
export {
  resolveCompendiumItem,
  resolveSlugToUuid,
  resolveSpellFromCompendium,
  resolveSpellSourceFromCompendium,
} from "./compendium-resolver.js";
export { MAX_HERO_POINTS, PROFICIENCY_LEGENDARY, PROFICIENCY_TRAINED } from "./pf2e-ranks.js";
export {
  AddSpellModifier,
  DemiplaneSlotEntry,
  DomainEngineData,
  EngineModifier,
  RawEngineLine,
  RepertoireCountEntry,
  expandFeatGrantLines,
  fetchDomainEngineData,
  fetchStreamEngineLines,
  mapClassFeatureEngineIds,
  mapSpellEngineIds,
  parseEngineLines,
  resolveClassFeatureEngineIdsBySlug,
  resolveGrantBuilderSelections,
  resolveGrantedFeatsBySlug,
} from "./stream-engines.js";
