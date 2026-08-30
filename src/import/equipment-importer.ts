import { stampImported } from "./types.js";
import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { normalizeEquipmentSlug, parseRankedConsumable } from "./slug-utils.js";
import { resolveSpellSourceFromCompendium } from "./compendium-resolver.js";
import { EQUIPMENT_PACK } from "../config.js";

interface EquipmentState {
  primaryHandId: string | undefined;
  offHandId: string | undefined;
  bothHandsId: string | undefined;
  wornIds: Set<string>;
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
  const containerMap = new Map<string, string>();
  const quantityMap = new Map<string, number>();
  const spellByItemId = new Map<string, string>();
  const nameById = new Map<string, string>();

  const customBags = { wornIds, containerMap, quantityMap, nameById };

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

function collectCustomEngine(
  eng: DemiplaneEngineEntry,
  bags: {
    wornIds: Set<string>;
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
  if (state.primaryHandId === demiplaneId) return { carryType: "held", handsHeld: 1, invested: null };
  if (state.offHandId === demiplaneId) return { carryType: "held", handsHeld: 1, invested: null };
  if (state.bothHandsId === demiplaneId) return { carryType: "held", handsHeld: 2, invested: null };
  if (state.containerMap.has(demiplaneId)) return { carryType: "stowed", handsHeld: 0 };

  const needsSlot = itemType === "armor" || itemType === "backpack";
  if (state.wornIds.has(demiplaneId)) {
    return {
      carryType: "worn",
      handsHeld: 0,
      invested: true,
      ...(needsSlot && { inSlot: true }),
    };
  }
  return {
    carryType: "worn",
    handsHeld: 0,
    invested: null,
    ...(needsSlot && { inSlot: true }),
  };
}

function findBySlug(
  equipIndex: {
    find: (fn: (e: { system?: { slug?: string } }) => boolean) => { _id: string } | undefined;
  },
  slug: string
): { _id: string } | undefined {
  const exact = equipIndex.find((e: { system?: { slug?: string } }) => e.system?.slug === slug);
  if (exact) return exact;

  const plural = `${slug}s`;
  const pluralMatch = equipIndex.find((e: { system?: { slug?: string } }) => e.system?.slug === plural);
  if (pluralMatch) return pluralMatch;

  const fallbackSlug = slug.replace(/-(basic|lesser|greater|moderate|major|superb)$/, "");
  if (fallbackSlug !== slug) {
    return equipIndex.find((e: { system?: { slug?: string } }) => e.system?.slug === fallbackSlug);
  }
  return undefined;
}

async function createBackpackFirst(actor: Actor, items: PendingItem[], state: EquipmentState): Promise<number> {
  const backpackIdx = items.findIndex((i) => (i.data.type as string) === "backpack");
  if (backpackIdx < 0) return 0;

  const backpackEntry = items.splice(backpackIdx, 1)[0]!;
  const created = await actor.createEmbeddedDocuments("Item", [backpackEntry.data] as never);
  const backpackFoundryId = (created[0] as { id: string }).id;

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
  const itemEngines = engines.filter((e) => e.type === "DemiplaneEngine" && e.name.startsWith("tabula/item/"));
  if (itemEngines.length === 0) return;

  const state = buildEquipmentState(engines);

  const equipPack = game.packs!.get(EQUIPMENT_PACK);
  if (!equipPack) {
    summary.errors.push(`${EQUIPMENT_PACK} compendium not found`);
    return;
  }
  const equipIndex = (await equipPack.getIndex({
    fields: ["system.slug"],
  } as never)) as unknown as Array<{ _id: string; system?: { slug?: string } }>;

  const items: PendingItem[] = [];
  const skipped: string[] = [];

  for (const eng of itemEngines) {
    const pending = await buildEquipmentItem(
      eng,
      equipPack as unknown as EquipmentPack,
      equipIndex as never,
      state,
      summary,
      skipped
    );
    if (pending) items.push(pending);
  }

  if (items.length === 0) {
    if (skipped.length > 0) summary.log.push(`! equipment: ${skipped.length} items not found`);
    return;
  }

  const backpackCount = await createBackpackFirst(actor, items, state);

  if (items.length > 0) {
    await actor.createEmbeddedDocuments("Item", items.map((i) => i.data) as never);
  }

  summary.log.push(`+ equipment: ${backpackCount + items.length} items`);
  if (skipped.length > 0) {
    summary.log.push(`! equipment skipped: [${skipped.join(", ")}]`);
  }
}

interface EquipmentPack {
  getDocument: (id: string) => Promise<unknown>;
}

/** Builds one equipment item from its engine, or records why it can't be imported. */
async function buildEquipmentItem(
  eng: DemiplaneEngineEntry,
  equipPack: EquipmentPack,
  equipIndex: never,
  state: EquipmentState,
  summary: ImportSummary,
  skipped: string[]
): Promise<PendingItem | null> {
  const demiplaneSlug = rawEquipmentSlug(eng);
  const slug = normalizeEquipmentSlug(demiplaneSlug);
  const demiplaneId = eng.demiplaneEngineId as string;

  const indexEntry = findBySlug(equipIndex, slug);
  if (!indexEntry) {
    skipped.push(slug);
    summary.unresolved.push(`Could not import equipment "${slug}": not found in compendium`);
    return null;
  }

  const doc = await equipPack.getDocument(indexEntry._id);
  if (!doc) return null;

  const data = (doc as { toObject: () => Record<string, unknown> }).toObject();
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
  const equipPack = game.packs!.get(EQUIPMENT_PACK);
  if (!equipPack) return;
  const index = (await equipPack.getIndex({
    fields: ["system.slug"],
  } as never)) as unknown as Array<{ _id: string; system?: { slug?: string } }>;

  const coinItems: Record<string, unknown>[] = [];
  for (const { engine, slug } of CURRENCY_MAP) {
    const eng = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === engine);
    const amount = Number(eng?.value) || 0;
    if (amount <= 0) continue;

    const entry = index.find((e: { system?: { slug?: string } }) => e.system?.slug === slug);
    if (!entry) continue;

    const doc = await equipPack.getDocument(entry._id);
    if (!doc) continue;

    const data = (doc as { toObject: () => Record<string, unknown> }).toObject();
    const system = data.system as Record<string, unknown>;
    system.quantity = amount;
    system.equipped = { carryType: "worn", handsHeld: 0 };
    coinItems.push(stampImported(data));
  }

  if (coinItems.length > 0) {
    await actor.createEmbeddedDocuments("Item", coinItems as never);
    const desc = coinItems.map((c) => `${(c.system as { quantity: number }).quantity} ${c.name}`).join(", ");
    summary.log.push(`+ currency: ${desc}`);
  }
}
