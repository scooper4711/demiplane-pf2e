import { stampImported, MODULE_ID } from "./types.js";
import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { toFoundrySlug } from "./slug-utils.js";
import { findSpellEngines } from "./spell-engines.js";
import { resolveSpellSlots } from "./spell-slot-resolver.js";

interface SpellcastingConfig {
  tradition: string;
  preparedType: "spontaneous" | "prepared";
  ability: string;
}

const CLASS_SPELLCASTING: Record<string, SpellcastingConfig> = {
  "sorcerer-spellcasting-rm": {
    tradition: "arcane",
    preparedType: "spontaneous",
    ability: "cha",
  },
  "wizard-spellcasting-rm": {
    tradition: "arcane",
    preparedType: "prepared",
    ability: "int",
  },
  "bard-spellcasting-rm": {
    tradition: "occult",
    preparedType: "spontaneous",
    ability: "cha",
  },
  "cleric-spellcasting-rm": {
    tradition: "divine",
    preparedType: "prepared",
    ability: "wis",
  },
  "druid-spellcasting-rm": {
    tradition: "primal",
    preparedType: "prepared",
    ability: "wis",
  },
  "oracle-spellcasting-rm": {
    tradition: "divine",
    preparedType: "spontaneous",
    ability: "cha",
  },
  "witch-spellcasting-rm": {
    tradition: "occult",
    preparedType: "prepared",
    ability: "int",
  },
  "psychic-spellcasting-rm": {
    tradition: "occult",
    preparedType: "spontaneous",
    ability: "cha",
  },
};

type PackIndex = Array<{ _id: string; system?: { slug?: string } }>;

function getPacks(): NonNullable<typeof game.packs> {
  if (!game.packs) throw new Error("game.packs unavailable — import called before ready");
  return game.packs;
}

async function resolveSpell(slug: string): Promise<Record<string, unknown> | null> {
  const pack = getPacks().get("pf2e.spells-srd");
  if (!pack) return null;
  const index = (await pack.getIndex({
    fields: ["system.slug"],
  } as never)) as unknown as PackIndex;
  const foundrySlug = toFoundrySlug(slug);
  const match = index.find((i) => i.system?.slug === foundrySlug);
  if (!match) return null;
  const doc = await pack.getDocument(match._id);
  return doc ? (doc as { toObject: () => Record<string, unknown> }).toObject() : null;
}

interface SpellGroup {
  source: string;
  config: SpellcastingConfig | null;
  spellbook: DemiplaneEngineEntry[];
}

function groupSpells(engines: DemiplaneEngineEntry[]): {
  main: SpellGroup[];
  innate: DemiplaneEngineEntry[];
} {
  const spellEngines = findSpellEngines(engines);
  const mainGroups = new Map<string, SpellGroup>();
  const innateSpells: DemiplaneEngineEntry[] = [];

  for (const eng of spellEngines) {
    const parentFeature = eng.args?.parentSpellFeature as string | undefined;
    const sourceType = eng.args?.sourceType as string | undefined;

    if (sourceType === "select-spell") {
      innateSpells.push(eng);
      continue;
    }

    if (!parentFeature || parentFeature === "scroll") continue;

    if (!mainGroups.has(parentFeature)) {
      mainGroups.set(parentFeature, {
        source: parentFeature,
        config: CLASS_SPELLCASTING[parentFeature] ?? null,
        spellbook: [],
      });
    }
    mainGroups.get(parentFeature)!.spellbook.push(eng);
  }

  return { main: [...mainGroups.values()], innate: innateSpells };
}

async function createEntry(
  actor: Actor,
  name: string,
  tradition: string,
  preparedType: string,
  ability: string
): Promise<string> {
  const created = await actor.createEmbeddedDocuments("Item", [
    stampImported({
      name,
      type: "spellcastingEntry",
      system: {
        prepared: { value: preparedType },
        tradition: { value: tradition },
        proficiency: { value: 1 },
        ability: { value: ability },
      },
    }),
  ] as never);
  return (created[0] as { id: string }).id;
}

async function addSpells(
  actor: Actor,
  entryId: string,
  spellEngines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<Map<string, string>> {
  const slugToId = new Map<string, string>();
  const spellItems: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const eng of spellEngines) {
    const slug = eng.args?.slug as string;
    if (!slug) continue;

    const foundrySlug = toFoundrySlug(slug);
    if (seen.has(foundrySlug)) continue;
    seen.add(foundrySlug);

    const spellData = await resolveSpell(slug);
    if (!spellData) {
      summary.log.push(`- spell: ${foundrySlug} (not found)`);
      continue;
    }

    (spellData as { system: Record<string, unknown> }).system.location = {
      value: entryId,
    };
    spellItems.push(stampImported(spellData));
  }

  if (spellItems.length > 0) {
    const created = await actor.createEmbeddedDocuments("Item", spellItems as never);
    for (const item of created as Array<{
      id: string;
      system: { slug: string };
    }>) {
      slugToId.set(item.system.slug, item.id);
    }
  }

  return slugToId;
}

