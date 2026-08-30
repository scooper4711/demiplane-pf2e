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
      name: `Slug Mappings — ${kind}`,
      hint: `GM-defined compendium targets for unresolved ${kind} slugs. Managed on the Slug Mapping screen.`,
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
