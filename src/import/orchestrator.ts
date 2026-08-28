/**
 * ImportOrchestrator - Coordinates full character import from Demiplane into Foundry PF2e.
 *
 * Key architecture decisions:
 * - Items are resolved from compendium via slug matching (strip -rm suffix)
 * - ChoiceSet prompts are suppressed by monkey-patching preCreate during import
 * - Feats get system.location and system.level.taken set from Demiplane sourceRow
 * - Feats granted by other feats' ChoiceSets are skipped (deduplication)
 * - Feats granted by GrantItem rules (e.g. background → Assurance) are detected and skipped
 * - Class features are created by PF2e's native Granted rules, not imported directly
 * - Import order: ancestry → heritage → background → class (sequential), then feats (batch)
 */

import type { DemiplaneEngineEntry, ImportOptions, ImportSummary, ItemCategory } from "./types.js";
import { MODULE_ID, stampImported } from "./types.js";
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

export class ImportOrchestrator {
  private choiceSetHandler = new ChoiceSetHandler();

  async importCharacter(actor: Actor, characterId: string, options: ImportOptions = {}): Promise<ImportSummary> {
    const { token } = options;
    const summary: ImportSummary = {
      itemsImported: 0,
      itemsSkipped: 0,
      unresolved: [],
      errors: [],
      log: [],
    };

    const fetched = await this.fetchCharacterEngines(characterId, token, summary);
    if (!fetched) return summary;
    const { engines, updated } = fetched;
    if (updated) {
      await actor.setFlag(MODULE_ID, "lastUpdated", updated);
      debugLog(`[import] stored lastUpdated=${updated}`);
    } else {
      debugLog(`[import] character has no updated timestamp; leaving lastUpdated unchanged`);
    }

    // eslint-disable-next-line no-console -- single always-on log per pull
    console.info(`${MODULE_ID} | Pulled character data from Demiplane (${characterId})`);

    this.choiceSetHandler.setEngines(engines);

    const selectionData = this.buildSelectionData(engines);
    const categorized = this.categorizeEngines(engines);

    this.choiceSetHandler.enable();

    const importHookId = Hooks.on("preCreateItem", ((item: Item) => {
      if (item.parent?.id !== actor.id) return;
      (item as { updateSource: (data: Record<string, unknown>) => void }).updateSource({
        [`flags.${MODULE_ID}.imported`]: true,
      });
    }) as never);

    try {
      // Create Lore items BEFORE any ancestry/background/class/feat items. Feats
      // like Assurance can reference lore skills granted by ancestry/background,
      // and their grants fire natively during item creation.
      await this.createLoreItems(actor, engines, summary);

      for (const category of ["ancestry", "heritage", "background", "class"] as ItemCategory[]) {
        for (const eng of categorized[category]) {
          await this.addItemToActor(actor, eng, category, summary);
        }
      }

      // Resolve pending grants and exclude their slugs from the batch import
      const grantResolvedSlugs = await this.resolvePendingGrants(actor, summary);
      for (const slug of grantResolvedSlugs) {
        selectionData.grantedFeatSlugs.add(slug);
      }

      await this.importBatchItems(actor, categorized, selectionData, summary);

      await this.applyPostProcessing(actor, engines, summary);

      // Some feats appear both in the Demiplane engine list (imported via the
      // batch above) and as native PF2e grants from another item (e.g. Gnome
      // Obsession granted by the Gnome ancestry, Animal Empathy granted by the
      // Druid's Voice of Nature). Remove the duplicate copies we stamped.
      await this.removeDuplicateItems(actor, summary);
    } finally {
      Hooks.off("preCreateItem", importHookId);
      this.choiceSetHandler.disable();
    }

    await actor.setFlag(MODULE_ID, "lastImportTimestamp", Date.now());
    return summary;
  }

