import { MODULE_ID } from "./import/types.js";
import type { SlugKind } from "./import/types.js";
import { debugLog } from "./import/debug-log.js";

/** A GM-chosen target for a Demiplane slug that doesn't resolve on its own. */
export interface SlugMapping {
  uuid: string;
  name: string;
}

const SLUG_KINDS: readonly SlugKind[] = ["ancestry", "heritage", "background", "class", "feat", "equipment", "spell"];

const SETTING_KEY_BY_KIND: Record<SlugKind, `slugMappings${Capitalize<SlugKind>}`> = {
  ancestry: "slugMappingsAncestry",
  heritage: "slugMappingsHeritage",
  background: "slugMappingsBackground",
  class: "slugMappingsClass",
  feat: "slugMappingsFeat",
  equipment: "slugMappingsEquipment",
  spell: "slugMappingsSpell",
};

/** One world-scoped setting per kind keeps mappings of different kinds from colliding. */
function settingKey(kind: SlugKind) {
  return SETTING_KEY_BY_KIND[kind];
}

export function registerSlugMappingSettings(): void {
  for (const kind of SLUG_KINDS) {
    game.settings.register(MODULE_ID, settingKey(kind), {
      name: `Demiplane Mapping — ${kind}`,
      hint: `GM-defined Foundry items for unresolved ${kind} names. Managed on the Demiplane Mapping screen.`,
      scope: "world",
      // Not shown in the standard settings list; the mapping screen is the UI.
      config: false,
      type: Object,
      default: {},
    });
  }
}

export function getAllMappings(kind: SlugKind): Record<string, SlugMapping> {
  const raw = game.settings.get(MODULE_ID, settingKey(kind)) as Record<string, SlugMapping> | undefined;
  return raw ?? {};
}

export function getMapping(kind: SlugKind, slug: string): SlugMapping | undefined {
  return getAllMappings(kind)[slug];
}

export async function setMapping(kind: SlugKind, slug: string, mapping: SlugMapping): Promise<void> {
  await game.settings.set(MODULE_ID, settingKey(kind), { ...getAllMappings(kind), [slug]: mapping });
}

/**
 * Records a resolution discovered by a strategy other than the mapping table
 * (e.g. a compendium slug match) so subsequent lookups of the same slug hit the
 * mapping first. Makes every resolved slug a first-class mapping the GM can see
 * and correct in the editor.
 *
 * Idempotent and non-clobbering: an existing entry (including a GM override) is
 * left untouched, so recording an auto-resolution never overwrites a deliberate
 * choice. Callers only reach here after `resolveMappedItem` returned null, so in
 * practice the slug is genuinely new.
 */
export async function recordResolvedMapping(kind: SlugKind, slug: string, mapping: SlugMapping): Promise<void> {
  if (getMapping(kind, slug)) return;
  await setMapping(kind, slug, mapping);
  debugLog(`[slug-mapping] recorded auto-resolved ${kind} "${slug}" → ${mapping.uuid}`);
}

export async function clearMapping(kind: SlugKind, slug: string): Promise<void> {
  const remaining = { ...getAllMappings(kind) };
  delete remaining[slug];
  await game.settings.set(MODULE_ID, settingKey(kind), remaining);
}

/**
 * Resolves a slug through the GM's mapping, ahead of the normal compendium
 * lookup. Returns null when there is no mapping, so callers fall through to
 * their usual resolution and record the slug as unmapped.
 *
 * A mapping whose target has since disappeared (uninstalled pack, changed
 * content) also returns null rather than breaking the import.
 */
export async function resolveMappedItem(kind: SlugKind, slug: string): Promise<Record<string, unknown> | null> {
  const mapping = getMapping(kind, slug);
  if (!mapping) return null;

  const doc = await fromUuid(mapping.uuid);
  if (!doc) {
    debugLog(`[slug-mapping] mapped target missing for ${kind} "${slug}" (${mapping.uuid})`);
    return null;
  }

  return (doc as { toObject: () => Record<string, unknown> }).toObject();
}

/**
 * Whether a mapping's target still exists, so the screen can flag mappings that
 * point at something no longer installed.
 */
export async function isMappingResolvable(mapping: SlugMapping): Promise<boolean> {
  return (await fromUuid(mapping.uuid)) !== null;
}

