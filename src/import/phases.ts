/**
 * Import phases — an ordered pipeline that ImportOrchestrator drives in sequence.
 *
 * Each phase implements `ImportPhase.run(actor, ctx)` and performs one cohesive
 * step of a character import. Splitting the god-object orchestrator into these
 * phases keeps `importCharacter` a thin driver while preserving the exact
 * ordering and arguments of the original sequential implementation.
 */

import type { DemiplaneEngineEntry, ImportSummary, ItemCategory } from "./types.js";
import { stampImported } from "./types.js";
import {
  characterSystem,
  itemSystem,
  sourceRules,
  itemSourceId,
  compendiumSource,
  toPlainData,
} from "../pf2e-types.js";
import { debugLog } from "./debug-log.js";
import { toFoundrySlug, getSlug, categorizeEngine, parseFeatSlot } from "./slug-utils.js";
import { resolveCompendiumItem } from "./compendium-resolver.js";
import { ChoiceSetHandler } from "./choice-set-handler.js";
import { applyBiography } from "./biography-importer.js";
import { applyEquipment, applyCurrency } from "./equipment-importer.js";
import { applySpells } from "./spell-importer.js";
import { applyFeatureGrantedSpells } from "./feature-spell-resolver.js";
import { applyItemSpells } from "./item-spell-resolver.js";
import { applySkillProficiencies, applyLanguages, applyAttributeBoosts } from "./attribute-language-importer.js";

/** Shared state threaded through every phase of a single import. */
export interface ImportContext {
  engines: DemiplaneEngineEntry[];
  summary: ImportSummary;
  choiceSetHandler: ChoiceSetHandler;
  categorized: Record<ItemCategory, Array<DemiplaneEngineEntry & { _slug: string }>>;
  selectionData: { grantedFeatSlugs: Set<string>; selectedFeats: string[] };
  /** Slugs of items created by resolving native PF2e grants. */
  grantResolvedSlugs: Set<string>;
}

/** A single ordered step of the import pipeline. */
export interface ImportPhase {
  run(actor: Actor, ctx: ImportContext): Promise<void>;
}

// ─── Pre-pipeline data prep (also exposed for the driver) ───────────────────

export function buildSelectionData(engines: DemiplaneEngineEntry[]) {
  const grantedFeatSlugs = new Set<string>();
  for (const eng of engines) {
    const sr = (eng.args?.sourceRow as string) || "";
    if (sr.includes("select-feat-") && eng.args?.slug && eng.name.includes("/feat/")) {
      grantedFeatSlugs.add(toFoundrySlug(eng.args.slug as string));
    }
  }

  const selectedFeats = engines
    .filter((e) => ((e.args?.sourceRow as string) || "").includes("select-feat-") && e.args?.slug)
    .map((e) => toFoundrySlug(e.args.slug as string));

  return { grantedFeatSlugs, selectedFeats };
}

export function categorizeEngines(engines: DemiplaneEngineEntry[]) {
  const categorized: Record<ItemCategory, Array<DemiplaneEngineEntry & { _slug: string }>> = {
    ancestry: [],
    heritage: [],
    background: [],
    class: [],
    feat: [],
    equipment: [],
  };

  for (const eng of engines.filter((e) => e.type === "DemiplaneEngine")) {
    const slug = getSlug(eng);
    if (!slug) continue;
    const category = categorizeEngine(eng.name);
    if (category) {
      categorized[category].push({ ...eng, _slug: slug });
    }
  }

  return categorized;
}

// ─── Phase 1: Lore items (must precede ancestry/background/class creation) ───

export class LoreItemsPhase implements ImportPhase {
  async run(actor: Actor, ctx: ImportContext): Promise<void> {
    const backgroundLores = await this.getBackgroundLoreNames(ctx.engines);
    const loreNames = collectLoreNames(ctx.engines, backgroundLores);
    if (loreNames.length === 0) return;

    const existingLores = new Set(
      actor.items.filter((i: { type: string }) => i.type === "lore").map((i: { name: string }) => i.name)
    );
    const newLores = loreNames.filter((n) => !existingLores.has(n));

    if (newLores.length > 0) {
      const loreItems: Record<string, unknown>[] = newLores.map((name: string) => ({
        name,
        type: "lore" as const,
        system: { proficient: { value: 1 } },
      }));
      await actor.createEmbeddedDocuments(
        "Item",
        loreItems.map((i) => stampImported(i))
      );
      ctx.summary.log.push(`+ lore: [${newLores.join(", ")}]`);
    }
  }

