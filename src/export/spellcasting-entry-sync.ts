import { MODULE_ID } from "../import/types.js";
import type { ExportManager } from "../export-manager.js";
import { itemSystem, type Pf2eSpellSlotRank } from "../pf2e-types.js";
import { canWriteQuantity } from "../write-level.js";

/**
 * Export sync for spellcasting-entry slot state. Two independent concerns share
 * the entry's `system.slots` update:
 *
 * - Prepared casters (wizard/cleric) track individual cast spells via a
 *   `prepared[i].expended` toggle → Demiplane's `<preparedEngineId>-is-cast`
 *   flag. Rides the quantity tier (like item quantity/equipped).
 * - Spontaneous casters (bard/sorcerer) track remaining casts per rank via
 *   `slot{rank}.value` → Demiplane's
 *   `character_spell-feature_{feature}_spell-slots_rank-{N}_current`. Rides the
 *   text tier (the lowest, like HP/hero points/focus).
 *
 * The two are distinguished by import-stamped flags: `preparedSlotEngineIds`
 * (prepared) and `spellFeature` (spontaneous). An entry may carry either.
 */

/** A spellcasting entry's per-rank slots, keyed `slot{rank}`, as read live. */
type LiveSlots = Record<string, Pf2eSpellSlotRank>;

/** The import-stamped `slot{rank}` → prepared-engine-id map, if any. */
function preparedSlotEngineIds(item: Item): Record<string, string[]> | undefined {
  const flags = (item.flags?.[MODULE_ID] as { preparedSlotEngineIds?: unknown } | undefined) ?? {};
  const map = flags.preparedSlotEngineIds;
  return typeof map === "object" && map !== null ? (map as Record<string, string[]>) : undefined;
}

/** The import-stamped spellcasting feature slug, if any. */
export function readSpellFeature(item: Item): string | undefined {
  const flags = (item.flags?.[MODULE_ID] as { spellFeature?: unknown } | undefined) ?? {};
  return typeof flags.spellFeature === "string" ? flags.spellFeature : undefined;
}

/** The numeric rank from a `slot{N}` key, or undefined when it isn't one. */
export function parseSlotRank(slotKey: string): number | undefined {
  const match = /^slot(\d+)$/.exec(slotKey);
  return match ? Number(match[1]) : undefined;
}

/** The Demiplane remaining-slot engine name for a feature and rank. */
export function slotEngineName(feature: string, rank: number): string {
  return `character_spell-feature_${feature}_spell-slots_rank-${String(rank)}_current`;
}

/** The live per-rank slots off the entry, or undefined. */
function liveSlotsOf(item: Item): LiveSlots | undefined {
  return itemSystem(item).slots;
}

function changedSlotsOf(changes: Record<string, unknown>): Record<string, unknown> | undefined {
  const slots = getNested(changes, "system.slots");
  return typeof slots === "object" && slots !== null ? (slots as Record<string, unknown>) : undefined;
}

/**
 * Queues the slot changes carried by a spellcasting-entry update. Both concerns
 * are spent-resource tracking ("spell ammo"), so both ride the quantity tier —
 * gated here since the caller routes spellcasting entries around the
 * physical-item quantity guard.
 */
export function queueSpellcastingEntryChanges(
  exportManager: ExportManager,
  actor: Actor,
  item: Item,
  changes: Record<string, unknown>
): void {
  if (!canWriteQuantity()) return;
  const changedSlots = changedSlotsOf(changes);
  if (!changedSlots) return;

  if (preparedSlotEngineIds(item)) {
    queueCastChanges(exportManager, actor, item, changedSlots);
  }
  if (readSpellFeature(item)) {
    queueSpontaneousSlotChanges(exportManager, actor, item, changedSlots);
  }
}

/**
 * Queues a `cast` change for each prepared slot whose `expended` toggled. The
 * entry's `preparedSlotEngineIds` map resolves a slot position (rank + index) to
 * the prepared engine whose `-is-cast` flag the push should set.
 */
