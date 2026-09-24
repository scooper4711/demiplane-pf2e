/** An item built for creation, paired with its Demiplane engine id. */
export interface PlaceablePendingItem {
  data: Record<string, unknown>;
  demiplaneId: string;
}

/** The Foundry item type PF2e uses for containers (backpacks, pouches, …). */
const CONTAINER_ITEM_TYPE = "backpack";

/**
 * Creates every container item (backpacks, pouches, …) before the rest of the
 * inventory, then points each stowed item's `containerId` at the Foundry id of
 * the container it belongs to.
 *
 * Containers are created first because a stowed item's `system.containerId` must
 * reference an already-created container document. They are matched by the
 * container's unique Demiplane engine id (`containerMap` maps a stowed item's
 * engine id to its container's engine id), NOT by slug — so two containers of
 * the same base type (two backpacks, "left pouch"/"right pouch") are kept
 * distinct and items land in the correct one.
 *
 * `items` is mutated in place: the created containers are spliced out (they're
 * created here), leaving only the non-container items for the caller to create.
 *
 * @returns The number of containers created.
 */
export async function createContainersFirst(
  actor: Actor,
  items: PlaceablePendingItem[],
  containerMap: Map<string, string>
): Promise<number> {
  const containerEntries = items.filter((item) => (item.data.type as string) === CONTAINER_ITEM_TYPE);
  if (containerEntries.length === 0) return 0;

  // Remove containers from `items` so the caller doesn't create them twice.
  for (const container of containerEntries) {
    items.splice(items.indexOf(container), 1);
  }

  const created = await actor.createEmbeddedDocuments(
    "Item",
    containerEntries.map((container) => container.data)
  );

  const foundryIdByContainerEngineId = mapContainerEngineIdsToFoundryIds(containerEntries, created);
  placeItemsInContainers(items, containerMap, foundryIdByContainerEngineId);

  return containerEntries.length;
}

/**
 * Maps each container's Demiplane engine id to the Foundry id it was created
 * with, so stowed items can reference the right container instance.
 */
function mapContainerEngineIdsToFoundryIds(
  containerEntries: PlaceablePendingItem[],
  created: Array<{ id?: string | null }>
): Map<string, string> {
  const byEngineId = new Map<string, string>();
  containerEntries.forEach((container, index) => {
    const foundryId = created[index]?.id;
    if (foundryId) byEngineId.set(container.demiplaneId, foundryId);
  });
  return byEngineId;
}

/** Sets each stowed item's `system.containerId` to its container's Foundry id. */
function placeItemsInContainers(
  items: PlaceablePendingItem[],
  containerMap: Map<string, string>,
  foundryIdByContainerEngineId: Map<string, string>
): void {
  for (const item of items) {
    const containerEngineId = containerMap.get(item.demiplaneId);
    if (!containerEngineId) continue;
    const containerFoundryId = foundryIdByContainerEngineId.get(containerEngineId);
    if (containerFoundryId) {
      (item.data.system as Record<string, unknown>).containerId = containerFoundryId;
    }
  }
}
