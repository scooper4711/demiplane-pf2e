import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { toFoundrySlug } from "./slug-utils.js";
import { createEntry, resolveSpellItems, createSpellItems } from "./spellcasting-entry.js";

const FONT_ENTRY_NAME = "Divine Font (Healing)";
const DEFAULT_FONT_SLUG = "heal";

/**
 * Imports Divine Font spells (e.g. cleric heal/harm) into a dedicated
 * "Divine Font (Healing)" spellcasting entry. Demiplane represents these as
 * spell engines with `args.spellSlot === "divine-font"`; they are grouped
 * separately so they don't land in the regular prepared-spell slots.
 */
export async function importFontSpells(
  actor: Actor,
  fontEngines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<number> {
  if (fontEngines.length === 0) return 0;

  const entryId = await createEntry(actor, FONT_ENTRY_NAME, "divine", "spontaneous", "wis");
  const slugToId = await addFontSpells(actor, entryId, fontEngines, summary);
  await placeFontSlots(actor, entryId, fontEngines, slugToId, summary);
  return slugToId.size;
}

async function addFontSpells(
  actor: Actor,
  entryId: string,
  fontEngines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<Map<string, string>> {
  const items = await resolveSpellItems(fontEngines, entryId, summary, {
    logLabel: "divine font",
    extras: (eng) => ({
      heightenedLevel: (eng.args?.selectionRank as number) ?? 1,
      signature: true,
    }),
  });
  return createSpellItems(actor, items);
}

async function placeFontSlots(
  actor: Actor,
  entryId: string,
  fontEngines: DemiplaneEngineEntry[],
  slugToId: Map<string, string>,
  summary: ImportSummary
): Promise<void> {
  const healSlug = toFoundrySlug((fontEngines[0]?.args?.slug as string) ?? DEFAULT_FONT_SLUG);
  const healId = slugToId.get(healSlug) ?? null;
  const count = fontEngines.length;

  const slots = Array.from({ length: count }, () => ({ id: healId, expended: false }));
  const slotsUpdate = {
    slot0: { max: 0, value: 0, prepared: [] as Array<{ id: string | null; expended: boolean }> },
    slot1: { max: count, value: count, prepared: slots },
  };

  const entry = actor.items.get(entryId);
  if (entry) {
    await entry.update({ system: { slots: slotsUpdate } });
    summary.log.push(`+ divine font: ${String(count)} ${FONT_ENTRY_NAME} slots`);
  }
}
