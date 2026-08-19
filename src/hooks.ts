/**
 * Registers Foundry hooks for detecting actor/item changes
 * that should be synced back to Demiplane.
 */
export function registerHooks(): void {
  Hooks.on("updateActor", onActorUpdate);
  Hooks.on("updateItem", onItemUpdate);
  Hooks.on("createItem", onItemCreate);
  Hooks.on("deleteItem", onItemDelete);
}

function onActorUpdate(
  actor: Actor,
  changes: Record<string, unknown>
): void {
  if (actor.type !== "character") return;
  // TODO: Detect HP, hero points, focus points changes and queue sync
  console.log("foundry-demiplane-pf2e | Actor updated:", actor.name, changes);
}

function onItemUpdate(
  item: Item,
  changes: Record<string, unknown>
): void {
  if (item.actor?.type !== "character") return;
  // TODO: Detect consumable quantity changes and queue sync
  console.log("foundry-demiplane-pf2e | Item updated:", item.name, changes);
}

function onItemCreate(item: Item): void {
  if (item.actor?.type !== "character") return;
  // TODO: Detect new inventory items for potential sync
  console.log("foundry-demiplane-pf2e | Item created:", item.name);
}

function onItemDelete(item: Item): void {
  if (item.actor?.type !== "character") return;
  // TODO: Detect removed items for potential sync
  console.log("foundry-demiplane-pf2e | Item deleted:", item.name);
}
