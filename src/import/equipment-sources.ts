import { EQUIPMENT_PACK } from "../config.js";
import { EXPECTED_TYPES } from "./types.js";
import { findPacksWithItemTypes } from "./pack-discovery.js";
import type CompendiumCollection from "@client/documents/collections/compendium-collection.mjs";
import { getPackIndex, type PackIndex } from "./pack-index.js";

/** One searchable equipment source: the official pack first, third-party after. */
export interface EquipmentSource {
  packKey: string;
  pack: CompendiumCollection;
  index: PackIndex;
}

/**
 * Loads every equipment source: the official pack first (when installed),
 * then every other visible pack holding equipment item types. Official content
 * therefore resolves exactly as before; third-party packs only fill misses.
 */
export async function loadEquipmentSources(): Promise<EquipmentSource[]> {
  const keys = [
    EQUIPMENT_PACK,
    ...(await findPacksWithItemTypes(EXPECTED_TYPES.equipment)).filter((key) => key !== EQUIPMENT_PACK),
  ];
  const sources: EquipmentSource[] = [];
  for (const packKey of keys) {
    const pack = game.packs.get(packKey);
    if (!pack) continue;
    try {
      sources.push({ packKey, pack, index: await getPackIndex(pack, ["system.slug"]) });
    } catch {
      continue;
    }
  }
  return sources;
}

/** First source whose index holds the slug (official first), with the entry. */
export function findEquipmentEntry(
  sources: EquipmentSource[],
  slug: string
): { source: EquipmentSource; entry: { _id: string } } | undefined {
  for (const source of sources) {
    const entry = findBySlug(source.index, slug);
    if (entry) return { source, entry };
  }
  return undefined;
}

export function findBySlug(equipIndex: PackIndex, slug: string): { _id: string } | undefined {
  const exact = equipIndex.find((e) => e.system?.slug === slug);
  if (exact) return exact;

  const plural = `${slug}s`;
  const pluralMatch = equipIndex.find((e) => e.system?.slug === plural);
  if (pluralMatch) return pluralMatch;

  // Named ranked specialty scrolls/wands are normalized to end in `-Nth-rank`,
  // but most compendium entries carry a trailing `-spell` (e.g.
  // `wand-of-widening-9th-rank-spell`). A few (e.g. Legerdemain) don't, which the
  // exact match above already covers.
  if (/-\d+(?:st|nd|rd|th)-rank$/.test(slug)) {
    const withSpell = equipIndex.find((e) => e.system?.slug === `${slug}-spell`);
    if (withSpell) return withSpell;
  }

  const fallbackSlug = slug.replace(/-(basic|lesser|greater|moderate|major|superb)$/, "");
  if (fallbackSlug !== slug) {
    return equipIndex.find((e) => e.system?.slug === fallbackSlug);
  }
  return undefined;
}
