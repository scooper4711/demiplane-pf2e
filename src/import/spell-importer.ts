import { stampImported, MODULE_ID } from "./types.js";
import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { debugLog } from "./debug-log.js";
import { toFoundrySlug } from "./slug-utils.js";
import { findSpellEngines, isCurriculumSpell } from "./spell-engines.js";
import { resolveSpellSlots } from "./spell-slot-resolver.js";

interface SpellcastingConfig {
  tradition: string;
  preparedType: "spontaneous" | "prepared";
  ability: string;
}

const CLASS_SPELLCASTING: Record<string, SpellcastingConfig> = {
  "sorcerer-spellcasting-rm": { tradition: "arcane", preparedType: "spontaneous", ability: "cha" },
  "wizard-spellcasting-rm": { tradition: "arcane", preparedType: "prepared", ability: "int" },
  "bard-spellcasting-rm": { tradition: "occult", preparedType: "spontaneous", ability: "cha" },
  "cleric-spellcasting-rm": { tradition: "divine", preparedType: "prepared", ability: "wis" },
  "druid-spellcasting-rm": { tradition: "primal", preparedType: "prepared", ability: "wis" },
  "oracle-spellcasting-rm": { tradition: "divine", preparedType: "spontaneous", ability: "cha" },
  "witch-spellcasting-rm": { tradition: "occult", preparedType: "prepared", ability: "int" },
  "psychic-spellcasting-rm": { tradition: "occult", preparedType: "spontaneous", ability: "cha" },
};

type PackIndex = Array<{ _id: string; system?: { slug?: string } }>;

function getPacks(): NonNullable<typeof game.packs> {
  if (!game.packs) throw new Error("game.packs unavailable — import called before ready");
  return game.packs;
}

async function resolveSpell(slug: string): Promise<Record<string, unknown> | null> {
  const pack = getPacks().get("pf2e.spells-srd");
  if (!pack) return null;
  const index = (await pack.getIndex({ fields: ["system.slug"] } as never)) as unknown as PackIndex;
  const foundrySlug = toFoundrySlug(slug);
  const match = index.find((i) => i.system?.slug === foundrySlug);
  if (!match) return null;
  const doc = await pack.getDocument(match._id);
  return doc ? (doc as { toObject: () => Record<string, unknown> }).toObject() : null;
}

// ─── Grouping ────────────────────────────────────────────────────────────────

interface SpellGroup {
  source: string;
  config: SpellcastingConfig | null;
  spellbook: DemiplaneEngineEntry[];
  curriculumSpellbook: DemiplaneEngineEntry[];
  prepared: DemiplaneEngineEntry[];
  curriculumPrepared: DemiplaneEngineEntry[];
}

function groupSpells(engines: DemiplaneEngineEntry[]): {
  main: SpellGroup[];
  innate: DemiplaneEngineEntry[];
} {
  const spellEngines = findSpellEngines(engines);
  const mainGroups = new Map<string, SpellGroup>();
  const innateSpells: DemiplaneEngineEntry[] = [];

  for (const eng of spellEngines) {
    const parentFeature = eng.args?.parentSpellFeature as string | undefined;
    const sourceType = eng.args?.sourceType as string | undefined;
    const isPrepare = eng.args?.isPrepare === true;

    if (sourceType === "select-spell") {
      innateSpells.push(eng);
      continue;
    }

    if (!parentFeature || parentFeature === "scroll") continue;

    if (!mainGroups.has(parentFeature)) {
      mainGroups.set(parentFeature, {
        source: parentFeature,
        config: CLASS_SPELLCASTING[parentFeature] ?? null,
        spellbook: [],
        curriculumSpellbook: [],
        prepared: [],
        curriculumPrepared: [],
      });
    }

    const group = mainGroups.get(parentFeature)!;
    const isCurriculum = isCurriculumSpell(eng);

    if (isPrepare) {
      if (isCurriculum) {
        group.curriculumPrepared.push(eng);
      } else {
        group.prepared.push(eng);
      }
    } else {
      if (isCurriculum) {
        group.curriculumSpellbook.push(eng);
      }
      // All spellbook spells go into main spellbook (curriculum spells appear in both)
      group.spellbook.push(eng);
    }
  }

  return { main: [...mainGroups.values()], innate: innateSpells };
}

// ─── Entry Creation ──────────────────────────────────────────────────────────

