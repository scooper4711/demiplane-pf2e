/**
 * ImportOrchestrator - Handles full character import from Demiplane into Foundry PF2e.
 *
 * Key architecture decisions:
 * - Items are resolved from compendium via slug matching (strip -rm suffix)
 * - ChoiceSet prompts are suppressed by monkey-patching preCreate during import
 * - Feats get system.location and system.level.taken set from Demiplane sourceRow
 * - Feats granted by other feats' ChoiceSets are skipped (deduplication)
 * - Import order: ancestry → heritage → background → class (sequential), then feats (batch)
 */

const MODULE_ID = "foundry-demiplane-pf2e";

const PACKS = [
  "pf2e.classes",
  "pf2e.ancestries",
  "pf2e.heritages",
  "pf2e.backgrounds",
  "pf2e.feats-srd",
  "pf2e.spells-srd",
  "pf2e.equipment-srd",
  "pf2e.classfeatures",
] as const;

export interface ImportOptions {
  dryRun?: boolean;
  token?: string;
}

export interface ImportSummary {
  itemsImported: number;
  itemsSkipped: number;
  errors: string[];
  log: string[];
  preview: boolean;
}

interface DemiplaneEngineEntry {
  id: string;
  name: string;
  type: "DemiplaneEngine" | "CustomDemiplaneEngine";
  args: Record<string, unknown>;
  value?: string | number | boolean;
  [key: string]: unknown;
}

type ItemCategory = "ancestry" | "heritage" | "background" | "class" | "feat" | "classfeature" | "equipment";

/**
 * Strips the trailing "-rm" suffix from Demiplane slugs.
 */
function toFoundrySlug(slug: string): string {
  return slug.endsWith("-rm") ? slug.slice(0, -3) : slug;
}

/**
 * Extracts slug from engine name when args.slug is missing.
 * e.g. "tabula/ancestry/human-rm.eng" → "human-rm"
 */
function getSlug(eng: DemiplaneEngineEntry): string | null {
  if (eng.args?.slug) return eng.args.slug as string;
  const match = eng.name.match(/\/([^/]+)\.eng$/);
  return match ? match[1] : null;
}

/**
 * Parse Demiplane sourceRow to determine Foundry feat location and level.taken.
 */
function parseFeatSlot(sourceRow: string): { location: string | null; taken: number | null } {
  if (!sourceRow) return { location: null, taken: null };

  // Pattern: {classname|ancestry|skill|general}-feat(s)-level-{N}(-rm)
  const levelMatch = sourceRow.match(/^(\w+)-feats?-level-(\d+)/);
  if (levelMatch) {
    const prefix = levelMatch[1];
    const level = parseInt(levelMatch[2], 10);
    let type = "class";
    if (prefix === "ancestry") type = "ancestry";
    else if (prefix === "skill") type = "skill";
    else if (prefix === "general") type = "general";
    return { location: `${type}-${level}`, taken: level };
  }

  // "ancestry-feats" = level 1 ancestry feat
  if (sourceRow === "ancestry-feats") return { location: "ancestry-1", taken: 1 };

  // For feats granted by ChoiceSets, no location
  if (sourceRow.includes("select-feat-")) return { location: null, taken: null };

  return { location: null, taken: null };
}
/**
 * Categorize a Demiplane engine entry by its path.
 */
function categorizeEngine(engineName: string): ItemCategory | null {
  if (engineName.includes("/classfeature/") || engineName.includes("/class-feature/")) return "classfeature";
  if (engineName.includes("/ancestry/")) return "ancestry";
  if (engineName.includes("/heritage/")) return "heritage";
  if (engineName.includes("/background/")) return "background";
  if (engineName.includes("/class/") && !engineName.includes("/classfeature/")) return "class";
  if (engineName.includes("/feat/")) return "feat";
  if (engineName.includes("/equipment/") || engineName.includes("/armor/") || engineName.includes("/weapon/")) return "equipment";
  return null;
}

export class ImportOrchestrator {
  private currentEngines: DemiplaneEngineEntry[] = [];
  private originalPreCreate: ((...args: unknown[]) => Promise<void>) | null = null;
  private importMode = false;

  /**
   * Run a full character import from Demiplane into a Foundry actor.
   */
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

    // Step 1: Fetch character data from Demiplane
    const engines = await this.fetchCharacterEngines(characterId, token, summary);
    if (!engines) return summary;

    // Store engines for use in choice resolution
    this.currentEngines = engines;

    // Step 2: Build selection data for ChoiceSet auto-resolution
    const selectionData = this.buildSelectionData(engines);

    // Step 3: Categorize engines
    const categorized = this.categorizeEngines(engines);

    if (dryRun) {
      // Count what would be imported
      for (const items of Object.values(categorized)) {
        summary.itemsImported += items.length;
      }
      summary.itemsImported -= selectionData.grantedFeatSlugs.size;
      return summary;
    }

    // Step 4: Enable import mode (auto-resolve ChoiceSet prompts)
    this.enableImportMode();

