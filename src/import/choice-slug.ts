/**
 * Normalizes a ChoiceSet label or name into a slug used to match against
 * Demiplane engine slugs. Drops any leading namespace before a colon
 * (e.g. "Skill: Society" → "society"), lowercases, and collapses
 * non-alphanumeric runs into single hyphens.
 *
 * A possessive apostrophe is elided rather than treated as a separator, so
 * "Barrow's Edge" → `barrows-edge` (matching the PF2e/Demiplane slug) instead of
 * `barrow-s-edge`. Both the straight (') and curly (’) apostrophe are handled.
 */
export function toChoiceSlug(label: string): string {
  const name = label.split(":").pop() || label;
  return name
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
