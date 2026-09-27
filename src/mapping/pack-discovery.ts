/**
 * Discovers which compendium packs hold items of given item types, the same
 * way PF2e's own tools discover their sources (Compendium Browser source scan
 * in `browser.svelte.ts`, `ABCPicker.#gatherItems` in
 * `actor/character/apps/abc-picker/app.ts`): every visible Item pack's index
 * is grouped by item `type`, so third-party packs (e.g. SF2 Anachronisms)
 * appear alongside the official ones.
 *
 * Shared by the mapping editor's browse buttons and the import's compendium
 * fallback. Results are cached per item-type set for the session; pack indexes
 * are cached by Foundry itself after first read.
 */

/** Discovered pack keys per sorted item-type set. */
const discoveryCache = new Map<string, string[]>();

/** Clears the discovery cache. Exported for tests; production code never calls it. */
export function clearPackDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * Pack keys holding at least one item of any of the given item types
 * (e.g. `["ancestry"]`). Order follows `game.packs`, so official packs —
 * which load first — come before third-party ones.
 */
export async function findPacksWithItemTypes(itemTypes: readonly string[]): Promise<string[]> {
  const key = [...itemTypes].sort().join("\0");
  const cached = discoveryCache.get(key);
  if (cached) return cached;

  const wanted = new Set(itemTypes);
  const found: string[] = [];
  for (const pack of game.packs.filter((candidate) => candidate.documentName === "Item")) {
    // No logged-in user only happens outside a real client (tests); the gate
    // is a no-op there, exactly as everywhere else user permissions apply.
    if (game.user && !pack.testUserPermission(game.user, "LIMITED")) continue;
    let index;
    try {
      // Default index fields already carry `type`; no extra fields needed.
      index = await pack.getIndex({ fields: [] });
    } catch {
      continue;
    }
    if (index.map((entry) => entry.type).some((type) => wanted.has(type))) {
      found.push(pack.collection);
    }
  }
  discoveryCache.set(key, found);
  return found;
}
