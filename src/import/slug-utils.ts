import type { DemiplaneEngineEntry, ItemCategory } from "./types.js";

/**
 * Strips the trailing "-rm" suffix from Demiplane slugs.
 */
export function toFoundrySlug(slug: string): string {
  return slug.endsWith("-rm") ? slug.slice(0, -3) : slug;
}

/**
 * Extracts slug from engine name when args.slug is missing.
 * e.g. "tabula/ancestry/human-rm.eng" → "human-rm"
 */
export function getSlug(eng: DemiplaneEngineEntry): string | null {
  if (eng.args?.slug) return eng.args.slug as string;
  const match = /\/([^/]+)\.eng$/.exec(eng.name);
  return match?.[1] ?? null;
}

/**
 * Parse Demiplane sourceRow to determine Foundry feat location and level.taken.
 */
export function parseFeatSlot(sourceRow: string): {
  location: string | null;
  taken: number | null;
} {
  if (!sourceRow) return { location: null, taken: null };

  // The mythic calling occupies its own dedicated slot, not a level slot.
  if (sourceRow === "mythic-calling") return { location: "mythic-calling", taken: 1 };

  const levelMatch = /^(\w+)-feats?-level-(\d+)/.exec(sourceRow);
  if (levelMatch) {
    const prefix = levelMatch[1] ?? "";
    const level = Number.parseInt(levelMatch[2] ?? "0", 10);
    // Map the Demiplane feat-slot prefix to the Foundry location prefix. Prefixes
    // that already match Foundry (ancestry/skill/general/mythic/archetype) pass
    // through; anything else (a class name) becomes a class feat.
    const PASSTHROUGH_PREFIXES = new Set(["ancestry", "skill", "general", "mythic", "archetype"]);
    const type = PASSTHROUGH_PREFIXES.has(prefix) ? prefix : "class";
    return { location: `${type}-${level}`, taken: level };
  }

  if (sourceRow === "ancestry-feats") return { location: "ancestry-1", taken: 1 };
  if (sourceRow.includes("select-feat-")) return { location: null, taken: null };

  return { location: null, taken: null };
}

/** Feat-slot prefixes that name a category directly (the rest are class names). */
const FEAT_SLOT_CATEGORY_LABELS: Record<string, string> = {
  ancestry: "Ancestry",
  skill: "Skill",
  general: "General",
  archetype: "Archetype",
  mythic: "Mythic",
};

/**
 * Produces a human-readable label for the feat slot a Demiplane feat came from,
 * derived from its `sourceRow`. This is display context to help a GM recognize
 * an unresolved feat (the slug often doesn't match the name on the sheet), not a
 * mapping key — the same feat can occupy different slots on different characters.
 *
 * Examples:
 *   `skill-feat-level-2-rm`       → "Skill feat (level 2)"
 *   `champion-feat-level-1-rm`    → "Class feat (level 1)"
 *   `ancestry-feat-level-5-rm`    → "Ancestry feat (level 5)"
 *   `ancestry-feats`              → "Ancestry feat"
 *   `background-feat` / bg row    → "Background feat"
 *   `..._select-feat-<x>_...`     → "Granted feat"
 * Returns `undefined` when the sourceRow carries no useful slot context.
 */
export function describeFeatSlot(sourceRow: string | undefined): string | undefined {
  if (!sourceRow) return undefined;

  if (sourceRow === "mythic-calling") return "Mythic calling";

  const levelMatch = /^(\w+)-feats?-level-(\d+)/.exec(sourceRow);
  if (levelMatch) {
    const prefix = levelMatch[1] ?? "";
    const level = levelMatch[2];
    const category = FEAT_SLOT_CATEGORY_LABELS[prefix] ?? "Class";
    return `${category} feat (level ${level})`;
  }

  if (sourceRow === "ancestry-feats") return "Ancestry feat";
  if (sourceRow.includes("background")) return "Background feat";
  // A feat granted by another selection (e.g. Natural Ambition, Versatile
  // Human) — the level lives on the granting feat, not here.
  if (sourceRow.includes("select-feat-")) return "Granted feat";

  return undefined;
}

/**
 * Categorize a Demiplane engine entry by its path.
 */
export function categorizeEngine(engineName: string): ItemCategory | null {
  if (engineName.includes("/classfeature/") || engineName.includes("/class-feature/")) return null;
  // `core/selection/...` engines are the character's *choices* (adopted
  // ancestry, skill increases, attribute boosts, item picks), handled by the
  // choice/attribute/skill importers — not the ABC/feat/equipment items to
  // create. Excluding them prevents e.g. `core/selection/ancestry/...` (Adopted
  // Ancestry = Human) from being mistaken for the character's ancestry
  // (Skeleton) and overwriting it.
  if (engineName.includes("/selection/")) return null;
  if (engineName.includes("/ancestry/")) return "ancestry";
  if (engineName.includes("/heritage/")) return "heritage";
  if (engineName.includes("/background/")) return "background";
  if (engineName.includes("/class/") && !engineName.includes("/classfeature/")) return "class";
  if (engineName.includes("/feat/")) return "feat";
  if (engineName.includes("/equipment/") || engineName.includes("/armor/") || engineName.includes("/weapon/"))
    return "equipment";
  return null;
}

const CLASS_SUFFIXES = [
  "-sorcerer",
  "-wizard",
  "-cleric",
  "-druid",
  "-bard",
  "-fighter",
  "-ranger",
  "-rogue",
  "-monk",
  "-champion",
  "-barbarian",
  "-commander",
  "-alchemist",
  "-investigator",
  "-oracle",
  "-swashbuckler",
  "-witch",
  "-magus",
  "-summoner",
  "-gunslinger",
  "-inventor",
  "-psychic",
  "-thaumaturge",
  "-kineticist",
];

