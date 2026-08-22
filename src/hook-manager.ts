import { MODULE_ID } from "./import/types.js";
import type { ExportManager } from "./export-manager.js";


/**
 * Field mapping from Foundry actor data paths to Demiplane store names.
 *
 * Keys are the nested property paths within the `changes` object passed
 * to the `updateActor` hook. Values are the Demiplane Custom_Engine store
 * names used by ExportManager.queueChange.
 */
const ACTOR_FIELD_MAPPINGS: Record<string, string> = {
  "system.attributes.hp.value": "character_hit-points_current",
  "system.attributes.hp.temp": "character_hit-points_temp",
  "system.resources.heroPoints.value": "character_hero-points",
  "system.resources.focus.value": "character_focus_current",
  "system.currency.gp": "character_currency_gold",
  "system.currency.sp": "character_currency_silver",
  "system.currency.cp": "character_currency_copper",
  "system.currency.pp": "character_currency_platinum",
};

/**
 * Manages Foundry hooks for detecting session state changes on linked actors
 * and queueing them for export to Demiplane.
 *
 * Only processes actors that are characters with a linked Demiplane character
 * UUID stored in their module flags.
 */
export class HookManager {
  private readonly exportManager: ExportManager;
  private hookIds: number[] = [];

  constructor(exportManager: ExportManager) {
    this.exportManager = exportManager;
  }

  register(): void {
    this.hookIds.push(
      Hooks.on("updateActor", this.onActorUpdate.bind(this)),
      Hooks.on("updateItem", this.onItemUpdate.bind(this)),
      Hooks.on("createItem", this.onItemCreate.bind(this)),
      Hooks.on("deleteItem", this.onItemDelete.bind(this)),
    );
  }

  unregister(): void {
    for (const id of this.hookIds) {
      Hooks.off("updateActor", id);
    }
    this.hookIds = [];
  }

  private onActorUpdate(actor: Actor, changes: Record<string, unknown>): void {
    if (!this.isLinkedCharacterActor(actor)) return;

    for (const [actorPath, storeName] of Object.entries(ACTOR_FIELD_MAPPINGS)) {
      const value = this.getNestedValue(changes, actorPath);
      if (value !== undefined && typeof value === "number") {
        this.exportManager.queueChange(actor, storeName, value);
      }
    }
  }

  private onItemUpdate(item: Item, changes: Record<string, unknown>): void {
    const actor = item.actor;
    if (!actor || !this.isLinkedCharacterActor(actor)) return;

    const quantity = this.getNestedValue(changes, "system.quantity");
    if (quantity !== undefined && typeof quantity === "number") {
      console.log(
        `${MODULE_ID} | Consumable quantity changed: ${item.name} → ${String(quantity)}`,
      );
    }
  }

  private onItemCreate(item: Item): void {
    const actor = item.actor;
    if (!actor || !this.isLinkedCharacterActor(actor)) return;
    console.log(`${MODULE_ID} | Item created on linked actor: ${item.name}`);
  }

  private onItemDelete(item: Item): void {
    const actor = item.actor;
    if (!actor || !this.isLinkedCharacterActor(actor)) return;
    console.log(`${MODULE_ID} | Item deleted from linked actor: ${item.name}`);
  }

  private isLinkedCharacterActor(actor: Actor): boolean {
    if (actor.type !== "character") return false;
    const characterId = actor.getFlag(MODULE_ID, "characterId");
    return characterId !== undefined && characterId !== null;
  }

  private getNestedValue(
    obj: Record<string, unknown>,
    path: string,
  ): unknown {
    const parts = path.split(".");
    let current: unknown = obj;
    for (const part of parts) {
      if (
        current === null ||
        current === undefined ||
        typeof current !== "object"
      ) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}
