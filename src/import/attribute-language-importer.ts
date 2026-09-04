import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { characterSystem, pf2eLanguages } from "../pf2e-types.js";
import { PROFICIENCY_TRAINED, PROFICIENCY_EXPERT } from "./pf2e-ranks.js";

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

  const currentSkills = characterSystem(actor).skills;

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
    const overriddenMatch = /^character_(.+)_prof--overridden$/.exec(eng.name);
    if (overriddenMatch?.[1] && eng.value === 1) {
      overriddenFlags.add(overriddenMatch[1]);
    }
    const profMatch = /^character_(.+)_prof$/.exec(eng.name);
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
    if (sourceRow.includes("select-skill-") && /heritage|human-rm/.exec(sourceRow)) continue;
    if (slug in activeOverrides) continue;

    const isIncrease = sourceRow.includes("skill-increase");
    const rank = isIncrease ? PROFICIENCY_EXPERT : PROFICIENCY_TRAINED;
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
    .split(/[,\n\r;]+/)
    .map((l) => l.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter(Boolean);

  const validLanguages = Object.keys(pf2eLanguages());

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
    const currentLangs = characterSystem(actor).details.languages.value;
    const newLangs = [...new Set([...currentLangs, ...matched])];
    const langUpdate: Record<string, unknown> = { "system.details.languages.value": newLangs };
    await actor.update(langUpdate);
    summary.log.push(`+ languages: [${matched.join(", ")}]`);
  }

  if (unmatched.length > 0) {
    summary.log.push(`! languages not found in Foundry: [${unmatched.join(", ")}]`);
    summary.errors.push(`Languages not found in Foundry: ${unmatched.join(", ")}`);
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

  await applyAncestryBoosts(actor, categories.ancestryBoosts, usesAlternateAncestryBoosts(engines), summary);
  await applyItemBoosts(actor, "background", categories.backgroundBoosts, summary);
  await applyLevelBoosts(actor, categories.levelBoosts, summary);
}

/**
 * Whether the character uses the alternate ancestry-boost strategy (two free
 * boosts instead of the ancestry's fixed boost plus a free choice).
 *
 * Demiplane signals this with the `ancestry-boost-option` custom engine set to
 * `two-boosts`; the default (fixed + free) omits it or uses another value.
 */
function usesAlternateAncestryBoosts(engines: DemiplaneEngineEntry[]): boolean {
  const option = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === "ancestry-boost-option");
  return option?.value === "two-boosts";
}

/**
 * Applies ancestry attribute boosts, honoring the two boost strategies.
 *
 * - Alternate (`two-boosts`): PF2e stores both free attributes in
 *   `system.alternateAncestryBoosts`; the fixed/free `boosts` slots are ignored.
 * - Standard (fixed + free): the free choice(s) fill the ancestry's free boost
 *   slots (see {@link applyItemBoosts}).
 */
async function applyAncestryBoosts(
  actor: Actor,
  boosts: string[],
  alternate: boolean,
  summary: ImportSummary
): Promise<void> {
  if (boosts.length === 0) return;

  if (alternate) {
    const item = actor.items.find((i: { type: string }) => i.type === "ancestry");
    if (!item) return;
    await item.update({ "system.alternateAncestryBoosts": boosts });
    summary.log.push(`+ boosts: ancestry (alternate) [${boosts.join(", ")}]`);
    return;
  }

  await applyItemBoosts(actor, "ancestry", boosts, summary);
}

interface BoostCategories {
  ancestryBoosts: string[];
  backgroundBoosts: string[];
  levelBoosts: Record<string, string[]>;
}

/** Foundry stores leveling attribute boosts only at these milestone levels. */
const BOOST_MILESTONES = [1, 5, 10, 15, 20] as const;

/**
 * Demiplane sourceRow schemes for a leveling attribute boost. All three encode
 * the character level the boost was taken at:
 * - `attribute-boosts-level-<n>[-rm]` — standard rule (exemplar, bard, ...)
 * - `ability-boost-level-<n>`         — standard rule (thaumaturge, ...)
 * - `gradual-attribute-boost-level-<n>` — Gradual Ability Boosts variant
 */
const BOOST_LEVEL_SOURCE_ROW_RE = /(?:attribute-boosts|ability-boost|gradual-attribute-boost)-level-(\d+)/;

