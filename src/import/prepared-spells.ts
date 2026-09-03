import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { toFoundrySlug } from "./slug-utils.js";
import { debugLog } from "./debug-log.js";
import { resolveSpellItems, createSpellItems } from "./spellcasting-entry.js";

const SIGNATURE_SUFFIX = "-spell-is-signature";

type PreparedSlot = { id: string | null; expended: boolean };

export async function placePreparedSpells(
  actor: Actor,
  entryId: string,
  preparedEngines: DemiplaneEngineEntry[],
  slugToId: Map<string, string>,
  summary: ImportSummary
): Promise<void> {
  if (preparedEngines.length === 0) return;

  await addMissingPreparedItems(actor, entryId, preparedEngines, slugToId, summary);

  const slotsUpdate = buildPreparedSlotsUpdate(preparedEngines, slugToId);

  debugLog(`[prepared] Placing ${String(preparedEngines.length)} prepared spells in entry ${entryId}`);

  const entry = actor.items.get(entryId);
  if (entry) {
    await entry.update({ system: { slots: slotsUpdate } });
    summary.log.push(`+ prepared: ${String(preparedEngines.length)} spells placed in slots`);
  }
}

function buildPreparedSlotsUpdate(
  preparedEngines: DemiplaneEngineEntry[],
  slugToId: Map<string, string>
): Record<string, { prepared: PreparedSlot[] }> {
  const slotsByRank = new Map<number, PreparedSlot[]>();

  for (const eng of preparedEngines) {
    const slug = eng.args?.slug as string;
    if (!slug) continue;

    const rank = (eng.args?.selectionRank as number) ?? 0;
    const spellId = slugToId.get(toFoundrySlug(slug)) ?? null;

    if (!slotsByRank.has(rank)) {
      slotsByRank.set(rank, []);
    }
    slotsByRank.get(rank)!.push({ id: spellId, expended: false });
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
