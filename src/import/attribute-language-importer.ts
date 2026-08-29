import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";

/** Canonical PF2e ability abbreviations (the only valid attribute-boost targets). */
export const VALID_ATTRIBUTES: readonly string[] = ["str", "dex", "con", "int", "wis", "cha"] as const;

/** Canonical PF2e skill keys. Lore skills are slugged as `lore-*` and handled separately. */
export const VALID_SKILLS: readonly string[] = [
  "acrobatics",
  "arcana",
  "athletics",
  "crafting",
  "deception",
  "diplomacy",
  "intimidation",
  "medicine",
  "nature",
  "occultism",
  "performance",
  "religion",
  "society",
  "stealth",
  "survival",
  "thievery",
] as const;

export function isAttributeSlug(slug: string): boolean {
  return VALID_ATTRIBUTES.includes(slug);
}

export function isSkillSlug(slug: string): boolean {
  return VALID_SKILLS.includes(slug) || slug.includes("lore");
}

interface ProfKnowledge {
  profOverrides: Record<string, number>;
  overriddenFlags: Set<string>;
}

/**
 * Imports skill proficiencies from Demiplane.
 */
export async function applySkillProficiencies(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const skillEngines = engines.filter((e) => e.name === "core/selection/skill/increase/index.eng" && e.args?.slug);
  if (skillEngines.length === 0) return;

  const { profOverrides, overriddenFlags } = collectProfKnowledge(engines);
  const activeOverrides = computeActiveOverrides(overriddenFlags, profOverrides);
  const ranks = computeSkillRanks(skillEngines, activeOverrides);

  const currentSkills = (actor.system as { skills: Record<string, { rank: number }> }).skills;

  const updates = buildSkillUpdates(currentSkills, ranks);
  if (Object.keys(updates).length > 0) {
    await actor.update(updates);
    summary.log.push(`+ skills: [${formatSkillUpdates(updates)}]`);
  }

  const overrideUpdates = buildOverrideUpdates(currentSkills, activeOverrides);
  if (Object.keys(overrideUpdates).length > 0) {
    await actor.update(overrideUpdates);
    summary.log.push(`+ skill overrides: [${formatOverrides(activeOverrides)}]`);
  }
}

function collectProfKnowledge(engines: DemiplaneEngineEntry[]): ProfKnowledge {
  const profOverrides: Record<string, number> = {};
  const overriddenFlags = new Set<string>();
  for (const eng of engines) {
    if (eng.type !== "CustomDemiplaneEngine") continue;
    const overriddenMatch = eng.name.match(/^character_(.+)_prof--overridden$/);
    if (overriddenMatch?.[1] && eng.value === 1) {
      overriddenFlags.add(overriddenMatch[1]);
    }
    const profMatch = eng.name.match(/^character_(.+)_prof$/);
    if (profMatch?.[1] && typeof eng.value === "number") {
      profOverrides[profMatch[1]] = eng.value as number;
    }
  }
  return { profOverrides, overriddenFlags };
}

function computeActiveOverrides(
  overriddenFlags: Set<string>,
  profOverrides: Record<string, number>
): Record<string, number> {
  const activeOverrides: Record<string, number> = {};
  for (const skill of overriddenFlags) {
    const override = profOverrides[skill];
    if (override !== undefined) {
      activeOverrides[skill] = override;
    }
  }
  return activeOverrides;
}

function computeSkillRanks(
  skillEngines: DemiplaneEngineEntry[],
  activeOverrides: Record<string, number>
): Record<string, number> {
  const ranks: Record<string, number> = {};
  for (const eng of skillEngines) {
    const slug = eng.args.slug as string;
    const sourceRow = (eng.args.sourceRow as string) || "";

    if (!isSkillSlug(slug)) continue;
    if (sourceRow.includes("select-skill-") && sourceRow.match(/heritage|human-rm/)) continue;
    if (slug in activeOverrides) continue;

    const isIncrease = sourceRow.includes("skill-increase");
    const rank = isIncrease ? 2 : 1;
    ranks[slug] = Math.max(ranks[slug] || 0, rank);
  }
  return ranks;
}

function buildSkillUpdates(
  currentSkills: Record<string, { rank: number }>,
  ranks: Record<string, number>
): Record<string, number> {
  const updates: Record<string, number> = {};
  for (const [skill, targetRank] of Object.entries(ranks)) {
    const currentRank = currentSkills[skill]?.rank ?? 0;
    if (targetRank > currentRank) {
      updates[`system.skills.${skill}.rank`] = targetRank;
    }
  }
  return updates;
}

function buildOverrideUpdates(
  currentSkills: Record<string, { rank: number }>,
  activeOverrides: Record<string, number>
): Record<string, number> {
  const updates: Record<string, number> = {};
  for (const [skill, rank] of Object.entries(activeOverrides)) {
    const currentRank = currentSkills[skill]?.rank ?? 0;
    if (rank !== currentRank) {
      updates[`system.skills.${skill}.rank`] = rank;
    }
  }
  return updates;
}

