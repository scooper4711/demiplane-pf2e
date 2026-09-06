import type { DemiplaneEngineEntry } from "./types.js";

/** The Foundry-side state of the variant rules an imported character may depend on. */
export interface FoundryVariantSettings {
  /** `game.pf2e.settings.variants.gab` — Gradual Ability Boosts. */
  gradualAbilityBoosts: boolean;
  /** `game.pf2e.settings.campaign.mythic !== "disabled"` — Mythic rules. */
  mythic: boolean;
}

/** A Demiplane variant preference flag paired with the Foundry setting it needs. */
interface VariantRule {
  /** The Demiplane `preferences--…` custom engine name. */
  engineName: string;
  /** Whether the corresponding Foundry setting is enabled. */
  enabledInFoundry: (settings: FoundryVariantSettings) => boolean;
  /** The human-readable issue text when the character uses it but Foundry doesn't. */
  issue: string;
}

const VARIANT_RULES: VariantRule[] = [
  {
    engineName: "preferences--enable-gradual-ability-boosts",
    enabledInFoundry: (s) => s.gradualAbilityBoosts,
    issue:
      "This character uses the Gradual Ability Boosts variant, but it is not enabled in Foundry " +
      "(Game Settings → Pathfinder Second Edition → Toggle Variant Rules → Gradual Ability Boosts). " +
      "Attribute boosts may be off until it is enabled and the character is re-imported.",
  },
  {
    engineName: "preferences--enable-mythic",
    enabledInFoundry: (s) => s.mythic,
    issue:
      "This character uses the Mythic variant, but it is not enabled in Foundry " +
      "(Game Settings → Pathfinder Second Edition → Toggle Variant Rules → Mythic). " +
      "Mythic feats and abilities may be missing until it is enabled and the character is re-imported.",
  },
];

/** True when a Demiplane `preferences--…` flag engine is present and set to 1. */
function hasEnabledPreference(engines: DemiplaneEngineEntry[], name: string): boolean {
  return engines.some((e) => e.type === "CustomDemiplaneEngine" && e.name === name && e.value === 1);
}

/**
 * Returns an issue message for each variant rule the character depends on that
 * is not enabled in the Foundry world. Empty when everything the character needs
 * is enabled (or the character uses no variants).
 */
export function findVariantMismatches(engines: DemiplaneEngineEntry[], settings: FoundryVariantSettings): string[] {
  return VARIANT_RULES.filter(
    (rule) => hasEnabledPreference(engines, rule.engineName) && !rule.enabledInFoundry(settings)
  ).map((rule) => rule.issue);
}
