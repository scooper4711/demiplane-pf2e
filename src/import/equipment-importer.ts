import { stampImported } from "./types.js";
import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import {
  genericConsumableSlug,
  isFormulaEngine,
  isGrantedByElement,
  normalizeEquipmentSlug,
  parseRankedConsumable,
  rawEquipmentSlug,
} from "./slug-utils.js";
import { isRuneEngine, collectRunesByParent, type WeaponRunes } from "./weapon-runes.js";
import { resolveSpellSourceFromCompendium } from "./compendium-resolver.js";
import { fetchStreamEngineLines } from "./stream-engines.js";
import { debugLog } from "./debug-log.js";
import { EQUIPMENT_PACK } from "../config.js";
import { resolveMappedItem, recordResolvedMapping } from "../slug-mapping.js";
import { isSoftDeleteEnabled } from "../write-level.js";
import type CompendiumCollection from "@client/documents/collections/compendium-collection.mjs";
import { getPackIndex, type PackIndex } from "./pack-index.js";
import { actorNaturalSize, toPlainData, type Pf2eSize } from "../pf2e-types.js";

/** A fixed spell a scroll/wand carries, taken from its `add-special-item-spell` modifier. */
interface SpecialItemSpell {
  spell: string;
  rank: number;
  itemType: "scroll" | "wand";
}

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

