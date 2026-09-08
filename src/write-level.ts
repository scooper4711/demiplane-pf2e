import { MODULE_ID } from "./import/types.js";

/**
 * How much of a linked character the module is allowed to write back to
 * Demiplane. Tiers are cumulative and ordered from least to most invasive, so a
 * higher tier permits everything a lower one does:
 *
 * - `none`                 — never write anything to Demiplane.
 * - `text`                 — text/value fields only: HP, hero points, currency,
 *                            languages, biography/appearance, organized play,
 *                            campaign notes.
 * - `text-quantity`        — the above plus item quantity and equipped state.
 * - `text-quantity-delete` — the above plus propagating inventory deletions.
 *
 * Deletions are the most dangerous write (they can remove an item from the
 * Demiplane sheet), so they sit at the top tier and are additionally guarded by
 * a per-delete confirmation prompt (see `hook-manager`).
 */
export type WriteLevel = "none" | "text" | "text-quantity" | "text-quantity-delete";

/** The world-scoped setting key holding the active {@link WriteLevel}. */
export const WRITE_LEVEL_SETTING = "syncWriteLevel";

/** The default for a fresh install: write nothing until the GM opts in. */
export const DEFAULT_WRITE_LEVEL: WriteLevel = "none";

/**
 * Human-readable labels for the settings dropdown, keyed by tier. Exported so
 * the settings registration and any UI share one source of truth.
 */
export const WRITE_LEVEL_LABELS: Record<WriteLevel, string> = {
  none: "No writing to Demiplane",
  text: "Text fields only (HP, currency, languages, biography)",
  "text-quantity": "Text fields + item quantity/equipped",
  "text-quantity-delete": "Text fields + quantity + item deletions",
};

/** Tier rank for cumulative comparisons; higher permits everything lower. */
const WRITE_LEVEL_RANK: Record<WriteLevel, number> = {
  none: 0,
  text: 1,
  "text-quantity": 2,
  "text-quantity-delete": 3,
};

/** Reads the active write level from settings, defaulting to the safest tier. */
export function getWriteLevel(): WriteLevel {
  const raw = game.settings.get(MODULE_ID, WRITE_LEVEL_SETTING);
  return isWriteLevel(raw) ? raw : DEFAULT_WRITE_LEVEL;
}

function isWriteLevel(value: unknown): value is WriteLevel {
  return typeof value === "string" && value in WRITE_LEVEL_RANK;
}

/** Whether the active tier permits writing at least `required`. */
function permits(required: WriteLevel): boolean {
  return WRITE_LEVEL_RANK[getWriteLevel()] >= WRITE_LEVEL_RANK[required];
}

/** Whether text/value fields (HP, currency, languages, biography, …) may be pushed. */
export function canWriteText(): boolean {
  return permits("text");
}

/** Whether item quantity and equipped-state changes may be pushed. */
export function canWriteQuantity(): boolean {
  return permits("text-quantity");
}

/** Whether an inventory item's deletion may be propagated to Demiplane. */
export function canWriteDeletes(): boolean {
  return permits("text-quantity-delete");
}

/**
 * The world-scoped setting key for soft-delete mode. When enabled, deleting an
 * inventory item sets its Demiplane quantity to 0 (a reversible marker Demiplane
 * itself supports) instead of removing the item engine outright — and the
 * importer then skips quantity-0 items so they stay gone until topped back up.
 *
 * Only meaningful when deletions are actually written (the top write level);
 * with soft-delete off, a deletion removes the item as before.
 */
export const SOFT_DELETE_SETTING = "syncSoftDelete";

/**
 * Whether soft-delete mode is active: deletions are written AND the user has
 * opted to represent them as quantity 0 rather than removing the item. Returns
 * false unless deletions are permitted, so the flag can't take effect at a lower
 * write level where deletions aren't written at all.
 */
export function isSoftDeleteEnabled(): boolean {
  return canWriteDeletes() && game.settings.get(MODULE_ID, SOFT_DELETE_SETTING) === true;
}
