/**
 * Single source of truth for spellcasting-feature identity: the base-class
 * config table (tradition/ability/prepared type) plus the special
 * `parentSpellFeature` slugs that route grants to non-repertoire entries
 * (hexes, apparition spells, spell runes) and the slug-normalization rules
 * that reconcile Demiplane's `-rm` / `-archetype` / bare-suffix variants.
 *
 * Consumers (spell-grouping's `configForFeature`, spell-importer's entry
 * naming, the feature-spell-resolver's grant categorization, and the
 * spell-slot-resolver's feature matching) all read from here so a new caster
 * or a renamed feature is a one-file change.
 */

/** Static per-class spellcasting config keyed by `parentSpellFeature` slug. */
export interface SpellcastingConfig {
  tradition: string;
  preparedType: "spontaneous" | "prepared";
  ability: string;
}

/**
 * Base-class spellcasting config by feature slug. Archetype features
 * (`*-archetype-rm`) are not listed: they reduce to their base class via
 * {@link baseSpellcastingSlug} and cast exactly like it. The summoner is also
 * absent — its tradition is the eidolon's, resolved dynamically by
 * spell-grouping — but its slug is still a known spellcasting feature.
 */
export const CLASS_SPELLCASTING: Record<string, SpellcastingConfig> = {
  "sorcerer-spellcasting-rm": { tradition: "arcane", preparedType: "spontaneous", ability: "cha" },
  "wizard-spellcasting-rm": { tradition: "arcane", preparedType: "prepared", ability: "int" },
  "bard-spellcasting-rm": { tradition: "occult", preparedType: "spontaneous", ability: "cha" },
  "cleric-spellcasting-rm": { tradition: "divine", preparedType: "prepared", ability: "wis" },
  "druid-spellcasting-rm": { tradition: "primal", preparedType: "prepared", ability: "wis" },
  "oracle-spellcasting-rm": { tradition: "divine", preparedType: "spontaneous", ability: "cha" },
  "witch-spellcasting-rm": { tradition: "occult", preparedType: "prepared", ability: "int" },
  "psychic-spellcasting-rm": { tradition: "occult", preparedType: "spontaneous", ability: "cha" },
  // Demiplane tags psychic spells with the bare feature (no -rm suffix).
  // Cha is the common key ability; an Int psychic would need a selection
  // signal Demiplane doesn't export.
  "psychic-spellcasting": { tradition: "occult", preparedType: "spontaneous", ability: "cha" },
  "magus-spellcasting-rm": { tradition: "arcane", preparedType: "prepared", ability: "int" },
  "animist-spellcasting-rm": { tradition: "divine", preparedType: "prepared", ability: "wis" },
  "necromancer-spellcasting-rm": { tradition: "occult", preparedType: "prepared", ability: "int" },
};

// ─── Special feature slugs (routing, not repertoire) ─────────────────────────

/** `parentSpellFeature` for summoner repertoire spells (tradition = eidolon's). */
export const SUMMONER_SPELLCASTING = "summoner-spellcasting-rm";

/**
 * Spellcasting tradition by eidolon (foundry slug). Per the eidolon rules, a
 * summoner's tradition is its eidolon's own. Only beast is covered by a live
 * fixture; the rest follow the rulebook (Player Core 2). A typo here silently
 * mis-traditions a summoner, so it is unit-tested per entry.
 */
export const EIDOLON_TRADITIONS: Record<string, string> = {
  angel: "divine",
  beast: "primal",
  construct: "arcane",
  demon: "divine",
  dragon: "arcane",
  fey: "primal",
  ghost: "occult",
  plant: "primal",
  psychopomp: "divine",
  undead: "occult",
};

/** The tradition an eidolon (foundry slug) grants its summoner, or null if unknown. */
export function eidolonTradition(eidolonSlug: string): string | null {
  return EIDOLON_TRADITIONS[eidolonSlug] ?? null;
}

/** `parentSpellFeature` for animist apparition grants (own spellcasting entry). */
export const APPARITION_SPELLCASTING = "apparition-spellcasting-rm";

/** Focus-group slug the witch's spellcasting feature declares for its hexes. */
export const HEX_FOCUS_GROUP = "hex-spells";