  private async getBackgroundLoreNames(engines: DemiplaneEngineEntry[]): Promise<string[]> {
    const bgEngine = engines.find(
      (e) => e.type === "DemiplaneEngine" && e.name.includes("/background/") && e.args?.slug
    );
    if (!bgEngine) return [];
    const bgSlug = getSlug(bgEngine);
    if (!bgSlug) return [];
    const bgItem = await resolveCompendiumItem(bgSlug, "background");
    if (!bgItem) return [];
    return itemSystem(bgItem).trainedSkills?.lore ?? [];
  }
}

// ─── Phase 2: Sequential ancestry → heritage → background → class items ──────

export class SequentialItemsPhase implements ImportPhase {
  async run(actor: Actor, ctx: ImportContext): Promise<void> {
    for (const category of ["ancestry", "heritage", "background", "class"] as ItemCategory[]) {
      for (const eng of ctx.categorized[category]) {
        await this.addItemToActor(actor, eng, category, ctx);
      }
    }
  }

  private async addItemToActor(
    actor: Actor,
    eng: DemiplaneEngineEntry & { _slug: string },
    category: ItemCategory,
    ctx: ImportContext
  ): Promise<void> {
    const itemData = await resolveCompendiumItem(eng._slug, category);
    if (itemData) {
      await ctx.choiceSetHandler.presetChoiceSelections(itemData, eng._slug);
      await actor.createEmbeddedDocuments("Item", [stampImported(itemData, eng._slug)]);
      ctx.summary.log.push(`+ ${category}: ${(itemData as { name: string }).name}`);
      ctx.summary.itemsImported++;
    } else {
      ctx.summary.log.push(`- ${category}: ${eng._slug} (not found)`);
      ctx.summary.unmapped.push({ slug: eng._slug, kind: category });
      ctx.summary.itemsSkipped++;
    }
  }
}

// ─── Phase 3: Resolve native PF2e pending grants ────────────────────────────

export class ResolveGrantsPhase implements ImportPhase {
  async run(actor: Actor, ctx: ImportContext): Promise<void> {
    const grantedSlugs = await this.resolvePendingGrants(actor, ctx);
    for (const slug of grantedSlugs) {
      ctx.selectionData.grantedFeatSlugs.add(slug);
      ctx.grantResolvedSlugs.add(slug);
    }
  }

  private async resolvePendingGrants(actor: Actor, ctx: ImportContext): Promise<Set<string>> {
    const grantedSlugs = new Set<string>();
    const allItems = Array.from(actor.items) as Array<{
      name: string;
      id: string;
      type: string;
      system: { rules?: Array<Record<string, unknown>> };
      flags: Record<string, unknown>;
    }>;

    for (const item of allItems) {
      const rules = this.extractSourceRules(item);
      const grantRules = rules.filter((r) => r.key === "GrantItem" && typeof r.uuid === "string" && !r.predicate);
      if (grantRules.length === 0) continue;

      const pf2eFlags = (item.flags?.pf2e || {}) as { rulesSelections?: Record<string, unknown> };
      const selections = pf2eFlags.rulesSelections || {};

      for (const rule of grantRules) {
        const slug = await this.processGrantRule(rule, selections, item.name, actor, ctx);
        if (slug) grantedSlugs.add(slug);
      }
    }

    return grantedSlugs;
  }

  private extractSourceRules(item: {
    system: { rules?: Array<Record<string, unknown>> };
  }): Array<Record<string, unknown>> {
    return sourceRules(item);
  }

  private async processGrantRule(
    rule: Record<string, unknown>,
    selections: Record<string, unknown>,
    itemName: string,
    actor: Actor,
    ctx: ImportContext
  ): Promise<string | null> {
    const uuid = this.resolveGrantUuid(rule, selections, itemName);
    if (!uuid) return null;

    if (this.isGrantAlreadyFulfilled(actor, uuid)) return null;

    try {
      const doc = await fromUuid(uuid);
      if (!doc) return null;

      const grantData = toPlainData(doc);
      await actor.createEmbeddedDocuments("Item", [stampImported(grantData)]);
      ctx.summary.log.push(`+ granted: ${String(grantData.name)} (from ${itemName})`);
      ctx.summary.itemsImported++;

      return itemSystem(grantData).slug ?? null;
    } catch {
      return null;
    }
  }

