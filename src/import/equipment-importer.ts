import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { normalizeEquipmentSlug } from "./slug-utils.js";

interface EquipmentState {
  primaryHandId: string | undefined;
  offHandId: string | undefined;
  bothHandsId: string | undefined;
  wornIds: Set<string>;
  containerMap: Map<string, string>;
  quantityMap: Map<string, number>;
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

  for (const eng of engines) {
    if (eng.type !== "CustomDemiplaneEngine") continue;
    if (eng.name.endsWith("-is-equipped") && eng.value === 1) {
      wornIds.add(eng.name.replace("-is-equipped", ""));
    } else if (eng.name.endsWith("-container")) {
      containerMap.set(eng.name.replace("-container", ""), String(eng.value));
    } else if (eng.name.endsWith("--quantity")) {
      quantityMap.set(eng.name.replace("--quantity", ""), Number(eng.value) || 1);
    }
  }

  return {
    primaryHandId: findCustom("character_hand_primary_equipped-id") as string | undefined,
    offHandId: findCustom("character_hand_offhand_equipped-id") as string | undefined,
    bothHandsId: findCustom("character_hand_both_equipped-id") as string | undefined,
    wornIds,
    containerMap,
    quantityMap,
  };
}

function resolveEquippedState(demiplaneId: string, state: EquipmentState, itemType: string): EquippedResult {
  if (state.primaryHandId === demiplaneId) return { carryType: "held", handsHeld: 1, invested: null };
  if (state.offHandId === demiplaneId) return { carryType: "held", handsHeld: 1, invested: null };
  if (state.bothHandsId === demiplaneId) return { carryType: "held", handsHeld: 2, invested: null };
  if (state.containerMap.has(demiplaneId)) return { carryType: "stowed", handsHeld: 0 };

  const needsSlot = itemType === "armor" || itemType === "backpack";
  if (state.wornIds.has(demiplaneId)) {
    return { carryType: "worn", handsHeld: 0, invested: true, ...(needsSlot && { inSlot: true }) };
  }
  return { carryType: "worn", handsHeld: 0, invested: null, ...(needsSlot && { inSlot: true }) };
}

function findBySlug(
  equipIndex: { find: (fn: (e: { system?: { slug?: string } }) => boolean) => { _id: string } | undefined },
  slug: string,
): { _id: string } | undefined {
  const exact = equipIndex.find((e: { system?: { slug?: string } }) => e.system?.slug === slug);
  if (exact) return exact;

  const fallbackSlug = slug.replace(/-(basic|lesser|greater|moderate|major|superb)$/, "");
  if (fallbackSlug !== slug) {
    return equipIndex.find((e: { system?: { slug?: string } }) => e.system?.slug === fallbackSlug);
  }
  return undefined;
}

async function createBackpackFirst(
  actor: Actor,
  items: PendingItem[],
  state: EquipmentState,
): Promise<number> {
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
  summary: ImportSummary,
): Promise<void> {
  const itemEngines = engines.filter(
    (e) => e.type === "DemiplaneEngine" && e.name.startsWith("tabula/item/"),
  );
  if (itemEngines.length === 0) return;

  const state = buildEquipmentState(engines);

  const equipPack = game.packs!.get("pf2e.equipment-srd");
  if (!equipPack) {
    summary.errors.push("pf2e.equipment-srd compendium not found");
    return;
  }
  // @ts-expect-error -- PF2e extends index with system.slug
  const equipIndex = await equipPack.getIndex({ fields: ["system.slug"] });

  const items: PendingItem[] = [];
  const skipped: string[] = [];

  for (const eng of itemEngines) {
    const slug = normalizeEquipmentSlug(eng.args?.slug as string ?? eng.name.split("/").pop() ?? "");
    const demiplaneId = eng.demiplaneEngineId as string;
    const indexEntry = findBySlug(equipIndex as never, slug);

    if (!indexEntry) {
      skipped.push(slug);
      continue;
    }

    const doc = await equipPack.getDocument(indexEntry._id);
    if (!doc) continue;

    const data = (doc as { toObject: () => Record<string, unknown> }).toObject();
    const system = data.system as Record<string, unknown>;
    system.quantity = state.quantityMap.get(demiplaneId) ?? 1;
    system.equipped = resolveEquippedState(demiplaneId, state, data.type as string);

    items.push({ data, demiplaneId });
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

const CURRENCY_MAP = [
  { engine: "character_currency_platinum", slug: "platinum-pieces" },
  { engine: "character_currency_gold", slug: "gold-pieces" },
  { engine: "character_currency_silver", slug: "silver-pieces" },
  { engine: "character_currency_copper", slug: "copper-pieces" },
] as const;

export async function applyCurrency(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary,
): Promise<void> {
  const equipPack = game.packs!.get("pf2e.equipment-srd");
  if (!equipPack) return;
  // @ts-expect-error -- PF2e extends index with system.slug
  const index = await equipPack.getIndex({ fields: ["system.slug"] }) as unknown as Array<{ _id: string; system?: { slug?: string } }>;

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
    coinItems.push(data);
  }

  if (coinItems.length > 0) {
    await actor.createEmbeddedDocuments("Item", coinItems as never);
    const desc = coinItems.map((c) => `${(c.system as { quantity: number }).quantity} ${c.name}`).join(", ");
    summary.log.push(`+ currency: ${desc}`);
  }
}
