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
  const match = eng.name.match(/\/([^/]+)\.eng$/);
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

  const levelMatch = sourceRow.match(/^(\w+)-feats?-level-(\d+)/);
  if (levelMatch) {
    const prefix = levelMatch[1] ?? "";
    const level = parseInt(levelMatch[2] ?? "0", 10);
    let type = "class";
    if (prefix === "ancestry") type = "ancestry";
    else if (prefix === "skill") type = "skill";
    else if (prefix === "general") type = "general";
    return { location: `${type}-${level}`, taken: level };
  }

  if (sourceRow === "ancestry-feats") return { location: "ancestry-1", taken: 1 };
  if (sourceRow.includes("select-feat-")) return { location: null, taken: null };

  return { location: null, taken: null };
}

/**
 * Categorize a Demiplane engine entry by its path.
 */
export function categorizeEngine(engineName: string): ItemCategory | null {
  if (engineName.includes("/classfeature/") || engineName.includes("/class-feature/")) return null;
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

export interface RankedConsumable {
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

export function normalizeEquipmentSlug(demiplaneSlug: string): string {
  const stripped = demiplaneSlug.replace(/-rm$/, "");

  const ranked = parseRankedConsumable(stripped);
  if (ranked) {
    return ranked.kind === "scroll"
      ? `scroll-of-${ranked.ordinal}-rank-spell`
      : `magic-wand-${ranked.ordinal}-rank-spell`;
  }

  return EQUIPMENT_SLUG_NORMALIZATIONS[stripped] ?? stripped;
}
