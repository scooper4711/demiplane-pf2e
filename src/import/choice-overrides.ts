import type { Choice, ChoiceSetContext } from "./choice-set-types.js";
import type { ChoiceKey, ChoiceOverrides, UnresolvedChoice } from "./types.js";
import { toChoiceSlug } from "./choice-slug.js";

/**
 * User-specified ChoiceSet resolution (the last resort after automatic
 * matching). These helpers are pure functions over the PF2e ChoiceSet context
 * plus the actor's stored overrides, so they unit-test without Foundry; the
 * `ChoiceSetHandler` owns the override map's lifecycle and calls in at the
 * fallback point.
 */

/**
 * Stable identity for one ChoiceSet on one actor: the owning item's slug plus
 * the rule's own selection flag. The flag is stable per rule definition
 * (unlike array index or prompt text) and the item slug disambiguates items
 * reusing generic flag names like "choice". Prefers the item's own slug
 * (present on compendium items), falling back to a slugified name.
 */
export function choiceKeyFor(itemSlug: string | null | undefined, itemName: string, flag: string): ChoiceKey {
  const slug = (typeof itemSlug === "string" && itemSlug.length > 0 ? itemSlug : toChoiceSlug(itemName)) || "item";
  return `${slug}::${flag || "choice"}`;
}

/**
 * Returns the stored user pick for this ChoiceSet as a live `Choice`, or
 * `null` when there is no override or the stored value no longer names a
 * current option (self-healing: the stale pick is ignored and the ChoiceSet
 * is re-reported as unresolved so the user can re-pick).
 */
export function resolveUserOverride(context: ChoiceSetContext, overrides: ChoiceOverrides): Choice | null {
  const stored = overrides[choiceKeyFor(context.item.slug, context.item.name, context.flag)];
  if (typeof stored !== "string") return null;
  return context.choices.find((c) => String(c.value) === stored) ?? null;
}
/**
 * Captures a ChoiceSet as a structured record for the sync dialog.
 * The prompt prefers the ChoiceSet's own prompt text, falling back to the
 * granting item's name when it is absent or not a string.
 */
export function unresolvedChoiceRecord(
  context: ChoiceSetContext,
  guessed: Choice,
  source: "guess" | "override"
): UnresolvedChoice {
  const prompt = typeof context.prompt === "string" && context.prompt.length > 0 ? context.prompt : context.item.name;
  return {
    key: choiceKeyFor(context.item.slug, context.item.name, context.flag),
    source,
    prompt,
    options: context.choices.map((c) => ({ value: String(c.value), label: c.label })),
    guessedValue: String(guessed.value),
  };
}
