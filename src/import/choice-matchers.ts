import type { DemiplaneEngineEntry } from "./types.js";
import { toFoundrySlug } from "./slug-utils.js";
import { debugLog } from "./debug-log.js";
import { toChoiceSlug } from "./choice-slug.js";
import type { Choice } from "./choice-set-types.js";

/**
 * Resolves a ChoiceSet's available options against the character's Demiplane
 * engines, returning the matching choice or null. Strategies are tried in a
 * fixed order from most specific (explicit skill selections) to most generic
 * (keyword matching), so a precise engine wins over a broad fallback.
 */
export function findMatchInChoices(
  choices: Choice[],
  engines: DemiplaneEngineEntry[],
  itemName?: string
): Choice | null {
  const match =
    matchSkillSlugs(choices, engines) ??
    matchCustomSelectionLore(choices, engines, itemName) ??
    matchAllSlugs(choices, engines) ??
    matchClassFeatures(choices, engines) ??
    matchGenericFeatures(choices, engines) ??
    matchFeatSlugs(choices, engines) ??
    matchGenericChoice(choices, engines, itemName);

  if (!match) debugLog("[ChoiceSet match] No match found across all strategies");
  return match;
}

function matchSkillSlugs(choices: Choice[], engines: DemiplaneEngineEntry[]): Choice | null {
  const allSkillSlugs = new Set(
    engines
      .filter((e) => e.name === "core/selection/skill/increase/index.eng" && e.args?.slug)
      .map((e) => e.args?.slug as string)
  );

  debugLog(`[ChoiceSet match] Strategy 1 - skill slugs: [${Array.from(allSkillSlugs).join(", ")}]`);

  for (const choice of choices) {
    const val = typeof choice.value === "string" ? choice.value : "";
    if (allSkillSlugs.has(val)) return choice;
  }
  return null;
}

/**
 * Matches a ChoiceSet (e.g. the skill choice on the Assurance feat) to a Lore
 * skill selected via a `core/selection/skill/custom-selection/index.eng` engine
 * (the "additional Lore" granted by ancestry/background features). The engine's
 * `args.name` holds the Lore name (e.g. "Forest Lore"); we slugify it and match
 * against the available skill choices so the grant resolves silently instead of
 * prompting the user.
 *
 * Scoped to the originating feat via the engine `sourceRow` when an item name is
 * known, so it doesn't mis-target unrelated skill choices.
 */
function matchCustomSelectionLore(
  choices: Choice[],
  engines: DemiplaneEngineEntry[],
  itemName?: string
): Choice | null {
  const itemSlug = itemName ? toChoiceSlug(itemName) : "";
  const loreEngines = engines.filter(
    (e) =>
      e.name === "core/selection/skill/custom-selection/index.eng" &&
      e.args?.name &&
      (itemSlug === "" ||
        (e.args.sourceRow as string)?.includes(`${itemSlug}-rm`) ||
        (e.args.sourceRow as string)?.includes(itemSlug))
  );

  const scoped = itemName ? ` for "${itemName}"` : "";
  const engineNames = loreEngines.map((e) => String(e.args?.name)).join(", ");
  debugLog(`[ChoiceSet match] custom-selection lore engines${scoped}: [${engineNames}]`);

  for (const eng of loreEngines) {
    const target = toChoiceSlug(eng.args!.name as string);
    for (const choice of choices) {
      const val = typeof choice.value === "string" ? choice.value.toLowerCase() : "";
      if (val === target || toChoiceSlug(choice.label) === target) return choice;
    }
  }
  return null;
}

function matchAllSlugs(choices: Choice[], engines: DemiplaneEngineEntry[]): Choice | null {
  const allSlugs = new Set(
    engines
      .filter((e) => e.type === "DemiplaneEngine" && e.args?.slug)
      .map((e) => toFoundrySlug(e.args?.slug as string))
  );

  debugLog(
    `[ChoiceSet match] Strategy 2 - all engine slugs (first 20): [${Array.from(allSlugs).slice(0, 20).join(", ")}]`
  );

  for (const choice of choices) {
    const val = typeof choice.value === "string" ? choice.value : "";
    if (allSlugs.has(val)) return choice;
  }
  return null;
}

