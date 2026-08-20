import type { DemiplaneEngineEntry } from "./types.js";
import { toFoundrySlug } from "./slug-utils.js";
import { resolveSlugToUuid } from "./compendium-resolver.js";

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
    const ChoiceSetRE = (game as unknown as { pf2e: { RuleElements: { builtin: Record<string, { prototype: Record<string, unknown> }> } } }).pf2e.RuleElements.builtin.ChoiceSet;
    this.originalPreCreate = ChoiceSetRE.prototype.preCreate as (...args: unknown[]) => Promise<void>;

    // eslint-disable-next-line @typescript-eslint/no-this-alias -- required for monkey-patch closure
    const self = this;
    ChoiceSetRE.prototype.preCreate = async function (
      this: { choices: Array<{ value: unknown; label: string }>; selection: unknown; item: { flags: Record<string, unknown>; getRollOptions: (s: string) => string[]; name: string }; actor: { getRollOptions: () => string[] }; resolveInjectedProperties: (p: unknown) => { test: (r: Set<string>) => boolean }; predicate: unknown; inflateChoices: (r: Set<string>, t: unknown) => Promise<Array<{ value: unknown; label: string }>>; flag: string; rollOption: string },
      params: { ruleSource: Record<string, unknown>; itemSource: { name: string } & Record<string, unknown>; tempItems: unknown },
    ) {
      if (!self.importMode) {
        return (self.originalPreCreate as (...args: unknown[]) => Promise<void>).call(this, params);
      }

      if (this.selection !== null) {
        return (self.originalPreCreate as (...args: unknown[]) => Promise<void>).call(this, params);
      }

      const rollOptions = new Set([this.actor.getRollOptions(), this.item.getRollOptions("parent")].flat());
      const predicate = this.resolveInjectedProperties(this.predicate);
      if (!predicate.test(rollOptions)) return;

      this.choices = await this.inflateChoices(rollOptions, params.tempItems);
      if (!this.choices || this.choices.length === 0) return;

      const matched = self.findMatchInChoices(this.choices);
      if (matched) {
        this.selection = params.ruleSource.selection = matched.value;
        const pf2eFlags = (this.item.flags.pf2e || {}) as Record<string, unknown>;
        const rulesSelections = (pf2eFlags.rulesSelections || {}) as Record<string, unknown>;
        rulesSelections[this.flag || "choice"] = matched.value;
        pf2eFlags.rulesSelections = rulesSelections;
        this.item.flags.pf2e = pf2eFlags;
      } else if (this.choices.length > 0) {
        const first = this.choices[0];
        this.selection = params.ruleSource.selection = first.value;
      }
    };
  }

  disable(): void {
    this.importMode = false;
    if (this.originalPreCreate) {
      const ChoiceSetRE = (game as unknown as { pf2e: { RuleElements: { builtin: Record<string, { prototype: Record<string, unknown> }> } } }).pf2e.RuleElements.builtin.ChoiceSet;
      ChoiceSetRE.prototype.preCreate = this.originalPreCreate;
      this.originalPreCreate = null;
    }
  }

  // eslint-disable-next-line complexity -- multi-strategy matching (skill, slug, generic, feat UUID)
  private findMatchInChoices(choices: Array<{ value: unknown; label: string }>): { value: unknown; label: string } | null {
    const allSlugs = this.currentEngines
      .filter((e) => e.type === "DemiplaneEngine" && e.args?.slug)
      .map((e) => toFoundrySlug(e.args?.slug as string));

    const allSkillSlugs = this.currentEngines
      .filter((e) => e.name === "core/selection/skill/increase/index.eng" && e.args?.slug)
      .map((e) => e.args?.slug as string);

    for (const choice of choices) {
      const val = typeof choice.value === "string" ? choice.value : "";
      if (allSkillSlugs.includes(val)) return choice;
    }

    for (const choice of choices) {
      const val = typeof choice.value === "string" ? choice.value : "";
      if (allSlugs.includes(val)) return choice;
    }

    const genericFeatureSlugs = this.currentEngines
      .filter((e) => e.type === "DemiplaneEngine" && e.name.includes("/generic-feature/") && e.args?.slug)
      .map((e) => toFoundrySlug(e.args?.slug as string));

    for (const choice of choices) {
      const val = typeof choice.value === "string" ? choice.value : "";
      if (!val || val.includes("Compendium")) continue;
      for (const slug of genericFeatureSlugs) {
        if (slug.includes(val)) return choice;
      }
    }

    const featSlugs = this.currentEngines
      .filter((e) => ((e.args?.sourceRow as string) || "").includes("select-feat-") && e.args?.slug)
      .map((e) => toFoundrySlug(e.args.slug as string));

    for (const choice of choices) {
      if (typeof choice.value === "string" && choice.value.includes("Compendium")) {
        const label = choice.label.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
        for (const featSlug of featSlugs) {
          if (label === featSlug || label.includes(featSlug)) return choice;
        }
      }
    }

    return null;
  }

  /**
   * Pre-set ChoiceSet selections on item data before adding to actor.
   */
  async presetChoiceSelections(
    itemData: Record<string, unknown>,
    demiplaneSlug: string,
  ): Promise<void> {
    const system = itemData.system as { rules?: Array<Record<string, unknown>> } | undefined;
    if (!system?.rules) return;

    for (const rule of system.rules) {
      if (rule.key !== "ChoiceSet") continue;
      const selection = await this.findChoiceSelection(demiplaneSlug, rule);
      if (selection !== null) {
        rule.selection = selection;
      }
    }
  }

  private async findChoiceSelection(
    parentSlug: string,
    rule: Record<string, unknown>,
  ): Promise<string | null> {
    const patterns = [
      `select-skill-${parentSlug}`,
      `select-feat-${parentSlug}`,
      `select-${parentSlug}`,
    ];

    for (const eng of this.currentEngines) {
      const sr = (eng.args?.sourceRow as string) || "";
      for (const pattern of patterns) {
        if (sr.includes(pattern) && eng.args?.slug) {
          const childSlug = toFoundrySlug(eng.args.slug as string);

          const choices = rule.choices;
          if (typeof choices === "object" && choices !== null && !Array.isArray(choices) && "filter" in (choices as Record<string, unknown>)) {
            return await resolveSlugToUuid(childSlug);
          }

          return childSlug;
        }

    // Strategy 2: child class-feature whose sourceRow matches the parent slug directly
    // e.g. "school-of-battle-magic-rm" has sourceRow "arcane-school-rm" = parent slug
    const strippedParent = parentSlug.replace(/-rm$/, "") + "-rm";
    for (const eng of this.currentEngines) {
      const sr = (eng.args?.sourceRow as string) || "";
      if (sr === strippedParent && eng.args?.slug && eng.name.includes("/class-feature/")) {
        const childSlug = toFoundrySlug(eng.args.slug as string);
        const choices = rule.choices;
        if (typeof choices === "object" && choices !== null && !Array.isArray(choices) && "filter" in (choices as Record<string, unknown>)) {
          return await resolveSlugToUuid(childSlug);
        }
        return childSlug;
      }
    }
      }
    }

    return null;
  }
}
