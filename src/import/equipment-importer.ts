import { stampImported } from "./types.js";
import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { normalizeEquipmentSlug, parseRankedConsumable } from "./slug-utils.js";
import { isRuneEngine, collectRunesByParent, type WeaponRunes } from "./weapon-runes.js";
import { resolveSpellSourceFromCompendium } from "./compendium-resolver.js";
import { EQUIPMENT_PACK } from "../config.js";
import { resolveMappedItem } from "../slug-mapping.js";
import type CompendiumCollection from "@client/documents/collections/compendium-collection.mjs";
import { getPackIndex, type PackIndex } from "./pack-index.js";
import { toPlainData } from "../pf2e-types.js";

interface EquipmentState {
  primaryHandId: string | undefined;
  offHandId: string | undefined;
  bothHandsId: string | undefined;
  wornIds: Set<string>;
  /** Item engine ids the character has invested (independent of being worn/held). */
  investedIds: Set<string>;
  containerMap: Map<string, string>;
  quantityMap: Map<string, number>;
  /** Item engine id → the slug of the spell the item carries. */
  spellByItemId: Map<string, string>;
  /** Item engine id → the character-specific name for the item. */
  nameById: Map<string, string>;
}

interface EquippedResult {
  carryType: string;
  handsHeld: number;
  invested?: boolean | null;
  inSlot?: boolean;
}

interface PendingItem {
  data: Record<string, unknown>;
  demiplaneId: string;
}

function buildEquipmentState(engines: DemiplaneEngineEntry[]): EquipmentState {
  const findCustom = (name: string) =>
    engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === name)?.value;

  const wornIds = new Set<string>();
  const investedIds = new Set<string>();
  const containerMap = new Map<string, string>();
  const quantityMap = new Map<string, number>();
  const spellByItemId = new Map<string, string>();
  const nameById = new Map<string, string>();

  const customBags = { wornIds, investedIds, containerMap, quantityMap, nameById };

  for (const eng of engines) {
    if (eng.type === "DemiplaneEngine") {
      collectCarriedSpell(eng, spellByItemId);
    } else if (eng.type === "CustomDemiplaneEngine") {
      collectCustomEngine(eng, customBags);
    }
  }

  return {
    primaryHandId: findCustom("character_hand_primary_equipped-id") as string | undefined,
    offHandId: findCustom("character_hand_offhand_equipped-id") as string | undefined,
    bothHandsId: findCustom("character_hand_both_equipped-id") as string | undefined,
    wornIds,
    investedIds,
    containerMap,
    quantityMap,
    spellByItemId,
    nameById,
  };
}

/** A spell linked to a scroll or wand names its owning item in `sourceData`. */
function collectCarriedSpell(eng: DemiplaneEngineEntry, spellByItemId: Map<string, string>): void {
  if (!eng.name.startsWith("tabula/spell/")) return;

  const ownerId = (eng.args?.sourceData as { engineID?: string } | undefined)?.engineID;
  const spellSlug = eng.args?.slug as string | undefined;
  if (ownerId && spellSlug) spellByItemId.set(ownerId, spellSlug);
}

/** Prefix Demiplane uses for the per-item "invested" flag: `value--is-invested--<engineId>`. */
const INVESTED_PREFIX = "value--is-invested--";

function collectCustomEngine(
  eng: DemiplaneEngineEntry,
  bags: {
    wornIds: Set<string>;
    investedIds: Set<string>;
    containerMap: Map<string, string>;
    quantityMap: Map<string, number>;
    nameById: Map<string, string>;
  }
): void {
  if (eng.name.endsWith("-override-name")) {
    const parentId = eng.args?.parentEngine as string | undefined;
    if (parentId && typeof eng.value === "string" && eng.value) bags.nameById.set(parentId, eng.value);
    return;
  }
  // Investment is a separate flag from equipped: an item can be invested without
  // being held/worn in a slot (e.g. a pendant of the occult).
  if (eng.name.startsWith(INVESTED_PREFIX)) {
    if (eng.value === 1) bags.investedIds.add(eng.name.slice(INVESTED_PREFIX.length));
    return;
  }
  if (eng.name.endsWith("-is-equipped") && eng.value === 1) {
    bags.wornIds.add(eng.name.replace("-is-equipped", ""));
    return;
  }
  if (eng.name.endsWith("-container")) {
    bags.containerMap.set(eng.name.replace("-container", ""), String(eng.value));
    return;
  }
  if (eng.name.endsWith("--quantity")) {
    bags.quantityMap.set(eng.name.replace("--quantity", ""), Number(eng.value) || 1);
  }
}

