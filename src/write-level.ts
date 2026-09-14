import { MODULE_ID } from "./import/types.js";

/**
 * How much of a linked character the module is allowed to write back to
 * Demiplane. Tiers are cumulative and ordered from least to most invasive, so a
 * higher tier permits everything a lower one does:
 *
 * - `read-only` — never write anything to Demiplane (the default, suitable for
 *   Pathfinder Society play or whenever the GM lacks write access).
 * - `story`    — biography/appearance/personality/campaign details, languages,
 *   organized play ID, and campaign notes. Nothing inventory-related and
 *   nothing ending in "points".
 * - `session`  — the above plus session state: hit points (current and temp),
 *   hero points, focus points, currency, spell slots, item quantity/equipped/
 *   container state. Item deletion is represented as quantity 0 (soft delete,
 *   reversible, no confirmation prompt).
 * - `full`     — the above plus actual item deletion on Demiplane (behind an
 *   explicit confirmation prompt).
 *
 * Deletions are the most dangerous write (they can remove an item from the
 * Demiplane sheet), so real deletion sits at the top tier and is additionally
 * guarded by a per-delete confirmation prompt (see `hook-manager`). One tier
 * down, deletion only zeroes the quantity, which the importer skips so the
 * item stays gone until topped back up.
 */
export type WriteLevel = "read-only" | "story" | "session" | "full";

/** The world-scoped setting key holding the active {@link WriteLevel}. */
export const WRITE_LEVEL_SETTING = "syncWriteLevel";

/** The default for a fresh install: write nothing until the GM opts in. */
export const DEFAULT_WRITE_LEVEL: WriteLevel = "read-only";

/**
 * Human-readable labels for the settings dropdown, keyed by tier. Exported so
 * the settings registration and any UI share one source of truth.
 */
export const WRITE_LEVEL_LABELS: Record<WriteLevel, string> = {
  "read-only": "Read-only",
  story: "Story mode",
  session: "Session mode",
  full: "Full sync",
};

/**
 * What the hint under the “Write to Demiplane” dropdown says for each level.
 * Shown live in the settings UI so the GM sees exactly what the *currently
 * selected* value does without saving. Keep the copy short — the old block
 * that listed every tier at once is what the dynamic hint replaces.
 */
export const WRITE_LEVEL_DESCRIPTIONS: Record<WriteLevel, string> = {
  "read-only":
    "Nothing is written to Demiplane — the module only reads. Perfect for Pathfinder Society play or when you don’t have write access to the character.",
  story:
    "Biography and appearance, languages, organized play ID, and campaign notes can all be edited in Foundry and written to Demiplane. Inventory and any field ending in “points” (hit points, hero points, focus points) stays local.",
  session:
    "Everything in Story Mode, plus hit points (current & temp), hero and focus points, currency, spell slots, and inventory (quantity, equipped, containers).\nDeleting an item sets its Demiplane quantity to 0 — the importer skips quantity-0 items at this level so the item stays gone until you restore it.",
  full: "The same as Session Mode, but deleting an item actually removes it from Demiplane.",
};

