import { MODULE_ID } from "./types.js";

/**
 * Deletes every item on the actor that was created by a Demiplane import
 * (i.e. carries the `demiplane-pf2e` module flag), returning the number
 * removed. Used before a re-import so previously imported items are replaced
 * rather than duplicated. Centralized here so the "what counts as imported"
 * rule lives in exactly one place.
 */
export async function deleteImportedItems(actor: Actor): Promise<number> {
  const importedItems = actor.items.filter((item) => {
    const moduleFlags = item.flags?.[MODULE_ID] as Record<string, unknown> | undefined;
    return moduleFlags !== undefined;
  });
  if (importedItems.length === 0) return 0;

  await actor.deleteEmbeddedDocuments(
    "Item",
    importedItems.map((item) => (item as { id: string }).id)
  );
  return importedItems.length;
}