function resolveEquippedState(demiplaneId: string, state: EquipmentState, itemType: string): EquippedResult {
  // Investment is tracked by its own Demiplane flag and is independent of how the
  // item is carried, so resolve it once and apply it to whichever branch wins.
  // `invested` stays null for items that can't be invested (held weapons), where
  // PF2e expects null rather than false.
  const invested = state.investedIds.has(demiplaneId) ? true : null;

  if (state.primaryHandId === demiplaneId) return { carryType: "held", handsHeld: 1, invested };
  if (state.offHandId === demiplaneId) return { carryType: "held", handsHeld: 1, invested };
  if (state.bothHandsId === demiplaneId) return { carryType: "held", handsHeld: 2, invested };
  if (state.containerMap.has(demiplaneId)) return { carryType: "stowed", handsHeld: 0, invested };

  const needsSlot = itemType === "armor" || itemType === "backpack";
  if (state.wornIds.has(demiplaneId)) {
    return {
      carryType: "worn",
      handsHeld: 0,
      // Worn items default to invested (unchanged prior behavior); the invest
      // flag only ever adds investment, never removes it here.
      invested: true,
      ...(needsSlot && { inSlot: true }),
    };
  }
  return {
    carryType: "worn",
    handsHeld: 0,
    invested,
    ...(needsSlot && { inSlot: true }),
  };
}

function findBySlug(equipIndex: PackIndex, slug: string): { _id: string } | undefined {
  const exact = equipIndex.find((e) => e.system?.slug === slug);
  if (exact) return exact;

  const plural = `${slug}s`;
  const pluralMatch = equipIndex.find((e) => e.system?.slug === plural);
  if (pluralMatch) return pluralMatch;

  const fallbackSlug = slug.replace(/-(basic|lesser|greater|moderate|major|superb)$/, "");
  if (fallbackSlug !== slug) {
    return equipIndex.find((e) => e.system?.slug === fallbackSlug);
  }
  return undefined;
}

async function createBackpackFirst(actor: Actor, items: PendingItem[], state: EquipmentState): Promise<number> {
  const backpackIdx = items.findIndex((i) => (i.data.type as string) === "backpack");
  if (backpackIdx < 0) return 0;

  const backpackEntry = items.splice(backpackIdx, 1)[0]!;
  const created = await actor.createEmbeddedDocuments("Item", [backpackEntry.data]);
  const backpackFoundryId = created[0]?.id;
  if (!backpackFoundryId) throw new Error("Failed to create backpack item");

  for (const item of items) {
    if (state.containerMap.get(item.demiplaneId) === backpackEntry.demiplaneId) {
      (item.data.system as Record<string, unknown>).containerId = backpackFoundryId;
    }
  }
  return 1;
}

export async function applyEquipment(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const allItemEngines = engines.filter((e) => e.type === "DemiplaneEngine" && e.name.startsWith("tabula/item/"));
  if (allItemEngines.length === 0) return;

  // Runes are affixed to a parent weapon (weapon.system.runes), not created as
  // their own inventory items. Split them out and group by the parent's id.
  const runeEngines = allItemEngines.filter(isRuneEngine);
  const itemEngines = allItemEngines.filter((e) => !isRuneEngine(e));
  const runesByParent = collectRunesByParent(runeEngines, (slug) => {
    // Surface an unrecognized rune the same way as an unresolved item, so it
    // appears in the sync issues and the GM mapping editor rather than being
    // silently dropped.
    summary.log.push(`! rune not recognized: ${slug}`);
    summary.unmapped.push({ slug, kind: "equipment" });
  });

  const state = buildEquipmentState(engines);

  const equipPack = game.packs.get(EQUIPMENT_PACK);
  if (!equipPack) {
    summary.errors.push(`${EQUIPMENT_PACK} compendium not found`);
    return;
  }
  const equipIndex = await getPackIndex(equipPack, ["system.slug"]);

  const items: PendingItem[] = [];
  const skipped: string[] = [];

  for (const eng of itemEngines) {
    const pending = await buildEquipmentItem(eng, equipPack, equipIndex, state, summary, skipped);
    if (pending) {
      applyRunesToItem(pending.data, runesByParent.get(pending.demiplaneId));
      items.push(pending);
    }
  }

  if (items.length === 0) {
    if (skipped.length > 0) summary.log.push(`! equipment: ${skipped.length} items not found`);
    return;
  }

  const backpackCount = await createBackpackFirst(actor, items, state);

  if (items.length > 0) {
    await actor.createEmbeddedDocuments(
      "Item",
      items.map((i) => i.data)
    );
  }

  summary.log.push(`+ equipment: ${backpackCount + items.length} items`);
  if (skipped.length > 0) {
    summary.log.push(`! equipment skipped: [${skipped.join(", ")}]`);
  }
}

/**
 * Applies affixed runes to an item's `system.runes`, merging with any runes the
 * compendium item already carries (e.g. specific magic items). No-op when the
 * parent has no runes.
 */
