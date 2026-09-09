import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { MODULE_ID } from "./types.js";
import { toFoundrySlug } from "./slug-utils.js";
import { debugLog } from "./debug-log.js";
import { resolveSpellItems, createSpellItems } from "./spellcasting-entry.js";

const SIGNATURE_SUFFIX = "-spell-is-signature";

/** Suffix of the per-slot flag marking a prepared spell as cast (slot expended). */
const IS_CAST_SUFFIX = "-is-cast";

type PreparedSlot = { id: string | null; expended: boolean };

export async function placePreparedSpells(
  actor: Actor,
  entryId: string,
  preparedEngines: DemiplaneEngineEntry[],
  slugToId: Map<string, string>,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  if (preparedEngines.length === 0) return;

  await addMissingPreparedItems(actor, entryId, preparedEngines, slugToId, summary);

  const castIds = collectCastEngineIds(engines);
  const slotsUpdate = buildPreparedSlotsUpdate(preparedEngines, slugToId, castIds);
  // Record the Demiplane prepared-engine id behind each slot position so a later
  // export can map a toggled `expended` slot back to the engine whose `-is-cast`
  // flag it should set. Keyed `slot{rank}` → ordered engine ids, matching the
  // slot order written above.
  const slotEngineIds = buildSlotEngineIdMap(preparedEngines);

  debugLog(`[prepared] Placing ${String(preparedEngines.length)} prepared spells in entry ${entryId}`);

  const entry = actor.items.get(entryId);
  if (entry) {
    await entry.update({
      system: { slots: slotsUpdate },
      [`flags.${MODULE_ID}.preparedSlotEngineIds`]: slotEngineIds,
    });
    summary.log.push(`+ prepared: ${String(preparedEngines.length)} spells placed in slots`);
  }
}

/**
 * Maps each slot position to its Demiplane prepared-engine id, in the same order
 * the slots are written. `slot{rank}` → `[engineId, …]`, so export can resolve
 * "slot N at rank R was expended" to the engine whose `-is-cast` flag to toggle.
 */
function buildSlotEngineIdMap(preparedEngines: DemiplaneEngineEntry[]): Record<string, string[]> {
  const byRank: Record<string, string[]> = {};
  for (const eng of preparedEngines) {
    if (!eng.args?.slug) continue;
    const rank = (eng.args?.selectionRank as number) ?? 0;
    const key = `slot${String(rank)}`;
    (byRank[key] ??= []).push(typeof eng.demiplaneEngineId === "string" ? eng.demiplaneEngineId : "");
  }
  return byRank;
}

/**
 * Collects the Demiplane engine ids of prepared slots the character has cast.
 * Demiplane marks a cast slot with a `<preparedEngineId>-is-cast` custom engine
 * set to 1; an uncast slot has no such engine. The returned ids are matched
 * against each prepared engine's `demiplaneEngineId` to set the slot's expended
 * state on import.
 */
function collectCastEngineIds(engines: DemiplaneEngineEntry[]): Set<string> {
  const castIds = new Set<string>();
  for (const eng of engines) {
    if (eng.type !== "CustomDemiplaneEngine") continue;
    if (!eng.name?.endsWith(IS_CAST_SUFFIX)) continue;
    if (eng.value !== 1) continue;
    castIds.add(eng.name.slice(0, -IS_CAST_SUFFIX.length));
  }
  return castIds;
}

function buildPreparedSlotsUpdate(
  preparedEngines: DemiplaneEngineEntry[],
  slugToId: Map<string, string>,
  castIds: Set<string>
): Record<string, { prepared: PreparedSlot[] }> {
  const slotsByRank = new Map<number, PreparedSlot[]>();

  for (const eng of preparedEngines) {
    const slug = eng.args?.slug as string;
    if (!slug) continue;

    const rank = (eng.args?.selectionRank as number) ?? 0;
    const spellId = slugToId.get(toFoundrySlug(slug)) ?? null;
    // A prepared slot is expended when its engine carries the is-cast flag.
    const expended = typeof eng.demiplaneEngineId === "string" && castIds.has(eng.demiplaneEngineId);

    if (!slotsByRank.has(rank)) {
      slotsByRank.set(rank, []);
    }
    slotsByRank.get(rank)!.push({ id: spellId, expended });
  }

  const slotsUpdate: Record<string, { prepared: PreparedSlot[] }> = {};
  for (const [rank, prepared] of slotsByRank) {
    slotsUpdate[`slot${String(rank)}`] = { prepared };
  }
  return slotsUpdate;
}

/**
 * Prepared spells must also exist as spell items in the entry. For casters that
 * only emit `isPrepare` spells (e.g. cleric), the spellbook pass adds nothing,
 * so resolve and add any missing spell items here before placing them in slots.
 */
async function addMissingPreparedItems(
  actor: Actor,
  entryId: string,
  preparedEngines: DemiplaneEngineEntry[],
  slugToId: Map<string, string>,
  summary: ImportSummary
): Promise<void> {
  const alreadyPresent = new Set(slugToId.keys());
  const missing = await resolveSpellItems(preparedEngines, entryId, summary, {
    logLabel: "prepared",
    seen: alreadyPresent,
  });

  if (missing.length === 0) return;

  const created = await createSpellItems(actor, missing);
  for (const [slug, id] of created) {
    slugToId.set(slug, id);
  }
  summary.log.push(`+ prepared: ${String(missing.length)} spells added to entry`);
}

export async function markSignatureSpells(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  slugToId: Map<string, string>,
  spellbookEngines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const signatureIds = collectSignatureEngineIds(engines);
  if (signatureIds.size === 0) return;

  const signatureSlugs = resolveSignatureSlugs(spellbookEngines, signatureIds);
  if (signatureSlugs.size === 0) return;

  const updates = buildSignatureUpdates(signatureSlugs, slugToId);
  if (updates.length === 0) return;

  await actor.updateEmbeddedDocuments("Item", updates);
  summary.log.push(`+ signature: ${String(updates.length)} spells marked as signature`);
  debugLog(`[signature] Marked ${String(updates.length)} signature spells`);
}

function collectSignatureEngineIds(engines: DemiplaneEngineEntry[]): Set<string> {
  const signatureIds = new Set<string>();
  for (const eng of engines) {
    if (eng.type !== "CustomDemiplaneEngine") continue;
    if (!eng.name?.endsWith(SIGNATURE_SUFFIX)) continue;
    if (eng.value !== 1) continue;

    signatureIds.add(eng.name.slice(0, -SIGNATURE_SUFFIX.length));
  }
  return signatureIds;
}

function resolveSignatureSlugs(spellbookEngines: DemiplaneEngineEntry[], signatureIds: Set<string>): Set<string> {
  const signatureSlugs = new Set<string>();
  for (const eng of spellbookEngines) {
    const demiplaneId = eng.demiplaneEngineId as string | undefined;
    if (demiplaneId && signatureIds.has(demiplaneId)) {
      signatureSlugs.add(toFoundrySlug(eng.args?.slug as string));
    }
  }
  return signatureSlugs;
}

function buildSignatureUpdates(
  signatureSlugs: Set<string>,
  slugToId: Map<string, string>
): Array<{ _id: string; "system.location.signature": boolean }> {
  const updates: Array<{ _id: string; "system.location.signature": boolean }> = [];
  for (const slug of signatureSlugs) {
    const itemId = slugToId.get(slug);
    if (itemId) {
      updates.push({ _id: itemId, "system.location.signature": true });
    }
  }
  return updates;
}