/**
 * Generate candidate slugs for compendium lookup.
 * Tries exact slug, then strips class suffix, then tries bloodline- prefix.
 */
export function generateSlugCandidates(slug: string): string[] {
  const candidates = [slug];
  for (const suffix of CLASS_SUFFIXES) {
    if (slug.endsWith(suffix)) {
      candidates.push(slug.slice(0, -suffix.length));
      break;
    }
  }
  candidates.push(`bloodline-${slug}`);
  return candidates;
}

const EQUIPMENT_SLUG_NORMALIZATIONS: Record<string, string> = {
  arrow: "arrows",
  bolt: "bolts",
  "rations-1-week": "rations",
  "rope-50-feet": "rope",
  "repair-toolkit-basic": "repair-toolkit",
};

/**
 * Generic ranked scrolls and wands. Demiplane names them by rank
 * (`magic-scroll-2nd-rank`), while the compendium has one item per rank with a
 * different shape (`scroll-of-2nd-rank-spell`).
 */
const RANKED_CONSUMABLE_RE = /^magic-(scroll|wand)-(\d+(?:st|nd|rd|th))-rank$/;

interface RankedConsumable {
  kind: "scroll" | "wand";
  /** Ordinal as written by Demiplane, e.g. "2nd". */
  ordinal: string;
  rank: number;
}

/** Recognises a generic ranked scroll/wand, e.g. `magic-scroll-2nd-rank-rm`. */
export function parseRankedConsumable(demiplaneSlug: string): RankedConsumable | null {
  const match = RANKED_CONSUMABLE_RE.exec(demiplaneSlug.replace(/-rm$/, ""));
  if (!match?.[1] || !match[2]) return null;
  const ordinal = match[2];
  return {
    kind: match[1] === "scroll" ? "scroll" : "wand",
    ordinal,
    rank: Number(/^(\d+)/.exec(ordinal)?.[1]),
  };
}

/**
 * The Demiplane-side slug for an item engine. Class-kit items carry no
 * `args.slug`, so fall back to the engine name
 * (`tabula/item/<slug>-rm.eng`). Shared by the import (which stamps items)
 * and the push (which matches queued changes back to engines) so both sides
 * resolve the same slug for the same engine.
 */
export function rawEquipmentSlug(eng: { args?: { slug?: unknown } | null; name: string }): string {
  return (eng.args?.slug as string | undefined) ?? (eng.name.split("/").pop() ?? "").replace(/\.eng$/, "");
}

/**
 * Whether an item engine was granted by another element (an ancestry, heritage,
 * background, class, or feat) rather than added to inventory by the player.
 *
 * A granted item engine carries a `sourceData` block naming the granting element
 * (its `category` and `engineID`), e.g. the dwarf's Clan Dagger records
 * `sourceData: { category: "ancestry", engineID: "<dwarf engine>" }`. A
 * player-added item has no `sourceData` — it carries `sourceRow:
 * "manual-sheet-drawer"` instead.
 *
 * The importer skips these: Foundry's own ancestry/feat rule elements (a
 * ChoiceSet resolving the pick, then a GrantItem creating the item) already add
 * the granted item, so importing the engine too would create a duplicate.
 */
export function isGrantedByElement(eng: DemiplaneEngineEntry): boolean {
  return eng.args?.sourceData !== undefined && eng.args?.sourceData !== null;
}

export function normalizeEquipmentSlug(demiplaneSlug: string): string {
  const stripped = demiplaneSlug.replace(/-rm$/, "");

  const ranked = parseRankedConsumable(stripped);
  if (ranked) {
    return ranked.kind === "scroll"
      ? `scroll-of-${ranked.ordinal}-rank-spell`
      : `magic-wand-${ranked.ordinal}-rank-spell`;
  }

  // Named specialty scrolls/wands (e.g. Wand of Widening) — Demiplane writes the
  // rank tier as `-Nth-level-spell` or `-Nth-rank-rm`, while the compendium uses
  // `-Nth-rank-spell` (or, for a few like Legerdemain, `-Nth-rank`). Canonicalize
  // the tier to `-Nth-rank`; findBySlug tries the `-spell` variant too.
  const named = stripped.replace(/-(\d+(?:st|nd|rd|th))-(?:level|rank)(?:-spell)?$/, "-$1-rank");
  if (named !== stripped) return named;

  return EQUIPMENT_SLUG_NORMALIZATIONS[stripped] ?? stripped;
}

/**
 * The English ordinal for a spell rank (1 → "1st", 3 → "3rd", 11 → "11th").
 * Used to build the compendium slug of a generic ranked consumable.
 */
export function rankOrdinal(rank: number): string {
  const mod100 = rank % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${rank}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[rank % 10] ?? "th";
  return `${rank}${suffix}`;
}

/**
 * The compendium slug of the generic ranked consumable that holds a spell of the
 * given rank, e.g. `("scroll", 2)` → `scroll-of-2nd-rank-spell` and
 * `("wand", 1)` → `magic-wand-1st-rank-spell`.
 *
 * The fallback for a fixed-spell scroll/wand (e.g. Scroll of Glitterdust) that
 * has no dedicated compendium item: PF2e models it as this generic consumable
 * carrying the spell.
 */
export function genericConsumableSlug(itemType: "scroll" | "wand", rank: number): string {
  const ordinal = rankOrdinal(rank);
  return itemType === "scroll" ? `scroll-of-${ordinal}-rank-spell` : `magic-wand-${ordinal}-rank-spell`;
}
