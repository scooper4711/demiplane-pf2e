import type { DemiplaneEngineEntry } from "./types.js";
import { toFoundrySlug } from "./slug-utils.js";
import { resolveSlugToUuid } from "./compendium-resolver.js";
import { debugLog } from "./debug-log.js";
import { toChoiceSlug } from "./choice-slug.js";
import { findMatchInChoices } from "./choice-matchers.js";
import type { Choice, ChoiceSetContext, PreCreateParams } from "./choice-set-types.js";
import { getLibWrapper, registerWrapper, unregisterWrapper, type WrappedFn } from "../libwrapper.js";
import { builtinRuleElement } from "../pf2e-types.js";

/** libWrapper target path for the PF2e ChoiceSet's `preCreate`, resolved from `globalThis`. */
const CHOICE_SET_TARGET = "game.pf2e.RuleElements.builtin.ChoiceSet.prototype.preCreate";

/**
 * Manages ChoiceSet auto-resolution during import.
 *
 * Wraps `ChoiceSetRuleElement.preCreate` to suppress dialogs and auto-select
 * based on Demiplane data. When the community libWrapper module is active the
 * wrap is registered through it (so this module chains cleanly with any other
 * module wrapping the same method); otherwise it falls back to a direct
 * prototype patch. Either way the wrap is installed only for the duration of an
 * import and removed afterwards.
 */
export class ChoiceSetHandler {
  private originalPreCreate: ((...args: unknown[]) => Promise<void>) | null = null;
  private patchedPreCreate: ((...args: unknown[]) => Promise<void>) | null = null;
  private usingLibWrapper = false;
  private importMode = false;
  private currentEngines: DemiplaneEngineEntry[] = [];

  setEngines(engines: DemiplaneEngineEntry[]): void {
    this.currentEngines = engines;
  }

  enable(): void {
    this.importMode = true;
    if (this.usingLibWrapper || this.originalPreCreate) {
      debugLog("[ChoiceSet] Wrap already enabled; skipping re-install");
      return;
    }

    if (getLibWrapper()) {
      this.enableViaLibWrapper();
    } else {
      this.enableViaPrototypePatch();
    }
  }

  disable(): void {
    this.importMode = false;
    if (this.usingLibWrapper) {
      unregisterWrapper(CHOICE_SET_TARGET);
      this.usingLibWrapper = false;
      debugLog("[ChoiceSet] libWrapper wrap removed, import mode off");
      return;
    }

    this.restorePrototypePatch();
    debugLog("[ChoiceSet] Monkey-patch disabled, import mode off");
  }

  private enableViaLibWrapper(): void {
    const handle = this.handlePreCreate.bind(this);
    registerWrapper(CHOICE_SET_TARGET, function (this: unknown, wrapped: WrappedFn, ...args: unknown[]) {
      const context = this as ChoiceSetContext;
      const params = args[0] as PreCreateParams;
      return handle(context, params, () => wrapped.call(context, params) as Promise<void>);
    });
    this.usingLibWrapper = true;
    debugLog("[ChoiceSet] libWrapper wrap registered, import mode active");
  }

  private enableViaPrototypePatch(): void {
    const ChoiceSetRE = this.getChoiceSetPrototype();
    const original = ChoiceSetRE.prototype.preCreate as (...args: unknown[]) => Promise<void>;
    this.originalPreCreate = original;

    const handle = this.handlePreCreate.bind(this);
    const patched = async function (this: ChoiceSetContext, params: PreCreateParams) {
      await handle(this, params, () => original.call(this, params) as Promise<void>);
    };
    this.patchedPreCreate = patched as (...args: unknown[]) => Promise<void>;
    ChoiceSetRE.prototype.preCreate = patched;
    debugLog("[ChoiceSet] Monkey-patch enabled, import mode active");
  }

  /**
   * Restores the original `preCreate`, but only if our patch is still the live
   * method. If another module wrapped `preCreate` after us, overwriting it here
   * would silently delete their wrapper — so we leave the newer wrapper in place
   * and just drop our reference.
   */
  private restorePrototypePatch(): void {
    if (!this.originalPreCreate) return;
    const ChoiceSetRE = this.getChoiceSetPrototype();
    if (ChoiceSetRE.prototype.preCreate === this.patchedPreCreate) {
      ChoiceSetRE.prototype.preCreate = this.originalPreCreate;
    } else {
      debugLog("[ChoiceSet] preCreate was re-wrapped by another module; leaving it in place");
    }
    this.originalPreCreate = null;
    this.patchedPreCreate = null;
  }

  private async handlePreCreate(
    context: ChoiceSetContext,
    params: PreCreateParams,
    callOriginal: () => Promise<void>
  ): Promise<void> {
    if (!this.importMode) {
      return callOriginal();
    }

    if (await this.shouldPassThroughPreSetSelection(context, params)) {
      return callOriginal();
    }

    debugLog(
      `ChoiceSet preCreate: item=${context.item.name}, flag=${context.flag || "choice"}, prompt=${this.description(
        context.prompt
      )}, choices=${this.describeChoiceQuery(context.choices)}`
    );

    const rollOptions = this.collectRollOptions(context);
    const predicate = context.resolveInjectedProperties(context.predicate);
    if (!predicate.test(rollOptions)) return;

    context.choices = await context.inflateChoices(rollOptions, params.tempItems);
    if (!context.choices || context.choices.length === 0) {
      debugLog("ChoiceSet presented choices: none");
      return;
    }

    debugLog(`ChoiceSet presented choices: ${this.describeChoices(context.choices)}`);

    const matched = findMatchInChoices(context.choices, this.currentEngines, context.item.name);
    const selected = matched ?? context.choices[0];
    if (selected) {
      this.applySelectedChoice(context, params, selected, matched !== null);
    }
  }

