import { PACKS, EXPECTED_TYPES } from "./types.js";
import type { SlugKind } from "./types.js";
import { toFoundrySlug, generateSlugCandidates } from "./slug-utils.js";
import { SPELLS_PACK } from "../config.js";
import { resolveMappedItem, recordResolvedMapping } from "../slug-mapping.js";
import { getPackIndex } from "./pack-index.js";
import { findPacksWithItemTypes } from "./pack-discovery.js";

function getPacks(): NonNullable<typeof game.packs> {
  if (!game.packs) throw new Error("game.packs unavailable — import called before ready");
  return game.packs;
}

interface SpellDocument {
  _source?: Record<string, unknown>;
  toObject: () => Record<string, unknown>;
}

/** Finds a spell's compendium document by Demiplane slug. */
async function findSpellDocument(slug: string): Promise<SpellDocument | null> {
  // A GM mapping wins over the compendium lookup, including for a slug that
  // would otherwise resolve. resolveMappedItem yields item data, so wrap it back
  // into the document shape this function is expected to return.
  const mapped = await resolveMappedItem("spell", slug);
  if (mapped) return { toObject: () => mapped };

  const foundrySlug = toFoundrySlug(slug);
  const match =
    (await findSlugMatch([foundrySlug], [SPELLS_PACK])) ??
    (await findSlugMatch([foundrySlug], await fallbackPackKeys("spell")));
  if (!match) return null;
  const doc = await fromUuid(match.uuid);
  if (!doc) return null;

  const name = (doc as { name?: string }).name ?? slug;
  await recordResolvedMapping("spell", slug, { uuid: match.uuid, name });
  // eslint-disable-next-line no-restricted-syntax -- compendium document → the minimal SpellDocument shape this resolver returns
  return doc as unknown as SpellDocument;
}

/**
 * Resolves a Demiplane spell slug directly to its compendium document object.
 * Spell resolvers only ever look in the spells compendium.
 */
export async function resolveSpellFromCompendium(slug: string): Promise<Record<string, unknown> | null> {
  const doc = await findSpellDocument(slug);
  return doc ? doc.toObject() : null;
}

/**
 * Resolves a spell's raw source so it can be embedded inside an item — the spell
 * a scroll or wand consumable carries.
 */
export async function resolveSpellSourceFromCompendium(slug: string): Promise<Record<string, unknown> | null> {
  const doc = await findSpellDocument(slug);
  if (!doc) return null;
  return doc._source ?? doc.toObject();
}

/**
 * Resolves a Demiplane slug to a compendium item document object.
 *
 * Official packs are searched first so core content resolves exactly as
 * before; only on a miss do third-party packs holding the kind's item types
 * get searched (same discovery the mapping editor's browse buttons use).
 */
export async function resolveCompendiumItem(
  demiplaneSlug: string,
  kind: SlugKind
): Promise<Record<string, unknown> | null> {
  // A GM mapping is checked first so it can override even a slug that would have
  // resolved on its own.
  const mapped = await resolveMappedItem(kind, demiplaneSlug);
  if (mapped) return mapped;

  const slugs = generateSlugCandidates(toFoundrySlug(demiplaneSlug));
  const match = (await findSlugMatch(slugs, [...PACKS])) ?? (await findSlugMatch(slugs, await fallbackPackKeys(kind)));
  if (!match) return null;
  const doc = await fromUuid(match.uuid);
  if (!doc) return null;
  const name = (doc as { name?: string }).name ?? demiplaneSlug;
  await recordResolvedMapping(kind, demiplaneSlug, { uuid: match.uuid, name });
  return (doc as { toObject: () => Record<string, unknown> }).toObject();
}

/**
 * Resolve a Foundry slug to its compendium UUID.
 */
export async function resolveSlugToUuid(foundrySlug: string): Promise<string | null> {
  const slugs = generateSlugCandidates(foundrySlug);
  const match = await findSlugMatch(slugs, [...PACKS]);
  if (match) return match.uuid;
  // Kind is unknown here, so fall back across every pack holding Items.
  const fallback = await findSlugMatch(slugs, await fallbackPackKeysForTypes(ALL_ITEM_TYPES));
  return fallback?.uuid ?? null;
}

/** Every item type the importer can resolve, used for the kind-less lookup. */
const ALL_ITEM_TYPES = [...new Set(Object.values(EXPECTED_TYPES).flat())];

/** A slug matched to its compendium UUID. */
interface SlugMatch {
  uuid: string;
}

/**
 * Searches slug candidates across the given pack keys (candidates outer,
 * packs inner — preserving the long-standing priority order). Returns the
 * first hit's UUID, or null.
 */
async function findSlugMatch(slugs: string[], packKeys: readonly string[]): Promise<SlugMatch | null> {
  const packs = getPacks();
  for (const slug of slugs) {
    for (const packKey of packKeys) {
      const pack = packs.get(packKey);
      if (!pack) continue;
      const index = await getPackIndex(pack, ["system.slug"]);
      const match = index.find((i) => i.system?.slug === slug);
      if (match) return { uuid: `Compendium.${packKey}.Item.${match._id}` };
    }
  }
  return null;
}

/**
 * Third-party pack keys holding the kind's item types, excluding the official
 * packs the caller already searched.
 */
async function fallbackPackKeys(kind: SlugKind): Promise<string[]> {
  return fallbackPackKeysForTypes(EXPECTED_TYPES[kind]);
}

async function fallbackPackKeysForTypes(itemTypes: readonly string[]): Promise<string[]> {
  const official = new Set<string>([...PACKS, SPELLS_PACK]);
  return (await findPacksWithItemTypes(itemTypes)).filter((key) => !official.has(key));
}
