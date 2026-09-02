import { stampImported } from "./types.js";
import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";
import { toFoundrySlug } from "./slug-utils.js";
import { resolveSpellFromCompendium } from "./compendium-resolver.js";

const PROFICIENCY_TRAINED = 1;

/** Optional per-spell overrides applied to `system.location` on a resolved spell item. */
export interface SpellLocationExtras {
  heightenedLevel?: number;
  signature?: boolean;
}

export async function createEntry(
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
        proficiency: { value: PROFICIENCY_TRAINED },
        ability: { value: ability },
        showSlotlessLevels: { value: false },
      },
    }),
  ] as never);
  return (created[0] as { id: string }).id;
}

/**
 * Resolves each engine's spell from the compendium, stamps it as imported, and
 * assigns it to the given entry. Deduplicates by Foundry slug and records
 * unmapped spells on the summary. Shared by the regular, prepared, and divine
 * font import paths so the "resolve and stamp" pattern lives in one place.
 */
export async function resolveSpellItems(
  engines: DemiplaneEngineEntry[],
  entryId: string,
  summary: ImportSummary,
  options: { logLabel: string; seen?: Set<string>; extras?: (eng: DemiplaneEngineEntry) => SpellLocationExtras } = {
    logLabel: "spell",
  }
): Promise<Record<string, unknown>[]> {
  const { logLabel, seen = new Set<string>(), extras } = options;
  const items: Record<string, unknown>[] = [];

  for (const eng of engines) {
    const slug = eng.args?.slug as string;
    if (!slug) continue;

    const foundrySlug = toFoundrySlug(slug);
    if (seen.has(foundrySlug)) continue;
    seen.add(foundrySlug);

    const spellData = await resolveSpellFromCompendium(slug);
    if (!spellData) {
      summary.log.push(`- ${logLabel}: ${foundrySlug} (not found)`);
      summary.unmapped.push({ slug, kind: "spell" });
      continue;
    }

    (spellData as { system: Record<string, unknown> }).system.location = {
      value: entryId,
      ...(extras ? extras(eng) : {}),
    };
    items.push(stampImported(spellData));
  }

  return items;
}

/** Creates spell items on the actor and returns a map of Foundry slug → item id. */
export async function createSpellItems(actor: Actor, items: Record<string, unknown>[]): Promise<Map<string, string>> {
  const slugToId = new Map<string, string>();
  if (items.length === 0) return slugToId;

  const created = (await actor.createEmbeddedDocuments("Item", items as never)) as Array<{
    id: string;
    system: { slug: string };
  }>;
  for (const item of created) {
    slugToId.set(item.system.slug, item.id);
  }
  return slugToId;
}

export async function addSpells(
  actor: Actor,
  entryId: string,
  spellEngines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<Map<string, string>> {
  const items = await resolveSpellItems(spellEngines, entryId, summary, { logLabel: "spell" });
  return createSpellItems(actor, items);
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