  private resolveGrantUuid(
    rule: Record<string, unknown>,
    selections: Record<string, unknown>,
    itemName: string
  ): string | null {
    let uuid = rule.uuid as string;

    const templateMatch = /\{item\|flags\.pf2e\.rulesSelections\.(\w+)\}/.exec(uuid);
    if (templateMatch?.[1]) {
      const flag = templateMatch[1];
      const resolved = selections[flag];
      if (typeof resolved === "string" && resolved.startsWith("Compendium.")) {
        uuid = resolved;
      } else {
        debugLog(
          `[orchestrator] Cannot resolve GrantItem template on ${itemName}: flag=${flag}, value=${String(resolved)}`
        );
        return null;
      }
    }

    return uuid.startsWith("Compendium.") ? uuid : null;
  }

  private isGrantAlreadyFulfilled(actor: Actor, uuid: string): boolean {
    return actor.items.some((existing: { flags?: Record<string, unknown>; sourceId?: string }) => {
      const core = existing.flags?.core as { sourceId?: string } | undefined;
      if (core?.sourceId === uuid) return true;

      if (itemSourceId(existing) === uuid) return true;

      const pf2eFlags = existing.flags?.pf2e as { grantedBy?: { id?: string } } | undefined;
      if (pf2eFlags?.grantedBy && compendiumSource(existing) === uuid) return true;

      return false;
    });
  }
}

// ─── Phase 4: Batch feat/equipment import ───────────────────────────────────

export class BatchItemsPhase implements ImportPhase {
  async run(actor: Actor, ctx: ImportContext): Promise<void> {
    const batchItems: Record<string, unknown>[] = [];
    for (const category of ["feat", "equipment"] as ItemCategory[]) {
      for (const eng of ctx.categorized[category]) {
        const itemOrNone = await this.processEngine(eng, category, ctx);
        if (itemOrNone) batchItems.push(itemOrNone);
      }
    }
    if (batchItems.length > 0) {
      await actor.createEmbeddedDocuments("Item", batchItems);
    }
  }

  private async processEngine(
    eng: DemiplaneEngineEntry & { _slug: string },
    category: ItemCategory,
    ctx: ImportContext
  ): Promise<Record<string, unknown> | null> {
    const slug = toFoundrySlug(eng._slug);
    if (ctx.selectionData.grantedFeatSlugs.has(slug)) {
      ctx.summary.log.push(`~ ${category}: ${slug} (already granted)`);
      return null;
    }

    const itemData = await resolveCompendiumItem(eng._slug, category);
    if (!itemData) {
      ctx.summary.log.push(`- ${category}: ${eng._slug} (not found)`);
      ctx.summary.unmapped.push({ slug: eng._slug, kind: category });
      ctx.summary.itemsSkipped++;
      return null;
    }

    await ctx.choiceSetHandler.presetChoiceSelections(itemData, eng._slug);
    if ((itemData as { type: string }).type === "feat" && eng.args?.sourceRow) {
      this.applyFeatSlot(itemData, eng.args.sourceRow as string);
    }

    const stamped = stampImported(itemData, eng._slug);
    ctx.summary.log.push(`+ ${category}: ${(itemData as { name: string }).name}`);
    ctx.summary.itemsImported++;
    return stamped;
  }

  private applyFeatSlot(itemData: Record<string, unknown>, sourceRow: string): void {
    const { location, taken } = parseFeatSlot(sourceRow);
    const system = itemData.system as Record<string, unknown>;
    if (location) system.location = location;
    if (taken !== null) {
      system.level = { ...(system.level as Record<string, unknown>), taken };
    }
  }
}

// ─── Phase 5: Post-import attribute/identity/spell processing ───────────────

export class PostProcessingPhase implements ImportPhase {
  async run(actor: Actor, ctx: ImportContext): Promise<void> {
    await this.setActorIdentity(actor, ctx.engines);
    await applyAttributeBoosts(actor, ctx.engines, ctx.summary);
    await applyLanguages(actor, ctx.engines, ctx.summary);
    await applyBiography(actor, ctx.engines, ctx.summary);
    await applySkillProficiencies(actor, ctx.engines, ctx.summary);
    await applyEquipment(actor, ctx.engines, ctx.summary);
    await applyCurrency(actor, ctx.engines, ctx.summary);
    await applySpells(actor, ctx.engines, ctx.summary);
    await applyFeatureGrantedSpells(actor, ctx.engines, ctx.summary);
    await applyItemSpells(actor, ctx.engines, ctx.summary);
    await this.syncSessionState(actor, ctx.engines);
  }

