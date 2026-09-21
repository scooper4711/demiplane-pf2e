import type { DemiplaneEngineEntry } from "./types.js";
import type { Choice } from "./choice-set-types.js";
import { toChoiceSlug } from "./choice-slug.js";
import { toFoundrySlug, stripTrailingWord } from "./slug-utils.js";
import { debugLog } from "./debug-log.js";
import { registerChoiceMatcher, type MatcherContext } from "./matcher-registry.js";
import { registerClassChoices } from "./class-choice-config.js";

/**
 * Kineticist ChoiceSet conventions, extracted from the matchers so the next
 * gated-choice class (sorcerer bloodlines, monk stances, champion tenets)
 * adds its own config object instead of literals. Covered: gate junctions
 * (threshold + element picks at 5/9/13/17) and the level-1 gate pair, all
 * resolved from Demiplane engines (taken feats, element parentage).
 */
export const KINETICIST_CHOICES = {
  classSlug: "kineticist",
  notes: "Gate junctions (expand/fork + element per junction) and the level-1 gate pair.",
  /** Expand/Fork option values on threshold ChoiceSets. */
  thresholdValues: { expand: "expand", fork: "fork" },
  /** Fork feat slug for a junction level. */
  forkSlugForLevel: (level: number): string => `fork-the-path-level-${level}`,
  /** Threshold-row marker a fork feat's sourceRow carries for a junction level. */
  thresholdRowMarkerForLevel: (level: number): string => `gates-threshold-level-${level}`,
  /** Junction level by threshold-item slug, in junction order. */
  thresholdLevelsByItemSlug: {
    "gates-threshold": 5,
    "second-gates-threshold": 9,
    "third-gates-threshold": 13,
    "fourth-gates-threshold": 17,
  } as Record<string, number>,
  /** Element ChoiceSet flags, in pick order for the level-1 pair. */
  elementFlags: ["elementOne", "elementTwo", "elementFork"],
  /** Engine slug suffix marking taken elements. */
  elementSuffix: "-kineticist",
  /** Source-row marker for directly-taken (level-1, non-fork) elements. */
  directElementRowMarker: "element-kineticist",
  /** Trailing word stripped when matching gate options ("Wood Gate" → wood). */
  gateLabelWord: "gate",
} as const;

registerClassChoices({
  classSlug: KINETICIST_CHOICES.classSlug,
  notes: KINETICIST_CHOICES.notes,
});

function tlog(actorTag: string | undefined, message: string): void {
  debugLog(actorTag ? `[${actorTag}] ${message}` : message);
}

/** Junction level from an explicit level or a threshold-item slug. */
function junctionLevel(itemLevel: number | undefined, itemSlug: string | undefined): number | null {
  if (typeof itemLevel === "number" && Number.isInteger(itemLevel)) return itemLevel;
  if (!itemSlug) return null;
  return KINETICIST_CHOICES.thresholdLevelsByItemSlug[toChoiceSlug(itemSlug)] ?? null;
}

/**
 * Matches a kineticist gate-junction threshold ChoiceSet (Expand the Portal
 * vs Fork the Path) against the fork feat taken at that junction's level.
 * Fork evidence is either the fork feat engine itself or — linked backward —
 * an element engine parented at it. Anything else falls through to the noisy
 * first-option fallback (Expand) rather than guessing silently.
 */
export function matchThreshold(ctx: MatcherContext): Choice | null {
  const { expand, fork } = KINETICIST_CHOICES.thresholdValues;
  const values = new Set(ctx.choices.map((c) => (typeof c.value === "string" ? c.value : "")));
  if (!values.has(expand) || !values.has(fork)) return null;

  const level = junctionLevel(ctx.itemLevel, ctx.itemSlug);
  if (level === null) return null;

  const forked =
    ctx.engines.some(
      (e) => e.type === "DemiplaneEngine" && e.args?.slug === KINETICIST_CHOICES.forkSlugForLevel(level)
    ) || forkElementAtLevel(ctx.engines, level) !== null;
  if (!forked) return null;

  tlog(ctx.actorTag, `[ChoiceSet match] Threshold strategy - fork taken at level ${level}`);
  return ctx.choices.find((c) => c.value === fork) ?? null;
}

/**
 * Backward fork evidence: the element engine (e.g. metal) parented at the
 * fork feat for a junction level, or null. Works even when the fork feat
 * engine itself is absent from the data.
 */
