import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { groupSpells } from "./spell-grouping.js";
import type { SpellGroup } from "./spell-grouping.js";
import type { FocusSelection } from "./spell-grouping.js";
import { createEntry, addSpells, capitalize, resolveSpellItems, createSpellItems } from "./spellcasting-entry.js";
import { placePreparedSpells, markSignatureSpells } from "./prepared-spells.js";
import { importFontSpells } from "./divine-font.js";
import { applySlotMaximums } from "./spell-slots.js";

const CURRICULUM_SLOT_SLUG = "wizard-school-spellbook-slot";

export async function applySpells(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary,
  cacheEngineIds: string[] = []
): Promise<void> {
  const { main, innate, focus, font, rituals } = groupSpells(engines);
  if (main.length === 0 && innate.length === 0 && focus.length === 0 && font.length === 0 && rituals.length === 0)
    return;

  let totalAdded = 0;

  for (const group of main) {
    totalAdded += await importSpellGroup(actor, group, engines, summary, cacheEngineIds);
  }

  if (innate.length > 0) {
    totalAdded += await importInnateSpells(actor, innate, main, engines, summary);
  }

  for (const selection of focus) {
    totalAdded += await importFocusSelection(actor, selection, summary);
  }

  if (font.length > 0) {
    totalAdded += await importFontSpells(actor, font, summary);
  }

  if (rituals.length > 0) {
    totalAdded += await importRituals(actor, rituals, summary);
  }

  if (totalAdded > 0) {
    summary.log.push(`+ spells: ${String(totalAdded)} spells across entries`);
  }
}

/**
 * Imports the character's known rituals. A ritual isn't part of any class
 * spellcasting entry: PF2e builds an ephemeral "Rituals" entry from the actor's
 * ritual-trait spells, so each ritual is created as a plain spell item with no
 * `location` entry (`value: null`). Resolution is the same compendium lookup as
 * any spell — the compendium item already carries the `ritual` block that makes
 * PF2e treat it as one.
 */
async function importRituals(actor: Actor, rituals: DemiplaneEngineEntry[], summary: ImportSummary): Promise<number> {
  const items = await resolveSpellItems(rituals, null, summary, { logLabel: "ritual" });
  const created = await createSpellItems(actor, items);
  return created.size;
}

/** Suffix Demiplane appends to a class's spellcasting-feature slug. */
const SPELLCASTING_SUFFIX = "-spellcasting-rm";
/** Bare variant (no -rm) Demiplane uses for newer features, e.g. psychic. */
const BARE_SPELLCASTING_SUFFIX = "-spellcasting";

/**
 * Names the main class spellcasting entry after its class and tradition, e.g.
 * `bard-spellcasting-rm` + `occult` -> "Bard Spells (Occult)". Falls back to the
 * tradition alone when the source slug isn't a recognizable class feature.
 */
export function deriveClassEntryName(source: string, tradition: string): string {
  let className = "";
  if (source.endsWith(SPELLCASTING_SUFFIX)) {
    className = capitalize(source.slice(0, -SPELLCASTING_SUFFIX.length));
  } else if (source.endsWith(BARE_SPELLCASTING_SUFFIX)) {
    className = capitalize(source.slice(0, -BARE_SPELLCASTING_SUFFIX.length));
  }
  const traditionLabel = capitalize(tradition);
  return className !== "" ? `${className} Spells (${traditionLabel})` : `${traditionLabel} Spells`;
}

