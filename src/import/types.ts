export const MODULE_ID = "demiplane-pf2e";

export const PACKS = [
  "pf2e.classes",
  "pf2e.ancestries",
  "pf2e.heritages",
  "pf2e.backgrounds",
  "pf2e.feats-srd",
  "pf2e.spells-srd",
  "pf2e.equipment-srd",
  "pf2e.classfeatures",
] as const;

export interface ImportOptions {
  token?: string;
}

export interface ImportSummary {
  itemsImported: number;
  itemsSkipped: number;
  /**
   * Slugs that could not be resolved to a compendium item. These are the single
   * source of truth for unmapped slugs — human-readable text is derived from them
   * via `formatUnmapped` rather than stored alongside.
   */
  unmapped: UnmappedSlug[];
  errors: string[];
  log: string[];
}

export interface DemiplaneEngineEntry {
  id: string;
  name: string;
  type: "DemiplaneEngine" | "CustomDemiplaneEngine";
  args: Record<string, unknown>;
  value?: string | number | boolean;
  [key: string]: unknown;
}

export type ItemCategory = "ancestry" | "heritage" | "background" | "class" | "feat" | "equipment";

/**
 * The kind of thing an unresolved slug was. Extends `ItemCategory` with `spell`,
 * which resolves through the spells compendium rather than the generic lookup.
 */
export type SlugKind = ItemCategory | "spell";

/** A Demiplane slug that could not be matched to a compendium item. */
export interface UnmappedSlug {
  /** Demiplane slug as it arrived (e.g. "religious-symbol-rm"). */
  slug: string;
  /** What kind of thing it was, for grouping and compendium-browser selection. */
  kind: SlugKind;
}

/** The single place the human-readable form of an unmapped slug comes from. */
export function formatUnmapped(record: UnmappedSlug): string {
  return `Could not import ${record.kind} "${record.slug}": not found in compendium`;
}

/** Stamp an item data object with the imported flag before creation. */
export function stampImported(itemData: Record<string, unknown>, demiplaneSlug?: string): Record<string, unknown> {
  const flags = (itemData.flags || {}) as Record<string, Record<string, unknown>>;
  const dpFlags: Record<string, unknown> = { ...flags["demiplane-pf2e"], imported: true };
  if (demiplaneSlug) dpFlags.demiplaneSlug = demiplaneSlug;
  flags["demiplane-pf2e"] = dpFlags;
  itemData.flags = flags;
  return itemData;
}
