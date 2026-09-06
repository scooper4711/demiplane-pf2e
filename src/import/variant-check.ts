import type { DemiplaneEngineEntry } from "./types.js";

/** The Foundry-side state of the variant rules an imported character may depend on. */
export interface FoundryVariantSettings {
  /** `game.pf2e.settings.variants.gab` — Gradual Attribute Boosts. */
  gradualAbilityBoosts: boolean;
  /** `game.pf2e.settings.campaign.mythic !== "disabled"` — Mythic Rules. */
  mythic: boolean;
  /** `game.pf2e.settings.variants.fa` — Free Archetype. */
  freeArchetype: boolean;
}

/** A variant rule tracked on both sides, with the labels used in its mismatch message. */
interface VariantRule {
  /** The Demiplane `preferences--…` custom engine name. */
  engineName: string;
  /** Whether the corresponding Foundry setting is enabled. */
  enabledInFoundry: (settings: FoundryVariantSettings) => boolean;
  /** Display name of the rule (as shown in Foundry's Toggle Variant Rules). */
  label: string;
  /** What may go wrong when the character uses it but Foundry doesn't. */
  consequenceWhenMissing: string;
}

/** Where these variant rules are toggled in Foundry. */
const FOUNDRY_SETTINGS_PATH = "Game Settings → Pathfinder Second Edition → Toggle Variant Rules";
/** Where these variant rules are toggled in Demiplane. */
const DEMIPLANE_SETTINGS_PATH = "Character Builder → Getting Started → Preferences & Rules";

const VARIANT_RULES: VariantRule[] = [
  {
    engineName: "preferences--enable-gradual-ability-boosts",
    enabledInFoundry: (s) => s.gradualAbilityBoosts,
    label: "Gradual Attribute Boosts",
    consequenceWhenMissing: "Attribute boosts may be applied incorrectly",
  },
  {
    engineName: "preferences--enable-mythic",
    enabledInFoundry: (s) => s.mythic,
    label: "Mythic Rules",
    consequenceWhenMissing: "Mythic feats and abilities may be missing",
  },
  {
    engineName: "preferences--enable-free-archetype",
    enabledInFoundry: (s) => s.freeArchetype,
    label: "Free Archetype",
    consequenceWhenMissing: "Free archetype feats may be misplaced or missing",
  },
];

/** True when a Demiplane `preferences--…` flag engine is present and set to 1. */
function usedInDemiplane(engines: DemiplaneEngineEntry[], name: string): boolean {
  return engines.some((e) => e.type === "CustomDemiplaneEngine" && e.name === name && e.value === 1);
}

/** The mismatch message for a rule, worded for whichever side has it enabled. */
function mismatchMessage(rule: VariantRule, demiplaneOn: boolean): string {
  if (demiplaneOn) {
    // Character uses it, Foundry doesn't: point at the Foundry setting to enable.
    return (
      `This character uses the ${rule.label} variant, but it is not enabled in Foundry. ` +
      `${rule.consequenceWhenMissing}. Enable "${rule.label}" at ${FOUNDRY_SETTINGS_PATH} and re-import, ` +
      `or turn it off in Demiplane (${DEMIPLANE_SETTINGS_PATH}).`
    );
  }
  // Foundry has it, character doesn't: point at the Demiplane setting.
  return (
    `The ${rule.label} variant is enabled in Foundry, but this character does not use it ` +
    `(the character may be built for the standard rules). Enable "${rule.label}" in Demiplane ` +
    `(${DEMIPLANE_SETTINGS_PATH}) and re-import, or turn it off at ${FOUNDRY_SETTINGS_PATH}.`
  );
}

/**
 * Returns an issue message for each variant rule whose Demiplane and Foundry
 * states disagree — in either direction (used in Demiplane but off in Foundry,
 * or on in Foundry but not used by the character). Empty when both sides agree.
 */
export function findVariantMismatches(engines: DemiplaneEngineEntry[], settings: FoundryVariantSettings): string[] {
  const issues: string[] = [];
  for (const rule of VARIANT_RULES) {
    const demiplaneOn = usedInDemiplane(engines, rule.engineName);
    const foundryOn = rule.enabledInFoundry(settings);
    if (demiplaneOn !== foundryOn) {
      issues.push(mismatchMessage(rule, demiplaneOn));
    }
  }
  return issues;
}