async function createEntry(
  actor: Actor,
  name: string,
  tradition: string,
  preparedType: string,
  ability: string
): Promise<string> {
  const created = await actor.createEmbeddedDocuments("Item", [
    stampImported({
      name,
      type: "spellcastingEntry",
      system: {
        prepared: { value: preparedType },
        tradition: { value: tradition },
        proficiency: { value: 1 },
        ability: { value: ability },
        showSlotlessLevels: { value: false },
      },
    }),
  ] as never);
  return (created[0] as { id: string }).id;
}

// ─── Spell Addition ──────────────────────────────────────────────────────────

async function addSpells(
  actor: Actor,
  entryId: string,
  spellEngines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<Map<string, string>> {
  const slugToId = new Map<string, string>();
  const spellItems: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const eng of spellEngines) {
    const slug = eng.args?.slug as string;
    if (!slug) continue;

    const foundrySlug = toFoundrySlug(slug);
    if (seen.has(foundrySlug)) continue;
    seen.add(foundrySlug);

    const spellData = await resolveSpell(slug);
    if (!spellData) {
      summary.log.push(`- spell: ${foundrySlug} (not found)`);
      continue;
    }

    (spellData as { system: Record<string, unknown> }).system.location = { value: entryId };
    spellItems.push(stampImported(spellData));
  }

  if (spellItems.length > 0) {
    const created = await actor.createEmbeddedDocuments("Item", spellItems as never);
    for (const item of created as Array<{ id: string; system: { slug: string } }>) {
      slugToId.set(item.system.slug, item.id);
    }
  }

  return slugToId;
}

// ─── Prepared Spell Placement ────────────────────────────────────────────────

async function placePreparedSpells(
  actor: Actor,
  entryId: string,
  preparedEngines: DemiplaneEngineEntry[],
  slugToId: Map<string, string>,
  summary: ImportSummary
): Promise<void> {
  if (preparedEngines.length === 0) return;

  const slotsByRank = new Map<number, Array<{ id: string | null; expended: boolean }>>();

  for (const eng of preparedEngines) {
    const slug = eng.args?.slug as string;
    if (!slug) continue;

    const rank = (eng.args?.selectionRank as number) ?? 0;
    const foundrySlug = toFoundrySlug(slug);
    const spellId = slugToId.get(foundrySlug) ?? null;

    if (!slotsByRank.has(rank)) {
      slotsByRank.set(rank, []);
    }
    slotsByRank.get(rank)!.push({ id: spellId, expended: false });
  }

  const slotsUpdate: Record<string, { prepared: Array<{ id: string | null; expended: boolean }> }> = {};
  for (const [rank, prepared] of slotsByRank) {
    slotsUpdate[`slot${String(rank)}`] = { prepared };
  }

  debugLog(`[prepared] Placing ${String(preparedEngines.length)} prepared spells in entry ${entryId}`);

  const entry = actor.items.get(entryId);
  if (entry) {
    await entry.update({ system: { slots: slotsUpdate } } as never);
    summary.log.push(`+ prepared: ${String(preparedEngines.length)} spells placed in slots`);
  }
}

// ─── Signature Spells ────────────────────────────────────────────────────────

async function markSignatureSpells(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  slugToId: Map<string, string>,
  spellbookEngines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const signatureIds = new Set<string>();

  for (const eng of engines) {
    if (eng.type !== "CustomDemiplaneEngine") continue;
    if (!eng.name?.endsWith("-spell-is-signature")) continue;
    if (eng.value !== 1) continue;

    const demiplaneId = eng.name.slice(0, -"-spell-is-signature".length);
    signatureIds.add(demiplaneId);
  }

  if (signatureIds.size === 0) return;

  // Map demiplaneEngineId → foundry slug
  const signatureSlugs = new Set<string>();
  for (const eng of spellbookEngines) {
    const demiplaneId = eng.demiplaneEngineId as string | undefined;
    if (demiplaneId && signatureIds.has(demiplaneId)) {
      signatureSlugs.add(toFoundrySlug(eng.args?.slug as string));
    }
  }

  if (signatureSlugs.size === 0) return;

  // Update each signature spell item
  const updates: Array<{ _id: string; "system.location.signature": boolean }> = [];
  for (const slug of signatureSlugs) {
    const itemId = slugToId.get(slug);
    if (itemId) {
      updates.push({ _id: itemId, "system.location.signature": true });
    }
  }

  if (updates.length > 0) {
    await actor.updateEmbeddedDocuments("Item", updates as never);
    summary.log.push(`+ signature: ${String(updates.length)} spells marked as signature`);
    debugLog(`[signature] Marked ${String(updates.length)} signature spells`);
  }
}