/**
 * Player-selected focus spells, keyed by the sourceRow marker Demiplane tags
 * the pick with. The witch's hexes borrow tradition/ability from the class at
 * import time; martial selections belong to no class spellcasting, so they
 * carry fixed values: devotion spells are divine/Cha, qi spells occult/Wis,
 * warden spells primal/Wis.
 */
export interface FocusSelectionConfig {
  /** Spellcasting-entry label, e.g. "Devotion Spells". */
  entryName: string;
  /** Fixed tradition; absent borrows the class config (witch hexes). */
  tradition?: string;
  /** Fixed ability; absent borrows the class config (witch hexes). */
  ability?: string;
}

export const FOCUS_SELECTIONS: Record<string, FocusSelectionConfig> = {
  "hex-spells-rm": { entryName: "Hexes" },
  "devotion-spells-rm": { entryName: "Devotion Spells", tradition: "divine", ability: "cha" },
  "qi-spells-rm": { entryName: "Qi Spells", tradition: "occult", ability: "wis" },
  "select-warden-spell": { entryName: "Warden Spells", tradition: "primal", ability: "wis" },
};

/** The vindicator archetype engine: its rangers cast divine warden spells. */
export const VINDICATOR_ARCHETYPE = "tabula/archetype/vindicator.eng";

/**
 * `parentSpellFeature` for the Runescarred dedication's Spell Runes feat. The
 * feat grants its chosen spell as a once-per-day innate spell, not a class
 * spellbook, so it is filed with the innate bucket.
 */
export const RUNES_SPELLCASTING_FEATURE = "spell-runes-spellcasting";

// ─── Slug normalization ──────────────────────────────────────────────────────

/** Drops a trailing `-rm` remaster marker for slug comparison. */
export function stripRemasterSuffix(slug: string): string {
  return slug.endsWith("-rm") ? slug.slice(0, -3) : slug;
}

/**
 * Whether a feature slug is an archetype spellcasting feature (e.g.
 * `wizard-spellcasting-archetype-rm`). An archetype casts exactly like its
 * base class.
 */
export function isArchetypeSpellcasting(slug: string): boolean {
  return /-archetype(?=-rm$|$)/.test(slug);
}

/**
 * Reduces an archetype spellcasting slug to its base class slug
 * (`wizard-spellcasting-archetype-rm` → `wizard-spellcasting-rm`); returns
 * non-archetype slugs unchanged.
 */
export function baseSpellcastingSlug(slug: string): string {
  return slug.replace(/-archetype(?=-rm$|$)/, "");
}

/**
 * Whether a modifier's feature slug refers to the same spellcasting feature as
 * `parentSpellFeature`. Demiplane mixes `-rm` and bare variants
 * (`magus-spellcasting` vs `magus-spellcasting-rm`) and a class response can
 * carry several features' slot blocks, so comparison is `-rm`-insensitive.
 * An empty/absent modifier slug predates the field and matches everything
 * (the old include-everything behavior); an empty `parentSpellFeature` also
 * matches everything.
 */
export function featureSlugMatches(modSlug: string | undefined, parentSpellFeature: string): boolean {
  if (parentSpellFeature === "") return true;
  if (modSlug === undefined || modSlug === "") return true;
  return stripRemasterSuffix(modSlug) === stripRemasterSuffix(parentSpellFeature);
}

/**
 * The base-class config for a feature slug, resolving archetype features to
 * their base class. Returns null for unknown or dynamic-tradition features
 * (e.g. the summoner), which callers handle specially.
 */
export function baseConfigForFeature(source: string): SpellcastingConfig | null {
  // Legacy (pre-remaster) characters send bare feature slugs
  // (`sorcerer-spellcasting`) while the table keys carry `-rm`, and vice
  // versa for psychic — so compare with both suffixes stripped. Archetype
  // features reduce to their base class the same way.
  const want = stripRemasterSuffix(baseSpellcastingSlug(source));
  for (const [key, config] of Object.entries(CLASS_SPELLCASTING)) {
    if (stripRemasterSuffix(baseSpellcastingSlug(key)) === want) return config;
  }
  return null;
}
