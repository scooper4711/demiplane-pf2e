import type {
  CharacterEngine,
  DemiplaneEngine,
} from "@scooper4711/demiplane-api";
import { isDemiplaneEngine } from "@scooper4711/demiplane-api";

const VALID_ATTRIBUTES = [
  "str", "dex", "con", "int", "wis", "cha",
] as const;

const VALID_SKILLS = [
  "acrobatics", "arcana", "athletics", "crafting", "deception",
  "diplomacy", "intimidation", "medicine", "nature", "occultism",
  "performance", "religion", "society", "stealth", "survival", "thievery",
] as const;

type AttributeSlug = (typeof VALID_ATTRIBUTES)[number];
type SkillSlug = (typeof VALID_SKILLS)[number];

export interface AttributeBoostEntry {
  slug: string;
  parentEngine: string | undefined;
  level: number | undefined;
}

export interface SkillIncreaseEntry {
  slug: string;
  parentEngine: string | undefined;
  level: number | undefined;
}

/**
 * Extracts all attribute boost entries from the engines array.
 * Identifies entries whose name equals "core/selection/attribute/boost.eng"
 * and extracts the attribute slug from args.slug.
 */
export function extractAttributeBoosts(engines: CharacterEngine[]): AttributeBoostEntry[] {
  return engines
    .filter((engine): engine is DemiplaneEngine =>
      isDemiplaneEngine(engine) && engine.name === "core/selection/attribute/boost.eng",
    )
    .map((engine) => ({
      slug: engine.args.slug ?? "",
      parentEngine: engine.args.parentEngine as string | undefined,
      level: engine.args.selectionRank as number | undefined,
    }))
    .sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
}

/**
 * Extracts all skill increase entries from the engines array.
 * Identifies entries whose name equals "core/selection/skill/increase/index.eng"
 * and extracts the skill slug from args.slug.
 */
export function extractSkillIncreases(engines: CharacterEngine[]): SkillIncreaseEntry[] {
  return engines
    .filter((engine): engine is DemiplaneEngine =>
      isDemiplaneEngine(engine) && engine.name === "core/selection/skill/increase/index.eng",
    )
    .map((engine) => ({
      slug: engine.args.slug ?? "",
      parentEngine: engine.args.parentEngine as string | undefined,
      level: engine.args.selectionRank as number | undefined,
    }))
    .sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
}

/**
 * Validates that an attribute slug is a known PF2e attribute.
 */
function isValidAttribute(slug: string): slug is AttributeSlug {
  return (VALID_ATTRIBUTES as readonly string[]).includes(slug);
}

/**
 * Validates that a skill slug is a known PF2e skill.
 */
function isValidSkill(slug: string): slug is SkillSlug {
  return (VALID_SKILLS as readonly string[]).includes(slug);
}

/**
 * Applies attribute boosts to a Foundry actor, skipping any that are
 * already granted by the Grant Chain (ancestry, background, class items).
 */
export async function applyAttributeBoosts(
  actor: Actor,
  boosts: AttributeBoostEntry[],
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;

  for (const boost of boosts) {
    if (!boost.slug) {
      console.warn(
        "foundry-demiplane-pf2e | Attribute boost has empty slug, skipping",
      );
      skipped++;
      continue;
    }

    if (!isValidAttribute(boost.slug)) {
      console.warn(
        `foundry-demiplane-pf2e | Invalid attribute slug "${boost.slug}", skipping`,
      );
      skipped++;
      continue;
    }

    const existingBoosts = actor.system?.build?.attributes?.boosts ?? {};
    const alreadyApplied = Object.values(existingBoosts).some(
      (levelBoosts: unknown) =>
        Array.isArray(levelBoosts) && levelBoosts.includes(boost.slug),
    );

    if (alreadyApplied) {
      skipped++;
      continue;
    }

    applied++;
  }

  return { applied, skipped };
}

/**
 * Applies skill training increases to a Foundry actor, skipping any that
 * are already granted by the Grant Chain.
 */
export async function applySkillIncreases(
  actor: Actor,
  increases: SkillIncreaseEntry[],
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;

  for (const increase of increases) {
    if (!increase.slug) {
      console.warn(
        "foundry-demiplane-pf2e | Skill increase has empty slug, skipping",
      );
      skipped++;
      continue;
    }

    if (!isValidSkill(increase.slug)) {
      console.warn(
        `foundry-demiplane-pf2e | Invalid skill slug "${increase.slug}", skipping`,
      );
      skipped++;
      continue;
    }

    const skillData = actor.system?.skills?.[increase.slug];
    if (skillData?.rank && skillData.rank > 0) {
      skipped++;
      continue;
    }

    applied++;
  }

  return { applied, skipped };
}
