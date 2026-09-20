import { toFoundrySlug } from "./slug-utils.js";
import { toChoiceSlug } from "./choice-slug.js";
import { debugLog } from "./debug-log.js";
import { registerChoiceMatcher, type MatcherContext } from "./matcher-registry.js";
import type { Choice } from "./choice-set-types.js";

registerChoiceMatcher({
  name: "granted-builder-selection",
  order: 135,
  // The grant walk needs compendium reads, so this matcher only acts ahead of
  // predicate gating; normal dispatch defers to the slug strategies.
  match: () => null,
  matchPrePredicate: async (ctx) => {
    const inflated = await ctx.inflateChoices?.();
    if (!inflated || inflated.length === 0) return null;
    return matchGrantedBuilderSelection({ ...ctx, choices: inflated });
  },
});

/** A compendium document read structurally for granted-item slug extraction. */
interface GrantWalkDoc {
  system?: { slug?: unknown; description?: { value?: unknown }; rules?: Array<Record<string, unknown>> };
  name?: unknown;
  toObject?: () => {
    system?: { slug?: unknown; description?: { value?: unknown }; rules?: Array<Record<string, unknown>> };
    name?: unknown;
  };
}

/** Reads a possibly-wrapped document's slug, preferring its system data. */
function walkDocSlug(doc: GrantWalkDoc | null): string | null {
  if (!doc) return null;
  const slug = systemSlug(doc.system) ?? systemSlug(doc.toObject?.()?.system);
  if (slug) return slug;
  const name = docName(doc.name) ?? docName(doc.toObject?.()?.name);
  return name ? toChoiceSlug(name) : null;
}

/** A system block's slug when it is a non-empty string. */
function systemSlug(system: { slug?: unknown } | undefined): string | null {
  return typeof system?.slug === "string" && system.slug !== "" ? system.slug : null;
}

/** A document name when it is a string. */
function docName(name: unknown): string | null {
  return typeof name === "string" ? name : null;
}

/** The GrantItem rule UUIDs a document carries. */
function walkGrantUuids(doc: GrantWalkDoc | null): string[] {
  const rules = doc?.system?.rules ?? doc?.toObject?.()?.system?.rules ?? [];
  const uuids: string[] = [];
  for (const rule of rules) {
    if (rule.key === "GrantItem" && typeof rule.uuid === "string") uuids.push(rule.uuid);
  }
  return uuids;
}

/**
 * Matches a ChoiceSet against a builder-row grant from an archetype (or
 * similar) definition — e.g. the vindicator mapping the hunter's-edge row to
 * vindication, where Foundry offers Flurry / Outwit / Precision / Vindicator.
 *
 * Neither the row nor the selection appears in the character's engines, and
 * the selection slug need not resemble the option label ("vindication" vs
 * "Vindicator"), so text matching cannot connect them. Instead each
 * compendium-valued option is resolved along with the items it grants, and
 * the option wins when the selection's every slug segment appears in one of
 * those slugs (the Vindicator option grants "Effect: Vindication Edge").
 */
async function matchGrantedBuilderSelection(ctx: MatcherContext): Promise<Choice | null> {
  const map = ctx.grantBuilderSelections;
  if (!map || map.size === 0) return null;
  const key = ctx.itemSlug ? toFoundrySlug(ctx.itemSlug) : "";
  const selection =
    (key !== "" ? map.get(key) : undefined) ?? (ctx.itemName ? map.get(toChoiceSlug(ctx.itemName)) : undefined);
  if (!selection) return null;

  debugLog(`[ChoiceSet match] granted-builder-selection for "${ctx.itemName}": ${selection}`);
  // The selection stays in Demiplane form for definition lookups elsewhere;
  // text matching normalizes it (vindication-rm → vindication).
  const foundrySelection = toFoundrySlug(selection);
  const segments = foundrySelection.split("-").filter((s) => s !== "");
  for (const choice of ctx.choices) {
    if (choiceMatchesSelection(choice, foundrySelection)) return choice;
    if (typeof choice.value !== "string" || !choice.value.startsWith("Compendium.")) continue;
    if (await optionGrantsSelection(choice.value, segments)) return choice;
  }
  return null;
}

/** Direct hits: a slug value or label equal to the granted selection. */
function choiceMatchesSelection(choice: Choice, selection: string): boolean {
  if (typeof choice.value === "string" && !choice.value.startsWith("Compendium.") && choice.value === selection) {
    return true;
  }
  return toChoiceSlug(choice.label) === selection;
}

/** Whether an option (or anything it grants) carries every selection segment. */
async function optionGrantsSelection(optionUuid: string, segments: string[]): Promise<boolean> {
  // eslint-disable-next-line no-restricted-syntax -- fromUuid returns an untyped document; slug/rules read structurally
  const doc = (await fromUuid(optionUuid)) as unknown as GrantWalkDoc | null;
  if (!doc) return false;
  const candidates = new Set<string>();
  const self = walkDocSlug(doc);
  if (self) candidates.add(self);
  for (const grantUuid of walkGrantUuids(doc)) {
    // eslint-disable-next-line no-restricted-syntax -- fromUuid returns an untyped document; slug read structurally
    const granted = (await fromUuid(grantUuid)) as unknown as GrantWalkDoc | null;
    const slug = walkDocSlug(granted);
    if (slug) candidates.add(slug);
  }
  if (
    [...candidates].some((slug) => {
      const parts = new Set(slug.split("-"));
      return segments.every((seg) => parts.has(seg));
    })
  ) {
    return true;
  }
  // Some links live only in prose: the Vindicator option grants no
  // vindication-slugged item, but its description names the vindication edge.
  // Fall back to token search over the option's own name and description.
  return docMentionsSelection(doc, segments);
}

/** Whether a document's name and description mention every selection segment. */
function docMentionsSelection(doc: GrantWalkDoc, segments: string[]): boolean {
  const resolved = doc.toObject?.() ?? null;
  const text = [typeof doc.name === "string" ? doc.name : "", typeof resolved?.name === "string" ? resolved.name : ""]
    .concat([docText(doc.system?.description), docText(resolved?.system?.description)])
    .join(" ")
    .toLowerCase();
  const tokens = new Set(text.split(/[^a-z0-9]+/).filter((t) => t !== ""));
  return segments.every((seg) => tokens.has(seg));
}

/** A description block's text, when present and well-formed. */
function docText(description: { value?: unknown } | undefined): string {
  return typeof description?.value === "string" ? description.value : "";
}
