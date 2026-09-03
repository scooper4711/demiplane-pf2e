import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { stampImported } from "./types.js";
import { debugLog } from "./debug-log.js";
import { toFoundrySlug } from "./slug-utils.js";
import { fetchStreamEngineLines } from "./stream-engines.js";
import { resolveSpellFromCompendium } from "./compendium-resolver.js";

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

/**
 * Generic ranked scroll/wand items (e.g. `magic-scroll-2nd-rank`,
 * `magic-wand-1st-rank`). PF2e models these as consumables carrying an embedded
 * spell, so the equipment importer owns them — they must not also become a
 * charges spellcasting entry.
 */
const GENERIC_CONSUMABLE_SLUG_RE = /^magic-(scroll|wand)-\d+(?:st|nd|rd|th)-rank$/;

function findSpellcastingItems(engines: DemiplaneEngineEntry[]): DemiplaneEngineEntry[] {
  return engines.filter((e) => {
    if (e.type !== "DemiplaneEngine") return false;
    if (!e.name?.startsWith("tabula/item/")) return false;
    const slug = ((e.args?.slug as string | undefined) ?? "").replace(/-rm$/, "");
    if (GENERIC_CONSUMABLE_SLUG_RE.test(slug)) return false;
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
  const lines = await fetchStreamEngineLines(engineIds);
  const sources: ItemSpellSource[] = [];

  for (const line of lines) {
    const matchingItem = itemEngines.find((e) => e.id === line.id);
    if (!matchingItem) continue;

    const spells: ItemSpellEntry[] = [];
    for (const mod of line.modifiers) {
      if (mod.type === "add-staff-spells") {
        spells.push(...mod.spells.map((s) => ({ rank: s.rank, spell: s.spell })));
      } else if (mod.type === "add-special-item-spell" && typeof mod.spell === "string") {
        spells.push({ rank: Number(mod.rank), spell: mod.spell });
      }
    }

    if (spells.length > 0) {
      sources.push({
        itemName: line.name ?? "Unknown Item",
        itemSlug: (matchingItem.args?.slug as string) ?? "",
        engineId: line.id ?? "",
        spells,
      });
    }
  }

  return sources;
}

// ─── Create Spellcasting Entry ───────────────────────────────────────────────

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
  ]);

  const first = created[0];
  if (!first) throw new Error(`Failed to create spellcasting entry for "${source.itemName}"`);
  const entryId = first.id;

  const spellItems: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const entry of source.spells) {
    const foundrySlug = toFoundrySlug(entry.spell);
    if (seen.has(foundrySlug)) continue;
    seen.add(foundrySlug);

    const spellData = await resolveSpellFromCompendium(entry.spell);
    if (!spellData) {
      summary.log.push(`- item-spell: ${foundrySlug} (not found)`);
      summary.unmapped.push({ slug: entry.spell, kind: "spell" });
      continue;
    }

    (spellData as { system: Record<string, unknown> }).system.location = { value: entryId };
    spellItems.push(stampImported(spellData));
  }

  if (spellItems.length > 0) {
    await actor.createEmbeddedDocuments("Item", spellItems);
    summary.log.push(`+ item-spells: ${source.itemName} (${String(spellItems.length)} spells)`);
  }
}
