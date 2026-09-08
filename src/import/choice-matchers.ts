import type { DemiplaneEngineEntry } from "./types.js";
import { toFoundrySlug, generateSlugCandidates, rawEquipmentSlug, isGrantedByElement } from "./slug-utils.js";
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
  itemName?: string,
  grantedFeatsByElement?: Map<string, Set<string>>
): Choice | null {
  const match =
    matchSkillSlugs(choices, engines) ??
    matchCustomSelectionLore(choices, engines, itemName) ??
    matchDeity(choices, engines) ??
    matchDomain(choices, engines) ??
    matchMuse(choices, engines) ??
    matchAdoptedAncestry(choices, engines) ??
    matchItemEngines(choices, engines) ??
    matchGrantedFeats(choices, grantedFeatsByElement, itemName) ??
    matchAllSlugs(choices, engines) ??
    matchClassFeatures(choices, engines) ??
    matchGenericFeatures(choices, engines) ??
    matchFeatSlugs(choices, engines, itemName) ??
    matchGenericChoice(choices, engines, itemName);

  if (!match) debugLog("[ChoiceSet match] No match found across all strategies");
  return match;
}

/**
 * Matches a ChoiceSet whose owning element grants a fixed feat that Foundry
 * models as a player choice — the Total Power background is the canonical case.
 *
 * Demiplane's Total Power grants the "troll" classification's Bone Spikes feat
 * outright (its element definition carries `feats: ["bone-spikes", ...]`),
 * whereas Foundry presents a "Blasting Beams vs Bone Spikes" ChoiceSet. Neither
 * a slug engine nor a feat engine exists for the grant — the only signal is the
 * granting element's own definition — so the generic strategies can't resolve
 * it. We look up the granting element by the ChoiceSet item's slug
 * ("Total Power" → `total-power`) and match its granted feat slugs against each
 * option's value and slugified label.
 */
function matchGrantedFeats(
  choices: Choice[],
  grantedFeatsByElement: Map<string, Set<string>> | undefined,
  itemName?: string
): Choice | null {
  if (!grantedFeatsByElement || !itemName) return null;

  const grantedFeats = grantedFeatsByElement.get(toChoiceSlug(itemName));
  if (!grantedFeats || grantedFeats.size === 0) return null;

  debugLog(`[ChoiceSet match] Granted-feats strategy for "${itemName}": [${Array.from(grantedFeats).join(", ")}]`);

  for (const choice of choices) {
    const value = typeof choice.value === "string" ? toFoundrySlug(choice.value) : "";
    const labelSlug = toChoiceSlug(choice.label);
    if (grantedFeats.has(value) || grantedFeats.has(labelSlug)) return choice;
  }
  return null;
}

/**
 * Matches the cleric "Deity" ChoiceSet against the character's deity engine.
 *
 * Two things make deity distinct from the generic slug strategies:
 *
 * 1. **Engine type.** The deity arrives as a `tabula/deity/<slug>.eng` engine of
 *    type `CustomDemiplaneEngine` (an override), so the strategies that filter
 *    to `type === "DemiplaneEngine"` never see it. We select it by name path
 *    instead, regardless of type.
 * 2. **Choice shape.** The deity ChoiceSet is a compendium filter: each option's
 *    `value` is a Compendium UUID, not a slug, so a value-equality check can't
 *    work. We compare the deity's foundry slug (e.g. `sarenrae` from
 *    `sarenrae-rm`) against each option's slugified label ("Sarenrae").
 */
function matchDeity(choices: Choice[], engines: DemiplaneEngineEntry[]): Choice | null {
  const deitySlugs = engines
    .filter((e) => e.name.includes("/deity/") && e.args?.slug)
    .map((e) => toFoundrySlug(e.args?.slug as string));

  if (deitySlugs.length === 0) return null;

  debugLog(`[ChoiceSet match] Deity strategy - deity slugs: [${deitySlugs.join(", ")}]`);

  for (const choice of choices) {
    const labelSlug = toChoiceSlug(choice.label);
    if (deitySlugs.includes(labelSlug)) return choice;
  }
  return null;
}

