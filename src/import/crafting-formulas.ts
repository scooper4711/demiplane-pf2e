import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { isFormulaEngine, normalizeEquipmentSlug, rawEquipmentSlug } from "./slug-utils.js";
import { findBySlug, loadEquipmentSources, type EquipmentSource } from "./equipment-sources.js";
import { resolveMappedItem, recordResolvedMapping, getMapping } from "../slug-mapping.js";
import { debugLog } from "./debug-log.js";

/**
 * Importing PF2e crafting formulas. A known formula arrives from Demiplane as a
 * `tabula/item/*` engine (like equipment) tagged `metaItemType: "formula"`, but
 * it isn't inventory: PF2e keeps known formulas under `system.crafting.formulas`
 * as `{ uuid }` entries pointing at the craftable item. This routes them there,
 * resolving the item exactly the way equipment does.
 */

/** One entry in PF2e's `system.crafting.formulas` — the UUID of a craftable item. */
interface CraftingFormula {
  uuid: string;
}

/**
 * Records the character's known crafting formulas on the actor.
 *
 * Each formula's item resolves exactly like equipment (a GM mapping wins, then
 * the equipment compendium), and an unresolved one is surfaced for the GM to map
 * — the same path an unrecognized item takes. Existing formulas are preserved
 * and the merge is deduped by uuid, so re-import never adds a duplicate or drops
 * a formula the player added by hand.
 */
export async function applyCraftingFormulas(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const formulaEngines = engines.filter(
    (e) => e.type === "DemiplaneEngine" && e.name.startsWith("tabula/item/") && isFormulaEngine(e)
  );
  if (formulaEngines.length === 0) return;

  const sources = await loadEquipmentSources();
  if (sources.length === 0) {
    summary.errors.push("No equipment compendium found");
    return;
  }

  const resolvedUuids: string[] = [];
  for (const eng of formulaEngines) {
    const uuid = await resolveFormulaUuid(eng, sources, summary);
    if (uuid) resolvedUuids.push(uuid);
  }
  if (resolvedUuids.length === 0) return;

  const merged = mergeFormulas(currentFormulas(actor), resolvedUuids);
  await actor.update({ "system.crafting.formulas": merged });
  summary.log.push(`+ formulas: ${resolvedUuids.length}`);
}

/** The actor's current known formulas, or an empty list when none are set. */
function currentFormulas(actor: Actor): CraftingFormula[] {
  const crafting = (actor as { system?: { crafting?: { formulas?: CraftingFormula[] } } }).system?.crafting;
  return Array.isArray(crafting?.formulas) ? crafting.formulas : [];
}

/** Adds the resolved formula UUIDs to the existing set, deduping by uuid. */
function mergeFormulas(existing: CraftingFormula[], addUuids: string[]): CraftingFormula[] {
  const byUuid = new Map(existing.map((formula) => [formula.uuid, formula]));
  for (const uuid of addUuids) {
    if (!byUuid.has(uuid)) byUuid.set(uuid, { uuid });
  }
  return [...byUuid.values()];
}

/**
 * Resolves a formula engine to the compendium UUID of the item it crafts,
 * reusing the equipment resolution: a GM mapping wins, then the equipment
 * sources (official first) by normalized slug. Records the resolution so it's
 * editable, or surfaces the slug as unmapped (kind "equipment") when nothing
 * matches — the GM then maps it from the Equipment section like any other
 * unresolved item.
 */
async function resolveFormulaUuid(
  eng: DemiplaneEngineEntry,
  sources: EquipmentSource[],
  summary: ImportSummary
): Promise<string | null> {
  const demiplaneSlug = rawEquipmentSlug(eng);

  const mapped = await resolveMappedItem("equipment", demiplaneSlug);
  if (mapped) return getMapping("equipment", demiplaneSlug)?.uuid ?? null;

  for (const source of sources) {
    const indexEntry = findBySlug(source.index, normalizeEquipmentSlug(demiplaneSlug));
    if (!indexEntry) continue;
    const uuid = `Compendium.${source.packKey}.Item.${indexEntry._id}`;
    const name = (eng.args?.name as string | undefined) || demiplaneSlug;
    await recordResolvedMapping("equipment", demiplaneSlug, { uuid, name });
    return uuid;
  }

  debugLog(`[formula] "${demiplaneSlug}" did not resolve in any equipment source; recorded as unmapped`);
  summary.unmapped.push({ slug: demiplaneSlug, kind: "equipment" });
  return null;
}