/** Tier rank for cumulative comparisons; higher permits everything lower. */
const WRITE_LEVEL_RANK: Record<WriteLevel, number> = {
  "read-only": 0,
  story: 1,
  session: 2,
  full: 3,
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

/**
 * A single writable thing. Callers gate on capabilities — never on levels —
 * so renaming a level or moving a permission between levels only touches
 * {@link CAPABILITY_MIN_LEVEL} below.
 */
export type WriteCapability =
  | "biography"
  | "languages"
  | "organized-play"
  | "campaign-notes"
  | "hit-points"
  | "hero-points"
  | "focus-points"
  | "currency"
  | "spell-slots"
  | "inventory-quantity"
  | "inventory-equipped"
  | "inventory-container"
  | "inventory-soft-delete"
  | "inventory-delete";

/**
 * The minimum level permitting each capability. This table is the only place
 * that maps capabilities to levels: to rename levels, keep the keys and change
 * the values; to move a permission, change that capability's value.
 */
export const CAPABILITY_MIN_LEVEL: Record<WriteCapability, WriteLevel> = {
  biography: "story",
  languages: "story",
  "organized-play": "story",
  "campaign-notes": "story",
  "hit-points": "session",
  "hero-points": "session",
  "focus-points": "session",
  currency: "session",
  "spell-slots": "session",
  "inventory-quantity": "session",
  "inventory-equipped": "session",
  "inventory-container": "session",
  "inventory-soft-delete": "session",
  "inventory-delete": "full",
};

/** Whether the active level permits a given capability. */
export function canWrite(capability: WriteCapability): boolean {
  return permits(CAPABILITY_MIN_LEVEL[capability]);
}

/** Whether biography/appearance/personality/campaign detail fields may be written. */
export function canWriteBiography(): boolean {
  return canWrite("biography");
}

/** Whether the user-added language list may be written. */
export function canWriteLanguages(): boolean {
  return canWrite("languages");
}

/** Whether the organized play ID may be written. */
export function canWriteOrganizedPlayId(): boolean {
  return canWrite("organized-play");
}

/** Whether campaign notes (the "Campaign" journal entry) may be written. */
export function canWriteCampaignNotes(): boolean {
  return canWrite("campaign-notes");
}

/** Whether current and temporary hit points may be written. */
export function canWriteHitPoints(): boolean {
  return canWrite("hit-points");
}

/** Whether hero points may be written. */
export function canWriteHeroPoints(): boolean {
  return canWrite("hero-points");
}

/** Whether focus points may be written. */
export function canWriteFocusPoints(): boolean {
  return canWrite("focus-points");
}

/** Whether currency may be written. */
export function canWriteCurrency(): boolean {
  return canWrite("currency");
}

/** Whether spell slot / cast state may be written. */
export function canWriteSpellSlots(): boolean {
  return canWrite("spell-slots");
}

/** Whether item quantity may be written. */
export function canWriteInventoryQuantity(): boolean {
  return canWrite("inventory-quantity");
}

/** Whether item equipped state may be written. */
export function canWriteInventoryEquipped(): boolean {
  return canWrite("inventory-equipped");
}

/** Whether item container placement may be written. */
export function canWriteInventoryContainer(): boolean {
  return canWrite("inventory-container");
}

/** Whether a deleted item may be soft-deleted (quantity 0) on Demiplane. */
export function canSoftDeleteInventory(): boolean {
  return canWrite("inventory-soft-delete");
}

/** Whether a deleted item may actually be deleted on Demiplane. */
export function canDeleteInventory(): boolean {
  return canWrite("inventory-delete");
}

/**
 * Whether writing to Demiplane is enabled at all (any level above read-only).
 * The master switch for every push path; per-capability gates apply at queue
 * time. Compares ranks rather than naming a tier so middle tiers rename freely.
 */
export function isWritingEnabled(): boolean {
  return WRITE_LEVEL_RANK[getWriteLevel()] > WRITE_LEVEL_RANK["read-only"];
}

/** Capabilities that make up adventuring-day session state. */
const SESSION_STATE_CAPABILITIES: WriteCapability[] = [
  "hit-points",
  "hero-points",
  "focus-points",
  "currency",
  "spell-slots",
  "inventory-quantity",
  "inventory-equipped",
  "inventory-container",
];

/**
 * Whether any adventuring-day session state is being written. Used by conflict
 * recovery: when session state already lives on Demiplane, a re-import pulls it
 * back, so an automatic re-import is safe; otherwise warn and leave the actor
 * untouched. Checks capabilities, not levels, so moving a permission flows
 * through automatically.
 */
export function canWriteSessionState(): boolean {
  return SESSION_STATE_CAPABILITIES.some((capability) => canWrite(capability));
}

/**
 * Whether the importer should skip quantity-0 items (treating them as
 * soft-deleted). Only true at exactly the session tier: that is the only tier
 * that writes deletions as quantity 0. At every other tier a 0 is a real
 * quantity (e.g. a consumable the player tops up in town) and imports as-is —
 * including at full sync, where deletions remove the engine outright so there
 * is nothing to skip.
 */
export function shouldSkipZeroQuantityItems(): boolean {
  return getWriteLevel() === "session";
}
