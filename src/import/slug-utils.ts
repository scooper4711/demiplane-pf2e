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
  return match ? match[1] : null;
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
    const prefix = levelMatch[1];
    const level = parseInt(levelMatch[2], 10);
    let type = "class";
    if (prefix === "ancestry") type = "ancestry";
    else if (prefix === "skill") type = "skill";
    else if (prefix === "general") type = "general";
    return { location: `${type}-${level}`, taken: level };
  }

  if (sourceRow === "ancestry-feats")
    return { location: "ancestry-1", taken: 1 };
  if (sourceRow.includes("select-feat-"))
    return { location: null, taken: null };

  return { location: null, taken: null };
}

/**
 * Categorize a Demiplane engine entry by its path.
 */
export function categorizeEngine(engineName: string): ItemCategory | null {
  if (
    engineName.includes("/classfeature/") ||
    engineName.includes("/class-feature/")
  )
    return "classfeature";
  if (engineName.includes("/ancestry/")) return "ancestry";
  if (engineName.includes("/heritage/")) return "heritage";
  if (engineName.includes("/background/")) return "background";
  if (engineName.includes("/class/") && !engineName.includes("/classfeature/"))
    return "class";
  if (engineName.includes("/feat/")) return "feat";
  if (
    engineName.includes("/equipment/") ||
    engineName.includes("/armor/") ||
    engineName.includes("/weapon/")
  )
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
  "rations-1-week": "rations",
  "rope-50-feet": "rope",
  "repair-toolkit-basic": "repair-toolkit",
};

export function normalizeEquipmentSlug(demiplaneSlug: string): string {
  const stripped = demiplaneSlug.replace(/-rm$/, "");
  return EQUIPMENT_SLUG_NORMALIZATIONS[stripped] ?? stripped;
}