function formatSkillUpdates(updates: Record<string, number>): string {
  return Object.entries(updates)
    .map(([s, r]) => `${s.replace("system.skills.", "").replace(".rank", "")}:${r}`)
    .join(", ");
}

function formatOverrides(activeOverrides: Record<string, number>): string {
  return Object.entries(activeOverrides)
    .map(([s, r]) => `${s}:${r}`)
    .join(", ");
}

/**
 * Imports additional languages from Demiplane free-text field.
 */
export async function applyLanguages(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const langEngine = engines.find((e) => e.name === "character-languages-user" && e.type === "CustomDemiplaneEngine");
  if (!langEngine || !langEngine.value || typeof langEngine.value !== "string") return;

  const rawLanguages = (langEngine.value as string)
    .split(/[,\n\r]+/)
    .map((l) => l.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter(Boolean);

  const validLanguages = Object.keys(
    (game as unknown as { pf2e: { system: { config: { PF2E: { languages: Record<string, string> } } } } }).pf2e?.system
      ?.config?.PF2E?.languages ??
      (CONFIG as unknown as { PF2E: { languages: Record<string, string> } }).PF2E?.languages ??
      {}
  );

  const matched: string[] = [];
  const unmatched: string[] = [];

  for (const lang of rawLanguages) {
    if (validLanguages.includes(lang)) {
      matched.push(lang);
    } else {
      unmatched.push(lang);
    }
  }

  if (matched.length > 0) {
    const currentLangs = (actor.system as { details: { languages: { value: string[] } } }).details.languages.value;
    const newLangs = [...new Set([...currentLangs, ...matched])];
    const langUpdate: Record<string, unknown> = { "system.details.languages.value": newLangs };
    await actor.update(langUpdate);
    summary.log.push(`+ languages: [${matched.join(", ")}]`);
  }

  if (unmatched.length > 0) {
    summary.log.push(`! languages not found in Foundry: [${unmatched.join(", ")}]`);
    summary.unresolved.push(`Languages not found in Foundry: ${unmatched.join(", ")}`);
  }
}

/**
 * Imports attribute boosts from Demiplane and applies them.
 */
export async function applyAttributeBoosts(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const boostEngines = engines.filter((e) => e.name === "core/selection/attribute/boost.eng" && e.args?.slug);
  if (boostEngines.length === 0) return;

  const categories = categorizeBoosts(boostEngines);

  await applyItemBoosts(actor, "ancestry", categories.ancestryBoosts, summary);
  await applyItemBoosts(actor, "background", categories.backgroundBoosts, summary);
  await applyLevelBoosts(actor, categories.levelBoosts, summary);
}

interface BoostCategories {
  ancestryBoosts: string[];
  backgroundBoosts: string[];
  levelBoosts: Record<string, string[]>;
}

function categorizeBoosts(boostEngines: DemiplaneEngineEntry[]): BoostCategories {
  const attrMap: Record<string, string> = {
    strength: "str",
    dexterity: "dex",
    constitution: "con",
    intelligence: "int",
    wisdom: "wis",
    charisma: "cha",
  };

  const ancestryBoosts: string[] = [];
  const backgroundBoosts: string[] = [];
  const levelBoosts: Record<string, string[]> = {};

  for (const eng of boostEngines) {
    const slug = attrMap[eng.args.slug as string] || (eng.args.slug as string);
    const sourceRow = (eng.args.sourceRow as string) || "";

    if (!isAttributeSlug(slug)) continue;

    if (sourceRow === "ancestry-boosts") {
      ancestryBoosts.push(slug);
    } else if (sourceRow === "background-boosts") {
      backgroundBoosts.push(slug);
    } else {
      const levelMatch = sourceRow.match(/attribute-boosts-level-(\d+)/);
      if (levelMatch) {
        const level = levelMatch[1] ?? "";
        if (!levelBoosts[level]) levelBoosts[level] = [];
        levelBoosts[level]?.push(slug);
      }
    }
  }

  return { ancestryBoosts, backgroundBoosts, levelBoosts };
}

async function applyItemBoosts(actor: Actor, type: string, boosts: string[], summary: ImportSummary): Promise<void> {
  if (boosts.length === 0) return;
  const item = actor.items.find((i: { type: string }) => i.type === type);
  if (!item) return;

  const updates: Record<string, string> = {};
  boosts.forEach((slug, i) => {
    updates[`system.boosts.${i}.selected`] = slug;
  });
  await item.update(updates);
  summary.log.push(`+ boosts: ${type} [${boosts.join(", ")}]`);
}

async function applyLevelBoosts(
  actor: Actor,
  levelBoosts: Record<string, string[]>,
  summary: ImportSummary
): Promise<void> {
  if (Object.keys(levelBoosts).length === 0) return;

  const updates: Record<string, string[]> = {};
  for (const [level, boosts] of Object.entries(levelBoosts)) {
    updates[`system.build.attributes.boosts.${level}`] = boosts;
  }
  await actor.update(updates);
  summary.log.push(
    `+ boosts: levels [${Object.entries(levelBoosts)
      .map(([l, b]) => `L${l}:${b.join(",")}`)
      .join("; ")}]`
  );
}
