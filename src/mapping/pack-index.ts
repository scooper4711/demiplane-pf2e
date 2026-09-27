import type { Collection } from "@common/utils/_module.mjs";
import type { CompendiumIndexData } from "@client/documents/collections/compendium-collection.mjs";

/**
 * A typed seam for reading compendium pack indices.
 *
 * WHY THIS FILE EXISTS
 * `getIndex` is generic and well-typed, but `CompendiumIndexData` carries a
 * `[key: string]: any` index signature, so `entry.system?.slug` resolves to
 * `any` — the requested `fields` aren't reflected in the type. Rather than let
 * that `any` (or an inline `as unknown as` to a hand-written array shape) spread
 * across every resolver, callers ask for a typed index here: one `PackIndexEntry`
 * shape and one `getPackIndex` helper that requests fields and narrows the
 * `system` payload to what the importers actually read.
 */

/** A compendium index entry with the system fields the importers read. */
export interface PackIndexEntry extends CompendiumIndexData {
  system?: { slug?: string };
}

/** A `.find`-able index of typed entries. */
export type PackIndex = Collection<string, PackIndexEntry>;

/** The pack surface `getPackIndex` needs — the real `CompendiumCollection` satisfies it. */
interface IndexablePack {
  getIndex: <T extends CompendiumIndexData>(options: { fields: string[] }) => Promise<Collection<string, T>>;
}

/**
 * Loads a compendium pack's index, requesting the given system fields and
 * typing each entry's `system` payload. The generic slot narrows the `any`
 * `system` that `CompendiumIndexData` would otherwise expose.
 */
export function getPackIndex(pack: IndexablePack, fields: string[]): Promise<PackIndex> {
  return pack.getIndex<PackIndexEntry>({ fields });
}
