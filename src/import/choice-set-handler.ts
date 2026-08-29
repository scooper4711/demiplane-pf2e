import type { DemiplaneEngineEntry } from "./types.js";
import { toFoundrySlug } from "./slug-utils.js";
import { resolveSlugToUuid } from "./compendium-resolver.js";
import { debugLog } from "./debug-log.js";

interface ChoiceSetContext {
  choices: Array<{ value: unknown; label: string }>;
  selection: unknown;
  item: {
    flags: Record<string, unknown>;
    getRollOptions: (s: string) => string[];
    rules: Array<{ ignored: boolean }>;
    name: string;
  };
  actor: { getRollOptions: () => string[] };
  resolveInjectedProperties: (p: unknown) => {
    test: (r: Set<string>) => boolean;
  };
  predicate: unknown;
  prompt?: unknown;
  inflateChoices: (r: Set<string>, t: unknown) => Promise<Array<{ value: unknown; label: string }>>;
  flag: string;
  rollOption: string;
}

interface PreCreateParams {
  ruleSource: Record<string, unknown>;
  itemSource: { name: string } & Record<string, unknown>;
  tempItems: unknown;
}

/**
 * Manages ChoiceSet auto-resolution during import.
 * Monkey-patches ChoiceSetRuleElement.preCreate to suppress dialogs
 * and auto-select based on Demiplane data.
 */
export class ChoiceSetHandler {
  private originalPreCreate: ((...args: unknown[]) => Promise<void>) | null = null;
  private importMode = false;
  private currentEngines: DemiplaneEngineEntry[] = [];

  setEngines(engines: DemiplaneEngineEntry[]): void {
    this.currentEngines = engines;
  }

  enable(): void {
    this.importMode = true;
    if (this.originalPreCreate) {
      debugLog("[ChoiceSet] Monkey-patch already enabled; skipping re-install");
      return;
    }
    const ChoiceSetRE = this.getChoiceSetPrototype();
    this.originalPreCreate = ChoiceSetRE.prototype.preCreate as (...args: unknown[]) => Promise<void>;
    debugLog("[ChoiceSet] Monkey-patch enabled, import mode active");

    // eslint-disable-next-line @typescript-eslint/no-this-alias -- required for monkey-patch closure
    const self = this;
    ChoiceSetRE.prototype.preCreate = async function (this: ChoiceSetContext, params: PreCreateParams) {
      if (!self.importMode) {
        return (self.originalPreCreate as (...args: unknown[]) => Promise<void>).call(this, params);
      }

      if (this.selection !== null) {
        // A selection was pre-set (e.g. by PF2e's native grant resolution). If it
        // doesn't correspond to a real available choice, it's a bad placeholder
        // (e.g. the generic "lore" slug instead of the actual "forest-lore" skill)
        // and would pop the grant UI. Re-resolve it below instead of passing through.
        const valid = await self.isPreSetSelectionValid(this, params);
        if (valid) {
          debugLog(
            `[ChoiceSet] preCreate passthrough: valid pre-set selection=${String(this.selection)}, item=${params.itemSource.name}`
          );
          return (self.originalPreCreate as (...args: unknown[]) => Promise<void>).call(this, params);
        }
        debugLog(
          `[ChoiceSet] preCreate: pre-set selection ${String(this.selection)} is not a valid choice; re-resolving, item=${params.itemSource.name}`
        );
        // fall through to re-resolution
      }

      debugLog(
        `ChoiceSet preCreate: item=${this.item.name}, flag=${this.flag || "choice"}, prompt=${String(this.prompt)}, choices=${self.describeChoiceQuery(this.choices)}`
      );

      const rollOptions = new Set([this.actor.getRollOptions(), this.item.getRollOptions("parent")].flat());
      const predicate = this.resolveInjectedProperties(this.predicate);
      if (!predicate.test(rollOptions)) return;

      this.choices = await this.inflateChoices(rollOptions, params.tempItems);
      if (!this.choices || this.choices.length === 0) {
        debugLog("ChoiceSet presented choices: none");
        return;
      }

      debugLog(`ChoiceSet presented choices: ${self.describeChoices(this.choices)}`);

      const matched = self.findMatchInChoices(this.choices, this.item.name);
      const selected = matched ?? this.choices[0];
      if (selected) {
        self.applySelectedChoice(this, params, selected, matched !== null);
      }
    };
  }

  disable(): void {
    this.importMode = false;
    if (this.originalPreCreate) {
      const ChoiceSetRE = this.getChoiceSetPrototype();
      ChoiceSetRE.prototype.preCreate = this.originalPreCreate;
      this.originalPreCreate = null;
    }
    debugLog("[ChoiceSet] Monkey-patch disabled, import mode off");
  }

