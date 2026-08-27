import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { stampImported } from "./types.js";
import { debugLog } from "./debug-log.js";
import { toFoundrySlug } from "./slug-utils.js";

const STREAM_ENGINES_URL = "https://character.demiplane.com/stream-engines";

interface ItemSpellEntry {
  rank: number;
  spell: string;
}

interface ItemSpellSource {
  itemName: string;
  itemSlug: string;
  engineId: string;
  spells: ItemSpellEntry[];
}

/**
 * Finds staff and wand items on the character, fetches their spell lists
 * from stream-engines, and creates spellcasting entries in Foundry.
 */
export async function applyItemSpells(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const itemEngines = findSpellcastingItems(engines);
  if (itemEngines.length === 0) return;

  const sources = await fetchItemSpellSources(itemEngines);
  if (sources.length === 0) return;

  const tradition = getMainTradition(engines);

  for (const source of sources) {
    await createItemSpellcastingEntry(actor, source, tradition, summary);
  }
}

function findSpellcastingItems(engines: DemiplaneEngineEntry[]): DemiplaneEngineEntry[] {
  return engines.filter((e) => {
    if (e.type !== "DemiplaneEngine") return false;
    if (!e.name?.startsWith("tabula/item/")) return false;
    const slug = (e.args?.slug as string) ?? "";
    return slug.includes("staff") || slug.includes("wand");
  });
}

function getMainTradition(engines: DemiplaneEngineEntry[]): string {
  // Find the main spellcasting feature to determine tradition
  const spellEngine = engines.find((e) => e.name?.startsWith("tabula/spell/") && e.args?.parentSpellFeature);
  const feature = spellEngine?.args?.parentSpellFeature as string | undefined;
  if (!feature) return "arcane";

  const traditions: Record<string, string> = {
    "wizard-spellcasting-rm": "arcane",
    "sorcerer-spellcasting-rm": "arcane",
    "bard-spellcasting-rm": "occult",
    "cleric-spellcasting-rm": "divine",
    "druid-spellcasting-rm": "primal",
    "witch-spellcasting-rm": "occult",
    "oracle-spellcasting-rm": "divine",
    "psychic-spellcasting-rm": "occult",
  };

  return traditions[feature] ?? "arcane";
}

// ─── Stream-Engines Fetch ────────────────────────────────────────────────────

async function fetchItemSpellSources(itemEngines: DemiplaneEngineEntry[]): Promise<ItemSpellSource[]> {
  const engineIds = itemEngines.map((e) => e.id as string);

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
    return parseItemSpellsFromNdjson(text, itemEngines);
  } catch {
    return [];
  }
}

interface EngineNode {
  name: string;
  data?: { string?: string };
}

interface StaffSpellModifier {
  type: "add-staff-spells";
  spells: Array<{ rank: number; spell: string }>;
}

interface WandSpellModifier {
  type: "add-special-item-spell";
  rank: string | number;
  spell: string;
  itemType: string;
}

function parseItemSpellsFromNdjson(ndjsonText: string, itemEngines: DemiplaneEngineEntry[]): ItemSpellSource[] {
  const lines = ndjsonText.split("\n").filter((line) => line.trim());
  const sources: ItemSpellSource[] = [];

  for (const line of lines) {
    const source = extractItemSpellsFromLine(line, itemEngines);
    if (source) sources.push(source);
  }

  return sources;
}

function extractItemSpellsFromLine(line: string, itemEngines: DemiplaneEngineEntry[]): ItemSpellSource | null {
  try {
    const parsed = JSON.parse(line) as { id?: string; data?: { nodes?: Record<string, EngineNode> } };
    const engineId = parsed.id as string;
    const matchingItem = itemEngines.find((e) => e.id === engineId);
    if (!matchingItem) return null;

    const nodes = Object.values(parsed.data?.nodes ?? {});

    for (const node of nodes) {
      if (node.name !== "StringObject" || !node.data?.string) continue;

      const spells = extractSpellsFromModifiers(node.data.string);
      if (spells.length > 0) {
        return {
          itemName: extractItemName(node.data.string),
          itemSlug: (matchingItem.args?.slug as string) ?? "",
          engineId,
          spells,
        };
      }
    }
  } catch {
    // Skip malformed lines
  }

  return null;
}

function extractItemName(jsonString: string): string {
  try {
    const obj = JSON.parse(jsonString) as { name?: string };
    return obj.name ?? "Unknown Item";
  } catch {
    return "Unknown Item";
  }
}

function extractSpellsFromModifiers(jsonString: string): ItemSpellEntry[] {
  try {
    const obj = JSON.parse(jsonString) as {
      engineModifiers?: Array<Record<string, unknown>>;
    };

    if (!obj.engineModifiers) return [];

    for (const mod of obj.engineModifiers) {
      if (mod.type === "add-staff-spells") {
        const staffMod = mod as unknown as StaffSpellModifier;
        return staffMod.spells.map((s) => ({ rank: s.rank, spell: s.spell }));
      }

      if (mod.type === "add-special-item-spell") {
        const wandMod = mod as unknown as WandSpellModifier;
        return [{ rank: Number(wandMod.rank), spell: wandMod.spell }];
      }
    }
  } catch {
    // Skip unparseable
  }

  return [];
}

// ─── Create Spellcasting Entry ───────────────────────────────────────────────

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

async function createItemSpellcastingEntry(
  actor: Actor,
  source: ItemSpellSource,
  tradition: string,
  summary: ImportSummary
): Promise<void> {
  debugLog(`[item-spells] Creating entry for "${source.itemName}" with ${String(source.spells.length)} spells`);

  const created = await actor.createEmbeddedDocuments("Item", [
    stampImported({
      name: source.itemName,
      type: "spellcastingEntry",
      system: {
        prepared: { value: "charges", validItems: "scroll" },
        tradition: { value: tradition },
        proficiency: { value: 1 },
        showSlotlessLevels: { value: false },
      },
    }),
  ] as never);

  const entryId = (created[0] as { id: string }).id;

  const spellItems: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const entry of source.spells) {
    const foundrySlug = toFoundrySlug(entry.spell);
    if (seen.has(foundrySlug)) continue;
    seen.add(foundrySlug);

    const spellData = await resolveSpellFromCompendium(entry.spell);
    if (!spellData) {
      summary.log.push(`- item-spell: ${foundrySlug} (not found)`);
      summary.unresolved.push(`Could not import spell "${entry.spell}": not found in compendium`);
      continue;
    }

    (spellData as { system: Record<string, unknown> }).system.location = { value: entryId };
    spellItems.push(stampImported(spellData));
  }

  if (spellItems.length > 0) {
    await actor.createEmbeddedDocuments("Item", spellItems as never);
    summary.log.push(`+ item-spells: ${source.itemName} (${String(spellItems.length)} spells)`);
  }
}
