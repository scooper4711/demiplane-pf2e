export interface ResolvedItem {
  uuid: string;
  packKey: string;
  slug: string;
}

const DEFAULT_PACK_SEARCH_ORDER = [
  "pf2e.classes",
  "pf2e.ancestries",
  "pf2e.heritages",
  "pf2e.backgrounds",
  "pf2e.feats-srd",
  "pf2e.spells-srd",
  "pf2e.equipment-srd",
  "pf2e.classfeatures",
] as const;

/**
 * Transforms a Demiplane slug to the Foundry PF2e compendium slug.
 * Strips the trailing "-rm" suffix if present.
 */
export function transformSlug(demiplaneSlug: string): string {
  if (demiplaneSlug.endsWith("-rm")) {
    return demiplaneSlug.slice(0, -3);
  }
  return demiplaneSlug;
}

/**
 * Translates Demiplane engine slugs into Foundry PF2e compendium item UUIDs.
 * All PF2e-specific slug transformation and compendium resolution lives here.
 */
export class SlugMapper {
  private readonly packSearchOrder: readonly string[];

  constructor(packSearchOrder?: string[]) {
    this.packSearchOrder = packSearchOrder ?? DEFAULT_PACK_SEARCH_ORDER;
  }

  async resolve(demiplaneSlug: string): Promise<ResolvedItem | undefined> {
    const foundrySlug = transformSlug(demiplaneSlug);
    let firstMatch: ResolvedItem | undefined;

    for (const packKey of this.packSearchOrder) {
      const pack = game.packs.get(packKey);
      if (!pack) {
        continue;
      }

      const index = await pack.getIndex();
      const matchingEntries = index.filter(
        (entry: { system?: { slug?: string }; _id: string }) =>
          entry.system?.slug === foundrySlug,
      );

      for (const entry of matchingEntries) {
        const uuid = `Compendium.${packKey}.Item.${entry._id}`;

        if (!firstMatch) {
          firstMatch = { uuid, packKey, slug: foundrySlug };
        } else {
          console.info(
            `demiplane-pf2e | Duplicate slug "${foundrySlug}" found in pack "${packKey}"; using first match from "${firstMatch.packKey}"`,
          );
        }
      }

      if (firstMatch) {
        return firstMatch;
      }
    }

    console.warn(
      `demiplane-pf2e | Slug mapping failed: Demiplane slug "${demiplaneSlug}" → derived Foundry slug "${foundrySlug}" not found in packs: [${this.packSearchOrder.join(", ")}]`,
    );

    return undefined;
  }
}