/** The compendium and per-character data needed to resolve one item engine. */
interface EquipmentBuildContext {
  equipPack: CompendiumCollection;
  equipIndex: PackIndex;
  state: EquipmentState;
  /** Item engine stream id → the fixed spell it carries (scrolls/wands). */
  specialSpells: Map<string, SpecialItemSpell>;
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

/**
 * Fetches the fixed spell each scroll/wand engine carries via its
 * `add-special-item-spell` modifier, keyed by the item engine's stream id.
 *
 * Only fixed-spell items (an inline `spell` slug, `freeSpell` false) are
 * collected — generic holders carry no spell here. This backs the fallback for
 * named scrolls/wands (e.g. Scroll of Glitterdust) that have no dedicated
 * compendium item: the modifier tells us the spell and rank to build a generic
 * ranked consumable instead. Network/parse failures degrade to an empty map.
 */
async function fetchSpecialItemSpells(itemEngines: DemiplaneEngineEntry[]): Promise<Map<string, SpecialItemSpell>> {
  const byEngineId = new Map<string, SpecialItemSpell>();
  // Only scroll/wand engines can carry `add-special-item-spell`, so limit the
  // network fetch to those rather than every equipment item.
  const engineIds = itemEngines.filter(isScrollOrWandEngine).map((e) => e.id);
  if (engineIds.length === 0) return byEngineId;

  const lines = await fetchStreamEngineLines(engineIds);
  for (const line of lines) {
    if (!line.id) continue;
    for (const mod of line.modifiers) {
      if (mod.type !== "add-special-item-spell") continue;
      if (mod.freeSpell || typeof mod.spell !== "string") {
        debugLog(
          `[equipment] special-item-spell for ${line.id}: no fixed spell (freeSpell=${String(mod.freeSpell)}, spell=${String(mod.spell)}) — using linked spell if any`
        );
        continue;
      }
      const itemType = mod.itemType === "scroll" ? "scroll" : "wand";
      debugLog(`[equipment] special-item-spell for ${line.id}: fixed "${mod.spell}" rank ${String(mod.rank)}`);
      byEngineId.set(line.id, { spell: mod.spell, rank: Number(mod.rank), itemType });
    }
  }
  return byEngineId;
}

/** Whether an item engine is a scroll or wand (the only carriers of a fixed item spell). */
function isScrollOrWandEngine(eng: DemiplaneEngineEntry): boolean {
  const slug = rawEquipmentSlug(eng);
  return slug.includes("scroll") || slug.includes("wand");
}

/**
 * A spell linked to a scroll or wand names its owning item in `sourceData`. A
 * generic scroll/wand holds a single spell, but Demiplane can emit several
 * candidate spell engines for one item (e.g. a wand whose held spell was
 * changed leaves the earlier selections orphaned in the save data). Demiplane's
 * own runtime honors the last selection, so take the last candidate and let it
 * overwrite earlier ones to match what the character sheet actually shows.
 */
function collectCarriedSpell(eng: DemiplaneEngineEntry, spellByItemId: Map<string, string>): void {
  if (!eng.name.startsWith("tabula/spell/")) return;

  const ownerId = (eng.args?.sourceData as { engineID?: string } | undefined)?.engineID;
  const spellSlug = eng.args?.slug as string | undefined;
  if (!ownerId || !spellSlug) return;

  const previous = spellByItemId.get(ownerId);
  if (previous && previous !== spellSlug) {
    debugLog(`[equipment] carried-spell: item ${ownerId} superseding "${previous}" with later "${spellSlug}"`);
  } else {
    debugLog(`[equipment] carried-spell: item ${ownerId} carries "${spellSlug}"`);
  }
  spellByItemId.set(ownerId, spellSlug);
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
    // Preserve a genuine 0 (Demiplane's "deleted" marker) — `Number(v) || 1`
    // would coerce it to 1. Only a missing or non-numeric value falls back to 1.
    const parsed = Number(eng.value);
    const quantity = Number.isFinite(parsed) ? parsed : 1;
    bags.quantityMap.set(eng.name.replace("--quantity", ""), quantity);
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

export function findBySlug(equipIndex: PackIndex, slug: string): { _id: string } | undefined {
  const exact = equipIndex.find((e) => e.system?.slug === slug);
  if (exact) return exact;

  const plural = `${slug}s`;
  const pluralMatch = equipIndex.find((e) => e.system?.slug === plural);
  if (pluralMatch) return pluralMatch;

  // Named ranked specialty scrolls/wands are normalized to end in `-Nth-rank`,
  // but most compendium entries carry a trailing `-spell` (e.g.
  // `wand-of-widening-9th-rank-spell`). A few (e.g. Legerdemain) don't, which the
  // exact match above already covers.
  if (/-\d+(?:st|nd|rd|th)-rank$/.test(slug)) {
    const withSpell = equipIndex.find((e) => e.system?.slug === `${slug}-spell`);
    if (withSpell) return withSpell;
  }

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

/**
 * Whether to skip importing an item engine because another element granted it.
 *
 * Foundry's ancestry/heritage/background/class/feat rule elements grant their
 * fixed items themselves (a ChoiceSet resolves the pick, a GrantItem creates the
 * item), so importing the Demiplane engine for the same item would leave the
 * character with two copies — e.g. a dwarf's Clan Dagger appearing once from the
 * ancestry grant and once from this importer. Logs the skip for traceability.
 */
function skipElementGrantedItem(eng: DemiplaneEngineEntry): boolean {
  if (!isGrantedByElement(eng)) return false;
  const category = (eng.args?.sourceData as { category?: string } | undefined)?.category ?? "element";
  debugLog(`[equipment] "${rawEquipmentSlug(eng)}" skipped: granted by ${category} (Foundry grants it natively)`);
  return true;
}

/**
 * The item engines this importer should create as inventory: `tabula/item`
 * engines, minus those another element grants (which Foundry creates itself; see
 * {@link skipElementGrantedItem}) and minus crafting formulas (which are recorded
 * as known formulas by {@link applyCraftingFormulas}, not created as items).
 */
function collectImportableItemEngines(engines: DemiplaneEngineEntry[]): DemiplaneEngineEntry[] {
  return engines.filter(
    (e) =>
      e.type === "DemiplaneEngine" &&
      e.name.startsWith("tabula/item/") &&
      !isFormulaEngine(e) &&
      !skipElementGrantedItem(e)
  );
}

export async function applyEquipment(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const allItemEngines = collectImportableItemEngines(engines);
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

  const equipPack = game.packs.get(EQUIPMENT_PACK);
  if (!equipPack) {
    summary.errors.push(`${EQUIPMENT_PACK} compendium not found`);
    return;
  }

  const ctx: EquipmentBuildContext = {
    equipPack,
    equipIndex: await getPackIndex(equipPack, ["system.slug"]),
    state: buildEquipmentState(engines),
    specialSpells: await fetchSpecialItemSpells(itemEngines),
  };

  const items: PendingItem[] = [];
  const skipped: string[] = [];

  for (const eng of itemEngines) {
    const pending = await buildEquipmentItem(eng, ctx, summary, skipped);
    if (pending) {
      applyRunesToItem(pending.data, runesByParent.get(pending.demiplaneId));
      items.push(pending);
    }
  }

  if (items.length === 0) {
    if (skipped.length > 0) summary.log.push(`! equipment: ${skipped.length} items not found`);
    return;
  }

  resizeItemsForActor(items, actor);

  const backpackCount = await createBackpackFirst(actor, items, ctx.state);

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
 * Resizes every built item to the actor's size before creation. Foundry only
 * does this on the sheet drop handler; the direct createEmbeddedDocuments this
 * importer uses bypasses it, so gear on a Tiny/Large actor would otherwise be
 * flagged as the wrong size on the sheet.
 */
function resizeItemsForActor(items: PendingItem[], actor: Actor): void {
  const actorSize = actorNaturalSize(actor);
  for (const item of items) resizeItemForActor(item.data, actorSize);
}

/** Treasure keeps its own size (coins/gems aren't resized to the bearer). */
const TREASURE_ITEM_TYPE = "treasure";

/**
 * Resizes an item's source `system.size` to the actor's size, mirroring the
 * PF2e system's `sizeItemForActor` (which only runs on the sheet drop handler,
 * not on the direct createEmbeddedDocuments this importer uses).
 *
 * Small is treated as Medium, so only Tiny and Large-or-bigger actors change an
 * item's size — matching how the sheet decides whether to flag a size mismatch.
 * Treasure is left alone. For a Large-or-bigger character carrying a non-magical
 * item, PF2e also clears `price.sizeSensitive`; we do the same for fidelity.
 */
function resizeItemForActor(data: Record<string, unknown>, actorSize: Pf2eSize): void {
  if (data.type === TREASURE_ITEM_TYPE) return;

  const itemSize: Pf2eSize = actorSize === "sm" ? "med" : actorSize;
  if (itemSize === "med") return;

  const system = data.system as Record<string, unknown>;
  system.size = itemSize;

  if (isLargerThanMedium(itemSize) && !isMagicalItem(system)) {
    const price = (system.price as Record<string, unknown> | undefined) ?? {};
    price.sizeSensitive = false;
    system.price = price;
  }
}

const SIZE_RANK: Record<Pf2eSize, number> = { tiny: 0, sm: 1, med: 2, lg: 3, huge: 4, grg: 5 };

function isLargerThanMedium(size: Pf2eSize): boolean {
  return SIZE_RANK[size] > SIZE_RANK.med;
}

/** Whether an item's source data carries the `magical` trait (or a magical tradition). */
function isMagicalItem(system: Record<string, unknown>): boolean {
  const traits = (system.traits as { value?: unknown } | undefined)?.value;
  if (!Array.isArray(traits)) return false;
  const MAGICAL_TRAITS = new Set(["magical", "arcane", "divine", "occult", "primal"]);
  return traits.some((t) => typeof t === "string" && MAGICAL_TRAITS.has(t));
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

  // Armor and weapons share potency and property runes but differ in their
  // fundamental defense/offense rune: armor carries `resilient`, weapons
  // `striking`. Write only the key that matches the item type so neither ends
  // up with a rune field its schema doesn't expect.
  const fundamental =
    data.type === "armor"
      ? { resilient: Math.max(existing.resilient ?? 0, runes.resilient) }
      : { striking: Math.max(existing.striking ?? 0, runes.striking) };

  system.runes = {
    potency: Math.max(existing.potency ?? 0, runes.potency),
    ...fundamental,
    property: [...new Set([...existingProperty, ...runes.property])],
  };
}

/** Builds one equipment item from its engine, or records why it can't be imported. */
async function buildEquipmentItem(
  eng: DemiplaneEngineEntry,
  ctx: EquipmentBuildContext,
  summary: ImportSummary,
  skipped: string[]
): Promise<PendingItem | null> {
  const demiplaneSlug = rawEquipmentSlug(eng);
  const slug = normalizeEquipmentSlug(demiplaneSlug);

  // A GM mapping is checked before the compendium lookup, and before the slug is
  // rewritten by normalization, so it matches what the GM mapped. The mapped item
  // is the base; a scroll/wand still runs the carried-spell attach below, so the
  // GM can correct which base item a spell-bearing consumable resolves to without
  // losing its spell.
  const mapped = await resolveMappedItem("equipment", demiplaneSlug);
  if (mapped) return finishEquipmentItem(mapped, eng, ctx, demiplaneSlug, slug, summary);

  const indexEntry = findBySlug(ctx.equipIndex, slug);
  if (!indexEntry) {
    return buildFixedSpellConsumable(eng, ctx, demiplaneSlug, summary, skipped);
  }

  const doc = await ctx.equipPack.getDocument(indexEntry._id);
  if (!doc) return null;

  const data = toPlainData(doc);

  // Record the resolution so it appears as an editable row on the mapping
  // screen — a GM can then correct an item that matched the wrong compendium
  // entry. Keyed by the pre-normalization slug, matching the resolveMappedItem
  // lookup above. No-ops if the GM has already set a mapping for this slug. The
  // carried-spell attach in finishEquipmentItem re-runs on the next import (which
  // hits the mapping branch above), so caching this does not empty the item.
  await recordResolvedMapping("equipment", demiplaneSlug, {
    uuid: `Compendium.${EQUIPMENT_PACK}.Item.${indexEntry._id}`,
    name: (data.name as string | undefined) ?? demiplaneSlug,
  });

  return finishEquipmentItem(data, eng, ctx, demiplaneSlug, slug, summary);
}

/**
 * Finishes an equipment item from its resolved base data — whether that came
 * from a GM mapping or the compendium lookup. Sets quantity and equipped state,
 * embeds the spell a scroll/wand carries, and applies the display name (explicit
 * override, else the "Scroll of {Spell} (Rank N)" form for a spell carrier, else
 * the base item's own name).
 *
 * Shared by both resolution paths so a GM-mapped scroll/wand still gets its
 * carried spell — the mapping only chooses the base item, not the spell.
 */
async function finishEquipmentItem(
  data: Record<string, unknown>,
  eng: DemiplaneEngineEntry,
  ctx: EquipmentBuildContext,
  demiplaneSlug: string,
  slug: string,
  summary: ImportSummary
): Promise<PendingItem | null> {
  const { state } = ctx;
  const demiplaneId = eng.demiplaneEngineId as string;
  const system = data.system as Record<string, unknown>;

  const quantity = state.quantityMap.get(demiplaneId) ?? (system.quantity as number | undefined) ?? 1;
  // In soft-delete mode a quantity of 0 marks an item the user "deleted" on the
  // sheet; skip it so a soft-deleted item stays gone. Otherwise a 0 is a real
  // quantity (e.g. a consumable the player tops up in town) and imports as-is.
  if (quantity === 0 && isSoftDeleteEnabled()) {
    debugLog(`[equipment] "${demiplaneSlug}" skipped: quantity 0 with soft-delete enabled`);
    return null;
  }
  system.quantity = quantity;
  system.equipped = resolveEquippedState(demiplaneId, state, data.type as string);

  const carriedSpellSlug = state.spellByItemId.get(demiplaneId);
  if (isScrollOrWandEngine(eng)) {
    debugLog(
      `[equipment] "${demiplaneSlug}" (id ${demiplaneId}) → ${slug}; carried spell: ${carriedSpellSlug ?? "none"}`
    );
  }
  const carried = await attachCarriedSpell(system, demiplaneSlug, carriedSpellSlug, summary);

  const customName = state.nameById.get(demiplaneId);
  if (customName) {
    data.name = customName;
  } else if (carried) {
    data.name = spellConsumableName(carried.kind, carried.spellName, carried.rank);
  }

  return { data: stampImported(data, slug), demiplaneId };
}

/**
 * The PF2e display name for a spell-bearing scroll/wand, matching the system's
 * `FromSpell` templates (e.g. "Scroll of Blessed Boundary (Rank 6)"). Applied so
 * an imported generic ranked consumable reads the same as one made by dragging a
 * spell onto the sheet, instead of the generic "Scroll of 6th-rank Spell".
 */
function spellConsumableName(kind: "scroll" | "wand", spellName: string, rank: number): string {
  const noun = kind === "scroll" ? "Scroll" : "Wand";
  return `${noun} of ${spellName} (Rank ${rank})`;
}

/**
 * Fallback for a fixed-spell scroll/wand with no dedicated compendium item (e.g.
 * Scroll of Glitterdust). Its `add-special-item-spell` modifier names the spell,
 * rank, and item type, so PF2e's generic ranked consumable
 * (`scroll-of-Nth-rank-spell` / `magic-wand-Nth-rank-spell`) can stand in with
 * the spell embedded. Records the item as unmapped (as before) when there is no
 * such modifier or the generic consumable itself is missing.
 */
async function buildFixedSpellConsumable(
  eng: DemiplaneEngineEntry,
  ctx: EquipmentBuildContext,
  demiplaneSlug: string,
  summary: ImportSummary,
  skipped: string[]
): Promise<PendingItem | null> {
  const { state } = ctx;
  const demiplaneId = eng.demiplaneEngineId as string;
  const special = ctx.specialSpells.get(eng.id);

  const recordUnmapped = (): null => {
    skipped.push(normalizeEquipmentSlug(demiplaneSlug));
    // Record the slug as Demiplane reported it, not the normalized one: that is
    // what a GM mapping is keyed on, and what they need to see. Holder/activation
    // wands with no fixed spell (e.g. Wand of Widening) stay unmapped on purpose,
    // so the GM can build and map an item that represents them rather than get a
    // silent, spell-less generic stand-in.
    summary.unmapped.push({ slug: demiplaneSlug, kind: "equipment" });
    return null;
  };

  if (!special) return recordUnmapped();

  const genericSlug = genericConsumableSlug(special.itemType, special.rank);
  const indexEntry = findBySlug(ctx.equipIndex, genericSlug);
  if (!indexEntry) return recordUnmapped();

  const doc = await ctx.equipPack.getDocument(indexEntry._id);
  if (!doc) return recordUnmapped();

  const quantity = state.quantityMap.get(demiplaneId) ?? 1;
  // Soft-deleted (quantity 0) items are skipped in soft-delete mode; see
  // finishEquipmentItem for the rationale.
  if (quantity === 0 && isSoftDeleteEnabled()) {
    debugLog(`[equipment] "${demiplaneSlug}" skipped: quantity 0 with soft-delete enabled`);
    return null;
  }

  debugLog(`[equipment] "${demiplaneSlug}" → generic ${genericSlug} carrying ${special.spell} (rank ${special.rank})`);

  const data = toPlainData(doc);
  const system = data.system as Record<string, unknown>;
  system.quantity = quantity;
  system.equipped = resolveEquippedState(demiplaneId, state, data.type as string);

  await attachSpecialItemSpell(system, special);

  // Keep the character's own item name (e.g. "Scroll of Glitterdust") rather
  // than the generic "Scroll of 2nd-rank Spell", preferring an explicit override.
  data.name = state.nameById.get(demiplaneId) ?? deriveFixedSpellItemName(eng, special.itemType);

  return { data: stampImported(data, genericSlug), demiplaneId };
}

/**
 * A readable name for a generic consumable standing in for a named scroll/wand.
 * Prefers the engine's display name; otherwise titlecases the Demiplane slug
 * (e.g. `scroll-of-glitterdust-rm` → "Scroll Of Glitterdust").
 */
function deriveFixedSpellItemName(eng: DemiplaneEngineEntry, itemType: "scroll" | "wand"): string {
  const engineName = eng.args?.name as string | undefined;
  if (engineName) return engineName;

  const slug = rawEquipmentSlug(eng).replace(/-rm$/, "");
  const titled = slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return titled || (itemType === "scroll" ? "Scroll" : "Wand");
}

/** How a spell-bearing consumable should be renamed after its spell is embedded. */
interface CarriedSpellNaming {
  kind: "scroll" | "wand";
  spellName: string;
  rank: number;
}

/**
 * Embeds the spell a scroll or wand carries, mirroring how the PF2e system
 * builds spell consumables: the spell's own source, detached from any
 * spellcasting entry and heightened to the item's rank.
 *
 * Returns the naming info for a generic ranked consumable (so the caller can
 * rename it "Scroll of {Spell} (Rank N)"), or null when no spell is carried or
 * the item is a named item that keeps its own name.
 *
 * A carried spell whose slug doesn't resolve in the compendium is recorded as an
 * unmapped spell so the GM sees it on the mapping screen and can map it, rather
 * than the item silently importing with no spell attached.
 */
async function attachCarriedSpell(
  system: Record<string, unknown>,
  demiplaneSlug: string,
  spellSlug: string | undefined,
  summary: ImportSummary
): Promise<CarriedSpellNaming | null> {
  if (!spellSlug) return null;

  const spellSource = await resolveSpellSourceFromCompendium(spellSlug);
  if (!spellSource) {
    debugLog(`[equipment] carried-spell "${spellSlug}" did not resolve in the spell compendium; item left empty`);
    summary.unmapped.push({ slug: spellSlug, kind: "spell" });
    return null;
  }

  const ranked = parseRankedConsumable(demiplaneSlug);
  const spellSystem = (spellSource.system as Record<string, unknown>) ?? {};
  const rank = ranked?.rank ?? (spellSystem.level as { value?: number } | undefined)?.value ?? 1;

  system.spell = {
    ...spellSource,
    _id: foundry.utils.randomID(),
    system: { ...spellSystem, location: { value: null, heightenedLevel: rank } },
  };

  // Only generic ranked consumables get the "Scroll of {Spell}" rename; a named
  // item (e.g. a specific magic wand) keeps its compendium name.
  if (!ranked) return null;
  const spellName = (spellSource.name as string | undefined) ?? spellSlug;
  return { kind: ranked.kind, spellName, rank };
}

/**
 * Embeds a fixed-spell item's spell on the generic consumable standing in for
 * it, at the rank named by the item's `add-special-item-spell` modifier (rather
 * than a rank parsed from the slug, which a named item doesn't carry).
 */
async function attachSpecialItemSpell(system: Record<string, unknown>, special: SpecialItemSpell): Promise<void> {
  const spellSource = await resolveSpellSourceFromCompendium(special.spell);
  if (!spellSource) return;

  const spellSystem = (spellSource.system as Record<string, unknown>) ?? {};
  system.spell = {
    ...spellSource,
    _id: foundry.utils.randomID(),
    system: { ...spellSystem, location: { value: null, heightenedLevel: special.rank } },
  };
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
