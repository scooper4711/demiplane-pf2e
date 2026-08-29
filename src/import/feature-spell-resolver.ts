import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { stampImported } from "./types.js";
import { debugLog } from "./debug-log.js";
import { toFoundrySlug } from "./slug-utils.js";
import { fetchStreamEngineLines, type EngineModifier } from "./stream-engines.js";
import { resolveSpellFromCompendium } from "./compendium-resolver.js";

/** A spell granted by a feature engine (class feature, heritage, feat). */
export interface GrantedSpell {
  slug: string;
  tradition: string;
  level: number;
  isInnate: boolean;
  isFocus: boolean;
  spellLevel: number;
}

/**
 * Fetches feature engines from stream-engines and extracts granted spells.
 * Handles class features, heritage, and ancestry feats.
 */
export async function resolveFeatureGrantedSpells(
  engines: DemiplaneEngineEntry[],
  characterLevel: number
): Promise<{ innate: GrantedSpell[]; focus: GrantedSpell[]; focusPoints: number }> {
  const featureEngineIds = collectFeatureEngineIds(engines);

  if (featureEngineIds.length === 0) {
    return { innate: [], focus: [], focusPoints: 0 };
  }

  const modifiers = await fetchFeatureModifiers(featureEngineIds);
  return categorizeGrantedSpells(modifiers, characterLevel);
}

function collectFeatureEngineIds(engines: DemiplaneEngineEntry[]): string[] {
  const ids: string[] = [];

  for (const eng of engines) {
    if (!eng.id || eng.type !== "DemiplaneEngine") continue;

    const name = eng.name as string;
    if (name.startsWith("tabula/class-feature/") || name.startsWith("tabula/heritage/")) {
      ids.push(eng.id as string);
    }
  }

  return ids;
}

// ─── Stream-Engines Fetch ────────────────────────────────────────────────────

async function fetchFeatureModifiers(engineIds: string[]): Promise<EngineModifier[]> {
  const lines = await fetchStreamEngineLines(engineIds);
  const modifiers: EngineModifier[] = [];
  for (const line of lines) {
    for (const mod of line.modifiers) {
      if (mod.type === "add-spell" || mod.type === "add-focus-point") modifiers.push(mod);
    }
  }
  return modifiers;
}

// ─── Categorization ──────────────────────────────────────────────────────────

function categorizeGrantedSpells(
  modifiers: EngineModifier[],
  characterLevel: number
): { innate: GrantedSpell[]; focus: GrantedSpell[]; focusPoints: number } {
  const innate: GrantedSpell[] = [];
  const focus: GrantedSpell[] = [];
  let focusPoints = 0;

  for (const mod of modifiers) {
    if (mod.type === "add-focus-point") {
      focusPoints += mod.addFocus;
      continue;
    }

    if (mod.type !== "add-spell") continue;
    if (mod.level > characterLevel) continue;

    const spell: GrantedSpell = {
      slug: mod.addSpell,
      tradition: mod.tradition ?? "arcane",
      level: mod.level,
      isInnate: mod.isInnate === true,
      isFocus: mod.isInnate !== true,
      spellLevel: mod.spellLevel ?? 0,
    };

    if (spell.isInnate) {
      innate.push(spell);
    } else {
      focus.push(spell);
    }
  }

  return { innate, focus, focusPoints };
}

/**
 * Applies feature-granted spells (focus and innate) to the actor.
 * Creates spellcasting entries and adds spells from stream-engines data.
 */
export async function applyFeatureGrantedSpells(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const characterLevel = getCharacterLevel(engines);
  const { innate, focus, focusPoints } = await resolveFeatureGrantedSpells(engines, characterLevel);

  debugLog(
    `[feature-spells] Found ${String(innate.length)} innate, ${String(focus.length)} focus spells, ${String(focusPoints)} focus points`
  );

  if (innate.length > 0) {
    await addFeatureInnateSpells(actor, innate, summary);
  }

  if (focus.length > 0) {
    await addFeatureFocusSpells(actor, focus, engines, summary);
  }

  if (focusPoints > 0) {
    await setFocusPool(actor, focusPoints);
    summary.log.push(`+ focus pool: ${String(focusPoints)} points`);
  }
}

