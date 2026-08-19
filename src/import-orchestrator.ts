import type {
  DemiplaneClient,
  CharacterEngine,
  DemiplaneEngine,
} from "@scooper4711/demiplane-api";
import {
  isDemiplaneEngine,
  findCustomEngineByName,
} from "@scooper4711/demiplane-api";
import type { SlugMapper, ResolvedItem } from "./slug-mapper.js";

const MODULE_ID = "foundry-demiplane-pf2e";

export interface ImportOptions {
  dryRun?: boolean;
}

export interface ImportSummary {
  itemsImported: number;
  itemsSkipped: number;
  errors: string[];
  preview: boolean;
}

type ItemCategory =
  | "ancestry"
  | "heritage"
  | "background"
  | "class"
  | "feat"
  | "classfeature"
  | "equipment"
  | "spell";

const SESSION_STATE_STORES: Record<string, string> = {
  "character_hit-points_current": "system.attributes.hp.value",
  "character_hit-points_temp": "system.attributes.hp.temp",
  "character_hero-points": "system.resources.heroPoints.value",
  "character_focus_current": "system.resources.focus.value",
  "character_currency_gold": "system.currency.gp",
  "character_currency_silver": "system.currency.sp",
  "character_currency_copper": "system.currency.cp",
  "character_currency_platinum": "system.currency.pp",
};

const SEQUENTIAL_CATEGORIES: ItemCategory[] = [
  "ancestry",
  "heritage",
  "background",
  "class",
];

const BATCH_CATEGORIES: ItemCategory[] = [
  "feat",
  "classfeature",
  "equipment",
  "spell",
];

/**
 * Determines the item category for a given Demiplane engine entry based on
 * its name field path segments.
 */
function categorizeEngine(engineName: string): ItemCategory | null {
  if (engineName.includes("/classfeature/") || engineName.includes("/class-feature/")) {
    return "classfeature";
  }
  if (engineName.includes("/ancestry/")) {
    return "ancestry";
  }
  if (engineName.includes("/heritage/")) {
    return "heritage";
  }
  if (engineName.includes("/background/")) {
    return "background";
  }
  if (engineName.includes("/class/")) {
    return "class";
  }
  if (engineName.includes("/feat/")) {
    return "feat";
  }
  if (engineName.includes("/spell/")) {
    return "spell";
  }
  if (
    engineName.includes("/equipment/") ||
    engineName.includes("/armor/") ||
    engineName.includes("/weapon/")
  ) {
    return "equipment";
  }
  return null;
}

/**
 * Coordinates a full character import from Demiplane into a Foundry actor.
 *
 * Import sequence:
 * 1. Fetch character data via DemiplaneClient
 * 2. Extract character name and level from Custom_Engines
 * 3. Reconcile existing actor items (remove stale imports)
 * 4. Add ancestry → heritage → background → class sequentially
 * 5. Add feats, class features, equipment, spells in batch
 * 6. Set session state values (HP, hero points, focus points, currency)
 * 7. Store version number and timestamp in actor flags
 */
export class ImportOrchestrator {
  private readonly client: DemiplaneClient;
  private readonly slugMapper: SlugMapper;

  constructor(client: DemiplaneClient, slugMapper: SlugMapper) {
    this.client = client;
    this.slugMapper = slugMapper;
  }

  async importCharacter(
    actor: Actor,
    characterId: string,
    options: ImportOptions = {},
  ): Promise<ImportSummary> {
    const { dryRun = false } = options;
    const summary: ImportSummary = {
      itemsImported: 0,
      itemsSkipped: 0,
      errors: [],
      preview: dryRun,
    };

    const characterData = await this.fetchCharacterSafely(characterId, summary);
    if (!characterData) {
      return summary;
    }

    const engines = characterData.engines;
    const characterName = this.extractCustomValue(engines, "character_name") as
      | string
      | undefined;
    const characterLevel = this.extractCustomValue(
      engines,
      "character_level",
    ) as number | undefined;

    const resolvedByCategory = await this.resolveAllSlugs(engines, summary);

    if (dryRun) {
      for (const items of resolvedByCategory.values()) {
        summary.itemsImported += items.length;
      }
      return summary;
    }

    this.updateActorIdentity(actor, characterName, characterLevel, summary);
    await this.reconcileStaleItems(actor, summary);
    await this.addSequentialItems(actor, resolvedByCategory, summary);
    await this.addBatchItems(actor, resolvedByCategory, summary);
    await this.applySessionState(actor, engines, summary);
    await this.storeVersionFlags(actor, characterId, summary);

    return summary;
  }

