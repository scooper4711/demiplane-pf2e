import { PACKS } from "./types.js";
import { toFoundrySlug, generateSlugCandidates } from "./slug-utils.js";

/**
 * Resolves a Demiplane slug to a compendium item document object.
 */
export async function resolveCompendiumItem(demiplaneSlug: string): Promise<Record<string, unknown> | null> {
  const foundrySlug = toFoundrySlug(demiplaneSlug);
  const candidates = generateSlugCandidates(foundrySlug);
  for (const slug of candidates) {
    for (const packKey of PACKS) {
      const pack = game.packs.get(packKey);
      if (!pack) continue;
      const index = await pack.getIndex({ fields: ["system.slug"] });
      const match = index.find((i: { system?: { slug?: string } }) => i.system?.slug === slug);
      if (match) {
        const uuid = `Compendium.${packKey}.Item.${match._id}`;
        const doc = await fromUuid(uuid);
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
  for (const packKey of PACKS) {
    const pack = game.packs.get(packKey);
    if (!pack) continue;
    const index = await pack.getIndex({ fields: ["system.slug"] });
    const match = index.find((i: { system?: { slug?: string }; _id: string }) => i.system?.slug === foundrySlug);
    if (match) return `Compendium.${packKey}.Item.${match._id}`;
  }
  return null;
}
