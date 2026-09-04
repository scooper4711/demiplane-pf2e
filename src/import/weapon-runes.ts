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
 * Demiplane property-rune slugs → PF2e property-rune slug (camelCase). Extend as
 * property runes are encountered; unknown property runes are reported rather
 * than guessed, since the PF2e slug is not a mechanical transform of the
 * Demiplane one.
 */
const PROPERTY_RUNE_SLUGS: Record<string, string> = {};

/** Strips the trailing "-rm" (remaster) suffix from a Demiplane rune slug. */
function stripRemaster(slug: string): string {
  return slug.endsWith("-rm") ? slug.slice(0, -3) : slug;
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
  onUnknown?: (slug: string) => void
): Map<string, WeaponRunes> {
  const byParent = new Map<string, WeaponRunes>();

  for (const eng of runeEngines) {
    const parentId = runeParentId(eng);
    const rawSlug = eng.args?.slug as string | undefined;
    if (!parentId || !rawSlug) continue;

    const runes = byParent.get(parentId) ?? { potency: 0, striking: 0, property: [] };
    applyRuneSlug(runes, rawSlug, onUnknown);
    byParent.set(parentId, runes);
  }

  return byParent;
}

/** Applies a single Demiplane rune slug to an accumulating {@link WeaponRunes}. */
function applyRuneSlug(runes: WeaponRunes, rawSlug: string, onUnknown?: (slug: string) => void): void {
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

  const property = PROPERTY_RUNE_SLUGS[slug];
  if (property) {
    if (!runes.property.includes(property)) runes.property.push(property);
    return;
  }

  onUnknown?.(rawSlug);
}