  private async applyPostProcessing(
    actor: Actor,
    engines: DemiplaneEngineEntry[],
    summary: ImportSummary
  ): Promise<void> {
    await this.setActorIdentity(actor, engines);
    await applyAttributeBoosts(actor, engines, summary);
    await applyLanguages(actor, engines, summary);
    await applyBiography(actor, engines, summary);
    await applySkillProficiencies(actor, engines, summary);
    await applyEquipment(actor, engines, summary);
    await applyCurrency(actor, engines, summary);
    await applySpells(actor, engines, summary);
    await applyFeatureGrantedSpells(actor, engines, summary);
    await applyItemSpells(actor, engines, summary);
    await this.syncSessionState(actor, engines);
  }

  private async importBatchItems(
    actor: Actor,
    categorized: Record<ItemCategory, Array<DemiplaneEngineEntry & { _slug: string }>>,
    selectionData: { grantedFeatSlugs: Set<string>; selectedFeats: string[] },
    summary: ImportSummary
  ): Promise<void> {
    const batchItems: Record<string, unknown>[] = [];
    for (const category of ["feat", "equipment"] as ItemCategory[]) {
      for (const eng of categorized[category]) {
        const slug = toFoundrySlug(eng._slug);
        if (selectionData.grantedFeatSlugs.has(slug)) {
          summary.log.push(`~ ${category}: ${slug} (already granted)`);
          continue;
        }

        const itemData = await resolveCompendiumItem(eng._slug);
        if (itemData) {
          await this.choiceSetHandler.presetChoiceSelections(itemData, eng._slug);
          if ((itemData as { type: string }).type === "feat" && eng.args?.sourceRow) {
            const { location, taken } = parseFeatSlot(eng.args.sourceRow as string);
            const system = (itemData as Record<string, unknown>).system as Record<string, unknown>;
            if (location) system.location = location;
            if (taken !== null)
              system.level = {
                ...((system.level as Record<string, unknown>) || {}),
                taken,
              };
          }
          batchItems.push(stampImported(itemData, eng._slug));
          summary.log.push(`+ ${category}: ${(itemData as { name: string }).name}`);
          summary.itemsImported++;
        } else {
          summary.log.push(`- ${category}: ${eng._slug} (not found)`);
          summary.unresolved.push(`Could not import ${category} "${eng._slug}": not found in compendium`);
          summary.itemsSkipped++;
        }
      }
    }
    if (batchItems.length > 0) {
      await (actor as Actor).createEmbeddedDocuments("Item", batchItems as never);
    }
  }

  private async syncSessionState(actor: Actor, engines: DemiplaneEngineEntry[]): Promise<void> {
    const findCustomValue = (name: string) =>
      engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === name);

    const maxHp = (actor as unknown as { system: { attributes: { hp: { max: number } } } }).system.attributes.hp.max;
    const currentHp = Number(findCustomValue("character_hit-points_current")?.value) || maxHp;
    const tempHp = Number(findCustomValue("character_hit-points_temp")?.value) || 0;
    const heroPoints = Number(findCustomValue("character_hero-points")?.value) || 1;

    await actor.update({
      "system.attributes.hp.value": Math.min(currentHp, maxHp),
      "system.attributes.hp.temp": tempHp,
      "system.resources.heroPoints.value": Math.min(heroPoints, 3),
    } as never);
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

  /**
   * Creates Lore skill items for the character. Lore can be granted by ancestry
   * features (e.g. Gnome Obsession's "additional Lore") or by the background
   * (`trainedSkills.lore`). Feats such as Assurance can reference these lore
   * skills, so this MUST run *before* any ancestry/background/class/feat items
   * are created — otherwise a feat's GrantItem/ChoiceSet resolves against a
   * skill list that does not yet contain the lore, popping the grant UI.
   *
   * Reads background lore from the compendium entry (not from the actor) so it
   * can run up-front, before the background item itself has been added.
   */
  private async createLoreItems(actor: Actor, engines: DemiplaneEngineEntry[], summary: ImportSummary): Promise<void> {
    const backgroundLores = await this.getBackgroundLoreNames(engines);
    const loreNames = collectLoreNames(engines, backgroundLores);
    if (loreNames.length === 0) return;

    const existingLores = actor.items
      .filter((i: { type: string }) => i.type === "lore")
      .map((i: { name: string }) => i.name);
    const newLores = loreNames.filter((n) => !existingLores.includes(n));

    if (newLores.length > 0) {
      const loreItems = newLores.map((name: string) => ({
        name,
        type: "lore" as const,
        system: { proficient: { value: 1 } },
      }));
      await actor.createEmbeddedDocuments(
        "Item",
        loreItems.map((i) => stampImported(i as Record<string, unknown>)) as never
      );
      summary.log.push(`+ lore: [${newLores.join(", ")}]`);
    }
  }

