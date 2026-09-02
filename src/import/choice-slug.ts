/**
 * Normalizes a ChoiceSet label or name into a slug used to match against
 * Demiplane engine slugs. Drops any leading namespace before a colon
 * (e.g. "Skill: Society" → "society"), lowercases, and collapses
 * non-alphanumeric runs into single hyphens.
 */
export function toChoiceSlug(label: string): string {
  const name = label.split(":").pop() || label;
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