  /**
   * A pre-set `selection` (e.g. from PF2e's native grant resolution) should pass
   * straight through when it's a real available choice. When it isn't — such as
   * the generic "lore" slug instead of the actual "forest-lore" skill — it would
   * pop the grant UI, so the caller re-resolves it via the matching strategies.
   */
  private async shouldPassThroughPreSetSelection(context: ChoiceSetContext, params: PreCreateParams): Promise<boolean> {
    if (context.selection === null) return false;

    if (await this.isPreSetSelectionValid(context, params)) {
      debugLog(
        `[ChoiceSet] preCreate passthrough: valid pre-set selection=${String(
          this.description(context.selection)
        )}, item=${params.itemSource.name}`
      );
      return true;
    }

    debugLog(
      `[ChoiceSet] preCreate: pre-set selection ${this.description(
        context.selection
      )} is not a valid choice; re-resolving, item=${params.itemSource.name}`
    );
    return false;
  }

  private async isPreSetSelectionValid(context: ChoiceSetContext, params: PreCreateParams): Promise<boolean> {
    if (context.selection === null) return true;
    const choices = await context.inflateChoices(this.collectRollOptions(context), params.tempItems);
    return Array.isArray(choices) && choices.some((c) => c.value === context.selection);
  }

  private collectRollOptions(context: ChoiceSetContext): Set<string> {
    return new Set([context.actor.getRollOptions(), context.item.getRollOptions("parent")].flat());
  }

  private applySelectedChoice(
    context: ChoiceSetContext,
    params: PreCreateParams,
    selected: Choice,
    matched: boolean
  ): void {
    debugLog(`ChoiceSet selection: ${matched ? "matched" : "fallback"} ${this.describeChoice(selected)}`);
    context.selection = params.ruleSource.selection = selected.value;

    // Set the item flag the same way PF2e's native ChoiceSet does — direct mutation
    // so that subsequent GrantItem rules can resolve {item|flags.pf2e.rulesSelections.X}
    const itemFlags = context.item.flags as Record<string, Record<string, unknown>>;
    itemFlags.pf2e ??= {};
    const pf2eFlags = itemFlags.pf2e as Record<string, unknown>;
    pf2eFlags.rulesSelections ??= {};
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
    const builtin = builtinRuleElement("ChoiceSet");
    if (!builtin) throw new Error("ChoiceSet RuleElement not found in game.pf2e.RuleElements.builtin");
    return builtin;
  }

  private description(selection: unknown): string {
    return typeof selection === "string" ? selection : JSON.stringify(selection);
  }

  private describeChoiceQuery(choices: unknown): string {
    if (typeof choices === "string") return choices;
    try {
      return JSON.stringify(choices) || "none";
    } catch {
      return "unserializable";
    }
  }

  private describeChoices(choices: Choice[]): string {
    return choices.map((choice) => this.describeChoice(choice)).join(", ");
  }

  private describeChoice(choice: Choice): string {
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
      await this.presetSingleRule(itemData, rule, demiplaneSlug);
    }
  }

  private async presetSingleRule(
    itemData: Record<string, unknown>,
    rule: Record<string, unknown>,
    demiplaneSlug: string
  ): Promise<void> {
    const flagText = typeof rule.flag === "string" ? (rule.flag as string) : "choice";
    const selection = await this.findChoiceSelection(demiplaneSlug, rule);
    if (selection === null) {
      debugLog(`[ChoiceSet] presetChoiceSelections: no match for flag=${flagText} on slug=${demiplaneSlug}`);
      return;
    }

    debugLog(`[ChoiceSet] presetChoiceSelections resolved: flag=${flagText}, selection=${String(selection)}`);
    rule.selection = selection;

    // Also set flags so GrantItem can resolve {item|flags.pf2e.rulesSelections.X}
    const flags = (itemData.flags || {}) as Record<string, Record<string, unknown>>;
    flags.pf2e ??= {};
    const rulesSelections = (flags.pf2e.rulesSelections ?? {}) as Record<string, unknown>;
    rulesSelections[flagText] = selection;
    flags.pf2e.rulesSelections = rulesSelections;
    itemData.flags = flags;
  }

  private async findChoiceSelection(parentSlug: string, rule: Record<string, unknown>): Promise<string | null> {
    const patterns = [
      `select-skill-${parentSlug}`,
      `select-feat-${parentSlug}`,
      `select-generic-feature-${parentSlug}`,
      `select-${parentSlug}`,
    ];

    for (const eng of this.currentEngines) {
      const sourceRow = (eng.args?.sourceRow as string) || "";
      for (const pattern of patterns) {
        if (sourceRow.includes(pattern) && eng.args?.slug) {
          return this.resolveChildSlug(eng.args.slug as string, rule, eng);
        }
      }
    }

    // Strategy 2: child class-feature whose sourceRow matches the parent slug directly
    const strippedParent = parentSlug.replace(/-rm$/, "") + "-rm";
    for (const eng of this.currentEngines) {
      const sourceRow = (eng.args?.sourceRow as string) || "";
      if (sourceRow === strippedParent && eng.args?.slug && eng.name.includes("/class-feature/")) {
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
      return toChoiceSlug(eng.args.name as string);
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