function matchClassFeatures(choices: Choice[], engines: DemiplaneEngineEntry[]): Choice | null {
  const classFeatureSlugs = engines
    .filter((e) => e.type === "DemiplaneEngine" && e.name.includes("/class-feature/") && e.args?.slug)
    .map((e) => toFoundrySlug(e.args?.slug as string));

  debugLog(`[ChoiceSet match] Strategy 3 - class feature slugs: [${classFeatureSlugs.join(", ")}]`);
  debugLog(
    `[ChoiceSet match] Choice labels for Strategy 3: [${choices
      .slice(0, 5)
      .map((c) => `${c.label}→${toChoiceSlug(c.label)}`)
      .join(", ")}...]`
  );

  for (const choice of choices) {
    const labelSlug = toChoiceSlug(choice.label);
    if (classFeatureSlugs.some((slug) => labelSlug === slug || labelSlug.endsWith(`-${slug}`))) {
      return choice;
    }
  }
  return null;
}

function matchGenericFeatures(choices: Choice[], engines: DemiplaneEngineEntry[]): Choice | null {
  const genericFeatureSlugs = engines
    .filter((e) => e.type === "DemiplaneEngine" && e.name.includes("/generic-feature/") && e.args?.slug)
    .map((e) => toFoundrySlug(e.args?.slug as string));

  debugLog(`[ChoiceSet match] Strategy 4 - generic feature slugs: [${genericFeatureSlugs.join(", ")}]`);

  for (const choice of choices) {
    const val = typeof choice.value === "string" ? choice.value : "";
    if (!val || val.includes("Compendium")) continue;
    for (const slug of genericFeatureSlugs) {
      if (slug.includes(val)) return choice;
    }
  }
  return null;
}

function matchFeatSlugs(choices: Choice[], engines: DemiplaneEngineEntry[]): Choice | null {
  const featSlugs = engines
    .filter((e) => ((e.args?.sourceRow as string) || "").includes("select-feat-") && e.args?.slug)
    .map((e) => toFoundrySlug(e.args.slug as string));

  debugLog(`[ChoiceSet match] Strategy 5 - feat slugs: [${featSlugs.join(", ")}]`);

  for (const choice of choices) {
    if (typeof choice.value === "string" && choice.value.includes("Compendium")) {
      const label = choice.label
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-")
        .replace(/-+/g, "-");
      for (const featSlug of featSlugs) {
        if (label === featSlug || label.includes(featSlug)) return choice;
      }
    }
  }
  return null;
}

// Strategy 6: generic-choice engines (e.g. "canny-acumen-save-option-will").
// Extract the trailing keyword from the slug and match against choice values/labels.
function matchGenericChoice(choices: Choice[], engines: DemiplaneEngineEntry[], itemName?: string): Choice | null {
  const genericChoiceEngines = engines.filter(
    (e) => e.type === "DemiplaneEngine" && e.name.includes("/generic-choice/") && e.args?.slug
  );

  const matchScoped = (scopedEngines: DemiplaneEngineEntry[], label: (keywords: string[]) => string): Choice | null => {
    if (scopedEngines.length === 0) return null;
    const keywords = genericChoiceKeywords(scopedEngines);
    debugLog(label(keywords));
    return matchByKeyword(choices, keywords);
  };

  return (
    matchScoped(
      genericChoiceEngines,
      (k) => `[ChoiceSet match] Strategy 6 - generic choice keywords: [${k.join(", ")}]`
    ) ??
    (itemName
      ? matchScoped(
          genericChoiceEngines.filter(
            (e) => e.args?.slug && toFoundrySlug(e.args.slug as string).startsWith(toChoiceSlug(itemName))
          ),
          (k) => `[ChoiceSet match] Strategy 6 - generic choice for "${itemName}": keywords=[${k.join(", ")}]`
        )
      : null)
  );
}

function genericChoiceKeywords(engines: DemiplaneEngineEntry[]): string[] {
  return engines.map((e) => {
    const slug = toFoundrySlug(e.args?.slug as string);
    return slug.split("-").pop() || "";
  });
}

function matchByKeyword(choices: Choice[], keywords: string[]): Choice | null {
  for (const choice of choices) {
    const val = typeof choice.value === "string" ? choice.value.toLowerCase() : "";
    const label = choice.label.toLowerCase();
    for (const keyword of keywords) {
      if (keyword && (val.includes(keyword) || label === keyword)) return choice;
    }
  }
  return null;
}