  private async getBackgroundLoreNames(engines: DemiplaneEngineEntry[]): Promise<string[]> {
    const bgEngine = engines.find(
      (e) => e.type === "DemiplaneEngine" && e.name.includes("/background/") && e.args?.slug
    );
    if (!bgEngine) return [];
    const bgSlug = getSlug(bgEngine);
    if (!bgSlug) return [];
    const bgItem = await resolveCompendiumItem(bgSlug);
    const system = (bgItem as { system?: { trainedSkills?: { lore?: string[] } } } | null)?.system;
    return system?.trainedSkills?.lore ?? [];
  }

  private async fetchCharacterEngines(
    characterId: string,
    token: string | undefined,
    summary: ImportSummary
  ): Promise<{ engines: DemiplaneEngineEntry[]; updated: string | null } | null> {
    if (!token) {
      summary.errors.push("No authentication token provided");
      return null;
    }

    try {
      const query = `query($id: uuid!) {
        demiplane_user_character(where: {uuid: {_eq: $id}, deleted_at: {_is_null: true}, enabled: {_eq: true}}) {
          data
          updated
        }
      }`;

      const response = await fetch("https://apiv4.demiplane.com/v1/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables: { id: characterId } }),
      });

      const json = (await response.json()) as {
        data?: {
          demiplane_user_character: Array<{
            data: { engines: DemiplaneEngineEntry[] };
            updated: string | null;
          }>;
        };
        errors?: Array<{ message: string }>;
      };

      if (json.errors) {
        summary.errors.push(`GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
        return null;
      }

      const character = json.data?.demiplane_user_character?.[0];
      if (!character?.data?.engines) {
        summary.errors.push(`Character not found: ${characterId}`);
        return null;
      }

      return { engines: character.data.engines, updated: character.updated };
    } catch (error) {
      summary.errors.push(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private buildSelectionData(engines: DemiplaneEngineEntry[]) {
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

  private categorizeEngines(engines: DemiplaneEngineEntry[]) {
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

  private async addItemToActor(
    actor: Actor,
    eng: DemiplaneEngineEntry & { _slug: string },
    category: ItemCategory,
    summary: ImportSummary
  ): Promise<void> {
    const itemData = await resolveCompendiumItem(eng._slug);
    if (itemData) {
      await this.choiceSetHandler.presetChoiceSelections(itemData, eng._slug);
      await actor.createEmbeddedDocuments("Item", [stampImported(itemData, eng._slug)] as never);
      summary.log.push(`+ ${category}: ${(itemData as { name: string }).name}`);
      summary.itemsImported++;
    } else {
      summary.log.push(`- ${category}: ${eng._slug} (not found)`);
      summary.unresolved.push(`Could not import ${category} "${eng._slug}": not found in compendium`);
      summary.itemsSkipped++;
    }
  }

  /**
   * After sequential items are added, check for items with GrantItem rules whose
   * UUID-based grants were not created (e.g. Bloodline → Bloodline: Imperial).
   *
   * PF2e's GrantItem resolves grants natively during createEmbeddedDocuments in most
   * cases. However, nested grants (a class grants an item that itself has a GrantItem
   * referencing a ChoiceSet selection) may not fire. This method detects unfulfilled
   * grants and manually adds the missing items.
   *
   * Returns the slugs of any items it created, so callers can exclude them from
   * subsequent batch imports.
   */
  /**
   * Removes items that were both imported from the Demiplane engine list and
   * created a second time by PF2e's native GrantItem handling (e.g. an ancestry
   * feat granted by the ancestry, or a class-granted feat). We prefer to keep the
   * native-granted copy (it carries the correct grant linkage) and delete the
   * duplicate we stamped with `flags.demiplane-pf2e.imported`.
   */
  private async removeDuplicateItems(actor: Actor, summary: ImportSummary): Promise<void> {
    const items = Array.from(actor.items) as Array<Record<string, unknown>>;
    const seen = new Map<string, Record<string, unknown>>();
    const toDelete: string[] = [];

    for (const item of items) {
      const flags = (item.flags || {}) as Record<string, Record<string, unknown>>;
      const core = (flags.core || {}) as { sourceId?: string };
      const key = core.sourceId || `${String(item.type)}::${String(item.name)}`;

      const isStamped = Boolean((flags["demiplane-pf2e"] as { imported?: boolean } | undefined)?.imported);

      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, item);
        continue;
      }

      const existingStamped = Boolean(
        ((existing.flags || {}) as Record<string, Record<string, unknown>>)["demiplane-pf2e"] as
          { imported?: boolean } | undefined
      )?.imported;

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
      await actor.deleteEmbeddedDocuments("Item", toDelete as never);
      summary.log.push(`- removed ${toDelete.length} duplicate item(s)`);
    }
  }

  private async resolvePendingGrants(actor: Actor, summary: ImportSummary): Promise<Set<string>> {
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
        const slug = await this.processGrantRule(rule, selections, item.name, actor, summary);
        if (slug) grantedSlugs.add(slug);
      }
    }

    return grantedSlugs;
  }

  private extractSourceRules(item: {
    system: { rules?: Array<Record<string, unknown>> };
  }): Array<Record<string, unknown>> {
    const sourceSystem = (item as unknown as { _source?: { system?: { rules?: Array<Record<string, unknown>> } } })
      ._source?.system;
    return sourceSystem?.rules ?? item.system?.rules ?? [];
  }

  private async processGrantRule(
    rule: Record<string, unknown>,
    selections: Record<string, unknown>,
    itemName: string,
    actor: Actor,
    summary: ImportSummary
  ): Promise<string | null> {
    const uuid = this.resolveGrantUuid(rule, selections, itemName);
    if (!uuid) return null;

    if (this.isGrantAlreadyFulfilled(actor, uuid)) return null;

    try {
      const doc = await fromUuid(uuid);
      if (!doc) return null;

      const grantData = (doc as { toObject: () => Record<string, unknown> }).toObject();
      await actor.createEmbeddedDocuments("Item", [stampImported(grantData)] as never);
      summary.log.push(`+ granted: ${(grantData as { name: string }).name} (from ${itemName})`);
      summary.itemsImported++;

      const system = grantData.system as { slug?: string } | undefined;
      return system?.slug ?? null;
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
        console.warn(
          `${MODULE_ID} | [orchestrator] Cannot resolve GrantItem template on ${itemName}: flag=${flag}, value=${String(resolved)}`
        );
        return null;
      }
    }

    return uuid.startsWith("Compendium.") ? uuid : null;
  }

  /**
   * Checks whether a grant has already been fulfilled by PF2e's native GrantItem
   * processing during createEmbeddedDocuments. Matches against sourceId,
   * flags.core.sourceId, and _stats.compendiumSource.
   */
  private isGrantAlreadyFulfilled(actor: Actor, uuid: string): boolean {
    return actor.items.some((existing: { flags?: Record<string, unknown>; sourceId?: string }) => {
      const core = existing.flags?.core as { sourceId?: string } | undefined;
      if (core?.sourceId === uuid) return true;

      if ((existing as unknown as { sourceId?: string }).sourceId === uuid) return true;

      const pf2eFlags = existing.flags?.pf2e as { grantedBy?: { id?: string } } | undefined;
      if (pf2eFlags?.grantedBy) {
        const src = (existing as unknown as { _stats?: { compendiumSource?: string } })._stats?.compendiumSource;
        if (src === uuid) return true;
      }

      return false;
    });
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
