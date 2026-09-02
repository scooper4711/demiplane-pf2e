import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { groupSpells } from "./spell-grouping.js";
import type { SpellGroup } from "./spell-grouping.js";
import { createEntry, addSpells, capitalize } from "./spellcasting-entry.js";
import { placePreparedSpells, markSignatureSpells } from "./prepared-spells.js";
import { importFontSpells } from "./divine-font.js";
import { applySlotMaximums } from "./spell-slots.js";

const CURRICULUM_SLOT_SLUG = "wizard-school-spellbook-slot";

export async function applySpells(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const { main, innate, font } = groupSpells(engines);
  if (main.length === 0 && innate.length === 0 && font.length === 0) return;

  let totalAdded = 0;

  for (const group of main) {
    totalAdded += await importSpellGroup(actor, group, engines, summary);
  }

  if (innate.length > 0) {
    totalAdded += await importInnateSpells(actor, innate, main, engines, summary);
  }

  if (font.length > 0) {
    totalAdded += await importFontSpells(actor, font, summary);
  }

  if (totalAdded > 0) {
    summary.log.push(`+ spells: ${String(totalAdded)} spells across entries`);
  }
}

async function importSpellGroup(
  actor: Actor,
  group: SpellGroup,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<number> {
  if (!group.config) {
    summary.log.push(`! spells: unknown source "${group.source}", skipping ${String(group.spellbook.length)} spells`);
    return 0;
  }

  const { tradition, preparedType, ability } = group.config;
  let totalAdded = 0;

  // Main spellcasting entry
  const entryName = `${capitalize(tradition)} ${capitalize(preparedType)} Spells`;
  const entryId = await createEntry(actor, entryName, tradition, preparedType, ability);
  const slugToId = await addSpells(actor, entryId, group.spellbook, summary);
  totalAdded += slugToId.size;

  await applySlotMaximums(actor, entryId, engines, group.source, "", summary);

  if (preparedType === "prepared") {
    await placePreparedSpells(actor, entryId, group.prepared, slugToId, summary);
  }

  if (preparedType === "spontaneous") {
    await markSignatureSpells(actor, engines, slugToId, group.spellbook, summary);
  }

  // Curriculum entry (wizard only)
  if (group.curriculumSpellbook.length > 0) {
    totalAdded += await importCurriculumSpells(actor, group, engines, summary);
  }

  return totalAdded;
}

async function importCurriculumSpells(
  actor: Actor,
  group: SpellGroup,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<number> {
  const { tradition, preparedType, ability } = group.config!;
  const schoolName = getSchoolName(engines) ?? "Curriculum";
  const entryName = `${schoolName} Curriculum Spells`;
  const entryId = await createEntry(actor, entryName, tradition, preparedType, ability);
  const slugToId = await addSpells(actor, entryId, group.curriculumSpellbook, summary);

  await applySlotMaximums(actor, entryId, engines, group.source, CURRICULUM_SLOT_SLUG, summary);

  if (group.curriculumPrepared.length > 0) {
    await placePreparedSpells(actor, entryId, group.curriculumPrepared, slugToId, summary);
  }

  return slugToId.size;
}

function getSchoolName(engines: DemiplaneEngineEntry[]): string | null {
  const schoolEngine = engines.find(
    (e) => e.name?.startsWith("tabula/class-feature/school-of-") || e.name?.startsWith("tabula/class-feature/school-")
  );
  if (!schoolEngine) return null;
  const name = schoolEngine.args?.name as string | undefined;
  if (!name) return null;
  // "School of Ars Grammatica" → "Ars Grammatica"
  return name.replace(/^School of /i, "");
}

async function importInnateSpells(
  actor: Actor,
  innate: DemiplaneEngineEntry[],
  main: SpellGroup[],
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<number> {
  const classConfig = main[0]?.config;
  const entryName = deriveInnateEntryName(innate, engines);
  const entryId = await createEntry(
    actor,
    entryName,
    classConfig?.tradition ?? "arcane",
    "innate",
    classConfig?.ability ?? "cha"
  );
  const slugToId = await addSpells(actor, entryId, innate, summary);
  return slugToId.size;
}

function deriveInnateEntryName(innate: DemiplaneEngineEntry[], engines: DemiplaneEngineEntry[]): string {
  // Try to find the feat that granted these innate spells.
  // sourceRow contains the parent engine ID followed by the feat slug.
  const sourceRow = innate[0]?.args?.sourceRow as string | undefined;
  if (!sourceRow) return "Innate Spells";

  // Extract the parent engine ID (first UUID in the sourceRow)
  const parentId = sourceRow.split("_")[0];
  if (!parentId) return "Innate Spells";

  // Find the feat engine that matches
  const feat = engines.find((e) => e.type === "DemiplaneEngine" && e.demiplaneEngineId === parentId && e.args?.name);

  if (feat?.args?.name) return `${feat.args.name as string} (Innate)`;
  return "Innate Spells";
}

/*
 * Note: On import, spell slot value is set to max (all slots available).
 * Demiplane tracks remaining slots as session state — import of that value
 * and export back to Demiplane is a future enhancement.
 */