/**
 * Matches domain ChoiceSets (e.g. Domain Initiate) against the character's
 * domain engines. Like the deity, domains arrive as `tabula/domain/<slug>.eng`
 * `CustomDemiplaneEngine` overrides invisible to the DemiplaneEngine-only
 * strategies. The domain choice's `value` is the domain key (e.g. `fire`), so we
 * match the domain's foundry slug (`fire` from `fire-rm`) against both the
 * option value and its slugified label.
 */
function matchDomain(choices: Choice[], engines: DemiplaneEngineEntry[]): Choice | null {
  const domainSlugs = engines
    .filter((e) => e.name.includes("/domain/") && e.args?.slug)
    .map((e) => toFoundrySlug(e.args?.slug as string));

  if (domainSlugs.length === 0) return null;

  debugLog(`[ChoiceSet match] Domain strategy - domain slugs: [${domainSlugs.join(", ")}]`);

  for (const choice of choices) {
    const val = typeof choice.value === "string" ? choice.value : "";
    if (domainSlugs.includes(val) || domainSlugs.includes(toChoiceSlug(choice.label))) return choice;
  }
  return null;
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

/**
 * Matches a bard/other-archetype muse ChoiceSet (Bard Dedication → Enigma /
 * Maestro / …). Demiplane records the chosen muse as a `.../class-feature/
 * <muse>-archetype-rm.eng` engine (e.g. `enigma-archetype-rm`), while PF2e's
 * ChoiceSet offers the bare muse slug (`enigma`, value via `slugsAsValues`). We
 * strip the `-archetype` suffix from the engine slug and match against the
 * choice value/label so the muse resolves instead of defaulting to the first.
 */
function matchMuse(choices: Choice[], engines: DemiplaneEngineEntry[]): Choice | null {
  const museSlugs = engines
    .filter((e) => e.name.includes("/class-feature/") && /-archetype-rm(\.eng)?$/.test(e.name) && e.args?.slug)
    .map((e) => toFoundrySlug(e.args?.slug as string).replace(/-archetype$/, ""));

  if (museSlugs.length === 0) return null;

  debugLog(`[ChoiceSet match] Muse strategy - muse slugs: [${museSlugs.join(", ")}]`);

  for (const choice of choices) {
    const val = typeof choice.value === "string" ? choice.value : "";
    if (museSlugs.includes(val) || museSlugs.includes(toChoiceSlug(choice.label))) return choice;
  }
  return null;
}

/**
 * Matches the Adopted Ancestry ChoiceSet against the character's chosen adopted
 * ancestry. Demiplane records it as a
 * `core/selection/ancestry/custom-selection/index.eng` engine whose `args.slug`
 * is the ancestry (e.g. `human-rm`); PF2e's ChoiceSet offers ancestry slugs via
 * `slugsAsValues`. Handled explicitly because the generic slug strategies don't
 * single out the ancestry-selection engine.
 */
function matchAdoptedAncestry(choices: Choice[], engines: DemiplaneEngineEntry[]): Choice | null {
  const ancestrySlugs = engines
    .filter((e) => e.name === "core/selection/ancestry/custom-selection/index.eng" && e.args?.slug)
    .map((e) => toFoundrySlug(e.args?.slug as string));

  if (ancestrySlugs.length === 0) return null;

  debugLog(`[ChoiceSet match] Adopted ancestry strategy - slugs: [${ancestrySlugs.join(", ")}]`);

  for (const choice of choices) {
    const val = typeof choice.value === "string" ? choice.value : "";
    if (ancestrySlugs.includes(val) || ancestrySlugs.includes(toChoiceSlug(choice.label))) return choice;
  }
  return null;
}

/**
 * Matches a ChoiceSet that resolves which item an element granted, e.g. the
 * dwarf ancestry's "Clan Dagger vs Clan Pistol" weapon choice. The chosen weapon
 * is present as a `tabula/item/<slug>.eng` engine (here `clan-dagger-rm`), which
 * the broad slug strategies miss: a weapon ChoiceSet's option `value` is usually
 * a compendium UUID, so only the option *label* ("Clan Dagger") identifies it.
 *
 * Only element-granted item engines are considered — those carrying a
 * `sourceData` block naming the granting element (see {@link isGrantedByElement}).
 * A ChoiceSet like this exists precisely to resolve an element's grant, so the
 * character's manually-added inventory is irrelevant to it and could otherwise
 * make an unrelated owned item spuriously win a slug match. We match the granted
 * slugs against both the option value (slug-valued ChoiceSets) and the slugified
 * label (the common UUID-valued case) so it resolves regardless of shape.
 */
function matchItemEngines(choices: Choice[], engines: DemiplaneEngineEntry[]): Choice | null {
  const itemSlugs = engines
    .filter((e) => e.type === "DemiplaneEngine" && e.name.startsWith("tabula/item/") && isGrantedByElement(e))
    .map((e) => toFoundrySlug(rawEquipmentSlug(e)));
  if (itemSlugs.length === 0) return null;

  debugLog(`[ChoiceSet match] Item-engine strategy - item slugs: [${itemSlugs.join(", ")}]`);

  for (const choice of choices) {
    const value = typeof choice.value === "string" ? choice.value : "";
    const labelSlug = toChoiceSlug(choice.label);
    if (itemSlugs.some((slug) => slug === value || slug === labelSlug)) return choice;
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

/**
 * Matches a compendium-feat ChoiceSet (e.g. the metamagic feat chosen for
 * School of Unified Magical Theory or Experimental Spellshaping) against the
 * character's `select-feat-<feature>` engines.
 *
 * Two things make this reliable where a naive slug-equality check fails:
 *
 * 1. **Scoping.** A character can have several `select-feat-*` engines for
 *    different features that all offer overlapping feat lists (any level-1
 *    wizard feat). When the owning feature is known, only that feature's
 *    selection is considered, so the school's choice resolves to its feat and
 *    Experimental Spellshaping's to its own — not whichever appears first.
 * 2. **Class-suffix stripping.** Demiplane feat slugs carry a class suffix
 *    (`widen-spell-wizard`) while the compendium/label slug does not
 *    (`widen-spell`). Each candidate is expanded via {@link generateSlugCandidates}
 *    (which strips the class suffix) before comparing.
 */
function matchFeatSlugs(choices: Choice[], engines: DemiplaneEngineEntry[], itemName?: string): Choice | null {
  const itemSlug = itemName ? toChoiceSlug(itemName) : "";
  const selectFeatEngines = engines.filter(
    (e) => ((e.args?.sourceRow as string) || "").includes("select-feat-") && e.args?.slug
  );

  // Prefer engines whose sourceRow names this feature; fall back to all when the
  // owner is unknown or none are scoped (preserving the prior broad behavior).
  const scoped = itemSlug ? selectFeatEngines.filter((e) => (e.args?.sourceRow as string).includes(itemSlug)) : [];
  const relevant = scoped.length > 0 ? scoped : selectFeatEngines;

  // Expand each Demiplane feat slug into its class-suffix-stripped candidates.
  const featSlugs = [...new Set(relevant.flatMap((e) => generateSlugCandidates(toFoundrySlug(e.args.slug as string))))];

  const scope = itemName ? ` for "${itemName}"` : "";
  debugLog(`[ChoiceSet match] Strategy 5 - feat slugs${scope}: [${featSlugs.join(", ")}]`);

  for (const choice of choices) {
    if (typeof choice.value === "string" && choice.value.includes("Compendium")) {
      // Compare the label slug against each candidate. `label === featSlug`
      // catches the class-suffix-stripped exact match (widen-spell ==
      // widen-spell from widen-spell-wizard); `label.includes(featSlug)` keeps
      // the prior behavior where a broader label contains the feat (Greater
      // Power Attack ⊃ power-attack). Scoping above prevents this leniency from
      // matching a sibling feature's feat.
      const label = toChoiceSlug(choice.label);
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
