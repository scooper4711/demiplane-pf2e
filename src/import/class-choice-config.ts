import type { DemiplaneEngineEntry } from "./types.js";
import { toFoundrySlug } from "./slug-utils.js";

/**
 * Per-class ChoiceSet matching data. Classes with chained, gated, or
 * otherwise unusual ChoiceSets (kineticist gates first) declare their
 * conventions here so matchers read configuration instead of literals.
 * A class with no entry uses only the generic strategies.
 */
export interface ClassChoiceConfig {
  /** Demiplane class slug, e.g. "kineticist". */
  classSlug: string;
  /** What's covered and what remains a known gap. */
  notes: string;
}

const configs = new Map<string, ClassChoiceConfig>();

/** Registers a class's choice configuration. Idempotent by class slug. */
export function registerClassChoices(config: ClassChoiceConfig): void {
  if (!configs.has(config.classSlug)) configs.set(config.classSlug, config);
}

/** Looks up the choice configuration for a class slug, if any. */
export function choiceConfigForClass(classSlug: string): ClassChoiceConfig | null {
  return configs.get(classSlug) ?? null;
}

/**
 * Finds the character's choice configuration from its class engine
 * (`tabula/class/<slug>.eng`), or null for classes without one.
 */
export function choiceConfigForEngines(engines: DemiplaneEngineEntry[]): ClassChoiceConfig | null {
  for (const engine of engines) {
    const match = /^tabula\/class\/(.+)\.eng$/.exec(engine.name);
    if (!match?.[1]) continue;
    const config = choiceConfigForClass(toFoundrySlug(match[1]));
    if (config) return config;
  }
  return null;
}