async function importSpellGroup(
  actor: Actor,
  group: SpellGroup,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary,
  cacheEngineIds: string[] = []
): Promise<number> {
  if (!group.config) {
    // Unknown spellcasting feature (e.g. a new Demiplane dedication granting
    // spells through its own `parentSpellFeature`). Skipping silently would
    // lose the player's spells without a trace, so surface it as a sync error
    // naming the source and the skipped spells.
    const slugs = [...group.spellbook, ...group.prepared, ...group.curriculumSpellbook, ...group.curriculumPrepared]
      .map((eng) => String(eng.args?.slug ?? "?"))
      .filter((slug, index, all) => all.indexOf(slug) === index);
    summary.errors.push(
      `Unknown spellcasting source "${group.source}" — skipped ${String(slugs.length)} spell(s) (${slugs.join(", ")}). ` +
        `The importer doesn't recognize this Demiplane spellcasting feature yet.`
    );
    return 0;
  }

  const { tradition, preparedType, ability } = group.config;
  let totalAdded = 0;

  // Main spellcasting entry, e.g. "Sorcerer Spells (Arcane)".
  const entryName = deriveClassEntryName(group.source, tradition);
  const entryId = await createEntry(actor, entryName, tradition, preparedType, ability);
  const slugToId = await addSpells(actor, entryId, group.spellbook, summary);
  totalAdded += slugToId.size;

  const hasRankedSlots = await applySlotMaximums(actor, entryId, engines, group.source, "", summary, cacheEngineIds);

  if (preparedType === "prepared") {
    await placePreparedSpells(actor, entryId, group.prepared, slugToId, engines, summary);
  }

  if (preparedType === "spontaneous") {
    await markSignatureSpells(actor, engines, slugToId, group.spellbook, summary);
  }

  flagMissingSlots(hasRankedSlots, group, summary);

  // Curriculum entry (wizard only)
  if (group.curriculumSpellbook.length > 0) {
    totalAdded += await importCurriculumSpells(actor, group, engines, summary, cacheEngineIds);
  }

  return totalAdded;
}

/**
 * Flags a class entry that has *ranked* (rank >= 1) spells but no ranked slots
 * to cast them — the class definition carries no slot progression (e.g.
 * summoner) and no player override fills the gap, so the spells are present but
 * uncastable. Loud (a sync error telling the GM to set slot overrides on
 * Demiplane) rather than a sheet that looks fine until cast time.
 *
 * A cantrip-only entry is never flagged: cantrips are at-will and need no
 * ranked slot. `hasRankedSlots` comes straight from slot resolution, so this
 * reads the computed result rather than round-tripping through the item.
 */
function flagMissingSlots(hasRankedSlots: boolean, group: SpellGroup, summary: ImportSummary): void {
  if (hasRankedSlots) return;
  if (!hasRankedSpells(group)) return;
  summary.errors.push(
    `Class "${group.source}" has spells but no spell slots in Demiplane's data. ` +
      `If the sheet shows slots, set them as builder overrides — Demiplane only records values changed from the shown default — and re-import.`
  );
}

/** Whether a group holds any rank >= 1 spell (cantrips alone need no slots). */
function hasRankedSpells(group: SpellGroup): boolean {
  return [...group.spellbook, ...group.prepared].some((eng) => ((eng.args?.selectionRank as number) ?? 0) >= 1);
}

async function importCurriculumSpells(
  actor: Actor,
  group: SpellGroup,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary,
  cacheEngineIds: string[] = []
): Promise<number> {
  const { tradition, preparedType, ability } = group.config!;
  const schoolName = getSchoolName(engines) ?? "Curriculum";
  const entryName = `${schoolName} Curriculum Spells`;
  const entryId = await createEntry(actor, entryName, tradition, preparedType, ability);
  const slugToId = await addSpells(actor, entryId, group.curriculumSpellbook, summary);

  await applySlotMaximums(actor, entryId, engines, group.source, CURRICULUM_SLOT_SLUG, summary, cacheEngineIds);

  if (group.curriculumPrepared.length > 0) {
    await placePreparedSpells(actor, entryId, group.curriculumPrepared, slugToId, engines, summary);
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

/**
 * Imports one group of player-selected focus spells (a witch's hexes, a
 * champion's devotion spells, a monk's qi spells, a ranger's warden spells)
 * into its focus entry. PF2e derives the focus-pool size from the number of
 * spells here. Feature-granted focus spells join the same entry later via
 * {@link applyFeatureGrantedSpells} whenever the entry name matches (e.g. the
 * witch's "Hexes").
 */
async function importFocusSelection(actor: Actor, selection: FocusSelection, summary: ImportSummary): Promise<number> {
  const entryId = await createEntry(actor, selection.entryName, selection.tradition, "focus", selection.ability);
  const slugToId = await addSpells(actor, entryId, selection.engines, summary);
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
