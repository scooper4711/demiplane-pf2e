export const MODULE_ID = "demiplane-pf2e";

/**
 * PF2e item `type`s that represent carriable inventory (physical items). A
 * character can legitimately own several of the same one (four wands, three
 * potions), so these are treated differently from feats/features when detecting
 * duplicates or propagating deletions. Single source of truth for both the
 * import dedup (phases.ts) and the export delete guard (hook-manager.ts).
 */
export const INVENTORY_ITEM_TYPES = new Set([
  "ammo",
  "armor",
  "backpack",
  "book",
  "consumable",
  "equipment",
  "kit",
  "shield",
  "treasure",
  "weapon",
]);

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
  /**
   * ChoiceSets no automatic strategy could resolve (and no valid user override
   * covered). Carried so the sync dialog can offer them for a manual pick;
   * human-readable text is derived at render time, never stored.
   */
  unresolvedChoices: UnresolvedChoice[];
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
  /**
   * For feats, a human-readable slot label (e.g. "Skill feat (level 2)") derived
   * from the Demiplane sourceRow. Display context to help a GM recognize a feat
   * whose slug doesn't match its sheet name — not part of the mapping key.
   */
  slot?: string;
}

/** The single place the human-readable form of an unmapped slug comes from. */
export function formatUnmapped(record: UnmappedSlug): string {
  const suffix = record.slot ? ` (${record.slot})` : "";
  return `Could not import ${record.kind} "${record.slug}"${suffix}: not found in compendium`;
}

/**
 * Stable identity for one ChoiceSet on one actor: the owning item's slug plus
 * the rule's own selection flag. The flag is stable per rule definition (unlike
 * array index or prompt text) and the item slug disambiguates items that reuse
 * generic flag names like "choice".
 */
export type ChoiceKey = string;

/** A per-actor user pick for a ChoiceSet, keyed by {@link ChoiceKey}. */
export type ChoiceOverrides = Record<ChoiceKey, string>;

/**
 * A ChoiceSet the automatic strategies could not resolve, recorded for the
 * sync dialog. `source` says how it was applied this import: a blind
 * `choices[0]` guess (needs the user's input) or a stored user pick (in
 * effect; deletable). Records are replaced wholesale each import.
 */
export interface UnresolvedChoice {
  /** Stable identity for this ChoiceSet on this actor (see {@link ChoiceKey}). */
  key: ChoiceKey;
  /** How this ChoiceSet was applied: blind guess or stored user pick. */
  source: "guess" | "override";
  /** Human label: the ChoiceSet prompt, or the granting item's name. */
  prompt: string;
  /** The options to offer, with serializable values for matching. */
  options: { value: string; label: string }[];
  /** What the blind `choices[0]` fallback applied or would apply, for display ("we guessed X"). */
  guessedValue: string | null;
}

/**
 * Stamp an item data object with the imported flag before creation.
 *
 * `demiplaneEngineId` is the item engine's unique Demiplane id. Unlike the slug
 * (shared by every item of the same base type — two backpacks are both
 * `backpack-rm`), it identifies this specific item instance, so the export can
 * resolve which container an item was stowed in even when several containers
 * share a slug.
 */
export function stampImported(
  itemData: Record<string, unknown>,
  demiplaneSlug?: string,
  demiplaneEngineId?: string
): Record<string, unknown> {
  const flags = (itemData.flags || {}) as Record<string, Record<string, unknown>>;
  const dpFlags: Record<string, unknown> = { ...flags["demiplane-pf2e"], imported: true };
  if (demiplaneSlug) dpFlags.demiplaneSlug = demiplaneSlug;
  if (demiplaneEngineId) dpFlags.demiplaneEngineId = demiplaneEngineId;
  flags["demiplane-pf2e"] = dpFlags;
  itemData.flags = flags;
  return itemData;
}