function queueCastChanges(
  exportManager: ExportManager,
  actor: Actor,
  item: Item,
  changedSlots: Record<string, unknown>
): void {
  const slotEngineIds = preparedSlotEngineIds(item);
  if (!slotEngineIds) return;
  const liveSlots = liveSlotsOf(item);

  for (const [slotKey, slotChange] of Object.entries(changedSlots)) {
    const prepared = (slotChange as { prepared?: Record<string, { expended?: boolean }> }).prepared;
    const engineIds = slotEngineIds[slotKey];
    if (!prepared || !engineIds) continue;

    // `prepared` may arrive as an array or an index-keyed object; iterate entries.
    for (const [indexKey, slot] of Object.entries(prepared)) {
      const engineId = engineIds[Number(indexKey)];
      if (!engineId) continue;
      const expended = resolveExpended(slot, liveSlots, slotKey, Number(indexKey));
      exportManager.queueItemChange(actor, engineId, engineId, "cast", { expended }, "spell");
    }
  }
}

/**
 * Queues the remaining count for each ranked slot whose `value` changed, as the
 * feature's `..._rank-{N}_current` engine. Cantrips (rank 0) are at-will and
 * skipped.
 */
function queueSpontaneousSlotChanges(
  exportManager: ExportManager,
  actor: Actor,
  item: Item,
  changedSlots: Record<string, unknown>
): void {
  const feature = readSpellFeature(item);
  if (!feature) return;
  const liveSlots = liveSlotsOf(item);

  for (const [slotKey, slotChange] of Object.entries(changedSlots)) {
    const rank = parseSlotRank(slotKey);
    if (rank === undefined || rank < 1) continue;
    const value = resolveSlotValue(slotChange, liveSlots, slotKey);
    if (value === undefined) continue;
    exportManager.queueChange(actor, slotEngineName(feature, rank), value);
  }
}

/**
 * Queues a spontaneous entry's current remaining slot counts for a full re-sync
 * push (the manual "Update to Demiplane"). Only entries stamped with a feature
 * slug contribute. The caller enforces the quantity tier.
 */
export function queueSpellSlotResync(exportManager: ExportManager, actor: Actor, item: Item): void {
  if ((item as { type?: string }).type !== "spellcastingEntry") return;
  const feature = readSpellFeature(item);
  if (!feature) return;

  const slots = liveSlotsOf(item) ?? {};
  for (const [slotKey, slot] of Object.entries(slots)) {
    const rank = parseSlotRank(slotKey);
    if (rank === undefined || rank < 1) continue;
    if (typeof slot?.value !== "number") continue;
    exportManager.queueChange(actor, slotEngineName(feature, rank), slot.value);
  }
}

/**
 * The effective expended state for a changed prepared slot: the changed value if
 * present, else the live slot's value (a partial update may omit `expended`, so
 * fall back to current state rather than assuming false).
 */
function resolveExpended(
  slotChange: { expended?: boolean },
  liveSlots: LiveSlots | undefined,
  slotKey: string,
  index: number
): boolean {
  if (typeof slotChange.expended === "boolean") return slotChange.expended;
  const live = liveSlots?.[slotKey]?.prepared?.[index]?.expended;
  return typeof live === "boolean" ? live : false;
}

/**
 * The effective remaining-slot value for a changed rank: the changed value when
 * present, else the live slot's value; undefined when neither is a number.
 */
function resolveSlotValue(slotChange: unknown, liveSlots: LiveSlots | undefined, slotKey: string): number | undefined {
  const changed = (slotChange as { value?: unknown }).value;
  if (typeof changed === "number") return changed;
  const live = liveSlots?.[slotKey]?.value;
  return typeof live === "number" ? live : undefined;
}

/** Reads a dotted path off a change payload (mirrors HookManager.getNestedValue). */
function getNested(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
