/**
 * ImportOrchestrator - Coordinates full character import from Demiplane into Foundry PF2e.
 *
 * Key architecture decisions:
 * - Items are resolved from compendium via slug matching (strip -rm suffix)
 * - ChoiceSet prompts are suppressed by monkey-patching preCreate during import
 * - Feats get system.location and system.level.taken set from Demiplane sourceRow
 * - Feats granted by other feats' ChoiceSets are skipped (deduplication)
 * - Import order: ancestry → heritage → background → class (sequential), then feats (batch)
 */

import type {
  DemiplaneEngineEntry,
  ImportOptions,
  ImportSummary,
  ItemCategory,
} from "./types.js";
import { stampImported } from "./types.js";
import {
  toFoundrySlug,
  getSlug,
  categorizeEngine,
  parseFeatSlot,
} from "./slug-utils.js";
import { resolveCompendiumItem } from "./compendium-resolver.js";
import { ChoiceSetHandler } from "./choice-set-handler.js";
import { applyBiography } from "./biography-importer.js";
import { applyEquipment, applyCurrency } from "./equipment-importer.js";
import { applySpells } from "./spell-importer.js";
import {
  applySkillProficiencies,
  applyLanguages,
  applyAttributeBoosts,
} from "./attribute-language-importer.js";

export class ImportOrchestrator {
  private choiceSetHandler = new ChoiceSetHandler();

  async importCharacter(
    actor: Actor,
    characterId: string,
    options: ImportOptions = {},
  ): Promise<ImportSummary> {
    const { dryRun = false, token } = options;
    const summary: ImportSummary = {
      itemsImported: 0,
      itemsSkipped: 0,
      errors: [],
      log: [],
      preview: dryRun,
    };

    const engines = await this.fetchCharacterEngines(
      characterId,
      token,
      summary,
    );
    if (!engines) return summary;

    this.choiceSetHandler.setEngines(engines);

    const selectionData = this.buildSelectionData(engines);
    const categorized = this.categorizeEngines(engines);

    if (dryRun) {
      for (const items of Object.values(categorized)) {
        summary.itemsImported += items.length;
      }
      summary.itemsImported -= selectionData.grantedFeatSlugs.size;
      return summary;
    }

    this.choiceSetHandler.enable();

    try {
      // Sequential import (ancestry, heritage, background, class)
      for (const category of [
        "ancestry",
        "heritage",
        "background",
        "class",
      ] as ItemCategory[]) {
        for (const eng of categorized[category]) {
          await this.addItemToActor(actor, eng, category, summary);
        }
      }

      await this.createLoreItems(actor, engines, summary);

      await this.importBatchItems(actor, categorized, selectionData, summary);

      await this.setActorIdentity(actor, engines);
      await applyAttributeBoosts(actor, engines, summary);
      await applyLanguages(actor, engines, summary);
      await applyBiography(actor, engines, summary);
      await applySkillProficiencies(actor, engines, summary);
      await applyEquipment(actor, engines, summary);
      await applyCurrency(actor, engines, summary);
      await applySpells(actor, engines, summary);
      await this.syncSessionState(actor, engines);
    } finally {
      this.choiceSetHandler.disable();
    }

    return summary;
  }

  private async importBatchItems(
    actor: Actor,
    categorized: Record<
      ItemCategory,
      Array<DemiplaneEngineEntry & { _slug: string }>
    >,
    selectionData: { grantedFeatSlugs: Set<string>; selectedFeats: string[] },
    summary: ImportSummary,
  ): Promise<void> {
    const batchItems: Record<string, unknown>[] = [];
    for (const category of [
      "feat",
      "classfeature",
      "equipment",
    ] as ItemCategory[]) {
      for (const eng of categorized[category]) {
        const slug = toFoundrySlug(eng._slug);
        if (selectionData.grantedFeatSlugs.has(slug)) {
          summary.log.push(`~ ${category}: ${slug} (granted by ChoiceSet)`);
          continue;
        }

        const itemData = await resolveCompendiumItem(eng._slug);
        if (itemData) {
          await this.choiceSetHandler.presetChoiceSelections(
            itemData,
            eng._slug,
          );
          if (
            (itemData as { type: string }).type === "feat" &&
            eng.args?.sourceRow
          ) {
            const { location, taken } = parseFeatSlot(
              eng.args.sourceRow as string,
            );
            const system = (itemData as Record<string, unknown>)
              .system as Record<string, unknown>;
            if (location) system.location = location;
            if (taken !== null)
              system.level = {
                ...((system.level as Record<string, unknown>) || {}),
                taken,
              };
          }
          batchItems.push(stampImported(itemData));
          summary.log.push(
            `+ ${category}: ${(itemData as { name: string }).name}`,
          );
          summary.itemsImported++;
        } else {
          summary.log.push(`- ${category}: ${eng._slug} (not found)`);
          summary.itemsSkipped++;
        }
      }
    }
    if (batchItems.length > 0) {
      await (actor as Actor).createEmbeddedDocuments(
        "Item",
        batchItems as never,
      );
    }
  }