export function forkElementAtLevel(engines: DemiplaneEngineEntry[], level: number): DemiplaneEngineEntry | null {
  const marker = KINETICIST_CHOICES.thresholdRowMarkerForLevel(level);
  const expectedSlug = KINETICIST_CHOICES.forkSlugForLevel(level);
  const byDemiplaneId = new Map(
    engines.filter((e) => typeof e.demiplaneEngineId === "string").map((e) => [e.demiplaneEngineId as string, e])
  );
  for (const element of engines) {
    const slug = element.args?.slug;
    if (typeof slug !== "string" || !slug.endsWith(KINETICIST_CHOICES.elementSuffix)) continue;
    const parentId = element.args?.parentEngine;
    if (typeof parentId !== "string") continue;
    const parent = byDemiplaneId.get(parentId);
    if (!parent) continue;
    if (parent.args?.slug === expectedSlug) return element;
    const sourceRow = parent.args?.sourceRow;
    if (typeof sourceRow === "string" && sourceRow.includes(marker)) return element;
  }
  return null;
}

/**
 * Matches a kineticist gate-element ChoiceSet (elementOne, elementTwo,
 * elementFork: compendium gate UUIDs labeled "X Gate") against the taken
 * elements. Junction forks resolve through the element parented at that
 * junction's fork feat; the level-1 pair resolves in taken order.
 */
export function matchKineticElement(ctx: MatcherContext): Choice | null {
  const { flag, itemLevel, itemSlug } = ctx;
  if (
    flag !== KINETICIST_CHOICES.elementFlags[0] &&
    flag !== KINETICIST_CHOICES.elementFlags[1] &&
    flag !== KINETICIST_CHOICES.elementFlags[2]
  ) {
    return null;
  }

  if (flag === KINETICIST_CHOICES.elementFlags[2]) {
    const level = junctionLevel(itemLevel, itemSlug);
    if (level === null) return null;
    const element = forkElementAtLevel(ctx.engines, level);
    const slug = element?.args?.slug;
    if (typeof slug !== "string") return null;
    return matchGateChoice(ctx.choices, toFoundrySlug(slug).replace(/-kineticist$/, ""), flag, ctx.actorTag);
  }
  const taken = takenGateElements(ctx.engines);
  const pick = taken[flag === KINETICIST_CHOICES.elementFlags[0] ? 0 : 1];
  if (!pick) return null;
  return matchGateChoice(ctx.choices, pick, flag, ctx.actorTag);
}

/** Matches a gate option label ("X Gate") against an element slug. */
function matchGateChoice(
  choices: Choice[],
  elementSlug: string,
  flag: string,
  actorTag: string | undefined
): Choice | null {
  tlog(actorTag, `[ChoiceSet match] Kinetic element strategy - ${flag}: ${elementSlug}`);
  for (const choice of choices) {
    if (toChoiceSlug(stripTrailingWord(choice.label, KINETICIST_CHOICES.gateLabelWord)) === elementSlug) return choice;
  }
  return null;
}

/**
 * The level-1 taken elements in character order (e.g. air then fire for Dual
 * Gate): `*-kineticist` engines chosen directly off the class, not off a fork
 * feat. Junction elements carry fork rows instead and never appear here.
 */
export function takenGateElements(engines: DemiplaneEngineEntry[]): string[] {
  const taken: string[] = [];
  for (const engine of engines) {
    if (engine.type !== "DemiplaneEngine") continue;
    const slug = engine.args?.slug;
    if (typeof slug !== "string" || !slug.endsWith(KINETICIST_CHOICES.elementSuffix)) continue;
    const sourceRow = engine.args?.sourceRow;
    if (typeof sourceRow !== "string") continue;
    if (!sourceRow.includes(KINETICIST_CHOICES.directElementRowMarker) || sourceRow.includes("fork-the-path")) {
      continue;
    }
    taken.push(toFoundrySlug(slug).replace(/-kineticist$/, ""));
  }
  return taken;
}

registerChoiceMatcher({
  name: "threshold",
  order: 80,
  match: (ctx) => matchThreshold(ctx),
});

registerChoiceMatcher({
  name: "kinetic-element",
  order: 75,
  match: (ctx) => matchKineticElement(ctx),
  matchPrePredicate: async (ctx) => {
    const inflated = await ctx.inflateChoices?.();
    if (!inflated || inflated.length === 0) return null;
    return matchKineticElement({ ...ctx, choices: inflated });
  },
});