  /**
   * Determines whether a ChoiceSet's already-present `selection` is one of the
   * choices PF2e would actually offer. A pre-set selection that isn't a valid
   * choice (e.g. the generic "lore" slug rather than "forest-lore") would
   * otherwise cause the grant UI to pop; in that case the caller should
   * re-resolve the selection via the normal matching strategies.
   */
  private async isPreSetSelectionValid(context: ChoiceSetContext, params: PreCreateParams): Promise<boolean> {
    if (context.selection === null) return true;
    const rollOptions = new Set([context.actor.getRollOptions(), context.item.getRollOptions("parent")].flat());
    const choices = await context.inflateChoices(rollOptions, params.tempItems);
    return Array.isArray(choices) && choices.some((c) => c.value === context.selection);
  }

  private applySelectedChoice(
    context: ChoiceSetContext,
    params: PreCreateParams,
    selected: { value: unknown; label: string },
    matched: boolean
  ): void {
    debugLog(`ChoiceSet selection: ${matched ? "matched" : "fallback"} ${this.describeChoice(selected)}`);
    context.selection = params.ruleSource.selection = selected.value;

    // Set the item flag the same way PF2e's native ChoiceSet does — direct mutation
    // so that subsequent GrantItem rules can resolve {item|flags.pf2e.rulesSelections.X}
    const itemFlags = context.item.flags as Record<string, Record<string, unknown>>;
    if (!itemFlags.pf2e) itemFlags.pf2e = {};
    const pf2eFlags = itemFlags.pf2e as Record<string, unknown>;
    if (!pf2eFlags.rulesSelections) pf2eFlags.rulesSelections = {};
    (pf2eFlags.rulesSelections as Record<string, unknown>)[context.flag || "choice"] = selected.value;

    debugLog(
      `[ChoiceSet] Set flag: item.flags.pf2e.rulesSelections.${context.flag || "choice"} = ${String(selected.value)}`
    );

    // Reset ignored state on sibling rules so GrantItem processes after selection is available
    for (const rule of context.item.rules) {
      rule.ignored = false;
    }
  }

  private getChoiceSetPrototype(): { prototype: Record<string, unknown> } {
    const builtin = (
      game as unknown as {
        pf2e: {
          RuleElements: {
            builtin: Record<string, { prototype: Record<string, unknown> } | undefined>;
          };
        };
      }
    ).pf2e.RuleElements.builtin.ChoiceSet;
    if (!builtin) throw new Error("ChoiceSet RuleElement not found in game.pf2e.RuleElements.builtin");
    return builtin;
  }

  private findMatchInChoices(
    choices: Array<{ value: unknown; label: string }>,
    itemName?: string
  ): { value: unknown; label: string } | null {
    const match =
      this.matchSkillSlugs(choices) ??
      this.matchCustomSelectionLore(choices, itemName) ??
      this.matchAllSlugs(choices) ??
      this.matchClassFeatures(choices) ??
      this.matchGenericFeatures(choices) ??
      this.matchFeatSlugs(choices) ??
      this.matchGenericChoice(choices, itemName);

    if (!match) debugLog("[ChoiceSet match] No match found across all strategies");
    return match;
  }

