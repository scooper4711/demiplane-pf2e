import { PACKS } from "./types.js";
import type { SlugKind } from "./types.js";
import { toFoundrySlug, generateSlugCandidates } from "./slug-utils.js";
import { SPELLS_PACK } from "../config.js";
import { resolveMappedItem } from "../slug-mapping.js";

type PackIndex = Array<{ _id: string; system?: { slug?: string } }>;

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

  const pack = getPacks().get(SPELLS_PACK);
  if (!pack) return null;
  const foundrySlug = toFoundrySlug(slug);
  const index = (await pack.getIndex({ fields: ["system.slug"] })) as unknown as PackIndex;
  const match = index.find((i) => i.system?.slug === foundrySlug);
  if (!match) return null;
  const doc = await pack.getDocument(match._id);
  return doc ? (doc as unknown as SpellDocument) : null;
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
 */
export async function resolveCompendiumItem(
  demiplaneSlug: string,
  kind: SlugKind
): Promise<Record<string, unknown> | null> {
  // A GM mapping is checked first so it can override even a slug that would have
  // resolved on its own.
  const mapped = await resolveMappedItem(kind, demiplaneSlug);
  if (mapped) return mapped;

  const packs = getPacks();
  const foundrySlug = toFoundrySlug(demiplaneSlug);
  const candidates = generateSlugCandidates(foundrySlug);

  for (const slug of candidates) {
    for (const packKey of PACKS) {
      const pack = packs.get(packKey);
      if (!pack) continue;
      const index = (await pack.getIndex({ fields: ["system.slug"] })) as unknown as PackIndex;
      const match = index.find((i) => i.system?.slug === slug);
      if (match) {
        const doc = await fromUuid(`Compendium.${packKey}.Item.${match._id}`);
        return doc ? (doc as { toObject: () => Record<string, unknown> }).toObject() : null;
      }
    }
  }
  return null;
}

/**
 * Resolve a Foundry slug to its compendium UUID.
 */
export async function resolveSlugToUuid(foundrySlug: string): Promise<string | null> {
  const packs = getPacks();

  for (const slug of generateSlugCandidates(foundrySlug)) {
    for (const packKey of PACKS) {
      const pack = packs.get(packKey);
      if (!pack) continue;
      const index = (await pack.getIndex({ fields: ["system.slug"] })) as unknown as PackIndex;
      const match = index.find((i) => i.system?.slug === slug);
      if (match) return `Compendium.${packKey}.Item.${match._id}`;
    }
  }
  return null;
}