  private async syncSessionState(
    actor: Actor,
    engines: DemiplaneEngineEntry[],
  ): Promise<void> {
    const findCustomValue = (name: string) =>
      engines.find(
        (e) => e.type === "CustomDemiplaneEngine" && e.name === name,
      );

    const maxHp = (
      actor as unknown as { system: { attributes: { hp: { max: number } } } }
    ).system.attributes.hp.max;
    const currentHp =
      Number(findCustomValue("character_hit-points_current")?.value) || maxHp;
    const tempHp =
      Number(findCustomValue("character_hit-points_temp")?.value) || 0;
    const heroPoints =
      Number(findCustomValue("character_hero-points")?.value) || 1;

    await actor.update({
      "system.attributes.hp.value": Math.min(currentHp, maxHp),
      "system.attributes.hp.temp": tempHp,
      "system.resources.heroPoints.value": Math.min(heroPoints, 3),
    } as never);
  }

  private async setActorIdentity(
    actor: Actor,
    engines: DemiplaneEngineEntry[],
  ): Promise<void> {
    const nameEng = engines.find(
      (e) => e.type === "CustomDemiplaneEngine" && e.name === "character_name",
    );
    const levelEng = engines.find(
      (e) => e.type === "CustomDemiplaneEngine" && e.name === "character_level",
    );
    const avatarEng = engines.find(
      (e) =>
        e.type === "CustomDemiplaneEngine" && e.name === "character_avatar",
    );
    const updates: Record<string, unknown> = {};
    if (nameEng?.value) updates.name = nameEng.value;
    if (levelEng?.value) updates["system.details.level.value"] = levelEng.value;
    if (avatarEng?.value) {
      updates.img = avatarEng.value;
      updates["prototypeToken.texture.src"] = avatarEng.value;
    }
    if (Object.keys(updates).length > 0) await actor.update(updates);
  }

  private async createLoreItems(
    actor: Actor,
    engines: DemiplaneEngineEntry[],
    summary: ImportSummary,
  ): Promise<void> {
    const loreNames: string[] = [];

    const bg = actor.items.find(
      (i: { type: string }) => i.type === "background",
    );
    if (bg) {
      const bgLores =
        (bg.system as { trainedSkills?: { lore?: string[] } }).trainedSkills
          ?.lore ?? [];
      loreNames.push(...bgLores);
    }

    const customSkills = engines.filter(
      (e) =>
        e.name === "core/selection/skill/custom-skill/index.eng" &&
        e.args?.name,
    );
    for (const eng of customSkills) {
      const name = eng.args.name as string;
      if (!loreNames.includes(name)) loreNames.push(name);
    }

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
        loreItems.map((i) =>
          stampImported(i as Record<string, unknown>),
        ) as never,
      );
      summary.log.push(`+ lore: [${newLores.join(", ")}]`);
    }
  }

  private async fetchCharacterEngines(
    characterId: string,
    token: string | undefined,
    summary: ImportSummary,
  ): Promise<DemiplaneEngineEntry[] | null> {
    if (!token) {
      summary.errors.push("No authentication token provided");
      return null;
    }

    try {
      const query = `query($id: uuid!) {
        demiplane_user_character(where: {uuid: {_eq: $id}, deleted_at: {_is_null: true}, enabled: {_eq: true}}) {
          data
          version
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
            version: number;
          }>;
        };
        errors?: Array<{ message: string }>;
      };

      if (json.errors) {
        summary.errors.push(
          `GraphQL: ${json.errors.map((e) => e.message).join("; ")}`,
        );
        return null;
      }

      const character = json.data?.demiplane_user_character?.[0];
      if (!character?.data?.engines) {
        summary.errors.push(`Character not found: ${characterId}`);
        return null;
      }

      return character.data.engines;
    } catch (error) {
      summary.errors.push(
        `Fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private buildSelectionData(engines: DemiplaneEngineEntry[]) {
    const grantedFeatSlugs = new Set<string>();
    for (const eng of engines) {
      const sr = (eng.args?.sourceRow as string) || "";
      if (
        sr.includes("select-feat-") &&
        eng.args?.slug &&
        eng.name.includes("/feat/")
      ) {
        grantedFeatSlugs.add(toFoundrySlug(eng.args.slug as string));
      }
      // Class-features from tabula/class-feature/ are imported directly.
    }
    // They represent selections like "School of Battle Magic" from "Arcane School".
    // We import them as standalone items — the ChoiceSet selection on the parent
    // is still set so Foundry shows the relationship correctly.

    const selectedFeats = engines
      .filter(
        (e) =>
          ((e.args?.sourceRow as string) || "").includes("select-feat-") &&
          e.args?.slug,
      )
      .map((e) => toFoundrySlug(e.args.slug as string));

    return { grantedFeatSlugs, selectedFeats };
  }

  private categorizeEngines(engines: DemiplaneEngineEntry[]) {
    const categorized: Record<
      ItemCategory,
      Array<DemiplaneEngineEntry & { _slug: string }>
    > = {
      ancestry: [],
      heritage: [],
      background: [],
      class: [],
      feat: [],
      classfeature: [],
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
    summary: ImportSummary,
  ): Promise<void> {
    const itemData = await resolveCompendiumItem(eng._slug);
    if (itemData) {
      await this.choiceSetHandler.presetChoiceSelections(itemData, eng._slug);
      await actor.createEmbeddedDocuments("Item", [
        stampImported(itemData),
      ] as never);
      summary.log.push(`+ ${category}: ${(itemData as { name: string }).name}`);
      summary.itemsImported++;
    } else {
      summary.log.push(`- ${category}: ${eng._slug} (not found)`);
      summary.itemsSkipped++;
    }
  }
}