export async function applySpells(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const { main, innate } = groupSpells(engines);
  if (main.length === 0 && innate.length === 0) return;

  let totalAdded = 0;

  for (const group of main) {
    if (!group.config) {
      summary.log.push(`! spells: unknown source "${group.source}", skipping ${group.spellbook.length} spells`);
      continue;
    }

    const { tradition, preparedType, ability } = group.config;
    const entryName = `${capitalize(tradition)} ${capitalize(preparedType)} Spells`;
    const entryId = await createEntry(actor, entryName, tradition, preparedType, ability);

    // For prepared casters: add entire spellbook, then set prepared slots
    // For spontaneous casters: spellbook = known repertoire (just add all)
    const slugToId = await addSpells(actor, entryId, group.spellbook, summary);
    totalAdded += slugToId.size;

    // Resolve and apply spell slot maximums
    await applySlotMaximums(actor, entryId, engines, group.source, summary);
  }

  // Innate spells from feats (Adapted Cantrip, Adaptive Adept, etc.)
  if (innate.length > 0) {
    const classConfig = main[0]?.config;
    const entryId = await createEntry(
      actor,
      "Innate Spells",
      classConfig?.tradition ?? "arcane",
      "innate",
      classConfig?.ability ?? "cha"
    );
    const slugToId = await addSpells(actor, entryId, innate, summary);
    totalAdded += slugToId.size;
  }

  if (totalAdded > 0) {
    summary.log.push(`+ spells: ${totalAdded} spells across ${main.length + (innate.length > 0 ? 1 : 0)} entries`);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function applySlotMaximums(
  actor: Actor,
  entryId: string,
  engines: DemiplaneEngineEntry[],
  parentSpellFeature: string,
  summary: ImportSummary
): Promise<void> {
  const classEngine = engines.find((e) => e.name?.startsWith("tabula/class/"));
  if (!classEngine) {
    console.warn(`${MODULE_ID} | [spell-slots] No class engine found, skipping slot setup`);
    return;
  }

  const classEngineId = classEngine.id as string;
  console.warn(
    `${MODULE_ID} | [spell-slots] Resolving slots for feature="${parentSpellFeature}", classEngineId="${classEngineId}"`
  );

  try {
    const progression = await resolveSpellSlots({
      classEngineId,
      characterLevel: getCharacterLevel(engines),
      engines,
      parentSpellFeature,
      slotSlug: "",
    });

    console.warn(
      `${MODULE_ID} | [spell-slots] Resolved: cantrips=${String(progression.cantrips)}, slots=${JSON.stringify(progression.slots)}`
    );

    const slotsUpdate = buildSlotsUpdate(progression);
    console.warn(`${MODULE_ID} | [spell-slots] Applying to entry ${entryId}: ${JSON.stringify(slotsUpdate)}`);

    const entry = actor.items.get(entryId);
    if (entry) {
      await entry.update({ system: { slots: slotsUpdate } } as never);
      summary.log.push(
        `+ spell-slots: cantrips=${String(progression.cantrips)}, ${Object.entries(progression.slots)
          .map(([r, c]) => `rank${r}=${String(c)}`)
          .join(", ")}`
      );
    } else {
      console.warn(`${MODULE_ID} | [spell-slots] Entry ${entryId} not found on actor`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${MODULE_ID} | [spell-slots] Failed to resolve slots: ${message}`);
    summary.log.push(`! spell-slots: failed to resolve (${message})`);
  }
}

function getCharacterLevel(engines: DemiplaneEngineEntry[]): number {
  const levelEngine = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === "character_level");
  return Number(levelEngine?.value) || 1;
}

function buildSlotsUpdate(progression: {
  cantrips: number;
  slots: Record<number, number>;
}): Record<string, { max: number }> {
  const update: Record<string, { max: number }> = {};
  update.slot0 = { max: progression.cantrips };

  for (const [rank, count] of Object.entries(progression.slots)) {
    update[`slot${rank}`] = { max: count };
  }

  return update;
}
/*
 * Note: Spell slots are not set during import. Demiplane computes them
 * client-side from class rules and does not expose them in the API.
 * Users should set slot max in Foundry after import.
 */