async function addFeatureInnateSpells(actor: Actor, spells: GrantedSpell[], summary: ImportSummary): Promise<void> {
  const tradition = spells[0]?.tradition ?? "arcane";
  const entryId = await createFeatureEntry(actor, "Innate Spells", tradition, "innate");

  await addGrantedSpellsToEntry(actor, entryId, spells, summary, "innate");
}

async function addFeatureFocusSpells(
  actor: Actor,
  spells: GrantedSpell[],
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const tradition = spells[0]?.tradition ?? "arcane";
  const entryName = deriveFocusEntryName(engines);
  const entryId = await createFeatureEntry(actor, entryName, tradition, "focus");

  await addGrantedSpellsToEntry(actor, entryId, spells, summary, "focus");
}

function deriveFocusEntryName(engines: DemiplaneEngineEntry[]): string {
  // Look for a school class feature (wizard) or patron (witch) that grants focus spells
  const schoolEngine = engines.find(
    (e) =>
      e.type === "DemiplaneEngine" &&
      (e.name?.startsWith("tabula/class-feature/school-of-") || e.name?.startsWith("tabula/class-feature/school-"))
  );
  if (schoolEngine?.args?.name) {
    const schoolName = (schoolEngine.args.name as string).replace(/^School of /i, "");
    return `${schoolName} Focus Spells`;
  }

  // Witch patron
  const patronEngine = engines.find(
    (e) =>
      e.type === "DemiplaneEngine" && e.name?.startsWith("tabula/class-feature/") && e.args?.sourceRow === "patron-rm"
  );
  if (patronEngine?.args?.name) {
    return `${patronEngine.args.name as string} Focus Spells`;
  }

  return "Focus Spells";
}

async function createFeatureEntry(
  actor: Actor,
  name: string,
  tradition: string,
  preparedType: string
): Promise<string> {
  const created = await actor.createEmbeddedDocuments("Item", [
    stampImported({
      name,
      type: "spellcastingEntry",
      system: {
        prepared: { value: preparedType },
        tradition: { value: tradition },
        proficiency: { value: 1 },
        showSlotlessLevels: { value: false },
      },
    }),
  ] as never);
  return (created[0] as { id: string }).id;
}

async function addGrantedSpellsToEntry(
  actor: Actor,
  entryId: string,
  spells: GrantedSpell[],
  summary: ImportSummary,
  label: string
): Promise<void> {
  const spellItems: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const spell of spells) {
    const foundrySlug = toFoundrySlug(spell.slug);
    if (seen.has(foundrySlug)) continue;
    seen.add(foundrySlug);

    const spellData = await resolveSpellFromCompendium(spell.slug);
    if (!spellData) {
      summary.log.push(`- ${label}: ${foundrySlug} (not found)`);
      summary.unresolved.push(`Could not import spell "${spell.slug}": not found in compendium`);
      continue;
    }

    (spellData as { system: Record<string, unknown> }).system.location = { value: entryId };
    spellItems.push(stampImported(spellData));
  }

  if (spellItems.length > 0) {
    await actor.createEmbeddedDocuments("Item", spellItems as never);
    summary.log.push(`+ ${label}: ${String(spellItems.length)} spells added`);
  }
}

async function setFocusPool(actor: Actor, points: number): Promise<void> {
  await actor.update({
    "system.resources.focus.max": Math.min(points, 3),
    "system.resources.focus.value": Math.min(points, 3),
  } as never);
}

function getCharacterLevel(engines: DemiplaneEngineEntry[]): number {
  const levelEngine = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === "character_level");
  return Number(levelEngine?.value) || 1;
}
