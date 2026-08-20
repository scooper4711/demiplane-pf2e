import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { normalizeEquipmentSlug } from "./slug-utils.js";

/**
 * Imports equipment items and currency from Demiplane.
 */
// eslint-disable-next-line complexity -- sequential equipment processing with fallback logic
export async function applyEquipment(
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

  const primaryHandId = getCustomValue("character_hand_primary_equipped-id") as string | undefined;
  const offHandId = getCustomValue("character_hand_offhand_equipped-id") as string | undefined;
  const bothHandsId = getCustomValue("character_hand_both_equipped-id") as string | undefined;

  const wornIds = new Set<string>();
  engines
    .filter((e) => e.type === "CustomDemiplaneEngine" && e.name.endsWith("-is-equipped") && e.value === 1)
    .forEach((e) => { wornIds.add(e.name.replace("-is-equipped", "")); });

  const containerMap = new Map<string, string>();
  engines
    .filter((e) => e.type === "CustomDemiplaneEngine" && e.name.endsWith("-container"))
    .forEach((e) => { containerMap.set(e.name.replace("-container", ""), String(e.value)); });

  const quantityMap = new Map<string, number>();
  engines
    .filter((e) => e.type === "CustomDemiplaneEngine" && e.name.endsWith("--quantity"))
    .forEach((e) => { quantityMap.set(e.name.replace("--quantity", ""), Number(e.value) || 1); });

  const equipPack = game.packs.get("pf2e.equipment-srd");
  if (!equipPack) {
    summary.errors.push("pf2e.equipment-srd compendium not found");
    return;
  }
  const equipIndex = await equipPack.getIndex({ fields: ["system.slug"] });

  const itemsToCreate: Array<{ data: Record<string, unknown>; demiplaneId: string }> = [];
  const skippedItems: string[] = [];

  for (const eng of itemEngines) {
    const slug = normalizeEquipmentSlug(eng.args?.slug ?? eng.name.split("/").pop() ?? "");
    const demiplaneId = eng.demiplaneEngineId as string;

    let indexEntry = equipIndex.find(
      (e: { system?: { slug?: string } }) => e.system?.slug === slug,
    );
    if (!indexEntry) {
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
    (itemData as { system: { quantity?: number } }).system.quantity = quantityMap.get(demiplaneId) ?? 1;
    (itemData as { system: { equipped?: unknown } }).system.equipped = resolveEquippedState(
      demiplaneId, primaryHandId, offHandId, bothHandsId, wornIds, containerMap, itemData,
    );

    itemsToCreate.push({ data: itemData, demiplaneId });
  }

  if (itemsToCreate.length === 0) {
    if (skippedItems.length > 0) {
      summary.log.push(`! equipment: ${skippedItems.length} items not found in compendium`);
    }
    return;
  }

  // Create backpack first for containerId assignment
  const backpackIdx = itemsToCreate.findIndex((i) => (i.data as { type?: string }).type === "backpack");
  let backpackFoundryId: string | null = null;
  let backpackDemiplaneId: string | null = null;

  if (backpackIdx >= 0) {
    const backpackEntry = itemsToCreate.splice(backpackIdx, 1)[0];
    backpackDemiplaneId = backpackEntry.demiplaneId;
    const created = await actor.createEmbeddedDocuments("Item", [backpackEntry.data]);
    backpackFoundryId = (created[0] as { id: string }).id;
  }

  if (backpackFoundryId && backpackDemiplaneId) {
    for (const item of itemsToCreate) {
      if (containerMap.get(item.demiplaneId) === backpackDemiplaneId) {
        (item.data as { system: { containerId?: string } }).system.containerId = backpackFoundryId;
      }
    }
  }

  if (itemsToCreate.length > 0) {
    await actor.createEmbeddedDocuments("Item", itemsToCreate.map((i) => i.data));
  }

  const totalCreated = (backpackFoundryId ? 1 : 0) + itemsToCreate.length;
  summary.log.push(`+ equipment: ${totalCreated} items`);
  if (skippedItems.length > 0) {
    summary.log.push(`! equipment skipped: [${skippedItems.join(", ")}]`);
  }
}

function resolveEquippedState(
  demiplaneId: string,
  primaryHandId: string | undefined,
  offHandId: string | undefined,
  bothHandsId: string | undefined,
  wornIds: Set<string>,
  containerMap: Map<string, string>,
  itemData: Record<string, unknown>,
): Record<string, unknown> {
  const itemType = (itemData as { type?: string }).type;

  if (primaryHandId === demiplaneId) return { carryType: "held", handsHeld: 1, invested: null };
  if (offHandId === demiplaneId) return { carryType: "held", handsHeld: 1, invested: null };
  if (bothHandsId === demiplaneId) return { carryType: "held", handsHeld: 2, invested: null };
  if (containerMap.has(demiplaneId)) return { carryType: "stowed", handsHeld: 0 };

  if (wornIds.has(demiplaneId)) {
    const result: Record<string, unknown> = { carryType: "worn", handsHeld: 0, invested: true };
    if (itemType === "armor" || itemType === "backpack") result.inSlot = true;
    return result;
  }

  const result: Record<string, unknown> = { carryType: "worn", handsHeld: 0, invested: null };
  if (itemType === "armor" || itemType === "backpack") result.inSlot = true;
  return result;
}

const CURRENCY_MAP: Array<{ engine: string; slug: string }> = [
  { engine: "character_currency_platinum", slug: "platinum-pieces" },
  { engine: "character_currency_gold", slug: "gold-pieces" },
  { engine: "character_currency_silver", slug: "silver-pieces" },
  { engine: "character_currency_copper", slug: "copper-pieces" },
];

export async function applyCurrency(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary,
): Promise<void> {
  const equipPack = game.packs.get("pf2e.equipment-srd");
  if (!equipPack) return;
  const index = await equipPack.getIndex({ fields: ["system.slug"] });

  const coinItems: Record<string, unknown>[] = [];
  for (const { engine, slug } of CURRENCY_MAP) {
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
