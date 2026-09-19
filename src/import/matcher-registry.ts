import type { DemiplaneEngineEntry } from "./types.js";
import type { Choice } from "./choice-set-types.js";

/**
 * The inputs a ChoiceSet matcher decides on. Superset of every legacy
 * strategy signature so existing matchers adapt without rewrites.
 */
export interface MatcherContext {
  choices: Choice[];
  engines: DemiplaneEngineEntry[];
  itemName?: string | undefined;
  itemSlug?: string | undefined;
  itemLevel?: number | undefined;
  flag?: string | undefined;
  grantedFeatsByElement?: Map<string, Set<string>> | undefined;
  actorTag?: string | undefined;
  /**
   * Inflates the ChoiceSet's options (labels, not filters). Only the
   * pre-predicate path needs it — the normal dispatch receives choices
   * already inflated by the handler.
   */
  inflateChoices?: () => Promise<Choice[] | null>;
}

/**
 * A ChoiceSet matching strategy. Normal dispatch calls {@link match} with
 * inflated choices; {@link matchPrePredicate} (when present) runs ahead of
 * predicate gating for ground-truth-derived picks whose predicates assume
 * interactive picking order (kineticist gate elements).
 */
export interface ChoiceMatcher {
  readonly name: string;
  /** Dispatch order; lower runs first. Existing sequence preserved. */
  readonly order: number;
  match(ctx: MatcherContext): Choice | null;
  matchPrePredicate?(ctx: MatcherContext): Promise<Choice | null> | Choice | null;
}

const registry: ChoiceMatcher[] = [];

/**
 * Registers a matcher, keeping dispatch order sorted. Idempotent by name so
 * repeated imports (HMR, test re-runs) never duplicate entries. New classes
 * add a matcher file that calls this on import, plus one import line where
 * the core matchers register — the dispatch loop itself never changes.
 */
export function registerChoiceMatcher(matcher: ChoiceMatcher): void {
  if (registry.some((m) => m.name === matcher.name)) return;
  registry.push(matcher);
  registry.sort((a, b) => a.order - b.order);
}

/** The registered matchers in dispatch order. */
export function registeredMatchers(): readonly ChoiceMatcher[] {
  return registry;
}

/**
 * Runs pre-predicate matchers (ground-truth picks that must precede predicate
 * gating) and returns the first hit, if any.
 */
export async function matchPrePredicate(ctx: MatcherContext): Promise<Choice | null> {
  for (const matcher of registry) {
    if (!matcher.matchPrePredicate) continue;
    const hit = await matcher.matchPrePredicate(ctx);
    if (hit) return hit;
  }
  return null;
}