  private matchSkillSlugs(choices: Array<{ value: unknown; label: string }>): { value: unknown; label: string } | null {
    const allSkillSlugs = this.currentEngines
      .filter((e) => e.name === "core/selection/skill/increase/index.eng" && e.args?.slug)
      .map((e) => e.args?.slug as string);

    debugLog(`[ChoiceSet match] Strategy 1 - skill slugs: [${allSkillSlugs.join(", ")}]`);

    for (const choice of choices) {
      const val = typeof choice.value === "string" ? choice.value : "";
      if (allSkillSlugs.includes(val)) return choice;
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
  private matchCustomSelectionLore(
    choices: Array<{ value: unknown; label: string }>,
    itemName?: string
  ): { value: unknown; label: string } | null {
    const itemSlug = itemName ? this.toChoiceSlug(itemName) : "";
    const loreEngines = this.currentEngines.filter(
      (e) =>
        e.name === "core/selection/skill/custom-selection/index.eng" &&
        e.args?.name &&
        (itemSlug === "" ||
          (e.args.sourceRow as string)?.includes(`${itemSlug}-rm`) ||
          (e.args.sourceRow as string)?.includes(itemSlug))
    );

    debugLog(
      `[ChoiceSet match] custom-selection lore engines${itemName ? ` for "${itemName}"` : ""}: [${loreEngines
        .map((e) => String(e.args?.name))
        .join(", ")}]`
    );

    for (const eng of loreEngines) {
      const target = this.toChoiceSlug(eng.args!.name as string);
      for (const choice of choices) {
        const val = typeof choice.value === "string" ? choice.value.toLowerCase() : "";
        if (val === target || this.toChoiceSlug(choice.label) === target) return choice;
      }
    }
    return null;
  }

  private matchAllSlugs(choices: Array<{ value: unknown; label: string }>): { value: unknown; label: string } | null {
    const allSlugs = this.currentEngines
      .filter((e) => e.type === "DemiplaneEngine" && e.args?.slug)
      .map((e) => toFoundrySlug(e.args?.slug as string));

    debugLog(`[ChoiceSet match] Strategy 2 - all engine slugs (first 20): [${allSlugs.slice(0, 20).join(", ")}]`);

    for (const choice of choices) {
      const val = typeof choice.value === "string" ? choice.value : "";
      if (allSlugs.includes(val)) return choice;
    }
    return null;
  }

  private matchClassFeatures(
    choices: Array<{ value: unknown; label: string }>
  ): { value: unknown; label: string } | null {
    const classFeatureSlugs = this.currentEngines
      .filter((e) => e.type === "DemiplaneEngine" && e.name.includes("/class-feature/") && e.args?.slug)
      .map((e) => toFoundrySlug(e.args?.slug as string));

    debugLog(`[ChoiceSet match] Strategy 3 - class feature slugs: [${classFeatureSlugs.join(", ")}]`);
    debugLog(
      `[ChoiceSet match] Choice labels for Strategy 3: [${choices
        .slice(0, 5)
        .map((c) => `${c.label}→${this.toChoiceSlug(c.label)}`)
        .join(", ")}...]`
    );

    for (const choice of choices) {
      const labelSlug = this.toChoiceSlug(choice.label);
      if (classFeatureSlugs.some((slug) => labelSlug === slug || labelSlug.endsWith(`-${slug}`))) {
        return choice;
      }
    }
    return null;
  }

  private matchGenericFeatures(
    choices: Array<{ value: unknown; label: string }>
  ): { value: unknown; label: string } | null {
    const genericFeatureSlugs = this.currentEngines
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

  private matchFeatSlugs(choices: Array<{ value: unknown; label: string }>): { value: unknown; label: string } | null {
    const featSlugs = this.currentEngines
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
  private matchGenericChoice(
    choices: Array<{ value: unknown; label: string }>,
    itemName?: string
  ): { value: unknown; label: string } | null {
    const genericChoiceEngines = this.currentEngines.filter(
      (e) => e.type === "DemiplaneEngine" && e.name.includes("/generic-choice/") && e.args?.slug
    );

    const matchScoped = (
      engines: DemiplaneEngineEntry[],
      label: (keywords: string[]) => string
    ): { value: unknown; label: string } | null => {
      if (engines.length === 0) return null;
      const keywords = this.genericChoiceKeywords(engines);
      debugLog(label(keywords));
      return this.matchByKeyword(choices, keywords);
    };

    return (
      matchScoped(
        genericChoiceEngines,
        (k) => `[ChoiceSet match] Strategy 6 - generic choice keywords: [${k.join(", ")}]`
      ) ??
      (itemName
        ? matchScoped(
            genericChoiceEngines.filter(
              (e) => e.args?.slug && toFoundrySlug(e.args.slug as string).startsWith(this.toChoiceSlug(itemName))
            ),
            (k) => `[ChoiceSet match] Strategy 6 - generic choice for "${itemName}": keywords=[${k.join(", ")}]`
          )
        : null)
    );
  }

  private genericChoiceKeywords(engines: DemiplaneEngineEntry[]): string[] {
    return engines.map((e) => {
      const slug = toFoundrySlug(e.args?.slug as string);
      return slug.split("-").pop() || "";
    });
  }

  private matchByKeyword(
    choices: Array<{ value: unknown; label: string }>,
    keywords: string[]
  ): { value: unknown; label: string } | null {
    for (const choice of choices) {
      const val = typeof choice.value === "string" ? choice.value.toLowerCase() : "";
      const label = choice.label.toLowerCase();
      for (const keyword of keywords) {
        if (keyword && (val.includes(keyword) || label === keyword)) return choice;
      }
    }
    return null;
  }

  private toChoiceSlug(label: string): string {
    const name = label.split(":").pop() || label;
    return name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  private describeChoiceQuery(choices: unknown): string {
    if (typeof choices === "string") return choices;
    try {
      return JSON.stringify(choices) || "none";
    } catch {
      return "unserializable";
    }
  }

  private describeChoices(choices: Array<{ value: unknown; label: string }>): string {
    return choices.map((choice) => this.describeChoice(choice)).join(", ");
  }

  private describeChoice(choice: { value: unknown; label: string }): string {
    return `${choice.label} [${String(choice.value)}]`;
  }

  /**
   * Pre-set ChoiceSet selections on item data before adding to actor.
   */
  async presetChoiceSelections(itemData: Record<string, unknown>, demiplaneSlug: string): Promise<void> {
    const system = itemData.system as { rules?: Array<Record<string, unknown>> } | undefined;
    if (!system?.rules) return;

    const choiceSetRules = system.rules.filter((r) => r.key === "ChoiceSet");
    if (choiceSetRules.length > 0) {
      debugLog(
        `[ChoiceSet] presetChoiceSelections: item=${(itemData as { name?: string }).name}, slug=${demiplaneSlug}, ChoiceSet rules count=${String(choiceSetRules.length)}`
      );
    }

    for (const rule of system.rules) {
      if (rule.key !== "ChoiceSet") continue;
      const selection = await this.findChoiceSelection(demiplaneSlug, rule);
      if (selection !== null) {
        debugLog(
          `[ChoiceSet] presetChoiceSelections resolved: flag=${String(rule.flag || "choice")}, selection=${String(selection)}`
        );
        rule.selection = selection;
        // Also set flags so GrantItem can resolve {item|flags.pf2e.rulesSelections.X}
        const flag = (rule.flag as string) || "choice";
        const flags = (itemData.flags || {}) as Record<string, Record<string, unknown>>;
        if (!flags.pf2e) flags.pf2e = {};
        const rulesSelections = (flags.pf2e.rulesSelections || {}) as Record<string, unknown>;
        rulesSelections[flag] = selection;
        flags.pf2e.rulesSelections = rulesSelections;
        itemData.flags = flags;
      } else {
        debugLog(
          `[ChoiceSet] presetChoiceSelections: no match for flag=${String(rule.flag || "choice")} on slug=${demiplaneSlug}`
        );
      }
    }
  }

  private async findChoiceSelection(parentSlug: string, rule: Record<string, unknown>): Promise<string | null> {
    const patterns = [
      `select-skill-${parentSlug}`,
      `select-feat-${parentSlug}`,
      `select-generic-feature-${parentSlug}`,
      `select-${parentSlug}`,
    ];

    for (const eng of this.currentEngines) {
      const sr = (eng.args?.sourceRow as string) || "";
      for (const pattern of patterns) {
        if (sr.includes(pattern) && eng.args?.slug) {
          return this.resolveChildSlug(eng.args.slug as string, rule, eng);
        }
      }
    }

    // Strategy 2: child class-feature whose sourceRow matches the parent slug directly
    const strippedParent = parentSlug.replace(/-rm$/, "") + "-rm";
    for (const eng of this.currentEngines) {
      const sr = (eng.args?.sourceRow as string) || "";
      if (sr === strippedParent && eng.args?.slug && eng.name.includes("/class-feature/")) {
        return this.resolveChildSlug(eng.args.slug as string, rule);
      }
    }

    return null;
  }

  private async resolveChildSlug(
    rawSlug: string,
    rule: Record<string, unknown>,
    eng?: DemiplaneEngineEntry
  ): Promise<string | null> {
    const childSlug = toFoundrySlug(rawSlug);
    if (this.isCompendiumChoiceSet(rule.choices)) {
      return await resolveSlugToUuid(childSlug);
    }
    // For generic-feature engines, the slug is compound (e.g. "martial-disciple-rm-athletics-rm").
    // Use the engine's args.name lowercased as the choice value (e.g. "athletics").
    if (eng?.name.includes("/generic-feature/") && eng.args?.name) {
      return (eng.args.name as string).toLowerCase().replace(/\s+/g, "-");
    }
    // For custom-selection lore engines (e.g. Gnome Obsession's "additional Lore"),
    // args.slug is the generic "lore" placeholder while args.name holds the real
    // skill ("Forest Lore"). Derive the specific skill slug so the grant resolves.
    if (eng?.name === "core/selection/skill/custom-selection/index.eng" && eng.args?.name) {
      return this.toChoiceSlug(eng.args.name as string);
    }
    return childSlug;
  }

  private isCompendiumChoiceSet(choices: unknown): boolean {
    return (
      typeof choices === "object" &&
      choices !== null &&
      !Array.isArray(choices) &&
      "filter" in (choices as Record<string, unknown>)
    );
  }
}
