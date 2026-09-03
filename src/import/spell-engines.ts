import type { DemiplaneEngineEntry } from "./types.js";

/**
 * PF2e-specific engine args for spell entries.
 * Extends the generic args shape with spell-related properties
 * used by the Demiplane character builder for Pathfinder 2e.
 */
interface Pf2eSpellEngineArgs {
  /** Identifier for the spell slot this engine occupies. */
  spellSlot?: string;
}

/**
 * Finds all spell-related engines by matching names that start with "tabula/spell/".
 * @param engines - The array of engine entries to search.
 * @returns An array of engine entries representing spells.
 */
export function findSpellEngines(engines: DemiplaneEngineEntry[]): DemiplaneEngineEntry[] {
  return engines.filter((e) => e.name.startsWith("tabula/spell/"));
}

/**
 * Checks whether a spell engine represents a curriculum (wizard school) spell
 * by inspecting its spell slot identifier.
 * @param engine - The engine entry to check.
 * @returns `true` if the engine's spell slot contains "wizard-school-spellbook-slot".
 */
export function isCurriculumSpell(engine: DemiplaneEngineEntry): boolean {
  const args = engine.args as Pf2eSpellEngineArgs;
  const slot = args.spellSlot;
  return typeof slot === "string" && slot.includes("wizard-school-spellbook-slot");
}