  private async syncSessionState(actor: Actor, engines: DemiplaneEngineEntry[]): Promise<void> {
    const findCustomValue = (name: string) =>
      engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === name);

    const maxHp = characterSystem(actor).attributes.hp.max;
    const currentHp = Number(findCustomValue("character_hit-points_current")?.value) || maxHp;
    const tempHp = Number(findCustomValue("character_hit-points_temp")?.value) || 0;
    const heroPoints = Number(findCustomValue("character_hero-points")?.value) || 1;

    await actor.update({
      "system.attributes.hp.value": Math.min(currentHp, maxHp),
      "system.attributes.hp.temp": tempHp,
      "system.resources.heroPoints.value": Math.min(heroPoints, 3),
    });
  }

  private async setActorIdentity(actor: Actor, engines: DemiplaneEngineEntry[]): Promise<void> {
    const nameEng = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === "character_name");
    const levelEng = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === "character_level");
    const avatarEng = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === "character_avatar");
    const updates: Record<string, unknown> = {};
    if (nameEng?.value) updates.name = nameEng.value;
    if (levelEng?.value) updates["system.details.level.value"] = levelEng.value;
    if (avatarEng?.value) {
      updates.img = avatarEng.value;
      updates["prototypeToken.texture.src"] = avatarEng.value;
    }
    if (Object.keys(updates).length > 0) await actor.update(updates);
  }
}

// ─── Phase 6: Remove duplicate (import-stamped + native-granted) items ──────

export class RemoveDuplicatesPhase implements ImportPhase {
  async run(actor: Actor, ctx: ImportContext): Promise<void> {
    // eslint-disable-next-line no-restricted-syntax -- reading created items as plain source records for dedup comparison
    const items = Array.from(actor.items) as unknown as Array<Record<string, unknown>>;
    const seen = new Map<string, Record<string, unknown>>();
    const toDelete: string[] = [];

    const isImportStamped = (item: Record<string, unknown>): boolean => {
      const flags = (item.flags as Record<string, Record<string, unknown>> | undefined) ?? {};
      const dpFlags = flags["demiplane-pf2e"] as { imported?: boolean } | undefined;
      return Boolean(dpFlags?.imported);
    };

    for (const item of items) {
      const flags = (item.flags || {}) as Record<string, Record<string, unknown>>;
      const core = (flags.core || {}) as { sourceId?: string };
      const key = core.sourceId || `${String(item.type)}::${String(item.name)}`;

      const isStamped = isImportStamped(item);

      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, item);
        continue;
      }

      const existingStamped = isImportStamped(existing);

      if (isStamped && !existingStamped) {
        toDelete.push(String(item._id));
      } else if (!isStamped && existingStamped) {
        toDelete.push(String(existing._id));
        seen.set(key, item);
      } else {
        toDelete.push(String(item._id));
      }
    }

    if (toDelete.length > 0) {
      await actor.deleteEmbeddedDocuments("Item", toDelete);
      ctx.summary.log.push(`- removed ${toDelete.length} duplicate item(s)`);
    }
  }
}

/**
 * Collects the names of Lore skills a character should have, from background
 * training and from Demiplane custom skill/lore selections.
 *
 * Background lore names come from the background item's `trainedSkills.lore`.
 * Additional lore (e.g. via an ancestry's "additional Lore" feature like Gnome
 * Obsession) arrives as a `core/selection/skill/custom-selection/index.eng`
 * engine whose `args.name` holds the Lore name. Custom lore skills may also
 * arrive as `core/selection/skill/custom-skill/index.eng`.
 */
export function collectLoreNames(engines: DemiplaneEngineEntry[], backgroundLores: string[] = []): string[] {
  const loreNames = [...backgroundLores];

  const customSkillEngines = engines.filter(
    (e) => e.name === "core/selection/skill/custom-skill/index.eng" && e.args?.name
  );
  for (const eng of customSkillEngines) {
    const name = eng.args!.name as string;
    if (!loreNames.includes(name)) loreNames.push(name);
  }

  const customSelectionLoreEngines = engines.filter(
    (e) =>
      e.name === "core/selection/skill/custom-selection/index.eng" &&
      e.args?.name &&
      /lore/i.test(e.args.name as string)
  );
  for (const eng of customSelectionLoreEngines) {
    const name = eng.args!.name as string;
    if (!loreNames.includes(name)) loreNames.push(name);
  }

  return loreNames;
}