// ─── Cross-world export / import ─────────────────────────────────────────────

/** The schema version stamped on an exported mapping file. */
export const MAPPINGS_EXPORT_VERSION = 1;

/** The serialized form of every mapping, for sharing a mapping set between worlds. */
export interface MappingsExport {
  version: number;
  mappings: Partial<Record<SlugKind, Record<string, SlugMapping>>>;
}

/** The outcome of importing a mapping file, for the summary shown to the GM. */
export interface MappingsImportResult {
  /** Mappings written to this world. */
  imported: number;
  /** Entries skipped because their target doesn't exist in this world. */
  skippedMissing: number;
  /** Entries skipped because a mapping for that slug already existed (non-overwrite). */
  skippedExisting: number;
  /** A short sample of the skipped-missing entries, for the summary (slug + name). */
  missingSamples: string[];
}

/** Collects every kind's mappings into a single serializable object. */
export function exportMappings(): MappingsExport {
  const mappings: Partial<Record<SlugKind, Record<string, SlugMapping>>> = {};
  for (const kind of SLUG_KINDS) {
    const forKind = getAllMappings(kind);
    if (Object.keys(forKind).length > 0) mappings[kind] = forKind;
  }
  return { version: MAPPINGS_EXPORT_VERSION, mappings };
}

/** Whether a value is a well-formed {uuid, name} mapping entry (both non-empty strings). */
function isSlugMapping(value: unknown): value is SlugMapping {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.uuid === "string" && entry.uuid.length > 0 && typeof entry.name === "string";
}

/**
 * Parses untrusted file content into a {@link MappingsExport}, or returns null
 * when it isn't a recognizable export. Validates the envelope and drops any
 * unknown kind key or malformed entry rather than trusting the file's shape.
 */
export function parseMappingsExport(raw: string): MappingsExport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as { version?: unknown; mappings?: unknown };
  if (typeof candidate.mappings !== "object" || candidate.mappings === null) return null;

  const source = candidate.mappings as Record<string, unknown>;
  const mappings: Partial<Record<SlugKind, Record<string, SlugMapping>>> = {};
  for (const kind of SLUG_KINDS) {
    const forKind = source[kind];
    if (typeof forKind !== "object" || forKind === null) continue;
    const clean: Record<string, SlugMapping> = {};
    for (const [slug, entry] of Object.entries(forKind as Record<string, unknown>)) {
      if (typeof slug === "string" && slug.length > 0 && isSlugMapping(entry)) clean[slug] = entry;
    }
    if (Object.keys(clean).length > 0) mappings[kind] = clean;
  }

  const version = typeof candidate.version === "number" ? candidate.version : MAPPINGS_EXPORT_VERSION;
  return { version, mappings };
}

/**
 * Merges an imported mapping set into this world. An entry is skipped when its
 * target doesn't resolve here (a pack the world lacks) so the store never gains
 * a broken mapping. When `overwrite` is false an entry whose slug is already
 * mapped locally is also skipped, so importing never silently replaces a
 * deliberate local choice. Returns counts and a sample of what was skipped.
 */
export async function importMappings(
  parsed: MappingsExport,
  options: { overwrite: boolean }
): Promise<MappingsImportResult> {
  const result: MappingsImportResult = { imported: 0, skippedMissing: 0, skippedExisting: 0, missingSamples: [] };

  for (const kind of SLUG_KINDS) {
    const forKind = parsed.mappings[kind];
    if (!forKind) continue;

    for (const [slug, mapping] of Object.entries(forKind)) {
      if (!options.overwrite && getMapping(kind, slug)) {
        result.skippedExisting++;
        continue;
      }
      if (!(await isMappingResolvable(mapping))) {
        result.skippedMissing++;
        if (result.missingSamples.length < MISSING_SAMPLE_LIMIT) {
          result.missingSamples.push(`${slug} → ${mapping.name}`);
        }
        continue;
      }
      await setMapping(kind, slug, mapping);
      result.imported++;
    }
  }

  debugLog(
    `[slug-mapping] import: ${result.imported} written, ${result.skippedMissing} missing, ${result.skippedExisting} already mapped`
  );
  return result;
}

/** How many skipped-missing entries to name in the import summary before "…and N more". */
const MISSING_SAMPLE_LIMIT = 10;
