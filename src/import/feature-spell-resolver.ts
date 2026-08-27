import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { stampImported } from "./types.js";
import { debugLog } from "./debug-log.js";
import { toFoundrySlug } from "./slug-utils.js";

const STREAM_ENGINES_URL = "https://character.demiplane.com/stream-engines";

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

interface SpellModifier {
  type: "add-spell";
  level: number;
  addSpell: string;
  tradition: string;
  isInnate?: boolean;
  spellLevel?: number;
  parentFeature?: string;
  autoScaleSpellLevel?: boolean;
}

interface FocusPointModifier {
  type: "add-focus-point";
  addFocus: number;
}

type FeatureModifier = SpellModifier | FocusPointModifier;

async function fetchFeatureModifiers(engineIds: string[]): Promise<FeatureModifier[]> {
  try {
    const response = await fetch(STREAM_ENGINES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engineIdsBySource: { "pathfinder2e-v2": engineIds },
        isSheet: true,
        nexusSlug: "pathfinder2e",
      }),
    });

    if (!response.ok) return [];

    const text = await response.text();
    return parseModifiersFromNdjson(text);
  } catch {
    return [];
  }
}

function parseModifiersFromNdjson(ndjsonText: string): FeatureModifier[] {
  const lines = ndjsonText.split("\n").filter((line) => line.trim());
  const modifiers: FeatureModifier[] = [];

  for (const line of lines) {
    modifiers.push(...extractModifiersFromLine(line));
  }

  return modifiers;
}

interface EngineNode {
  name: string;
  data?: { string?: string };
}

function extractModifiersFromLine(line: string): FeatureModifier[] {
  try {
    const parsed = JSON.parse(line) as { data?: { nodes?: Record<string, EngineNode> } };
    const nodes = Object.values(parsed.data?.nodes ?? {});

    for (const node of nodes) {
      if (node.name !== "StringObject" || !node.data?.string) continue;

      const results = extractModifiersFromStringNode(node.data.string);
      if (results.length > 0) return results;
    }
  } catch {
    // Skip malformed lines
  }

  return [];
}

function extractModifiersFromStringNode(jsonString: string): FeatureModifier[] {
  try {
    const obj = JSON.parse(jsonString) as {
      engineModifiers?: Array<Record<string, unknown>>;
    };

    if (!obj.engineModifiers) return [];

    const results: FeatureModifier[] = [];

    for (const mod of obj.engineModifiers) {
      if (mod.type === "add-spell" && typeof mod.addSpell === "string") {
        results.push(mod as unknown as SpellModifier);
      }
      if (mod.type === "add-focus-point" && typeof mod.addFocus === "number") {
        results.push(mod as unknown as FocusPointModifier);
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ─── Categorization ──────────────────────────────────────────────────────────

function categorizeGrantedSpells(
  modifiers: FeatureModifier[],
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

// ─── Apply to Actor ──────────────────────────────────────────────────────────

type PackIndex = Array<{ _id: string; system?: { slug?: string } }>;

async function resolveSpellFromCompendium(slug: string): Promise<Record<string, unknown> | null> {
  if (!game.packs) return null;
  const pack = game.packs.get("pf2e.spells-srd");
  if (!pack) return null;
  const index = (await pack.getIndex({ fields: ["system.slug"] } as never)) as unknown as PackIndex;
  const foundrySlug = toFoundrySlug(slug);
  const match = index.find((i) => i.system?.slug === foundrySlug);
  if (!match) return null;
  const doc = await pack.getDocument(match._id);
  return doc ? (doc as { toObject: () => Record<string, unknown> }).toObject() : null;
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