    try {
      // Step 5: Sequential import (ancestry, heritage, background, class)
      for (const category of ["ancestry", "heritage", "background", "class"] as ItemCategory[]) {
        for (const eng of categorized[category]) {
          await this.addItemToActor(actor, eng, category, summary);
        }
      }

      // Step 5.5: Create lore items from background
      await this.createLoreItems(actor, engines, summary);

      // Step 6: Batch import (feats, classfeatures, equipment) with slot assignment
      const batchItems: Record<string, unknown>[] = [];
      for (const category of ["feat", "classfeature", "equipment"] as ItemCategory[]) {
        for (const eng of categorized[category]) {
          const slug = toFoundrySlug(eng._slug);
          if (selectionData.grantedFeatSlugs.has(slug)) {
            summary.log.push(`~ ${category}: ${slug} (granted by ChoiceSet)`);
            continue;
          }

          const itemData = await this.resolveCompendiumItem(eng._slug);
          if (itemData) {
            // Pre-set ChoiceSet selections
            await this.presetChoiceSelections(itemData, eng._slug);
            // Set feat location and level.taken
            if ((itemData as Record<string, unknown>).type === "feat" && eng.args?.sourceRow) {
              const { location, taken } = parseFeatSlot(eng.args.sourceRow as string);
              const system = (itemData as Record<string, { level?: Record<string, unknown>; location?: string }>).system;
              if (location) system.location = location;
              if (taken !== null) system.level = { ...system.level, taken };
            }
            batchItems.push(itemData);
            summary.log.push(`+ ${category}: ${(itemData as { name: string }).name}`);
            summary.itemsImported++;
          } else {
            summary.log.push(`- ${category}: ${eng._slug} (not found)`);
            summary.itemsSkipped++;
          }
        }
      }
      if (batchItems.length > 0) {
        await actor.createEmbeddedDocuments("Item", batchItems);
      }

      // Step 7: Set name and level
      await this.setActorIdentity(actor, engines);

      // Step 7.5: Apply attribute boosts
      await this.applyAttributeBoosts(actor, engines, summary);

      // Step 7.6: Apply languages (after boosts since language count depends on INT)
      await this.applyLanguages(actor, engines, summary);

      // Step 7.7: Apply biography and character details
      await this.applyBiography(actor, engines, summary);

      // Step 7.8: Apply skill proficiencies
      await this.applySkillProficiencies(actor, engines, summary);

      // Step 7.9: Apply equipment from Demiplane inventory
      await this.applyEquipment(actor, engines, summary);

      // Step 7.10: Apply currency
      await this.applyCurrency(actor, engines, summary);


      // Step 7.11: Sync session state (HP, temp HP, hero points)
      const currentHpEng = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === "character_hit-points_current");
      const tempHpEng = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === "character_hit-points_temp");
      const heroPointsEng = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === "character_hero-points");
      const maxHp = (actor as unknown as { system: { attributes: { hp: { max: number } } } }).system.attributes.hp.max;
      const currentHp = currentHpEng ? Number(currentHpEng.value) : maxHp;
      const tempHp = tempHpEng ? Number(tempHpEng.value) : 0;
      const heroPoints = heroPointsEng ? Number(heroPointsEng.value) : 1;
      await actor.update({
        "system.attributes.hp.value": Math.min(currentHp, maxHp),
        "system.attributes.hp.temp": tempHp,
        "system.resources.heroPoints.value": Math.min(heroPoints, 3),
      });
    } finally {
      this.disableImportMode();
    }

    return summary;
  }

  private enableImportMode(): void {
    this.importMode = true;
    const ChoiceSetRE = (game as unknown as { pf2e: { RuleElements: { builtin: Record<string, { prototype: Record<string, unknown> }> } } }).pf2e.RuleElements.builtin.ChoiceSet;
    this.originalPreCreate = ChoiceSetRE.prototype.preCreate as (...args: unknown[]) => Promise<void>;

    const self = this;
    ChoiceSetRE.prototype.preCreate = async function (
      this: { choices: Array<{ value: unknown; label: string }>; selection: unknown; item: { flags: Record<string, unknown>; getRollOptions: (s: string) => string[]; name: string }; actor: { getRollOptions: () => string[] }; resolveInjectedProperties: (p: unknown) => { test: (r: Set<string>) => boolean }; predicate: unknown; inflateChoices: (r: Set<string>, t: unknown) => Promise<Array<{ value: unknown; label: string }>>; flag: string; rollOption: string },
      params: { ruleSource: Record<string, unknown>; itemSource: { name: string } & Record<string, unknown>; tempItems: unknown },
    ) {
      if (!self.importMode) {
        return (self.originalPreCreate as (...args: unknown[]) => Promise<void>).call(this, params);
      }

      // If selection is already pre-set from presetChoiceSelections, let original handle it
      if (this.selection !== null) {
        return (self.originalPreCreate as (...args: unknown[]) => Promise<void>).call(this, params);
      }

      // Selection wasn't pre-set — try to find a match from Demiplane data
      const rollOptions = new Set([this.actor.getRollOptions(), this.item.getRollOptions("parent")].flat());
      const predicate = this.resolveInjectedProperties(this.predicate);
      if (!predicate.test(rollOptions)) return;

      this.choices = await this.inflateChoices(rollOptions, params.tempItems);
      if (!this.choices || this.choices.length === 0) return;

      // Try to match against Demiplane selections
      const matched = self.findMatchInChoices(this.choices);
      if (matched) {
        this.selection = params.ruleSource.selection = matched.value;
        const pf2eFlags = (this.item.flags.pf2e || {}) as Record<string, unknown>;
        const rulesSelections = (pf2eFlags.rulesSelections || {}) as Record<string, unknown>;
        rulesSelections[this.flag || "choice"] = matched.value;
        pf2eFlags.rulesSelections = rulesSelections;
        this.item.flags.pf2e = pf2eFlags;
      } else if (this.choices.length > 0) {
        // Fallback: pick first choice
        const first = this.choices[0];
        this.selection = params.ruleSource.selection = first.value;
      }
    };
  }

  private disableImportMode(): void {
    this.importMode = false;
    if (this.originalPreCreate) {
      const ChoiceSetRE = (game as unknown as { pf2e: { RuleElements: { builtin: Record<string, { prototype: Record<string, unknown> }> } } }).pf2e.RuleElements.builtin.ChoiceSet;
      ChoiceSetRE.prototype.preCreate = this.originalPreCreate;
      this.originalPreCreate = null;
    }
  }

  private findMatchInChoices(choices: Array<{ value: unknown; label: string }>): { value: unknown; label: string } | null {
    // Collect all slugs from Demiplane engines that represent selections
    const allSlugs = this.currentEngines
      .filter((e) => e.type === "DemiplaneEngine" && e.args?.slug)
      .map((e) => toFoundrySlug(e.args?.slug as string));

    const allSkillSlugs = this.currentEngines
      .filter((e) => e.name === "core/selection/skill/increase/index.eng" && e.args?.slug)
      .map((e) => e.args?.slug as string);

    // Strategy 1: Direct value match against skill slugs
    for (const choice of choices) {
      const val = typeof choice.value === "string" ? choice.value : "";
      if (allSkillSlugs.includes(val)) return choice;
    }

    // Strategy 2: Direct value match against all DemiplaneEngine slugs
    for (const choice of choices) {
      const val = typeof choice.value === "string" ? choice.value : "";
      if (allSlugs.includes(val)) return choice;
    }

    // Strategy 3: Partial match against generic-feature engines only
    // e.g. choice value "sword" matches "weapon-master-sword" from generic-feature
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
    // Strategy 4: Feat UUID match by label
    const featSlugs = this.currentEngines
      .filter((e) => ((e.args?.sourceRow as string) || "").includes("select-feat-") && e.args?.slug)
      .map((e) => toFoundrySlug(e.args?.slug as string));

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
   * This lets the original PF2e preCreate logic handle name adjustment and grant processing.
   */
  private async presetChoiceSelections(
    itemData: Record<string, unknown>,
    demiplaneSlug: string,
  ): Promise<void> {
    const system = itemData.system as { rules?: Array<Record<string, unknown>> } | undefined;
    if (!system?.rules) return;

    for (const rule of system.rules) {
      if (rule.key !== "ChoiceSet") continue;

      // Find what Demiplane selected for this item's ChoiceSet
      const selection = await this.findChoiceSelection(demiplaneSlug, rule);
      if (selection !== null) {
        rule.selection = selection;
      }
    }
  }

  /**
   * Find the Demiplane-selected value for a ChoiceSet rule on a given item.
   */
  private async findChoiceSelection(
    parentSlug: string,
    rule: Record<string, unknown>,
  ): Promise<string | null> {
    // Look for engines whose sourceRow contains "select-{type}-{parentSlug}"
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

          // Determine if this ChoiceSet expects a UUID or a plain slug
          const choices = rule.choices;
          if (typeof choices === "object" && choices !== null && !Array.isArray(choices) && "filter" in (choices as Record<string, unknown>)) {
            // Item-based choice — resolve to compendium UUID
            return await this.resolveSlugToUuid(childSlug);
          }

          // Simple value choice (skill, attribute, etc.)
          return childSlug;
        }
      }
    }

    return null;
  }

  /**
   * Resolve a Foundry slug to its compendium UUID.
   */
  private async resolveSlugToUuid(foundrySlug: string): Promise<string | null> {
    for (const packKey of PACKS) {
      const pack = game.packs.get(packKey);
      if (!pack) continue;
      const index = await pack.getIndex({ fields: ["system.slug"] });
      const match = index.find((i: { system?: { slug?: string }; _id: string }) => i.system?.slug === foundrySlug);
      if (match) return `Compendium.${packKey}.Item.${match._id}`;
    }
    return null;
  }

  private async createLoreItems(actor: Actor, engines: DemiplaneEngineEntry[], summary: ImportSummary): Promise<void> {
    const loreNames: string[] = [];

    // Source 1: Background trainedSkills.lore
    const bg = actor.items.find((i: { type: string }) => i.type === "background");
    if (bg) {
      const bgLores = (bg.system as { trainedSkills?: { lore?: string[] } }).trainedSkills?.lore ?? [];
      loreNames.push(...bgLores);
    }

    // Source 2: Custom skill engines from Demiplane
    const customSkills = engines.filter(
      (e) => e.name === "core/selection/skill/custom-skill/index.eng" && e.args?.name,
    );
    for (const eng of customSkills) {
      const name = eng.args.name as string;
      if (!loreNames.includes(name)) loreNames.push(name);
    }

    if (loreNames.length === 0) return;

    // Skip lores already on the actor
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
      await actor.createEmbeddedDocuments("Item", loreItems);
      summary.log.push(`+ lore: [${newLores.join(", ")}]`);
    }
  }

    private async applyBiography(
    actor: Actor,
    engines: DemiplaneEngineEntry[],
    summary: ImportSummary,
  ): Promise<void> {
    const getValue = (name: string): string | undefined => {
      const eng = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === name);
      return eng?.value != null ? String(eng.value) : undefined;
    };

    const updates: Record<string, unknown> = {};

    // Simple field mappings
    const gender = getValue("character_appearance_gender");
    if (gender) updates["system.details.gender.value"] = gender;

    const age = getValue("character_appearance_age");
    if (age) updates["system.details.age.value"] = age;

    const ethnicity = getValue("character_appearance_ethnicity");
    if (ethnicity) updates["system.details.ethnicity.value"] = ethnicity;

    const nationality = getValue("character_appearance_nationality");
    if (nationality) updates["system.details.nationality.value"] = nationality;

    const height = getValue("character_appearance_height");
    if (height) updates["system.details.height.value"] = height;

    const weight = getValue("character_appearance_weight");
    if (weight) updates["system.details.weight.value"] = weight;

    // Biography fields
    const birthplace = getValue("character_appearance_birthplace");
    if (birthplace) updates["system.details.biography.birthPlace"] = birthplace;

    const appearance = getValue("character_appearance_appearance");
    if (appearance) updates["system.details.biography.appearance"] = appearance;

    const catchphrases = getValue("character_personality_catchphrases");
    if (catchphrases) updates["system.details.biography.catchphrases"] = catchphrases;

    const backstory = getValue("character_campaign_other");
    if (backstory) updates["system.details.biography.backstory"] = `<p>${backstory.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;


    // Deity — add as item from pf2e.deities compendium
    const deityName = getValue("character_personality_beliefs");
    if (deityName) {
      const deityPack = game.packs.get("pf2e.deities");
      if (deityPack) {
        const index = await deityPack.getIndex();
        const match = index.find((e: { name: string }) => e.name.toLowerCase() === deityName.toLowerCase());
        if (match) {
          const deityDoc = await deityPack.getDocument(match._id);
          if (deityDoc) {
            await actor.createEmbeddedDocuments("Item", [deityDoc.toObject()]);
            summary.log.push(`+ deity: ${deityName}`);
          }
        } else {
          updates["system.details.deity.value"] = deityName;
          summary.log.push(`! deity "${deityName}" not found in compendium, set as text only`);
        }
      }
    }

    // Attitude, likes, dislikes, allies, enemies, organizations
    const attitude = getValue("character_personality_attitude");
    if (attitude) updates["system.details.biography.attitude"] = attitude;

    const likes = getValue("character_personality_likes");
    if (likes) updates["system.details.biography.likes"] = likes;

    const dislikes = getValue("character_personality_dislikes");
    if (dislikes) updates["system.details.biography.dislikes"] = dislikes;

    const allies = getValue("character_campaign_allies");
    if (allies) updates["system.details.biography.allies"] = allies;

    const enemies = getValue("character_campaign_enemies");
    if (enemies) updates["system.details.biography.enemies"] = enemies;

    const organizations = getValue("character_campaign_organizations");
    if (organizations) updates["system.details.biography.organizations"] = organizations;

    // Edicts and anathema (comma-separated in Demiplane, array in Foundry)
    const edicts = getValue("character_personality_edicts");
    if (edicts) updates["system.details.biography.edicts"] = edicts.split(/[,\n\r]+/).map((s: string) => s.trim()).filter(Boolean);

    const anathema = getValue("character_personality_anathema");
    if (anathema) updates["system.details.biography.anathema"] = anathema.split(/[,\n\r]+/).map((s: string) => s.trim()).filter(Boolean);

    // Organized Play ID — "123456-2001" → playerNumber + characterNumber
    const orgPlayId = getValue("character_organizedplayid");
    if (orgPlayId) {
      const lastDash = orgPlayId.lastIndexOf("-");
      if (lastDash > 0) {
        updates["system.pfs.playerNumber"] = parseInt(orgPlayId.slice(0, lastDash), 10) || null;
        updates["system.pfs.characterNumber"] = parseInt(orgPlayId.slice(lastDash + 1), 10) || null;
      }
    }

    if (Object.keys(updates).length > 0) {
      await actor.update(updates);
      summary.log.push(`+ biography: ${Object.keys(updates).length} fields`);
    }
  }

    private async applySkillProficiencies(
    actor: Actor,
    engines: DemiplaneEngineEntry[],
    summary: ImportSummary,
  ): Promise<void> {
    const skillEngines = engines.filter(
      (e) => e.name === "core/selection/skill/increase/index.eng" && e.args?.slug,
    );

    if (skillEngines.length === 0) return;

    // Build override map: skills with explicit prof overrides
    // character_{skill}_prof = N means force that rank
    // character_{skill}_prof--overridden = 1 means the override is active
    const profOverrides: Record<string, number> = {};
    const overriddenFlags = new Set<string>();
    for (const eng of engines) {
      if (eng.type !== "CustomDemiplaneEngine") continue;
      const overriddenMatch = eng.name.match(/^character_(.+)_prof--overridden$/);
      if (overriddenMatch && eng.value === 1) {
        overriddenFlags.add(overriddenMatch[1]);
      }
      const profMatch = eng.name.match(/^character_(.+)_prof$/);
      if (profMatch && typeof eng.value === "number") {
        profOverrides[profMatch[1]] = eng.value as number;
      }
    }
    // Only apply overrides that have the --overridden flag set
    const activeOverrides: Record<string, number> = {};
    for (const skill of overriddenFlags) {
      if (skill in profOverrides) {
        activeOverrides[skill] = profOverrides[skill];
      }
    }

    // Compute final rank for each skill:
    // "skill-increase-level-*" = Expert (2), everything else = Trained (1)
    // Skip skills handled by heritage ChoiceSet (sourceRow contains "select-skill-")
    // Skip skills overridden to untrained
    const ranks: Record<string, number> = {};
    for (const eng of skillEngines) {
      const slug = eng.args.slug as string;
      const sourceRow = (eng.args.sourceRow as string) || "";

      // Skip skills granted by heritage ChoiceSet (heritage handles these via GrantItem)
      // Only skip if the sourceRow references a heritage slug pattern
      if (sourceRow.includes("select-skill-") && sourceRow.match(/heritage|human-rm/)) continue;

      // Skip skills with active overrides (we'll apply those separately)
      if (slug in activeOverrides) continue;

      const isIncrease = sourceRow.includes("skill-increase");
      const rank = isIncrease ? 2 : 1;
      ranks[slug] = Math.max(ranks[slug] || 0, rank);
    }

    // Apply ranks — use Math.max with existing rank (Grant Chain may have set some)
    const updates: Record<string, number> = {};
    const currentSkills = (actor.system as { skills: Record<string, { rank: number }> }).skills;

    for (const [skill, targetRank] of Object.entries(ranks)) {
      const currentRank = currentSkills[skill]?.rank ?? 0;
      if (targetRank > currentRank) {
        updates[`system.skills.${skill}.rank`] = targetRank;
      }
    }

    if (Object.keys(updates).length > 0) {
      await actor.update(updates);
      const applied = Object.entries(updates).map(([s, r]) => `${s.replace("system.skills.","").replace(".rank","")}:${r}`).join(", ");
      summary.log.push(`+ skills: [${applied}]`);
    }

    // Apply explicit prof overrides
    if (Object.keys(activeOverrides).length > 0) {
      const overrideUpdates: Record<string, number> = {};
      for (const [skill, rank] of Object.entries(activeOverrides)) {
        const currentRank = currentSkills[skill]?.rank ?? 0;
        if (rank !== currentRank) {
          overrideUpdates[`system.skills.${skill}.rank`] = rank;
        }
      }
      if (Object.keys(overrideUpdates).length > 0) {
        await actor.update(overrideUpdates);
        const applied = Object.entries(activeOverrides).map(([s, r]) => `${s}:${r}`).join(", ");
        summary.log.push(`+ skill overrides: [${applied}]`);
      }
    }
  }

    private async applyLanguages(
    actor: Actor,
    engines: DemiplaneEngineEntry[],
    summary: ImportSummary,
  ): Promise<void> {
    const langEngine = engines.find(
      (e) => e.name === "character-languages-user" && e.type === "CustomDemiplaneEngine",
    );
    if (!langEngine || !langEngine.value || typeof langEngine.value !== "string") return;

    // Parse comma-separated free-text languages
    const rawLanguages = (langEngine.value as string)
      .split(/[,\n\r]+/)
      .map((l) => l.trim().toLowerCase().replace(/\s+/g, "-"))
      .filter(Boolean);

    // Validate against Foundry's language list
    const validLanguages = Object.keys(
      (game as unknown as { pf2e: { system: { config: { PF2E: { languages: Record<string, string> } } } } }).pf2e?.system?.config?.PF2E?.languages
      ?? (CONFIG as unknown as { PF2E: { languages: Record<string, string> } }).PF2E?.languages
      ?? {},
    );

    const matched: string[] = [];
    const unmatched: string[] = [];

    for (const lang of rawLanguages) {
      if (validLanguages.includes(lang)) {
        matched.push(lang);
      } else {
        unmatched.push(lang);
      }
    }

    if (matched.length > 0) {
      const currentLangs = (actor.system as { details: { languages: { value: string[] } } }).details.languages.value;
      const newLangs = [...new Set([...currentLangs, ...matched])];
      await actor.update({ "system.details.languages.value": newLangs });
      summary.log.push(`+ languages: [${matched.join(", ")}]`);
    }

    if (unmatched.length > 0) {
      summary.log.push(`! languages not found in Foundry: [${unmatched.join(", ")}]`);
    }
  }

    private async applyAttributeBoosts(
    actor: Actor,
    engines: DemiplaneEngineEntry[],
    summary: ImportSummary,
  ): Promise<void> {
    const boostEngines = engines.filter(
      (e) => e.name === "core/selection/attribute/boost.eng" && e.args?.slug,
    );

    // Map Demiplane attribute names to PF2e abbreviations
    const attrMap: Record<string, string> = {
      strength: "str", dexterity: "dex", constitution: "con",
      intelligence: "int", wisdom: "wis", charisma: "cha",
    };

    // Group by sourceRow
    const ancestryBoosts: string[] = [];
    const backgroundBoosts: string[] = [];
    const levelBoosts: Record<string, string[]> = {};

    for (const eng of boostEngines) {
      const slug = attrMap[eng.args.slug as string] || (eng.args.slug as string);
      const sourceRow = (eng.args.sourceRow as string) || "";

      if (sourceRow === "ancestry-boosts") {
        ancestryBoosts.push(slug);
      } else if (sourceRow === "background-boosts") {
        backgroundBoosts.push(slug);
      } else if (sourceRow === "class-key-attribute") {
        // Handled by Grant Chain — skip
      } else {
        const levelMatch = sourceRow.match(/attribute-boosts-level-(\d+)/);
        if (levelMatch) {
          const level = levelMatch[1];
          if (!levelBoosts[level]) levelBoosts[level] = [];
          levelBoosts[level].push(slug);
        }
      }
    }

    // Apply ancestry boosts to the ancestry item
    const ancestryItem = actor.items.find((i: { type: string }) => i.type === "ancestry");
    if (ancestryItem && ancestryBoosts.length > 0) {
      const updates: Record<string, string> = {};
      ancestryBoosts.forEach((slug, i) => {
        updates[`system.boosts.${i}.selected`] = slug;
      });
      await ancestryItem.update(updates);
      summary.log.push(`+ boosts: ancestry [${ancestryBoosts.join(", ")}]`);
    }

    // Apply background boosts to the background item
    const backgroundItem = actor.items.find((i: { type: string }) => i.type === "background");
    if (backgroundItem && backgroundBoosts.length > 0) {
      const updates: Record<string, string> = {};
      backgroundBoosts.forEach((slug, i) => {
        updates[`system.boosts.${i}.selected`] = slug;
      });
      await backgroundItem.update(updates);
      summary.log.push(`+ boosts: background [${backgroundBoosts.join(", ")}]`);
    }

    // Apply level boosts to the actor
    if (Object.keys(levelBoosts).length > 0) {
      const updates: Record<string, string[]> = {};
      for (const [level, boosts] of Object.entries(levelBoosts)) {
        updates[`system.build.attributes.boosts.${level}`] = boosts;
      }
      await actor.update(updates);
      summary.log.push(`+ boosts: levels [${Object.entries(levelBoosts).map(([l, b]) => `L${l}:${b.join(",")}`).join("; ")}]`);
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
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables: { id: characterId } }),
      });

      const json = await response.json() as {
        data?: { demiplane_user_character: Array<{ data: { engines: DemiplaneEngineEntry[] }; version: number }> };
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

      return character.data.engines;
    } catch (error) {
      summary.errors.push(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private buildSelectionData(engines: DemiplaneEngineEntry[]) {
    // All skills selected via Demiplane
    const trainedSkills = engines
      .filter((e) => e.name === "core/selection/skill/increase/index.eng" && e.args?.slug)
      .map((e) => e.args.slug as string);

    // All feats granted by ChoiceSets (skip these in batch import)
    const grantedFeatSlugs = new Set<string>();
    for (const eng of engines) {
      const sr = (eng.args?.sourceRow as string) || "";
      if (sr.includes("select-feat-") && eng.args?.slug && eng.name.includes("/feat/")) {
        grantedFeatSlugs.add(toFoundrySlug(eng.args.slug as string));
      }
    }

    // Feats selected via ChoiceSets (by slug for label matching)
    const selectedFeats = engines
      .filter((e) => ((e.args?.sourceRow as string) || "").includes("select-feat-") && e.args?.slug)
      .map((e) => toFoundrySlug(e.args.slug as string));

    return { trainedSkills, grantedFeatSlugs, selectedFeats };
  }

  private categorizeEngines(engines: DemiplaneEngineEntry[]) {
    const categorized: Record<ItemCategory, Array<DemiplaneEngineEntry & { _slug: string }>> = {
      ancestry: [], heritage: [], background: [], class: [], feat: [], classfeature: [], equipment: [],
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
    const itemData = await this.resolveCompendiumItem(eng._slug);
    if (itemData) {
      // Pre-set ChoiceSet selections on the item data before adding
      await this.presetChoiceSelections(itemData, eng._slug);
      await actor.createEmbeddedDocuments("Item", [itemData]);
      summary.log.push(`+ ${category}: ${(itemData as { name: string }).name}`);
      summary.itemsImported++;
    } else {
      summary.log.push(`- ${category}: ${eng._slug} (not found)`);
      summary.itemsSkipped++;
    }
  }

  private async resolveCompendiumItem(demiplaneSlug: string): Promise<Record<string, unknown> | null> {
    const foundrySlug = toFoundrySlug(demiplaneSlug);
    const candidates = this.generateSlugCandidates(foundrySlug);
    for (const slug of candidates) {
      for (const packKey of PACKS) {
        const pack = game.packs.get(packKey);
        if (!pack) continue;
        const index = await pack.getIndex({ fields: ["system.slug"] });
        const match = index.find((i: { system?: { slug?: string } }) => i.system?.slug === slug);
        if (match) {
          const uuid = `Compendium.${packKey}.Item.${match._id}`;
          const doc = await fromUuid(uuid);
          return doc ? (doc as { toObject: () => Record<string, unknown> }).toObject() : null;
        }
      }
    }
    return null;
  }

  private static readonly CLASS_SUFFIXES = [
    "-sorcerer", "-wizard", "-cleric", "-druid", "-bard", "-fighter",
    "-ranger", "-rogue", "-monk", "-champion", "-barbarian", "-alchemist",
    "-investigator", "-oracle", "-swashbuckler", "-witch", "-magus", "-summoner",
    "-gunslinger", "-inventor", "-psychic", "-thaumaturge", "-kineticist",
  ];

  private generateSlugCandidates(slug: string): string[] {
    const candidates = [slug];
    // Try stripping class-name suffixes (e.g. "cantrip-expansion-sorcerer" -> "cantrip-expansion")
    for (const suffix of ImportOrchestrator.CLASS_SUFFIXES) {
      if (slug.endsWith(suffix)) {
        candidates.push(slug.slice(0, -suffix.length));
        break;
      }
    }
    // Try prefixing with "bloodline-" for bloodline class features
    candidates.push(`bloodline-${slug}`);
    return candidates;
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



  private static readonly SLUG_NORMALIZATIONS: Record<string, string> = {
    "arrow": "arrows",
    "rations-1-week": "rations",
    "rope-50-feet": "rope",
    "repair-toolkit-basic": "repair-toolkit",
  };

  private normalizeEquipmentSlug(demiplaneSlug: string): string {
    const stripped = demiplaneSlug.replace(/-rm$/, "");
    return ImportOrchestrator.SLUG_NORMALIZATIONS[stripped] ?? stripped;
  }

  private async applyEquipment(
    actor: Actor,
    engines: DemiplaneEngineEntry[],
    summary: ImportSummary,
  ): Promise<void> {
    const itemEngines = engines.filter(
      (e) => e.type === "DemiplaneEngine" && e.name.startsWith("tabula/item/"),
    );
    if (itemEngines.length === 0) return;

    const getCustomValue = (name: string): string | number | undefined => {
      const eng = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === name);
      return eng?.value ?? undefined;
    };

    // Build equipped state lookup
    const primaryHandId = getCustomValue("character_hand_primary_equipped-id") as string | undefined;
    const offHandId = getCustomValue("character_hand_offhand_equipped-id") as string | undefined;
    const bothHandsId = getCustomValue("character_hand_both_equipped-id") as string | undefined;

    const wornIds = new Set<string>();
    engines
      .filter((e) => e.type === "CustomDemiplaneEngine" && e.name.endsWith("-is-equipped") && e.value === 1)
      .forEach((e) => {
        const id = e.name.replace("-is-equipped", "");
        wornIds.add(id);
      });

    // Build container lookup: demiplaneEngineId -> parent container demiplaneEngineId
    const containerMap = new Map<string, string>();
    engines
      .filter((e) => e.type === "CustomDemiplaneEngine" && e.name.endsWith("-container"))
      .forEach((e) => {
        const childId = e.name.replace("-container", "");
        containerMap.set(childId, String(e.value));
      });

    // Build quantity lookup
    const quantityMap = new Map<string, number>();
    engines
      .filter((e) => e.type === "CustomDemiplaneEngine" && e.name.endsWith("--quantity"))
      .forEach((e) => {
        const id = e.name.replace("--quantity", "");
        quantityMap.set(id, Number(e.value) || 1);
      });

    // Load the equipment compendium index with slugs
    const equipPack = game.packs.get("pf2e.equipment-srd");
    if (!equipPack) {
      summary.errors.push("pf2e.equipment-srd compendium not found");
      return;
    }
    const equipIndex = await equipPack.getIndex({ fields: ["system.slug"] });

    // First pass: create all items and track the backpack for container assignment
    const itemsToCreate: Array<{ data: Record<string, unknown>; demiplaneId: string }> = [];
    const skippedItems: string[] = [];

    for (const eng of itemEngines) {
      const slug = this.normalizeEquipmentSlug(eng.args?.slug ?? eng.name.split("/").pop() ?? "");
      const demiplaneId = eng.demiplaneEngineId;

      let indexEntry = equipIndex.find(
        (e: { system?: { slug?: string } }) => e.system?.slug === slug,
      );
      if (!indexEntry) {
        // Fallback: strip tier suffixes (-basic, -lesser, -greater, -moderate, -major)
        const fallbackSlug = slug.replace(/-(basic|lesser|greater|moderate|major|superb)$/, "");
        if (fallbackSlug !== slug) {
          indexEntry = equipIndex.find(
            (e: { system?: { slug?: string } }) => e.system?.slug === fallbackSlug,
          );
        }
      }
      if (!indexEntry) {
        skippedItems.push(slug);
        continue;
      }

      const doc = await equipPack.getDocument(indexEntry._id);
      if (!doc) continue;

      const itemData = (doc as { toObject: () => Record<string, unknown> }).toObject();

      // Set quantity
      const qty = quantityMap.get(demiplaneId) ?? 1;
      (itemData as { system: { quantity?: number } }).system.quantity = qty;

      // Determine equipped state
      const equipped = this.resolveEquippedState(
        demiplaneId,
        primaryHandId,
        offHandId,
        bothHandsId,
        wornIds,
        containerMap,
        itemData,
      );
      (itemData as { system: { equipped?: unknown } }).system.equipped = equipped;

      itemsToCreate.push({ data: itemData, demiplaneId });
    }

    if (itemsToCreate.length === 0) {
      if (skippedItems.length > 0) {
        summary.log.push(`! equipment: ${skippedItems.length} items not found in compendium`);
      }
      return;
    }

    // Create items in batch - backpack first so we can get its Foundry ID for containerId
    const backpackIdx = itemsToCreate.findIndex(
      (i) => (i.data as { type?: string }).type === "backpack",
    );
    let backpackFoundryId: string | null = null;
    let backpackDemiplaneId: string | null = null;

    if (backpackIdx >= 0) {
      const backpackEntry = itemsToCreate.splice(backpackIdx, 1)[0];
      backpackDemiplaneId = backpackEntry.demiplaneId;
      const created = await actor.createEmbeddedDocuments("Item", [backpackEntry.data]);
      backpackFoundryId = (created[0] as { id: string }).id;
    }

    // Set containerId on items that are stowed in the backpack
    if (backpackFoundryId && backpackDemiplaneId) {
      for (const item of itemsToCreate) {
        const parentId = containerMap.get(item.demiplaneId);
        if (parentId === backpackDemiplaneId) {
          (item.data as { system: { containerId?: string } }).system.containerId = backpackFoundryId;
        }
      }
    }

    // Create remaining items
    if (itemsToCreate.length > 0) {
      await actor.createEmbeddedDocuments(
        "Item",
        itemsToCreate.map((i) => i.data),
      );
    }

    const totalCreated = (backpackFoundryId ? 1 : 0) + itemsToCreate.length;
    summary.log.push(`+ equipment: ${totalCreated} items`);
    if (skippedItems.length > 0) {
      summary.log.push(`! equipment skipped: [${skippedItems.join(", ")}]`);
    }
  }

  private resolveEquippedState(
    demiplaneId: string,
    primaryHandId: string | undefined,
    offHandId: string | undefined,
    bothHandsId: string | undefined,
    wornIds: Set<string>,
    containerMap: Map<string, string>,
    itemData: Record<string, unknown>,
  ): Record<string, unknown> {
    const itemType = (itemData as { type?: string }).type;

    // Held in primary hand (1H)
    if (primaryHandId === demiplaneId) {
      return { carryType: "held", handsHeld: 1, invested: null };
    }
    // Held in off-hand (1H)
    if (offHandId === demiplaneId) {
      return { carryType: "held", handsHeld: 1, invested: null };
    }
    // Held in both hands (2H)
    if (bothHandsId === demiplaneId) {
      return { carryType: "held", handsHeld: 2, invested: null };
    }
    // Stowed in a container
    if (containerMap.has(demiplaneId)) {
      return { carryType: "stowed", handsHeld: 0 };
    }
    // Worn/equipped (armor, backpack get inSlot: true)
    if (wornIds.has(demiplaneId)) {
      const result: Record<string, unknown> = { carryType: "worn", handsHeld: 0, invested: true };
      if (itemType === "armor" || itemType === "backpack") {
        result.inSlot = true;
      }
      return result;
    }
    // Default: worn (non-invested)
    const result: Record<string, unknown> = { carryType: "worn", handsHeld: 0, invested: null };
    if (itemType === "armor" || itemType === "backpack") {
      result.inSlot = true;
    }
    return result;
  }

  private static readonly CURRENCY_MAP: Array<{ engine: string; slug: string }> = [
    { engine: "character_currency_platinum", slug: "platinum-pieces" },
    { engine: "character_currency_gold", slug: "gold-pieces" },
    { engine: "character_currency_silver", slug: "silver-pieces" },
    { engine: "character_currency_copper", slug: "copper-pieces" },
  ];

  private async applyCurrency(
    actor: Actor,
    engines: DemiplaneEngineEntry[],
    summary: ImportSummary,
  ): Promise<void> {
    const equipPack = game.packs.get("pf2e.equipment-srd");
    if (!equipPack) return;
    const index = await equipPack.getIndex({ fields: ["system.slug"] });

    const coinItems: Record<string, unknown>[] = [];
    for (const { engine, slug } of ImportOrchestrator.CURRENCY_MAP) {
      const eng = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === engine);
      const amount = Number(eng?.value) || 0;
      if (amount <= 0) continue;

      const entry = index.find((e: { system?: { slug?: string } }) => e.system?.slug === slug);
      if (!entry) continue;

      const doc = await equipPack.getDocument(entry._id);
      if (!doc) continue;

      const itemData = (doc as { toObject: () => Record<string, unknown> }).toObject();
      (itemData as { system: { quantity?: number } }).system.quantity = amount;
      (itemData as { system: { equipped?: unknown } }).system.equipped = { carryType: "worn", handsHeld: 0 };
      coinItems.push(itemData);
    }

    if (coinItems.length > 0) {
      await actor.createEmbeddedDocuments("Item", coinItems);
      const desc = coinItems.map((c) => {
        const sys = c.system as { quantity: number };
        return `${sys.quantity} ${(c as { name: string }).name}`;
      }).join(", ");
      summary.log.push(`+ currency: ${desc}`);
    }
  }
}
