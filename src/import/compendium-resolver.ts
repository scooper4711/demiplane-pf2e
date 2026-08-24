import { PACKS } from "./types.js";
import { toFoundrySlug, generateSlugCandidates } from "./slug-utils.js";

type PackIndex = Array<{ _id: string; system?: { slug?: string } }>;

function getPacks(): NonNullable<typeof game.packs> {
  if (!game.packs) throw new Error("game.packs unavailable — import called before ready");
  return game.packs;
}

/**
 * Resolves a Demiplane slug to a compendium item document object.
 */
export async function resolveCompendiumItem(demiplaneSlug: string): Promise<Record<string, unknown> | null> {
  const packs = getPacks();
  const foundrySlug = toFoundrySlug(demiplaneSlug);
  const candidates = generateSlugCandidates(foundrySlug);

  for (const slug of candidates) {
    for (const packKey of PACKS) {
      const pack = packs.get(packKey);
      if (!pack) continue;
      const index = (await pack.getIndex({ fields: ["system.slug"] } as never)) as unknown as PackIndex;
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
      const index = (await pack.getIndex({ fields: ["system.slug"] } as never)) as unknown as PackIndex;
      const match = index.find((i) => i.system?.slug === slug);
      if (match) return `Compendium.${packKey}.Item.${match._id}`;
    }
  }
  return null;
}
