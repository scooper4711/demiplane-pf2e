import type { DemiplaneEngineEntry } from "./types.js";

/**
 * PF2e-specific engine args for spell entries.
 * Extends the generic args shape with spell-related properties
 * used by the Demiplane character builder for Pathfinder 2e.
 */
export interface Pf2eSpellEngineArgs {
  /** Identifier for the spell slot this engine occupies. */
  spellSlot?: string;
  /** Reference to the parent spell feature engine. */
  parentSpellFeature?: string;
  /** Whether this engine represents a prepared spell. */
  isPrepare?: boolean;
  /** Additional spell data for spellbook entries. */
  addSpellData?: { baseSpellbookSpell: boolean };
}

/**
 * Finds all spell-related engines by matching names that start with "tabula/spell/".
 * @param engines - The array of engine entries to search.
 * @returns An array of engine entries representing spells.
 */
export function findSpellEngines(
  engines: DemiplaneEngineEntry[],
): DemiplaneEngineEntry[] {
  return engines.filter((e) => e.name.startsWith("tabula/spell/"));
}

/**
 * Finds all spellbook spell engines (spells marked as base spellbook entries).
 * @param engines - The array of engine entries to search.
 * @returns An array of engine entries that are base spellbook spells.
 */
export function findSpellbookSpells(
  engines: DemiplaneEngineEntry[],
): DemiplaneEngineEntry[] {
  return findSpellEngines(engines).filter((e) => {
    const args = e.args as Pf2eSpellEngineArgs;
    return args.addSpellData?.baseSpellbookSpell === true;
  });
}

/**
 * Finds all prepared spell engines.
 * @param engines - The array of engine entries to search.
 * @returns An array of engine entries marked as prepared spells.
 */
export function findPreparedSpells(
  engines: DemiplaneEngineEntry[],
): DemiplaneEngineEntry[] {
  return findSpellEngines(engines).filter((e) => {
    const args = e.args as Pf2eSpellEngineArgs;
    return args.isPrepare === true;
  });
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
  return (
    typeof slot === "string" && slot.includes("wizard-school-spellbook-slot")
  );
}