// ─── Curriculum Entry ────────────────────────────────────────────────────────

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

// ─── Main Orchestrator ───────────────────────────────────────────────────────

export async function applySpells(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const { main, innate } = groupSpells(engines);
  if (main.length === 0 && innate.length === 0) return;

  let totalAdded = 0;

  for (const group of main) {
    totalAdded += await importSpellGroup(actor, group, engines, summary);
  }

  if (innate.length > 0) {
    totalAdded += await importInnateSpells(actor, innate, main, engines, summary);
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

  await applySlotMaximums(actor, entryId, engines, group.source, "wizard-school-spellbook-slot", summary);

  if (group.curriculumPrepared.length > 0) {
    await placePreparedSpells(actor, entryId, group.curriculumPrepared, slugToId, summary);
  }

  return slugToId.size;
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
  // Try to find the feat that granted these innate spells
  // sourceRow contains the parent engine ID followed by the feat slug
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

// ─── Slot Maximums ───────────────────────────────────────────────────────────

async function applySlotMaximums(
  actor: Actor,
  entryId: string,
  engines: DemiplaneEngineEntry[],
  parentSpellFeature: string,
  slotSlug: string,
  summary: ImportSummary
): Promise<void> {
  const engineId = findEngineIdForSlots(engines, slotSlug);
  if (!engineId) {
    debugLog(`[spell-slots] No engine found for slot resolution, skipping`);
    return;
  }

  const label = slotSlug ? `curriculum (${slotSlug})` : "regular";
  debugLog(`[spell-slots] Resolving ${label} slots for feature="${parentSpellFeature}", engineId="${engineId}"`);

  try {
    const progression = await resolveSpellSlots({
      classEngineId: engineId,
      characterLevel: getCharacterLevel(engines),
      engines,
      parentSpellFeature,
      slotSlug,
    });

    debugLog(
      `[spell-slots] Resolved: cantrips=${String(progression.cantrips)}, slots=${JSON.stringify(progression.slots)}`
    );

    const slotsUpdate = buildSlotsUpdate(progression);
    const entry = actor.items.get(entryId);
    if (entry) {
      await entry.update({ system: { slots: slotsUpdate } } as never);
      summary.log.push(
        `+ spell-slots (${label}): cantrips=${String(progression.cantrips)}, ${Object.entries(progression.slots)
          .map(([r, c]) => `rank${r}=${String(c)}`)
          .join(", ")}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${MODULE_ID} | [spell-slots] Failed to resolve ${label} slots: ${message}`);
    summary.log.push(`! spell-slots: failed to resolve ${label} (${message})`);
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function getCharacterLevel(engines: DemiplaneEngineEntry[]): number {
  const levelEngine = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === "character_level");
  return Number(levelEngine?.value) || 1;
}

/**
 * Finds the correct engine ID for slot resolution.
 * For regular slots: use the class engine.
 * For curriculum slots: use the school class-feature engine.
 */
function findEngineIdForSlots(engines: DemiplaneEngineEntry[], slotSlug: string): string | null {
  if (slotSlug) {
    // Curriculum: find the school class-feature engine
    const schoolEngine = engines.find(
      (e) => e.type === "DemiplaneEngine" && e.name?.startsWith("tabula/class-feature/school-")
    );
    return (schoolEngine?.id as string) ?? null;
  }

  // Regular: use the class engine
  const classEngine = engines.find((e) => e.name?.startsWith("tabula/class/"));
  return (classEngine?.id as string) ?? null;
}

function buildSlotsUpdate(progression: {
  cantrips: number;
  slots: Record<number, number>;
}): Record<string, { max: number; value: number }> {
  const update: Record<string, { max: number; value: number }> = {};
  update.slot0 = { max: progression.cantrips, value: progression.cantrips };

  for (const [rank, count] of Object.entries(progression.slots)) {
    update[`slot${rank}`] = { max: count, value: count };
  }

  return update;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/*
 * Note: On import, spell slot value is set to max (all slots available).
 * Demiplane tracks remaining slots as session state — import of that value
 * and export back to Demiplane is a future enhancement.
 */
