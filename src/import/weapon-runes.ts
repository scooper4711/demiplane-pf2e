import type { DemiplaneEngineEntry } from "./types.js";

/**
 * Fundamental and property runes affixed to a single weapon, in the shape the
 * PF2e system stores on `weapon.system.runes`.
 */
export interface WeaponRunes {
  potency: number;
  striking: number;
  property: string[];
}

/** Marks an item engine that is a rune affixed to another item, not a standalone item. */
const RUNE_META_ITEM_TYPE = "item-rune";

/** `weapon-potency-<n>-rm` → the potency value <n>. */
const POTENCY_SLUG_RE = /^weapon-potency-(\d+)/;

/**
 * Demiplane striking-rune slugs → PF2e striking value. Striking grades are a
 * small fixed set, so a lookup table is clearer than parsing.
 */
const STRIKING_VALUES: Record<string, number> = {
  "striking-basic": 1,
  striking: 1,
  "striking-greater": 2,
  "striking-major": 3,
  "striking-mythic": 4,
};

/**
 * Grade prefixes that PF2e places at the *front* of a property-rune slug, while
 * Demiplane places them at the *end* (e.g. `corrosive-greater` → `greaterCorrosive`).
 */
const GRADE_WORDS = new Set(["greater", "major", "true", "lesser", "moderate", "supreme"]);

/**
 * Validates that a candidate PF2e property-rune slug is real. Injectable so the
 * transform can be unit-tested without a live `game`; defaults to the PF2e
 * system's localization registry, which has a `PF2E.WeaponPropertyRune.<slug>.Name`
 * key for every valid rune.
 */
export type PropertyRuneValidator = (slug: string) => boolean;

/** Default validator: a rune slug is valid iff PF2e has a name localization for it. */
export function defaultPropertyRuneValidator(slug: string): boolean {
  const key = `PF2E.WeaponPropertyRune.${slug}.Name`;
  const i18n = (globalThis as { game?: { i18n?: { has?: (k: string) => boolean } } }).game?.i18n;
  return i18n?.has?.(key) ?? false;
}

/** Strips the trailing "-rm" (remaster) suffix from a Demiplane rune slug. */
function stripRemaster(slug: string): string {
  return slug.endsWith("-rm") ? slug.slice(0, -3) : slug;
}

/**
 * Converts a Demiplane property-rune slug to its PF2e camelCase slug by moving a
 * trailing grade word to the front and camelCasing the rest:
 *   `ghost-touch`      → `ghostTouch`
 *   `corrosive-greater`→ `greaterCorrosive`
 *   `shock-greater`    → `greaterShock`
 *
 * This is a general transform (no per-rune table), so newly released runes work
 * without code changes as long as they follow the naming convention. The result
 * is validated by the caller before use.
 */
export function toPropertyRuneSlug(demiplaneSlug: string): string {
  const words = stripRemaster(demiplaneSlug).split("-");
  const grades = words.filter((w) => GRADE_WORDS.has(w));
  const rest = words.filter((w) => !GRADE_WORDS.has(w));
  const ordered = [...grades, ...rest];
  return ordered.map((word, i) => (i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1))).join("");
}

/**
 * True when an item engine represents a rune affixed to a parent item rather
 * than a standalone inventory item.
 */
export function isRuneEngine(eng: DemiplaneEngineEntry): boolean {
  return eng.args?.metaItemType === RUNE_META_ITEM_TYPE;
}

/**
 * The `demiplaneEngineId` of the item a rune is affixed to. Matches the parent
 * weapon's `demiplaneEngineId` (the importer's item key).
 */
export function runeParentId(eng: DemiplaneEngineEntry): string | undefined {
  const parent = eng.args?.parentItemID ?? eng.args?.parentEngine;
  return typeof parent === "string" ? parent : undefined;
}

/**
 * Groups every rune engine by the id of the weapon it is affixed to, resolving
 * each rune slug to its effect on {@link WeaponRunes}. The returned map is keyed
 * by parent `demiplaneEngineId`.
 *
 * @param runeEngines - Item engines already filtered to runes ({@link isRuneEngine}).
 * @param onUnknown - Called with a Demiplane slug that could not be resolved to a rune.
 */
export function collectRunesByParent(
  runeEngines: DemiplaneEngineEntry[],
  onUnknown?: (slug: string) => void,
  isValidProperty: PropertyRuneValidator = defaultPropertyRuneValidator
): Map<string, WeaponRunes> {
  const byParent = new Map<string, WeaponRunes>();

  for (const eng of runeEngines) {
    const parentId = runeParentId(eng);
    const rawSlug = eng.args?.slug as string | undefined;
    if (!parentId || !rawSlug) continue;

    const runes = byParent.get(parentId) ?? { potency: 0, striking: 0, property: [] };
    applyRuneSlug(runes, rawSlug, isValidProperty, onUnknown);
    byParent.set(parentId, runes);
  }

  return byParent;
}

/** Applies a single Demiplane rune slug to an accumulating {@link WeaponRunes}. */
function applyRuneSlug(
  runes: WeaponRunes,
  rawSlug: string,
  isValidProperty: PropertyRuneValidator,
  onUnknown?: (slug: string) => void
): void {
  const slug = stripRemaster(rawSlug);

  const potency = POTENCY_SLUG_RE.exec(slug);
  if (potency?.[1]) {
    runes.potency = Math.max(runes.potency, Number(potency[1]));
    return;
  }

  const striking = STRIKING_VALUES[slug];
  if (striking !== undefined) {
    runes.striking = Math.max(runes.striking, striking);
    return;
  }

  // Property runes: derive the PF2e slug and keep it only if the system
  // recognizes it, so a bad transform surfaces as an issue instead of writing a
  // junk rune onto the weapon.
  const propertySlug = toPropertyRuneSlug(rawSlug);
  if (isValidProperty(propertySlug)) {
    if (!runes.property.includes(propertySlug)) runes.property.push(propertySlug);
    return;
  }

  onUnknown?.(rawSlug);
}