function applyRunesToItem(data: Record<string, unknown>, runes: WeaponRunes | undefined): void {
  if (!runes) return;

  const system = data.system as Record<string, unknown>;
  const existing = (system.runes as Partial<WeaponRunes> | undefined) ?? {};
  const existingProperty = Array.isArray(existing.property) ? existing.property : [];

  system.runes = {
    potency: Math.max(existing.potency ?? 0, runes.potency),
    striking: Math.max(existing.striking ?? 0, runes.striking),
    property: [...new Set([...existingProperty, ...runes.property])],
  };
}

/** Builds one equipment item from its engine, or records why it can't be imported. */
async function buildEquipmentItem(
  eng: DemiplaneEngineEntry,
  equipPack: CompendiumCollection,
  equipIndex: PackIndex,
  state: EquipmentState,
  summary: ImportSummary,
  skipped: string[]
): Promise<PendingItem | null> {
  const demiplaneSlug = rawEquipmentSlug(eng);
  const slug = normalizeEquipmentSlug(demiplaneSlug);
  const demiplaneId = eng.demiplaneEngineId as string;

  // A GM mapping is checked before the compendium lookup, and before the slug is
  // rewritten by normalization, so it matches what the GM mapped.
  const mapped = await resolveMappedItem("equipment", demiplaneSlug);
  if (mapped) return { data: stampImported(mapped, slug), demiplaneId };

  const indexEntry = findBySlug(equipIndex, slug);
  if (!indexEntry) {
    skipped.push(slug);
    // Record the slug as Demiplane reported it, not the normalized one: that is
    // what a GM mapping is keyed on, and what they need to see.
    summary.unmapped.push({ slug: demiplaneSlug, kind: "equipment" });
    return null;
  }

  const doc = await equipPack.getDocument(indexEntry._id);
  if (!doc) return null;

  const data = toPlainData(doc);
  const system = data.system as Record<string, unknown>;
  system.quantity = state.quantityMap.get(demiplaneId) ?? (system.quantity as number | undefined) ?? 1;
  system.equipped = resolveEquippedState(demiplaneId, state, data.type as string);

  await attachCarriedSpell(system, demiplaneSlug, state.spellByItemId.get(demiplaneId));

  const customName = state.nameById.get(demiplaneId);
  if (customName) data.name = customName;

  return { data: stampImported(data, slug), demiplaneId };
}

/**
 * Embeds the spell a scroll or wand carries, mirroring how the PF2e system
 * builds spell consumables: the spell's own source, detached from any
 * spellcasting entry and heightened to the item's rank.
 */
async function attachCarriedSpell(
  system: Record<string, unknown>,
  demiplaneSlug: string,
  spellSlug: string | undefined
): Promise<void> {
  if (!spellSlug) return;

  const spellSource = await resolveSpellSourceFromCompendium(spellSlug);
  if (!spellSource) return;

  const ranked = parseRankedConsumable(demiplaneSlug);
  const spellSystem = (spellSource.system as Record<string, unknown>) ?? {};
  const rank = ranked?.rank ?? (spellSystem.level as { value?: number } | undefined)?.value ?? 1;

  system.spell = {
    ...spellSource,
    _id: foundry.utils.randomID(),
    system: { ...spellSystem, location: { value: null, heightenedLevel: rank } },
  };
}

/**
 * Derives the raw (Demiplane) equipment slug for an item engine, without
 * normalizing it to the compendium's naming.
 */
function rawEquipmentSlug(eng: DemiplaneEngineEntry): string {
  return (eng.args?.slug as string | undefined) ?? (eng.name.split("/").pop() ?? "").replace(/\.eng$/, "");
}

const CURRENCY_MAP = [
  { engine: "character_currency_platinum", slug: "platinum-pieces" },
  { engine: "character_currency_gold", slug: "gold-pieces" },
  { engine: "character_currency_silver", slug: "silver-pieces" },
  { engine: "character_currency_copper", slug: "copper-pieces" },
] as const;

export async function applyCurrency(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const equipPack = game.packs.get(EQUIPMENT_PACK);
  if (!equipPack) return;
  const index = await getPackIndex(equipPack, ["system.slug"]);

  const coinItems: Record<string, unknown>[] = [];
  for (const { engine, slug } of CURRENCY_MAP) {
    const eng = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === engine);
    const amount = Number(eng?.value) || 0;
    if (amount <= 0) continue;

    const entry = index.find((e) => e.system?.slug === slug);
    if (!entry) continue;

    const doc = await equipPack.getDocument(entry._id);
    if (!doc) continue;

    const data = toPlainData(doc);
    const system = data.system as Record<string, unknown>;
    system.quantity = amount;
    system.equipped = { carryType: "worn", handsHeld: 0 };
    coinItems.push(stampImported(data));
  }

  if (coinItems.length > 0) {
    await actor.createEmbeddedDocuments("Item", coinItems);
    const desc = coinItems.map((c) => `${(c.system as { quantity: number }).quantity} ${c.name}`).join(", ");
    summary.log.push(`+ currency: ${desc}`);
  }
}