  private async fetchCharacterSafely(
    characterId: string,
    summary: ImportSummary,
  ): Promise<{ engines: CharacterEngine[] } | null> {
    try {
      return await this.client.fetchCharacterData(characterId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push(`Failed to fetch character data: ${message}`);
      return null;
    }
  }

  private extractCustomValue(
    engines: CharacterEngine[],
    storeName: string,
  ): string | number | boolean | undefined {
    const engine = findCustomEngineByName(engines, storeName);
    return engine?.value;
  }

  private async resolveAllSlugs(
    engines: CharacterEngine[],
    summary: ImportSummary,
  ): Promise<Map<ItemCategory, ResolvedItem[]>> {
    const resolvedByCategory = new Map<ItemCategory, ResolvedItem[]>();
    for (const category of [...SEQUENTIAL_CATEGORIES, ...BATCH_CATEGORIES]) {
      resolvedByCategory.set(category, []);
    }

    const demiplaneEngines = engines.filter(
      (e): e is DemiplaneEngine => isDemiplaneEngine(e) && Boolean(e.args.slug),
    );

    for (const engine of demiplaneEngines) {
      const category = categorizeEngine(engine.name);
      if (!category) {
        continue;
      }

      const resolved = await this.slugMapper.resolve(engine.args.slug!);
      if (resolved) {
        resolvedByCategory.get(category)!.push(resolved);
      } else {
        summary.itemsSkipped++;
        console.warn(
          `foundry-demiplane-pf2e | Import: skipping unresolved slug "${engine.args.slug}" from engine "${engine.name}"`,
        );
      }
    }

    return resolvedByCategory;
  }

  private updateActorIdentity(
    actor: Actor,
    name: string | undefined,
    level: number | undefined,
    summary: ImportSummary,
  ): void {
    try {
      const updateData: Record<string, unknown> = {};
      if (name) {
        updateData["name"] = name;
      }
      if (level !== undefined) {
        updateData["system.details.level.value"] = level;
      }
      if (Object.keys(updateData).length > 0) {
        actor.update(updateData);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push(`Failed to update actor name/level: ${message}`);
    }
  }

  private async reconcileStaleItems(
    actor: Actor,
    summary: ImportSummary,
  ): Promise<void> {
    try {
      const existingItemIds = actor.items
        .filter(
          (item: Item) => item.getFlag(MODULE_ID, "imported") === true,
        )
        .map((item: Item) => item.id);

      if (existingItemIds.length > 0) {
        await actor.deleteEmbeddedDocuments("Item", existingItemIds);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push(`Failed to remove stale items: ${message}`);
    }
  }

  private async addSequentialItems(
    actor: Actor,
    resolvedByCategory: Map<ItemCategory, ResolvedItem[]>,
    summary: ImportSummary,
  ): Promise<void> {
    for (const category of SEQUENTIAL_CATEGORIES) {
      const items = resolvedByCategory.get(category) ?? [];
      if (items.length === 0) {
        continue;
      }

      try {
        const itemData = await this.buildItemData(items);
        if (itemData.length > 0) {
          await actor.createEmbeddedDocuments("Item", itemData);
          summary.itemsImported += itemData.length;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        summary.errors.push(`Failed to add ${category}: ${message}`);
      }
    }
  }

  private async addBatchItems(
    actor: Actor,
    resolvedByCategory: Map<ItemCategory, ResolvedItem[]>,
    summary: ImportSummary,
  ): Promise<void> {
    const batchItems: ResolvedItem[] = [];
    for (const category of BATCH_CATEGORIES) {
      batchItems.push(...(resolvedByCategory.get(category) ?? []));
    }

    if (batchItems.length === 0) {
      return;
    }

    try {
      const itemData = await this.buildItemData(batchItems);
      if (itemData.length > 0) {
        await actor.createEmbeddedDocuments("Item", itemData);
        summary.itemsImported += itemData.length;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push(`Failed to add batch items: ${message}`);
    }
  }

  private async applySessionState(
    actor: Actor,
    engines: CharacterEngine[],
    summary: ImportSummary,
  ): Promise<void> {
    try {
      const sessionUpdates: Record<string, unknown> = {};
      for (const [storeName, actorPath] of Object.entries(
        SESSION_STATE_STORES,
      )) {
        const value = this.extractCustomValue(engines, storeName);
        if (value !== undefined) {
          sessionUpdates[actorPath] = value;
        }
      }
      if (Object.keys(sessionUpdates).length > 0) {
        await actor.update(sessionUpdates);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push(`Failed to set session state: ${message}`);
    }
  }

  private async storeVersionFlags(
    actor: Actor,
    characterId: string,
    summary: ImportSummary,
  ): Promise<void> {
    try {
      const version = await this.client.fetchCharacterVersion(characterId);
      await actor.setFlag(MODULE_ID, "lastKnownVersion", version.version);
      await actor.setFlag(MODULE_ID, "lastSyncTimestamp", Date.now());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push(
        `Failed to store version in flags: ${message}`,
      );
    }
  }

  private async buildItemData(
    items: ResolvedItem[],
  ): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    for (const item of items) {
      try {
        const doc = await fromUuid(item.uuid);
        if (doc) {
          const data = doc.toObject() as Record<string, unknown>;
          const flags = (data.flags as Record<string, unknown>) ?? {};
          flags[MODULE_ID] = { imported: true };
          data.flags = flags;
          results.push(data);
        }
      } catch {
        // Item not resolvable from compendium — skip silently
      }
    }
    return results;
  }
}