/**
 * Demiplane's own milestone grouping for a boost, e.g.
 * `attribute-boost-level-group-5`. Present on Gradual Ability Boost selections,
 * where it authoritatively states which Foundry bucket the boost belongs to.
 */
const BOOST_LEVEL_GROUP_RE = /attribute-boost-level-group-(\d+)/;

/**
 * Maps a character level to the Foundry boost bucket that owns it.
 *
 * Foundry's `system.build.attributes.boosts` is keyed only by 1/5/10/15/20.
 * Under the standard rule Demiplane already emits boosts at those milestone
 * levels. Under the Gradual Ability Boosts variant, Demiplane emits one boost
 * per level (2, 3, 4, ...); each must land in the next milestone bucket (2-5 →
 * 5, 6-10 → 10, etc.) so the system keeps them rather than discarding writes to
 * non-existent keys.
 */
function boostMilestone(level: number): string {
  const milestone = BOOST_MILESTONES.find((m) => level <= m) ?? BOOST_MILESTONES[BOOST_MILESTONES.length - 1];
  return String(milestone);
}

/**
 * Resolves the Foundry milestone bucket for a leveling boost.
 *
 * Prefers Demiplane's own `attribute-boost-level-group-<n>` selectionGroup
 * (authoritative, used by Gradual Ability Boosts); otherwise derives the bucket
 * from the level encoded in the sourceRow. Returns `undefined` for engines that
 * are not leveling boosts.
 */
function resolveBoostBucket(sourceRow: string, selectionGroup: string): string | undefined {
  const group = BOOST_LEVEL_GROUP_RE.exec(selectionGroup);
  if (group?.[1]) return group[1];

  const level = BOOST_LEVEL_SOURCE_ROW_RE.exec(sourceRow);
  if (level?.[1]) return boostMilestone(Number(level[1]));

  return undefined;
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
      const selectionGroup = (eng.args.selectionGroup as string) || "";
      const bucket = resolveBoostBucket(sourceRow, selectionGroup);
      if (bucket) {
        levelBoosts[bucket] ??= [];
        levelBoosts[bucket]?.push(slug);
      }
    }
  }

  return { ancestryBoosts, backgroundBoosts, levelBoosts };
}

async function applyItemBoosts(actor: Actor, type: string, boosts: string[], summary: ImportSummary): Promise<void> {
  if (boosts.length === 0) return;
  const item = actor.items.find((i: { type: string }) => i.type === type);
  if (!item) return;

  // Demiplane sends only the player-chosen (free) boosts for an ABC item, not
  // its fixed boosts. Foundry ABC items interleave fixed slots (a single allowed
  // option, e.g. Kitsune's fixed Charisma) with free slots (multiple options).
  // Assign each incoming boost to the next *free* slot; writing to a fixed slot
  // is rejected by the system, which silently drops the boost.
  const slotKeys = freeBoostSlotKeys(item);

  const updates: Record<string, string> = {};
  boosts.forEach((slug, i) => {
    const key = slotKeys[i];
    if (key !== undefined) updates[`system.boosts.${key}.selected`] = slug;
  });
  await item.update(updates);
  summary.log.push(`+ boosts: ${type} [${boosts.join(", ")}]`);
}

/** A single ABC boost slot: `value` lists the allowed attributes, `selected` the chosen one. */
interface AbcBoostSlot {
  value?: string[];
  selected?: string | null;
}

/**
 * Ordered keys of an ABC item's *free* (player-selectable) boost slots.
 *
 * A slot with exactly one allowed `value` is a fixed boost (predetermined by the
 * ancestry/background/class) and must not be overwritten. Free slots offer
 * multiple options and are where Demiplane's chosen boosts belong.
 */
function freeBoostSlotKeys(item: { system?: { boosts?: Record<string, AbcBoostSlot> } }): string[] {
  const slots = item.system?.boosts ?? {};
  // A free slot offers a real choice (multiple allowed options). A single-option
  // slot is a fixed boost; an empty-option slot is a placeholder — skip both.
  return Object.keys(slots).filter((key) => (slots[key]?.value?.length ?? 0) > 1);
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
  const perLevel = Object.entries(levelBoosts)
    .map(([l, b]) => `L${l}:${b.join(",")}`)
    .join("; ");
  summary.log.push(`+ boosts: levels [${perLevel}]`);
}
