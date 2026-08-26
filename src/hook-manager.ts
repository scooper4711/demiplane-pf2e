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
};

const TREASURE_ITEM_MAP: Record<string, string> = {
  "platinum-pieces": "character_currency_platinum",
  "gold-pieces": "character_currency_gold",
  "silver-pieces": "character_currency_silver",
  "copper-pieces": "character_currency_copper",
};

/**
 * Queues current HP, temporary HP, and hero points from a linked actor
 * so they can be flushed immediately (manual push / exportNow).
 */
export function queueCombatResourceChanges(exportManager: ExportManager, actor: Actor): void {
  const hitPoints = actor.system.attributes?.hp;
  if (typeof hitPoints?.value === "number") {
    exportManager.queueChange(actor, "character_hit-points_current", hitPoints.value);
  }
  if (typeof hitPoints?.temp === "number") {
    exportManager.queueChange(actor, "character_hit-points_temp", hitPoints.temp);
  }
  const heroPoints = actor.system.resources?.heroPoints?.value;
  if (typeof heroPoints === "number") {
    exportManager.queueChange(actor, "character_hero-points", heroPoints);
  }
}

type ActorSyncHook = "updateActor" | "updateItem" | "createItem" | "deleteItem";

interface RegisteredHook {
  event: ActorSyncHook;
  id: number;
}

/**
 * Manages Foundry hooks for detecting session state changes on linked actors
 * and queueing them for export to Demiplane.
 *
 * Only processes actors that are characters with a linked Demiplane character
 * UUID stored in their module flags.
 */
export class HookManager {
  private readonly exportManager: ExportManager;
  private hooks: RegisteredHook[] = [];

  constructor(exportManager: ExportManager) {
    this.exportManager = exportManager;
  }

  register(): void {
    this.hooks.push(
      { event: "updateActor", id: Hooks.on("updateActor", this.onActorUpdate.bind(this)) },
      { event: "updateItem", id: Hooks.on("updateItem", this.onItemUpdate.bind(this)) },
      { event: "createItem", id: Hooks.on("createItem", this.onItemCreate.bind(this)) },
      { event: "deleteItem", id: Hooks.on("deleteItem", this.onItemDelete.bind(this)) }
    );
  }

  unregister(): void {
    for (const hook of this.hooks) {
      Hooks.off(hook.event, hook.id);
    }
    this.hooks = [];
  }

  private onActorUpdate(actor: Actor, changes: Record<string, unknown>): void {
    if (!this.isLinkedCharacterActor(actor)) return;
    if (!game.settings.get(MODULE_ID, "autoSync")) return;

    for (const [actorPath, storeName] of Object.entries(ACTOR_FIELD_MAPPINGS)) {
      const value = this.getChangeValue(changes, actorPath);
      if (value !== undefined && typeof value === "number") {
        this.exportManager.queueChange(actor, storeName, value);
      }
    }
  }

  private onItemUpdate(item: Item, changes: Record<string, unknown>): void {
    const actor = item.actor;
    if (!actor || !this.isLinkedCharacterActor(actor)) return;
    if (!game.settings.get(MODULE_ID, "autoSync")) return;

    const quantity = this.getNestedValue(changes, "system.quantity");
    if (quantity === undefined || typeof quantity !== "number") return;

    const slug: string | undefined = (item as { system?: { slug?: string } })?.system?.slug;
    if (typeof slug === "string" && slug in TREASURE_ITEM_MAP) {
      this.exportManager.queueChange(actor, TREASURE_ITEM_MAP[slug]!, quantity);
    }
  }

  private onItemCreate(item: Item): void {
    const actor = item.actor;
    if (!actor || !this.isLinkedCharacterActor(actor)) return;
    console.log(
      `${MODULE_ID} | Item created on linked actor: ${item.name}; granted choices: ${this.getGrantedChoiceLog(item)}`
    );
  }

  private getGrantedChoiceLog(item: Item): string {
    const rules = (item.system as unknown as { rules?: unknown[] })?.rules ?? [];
    const selections = rules
      .filter((rule): rule is { key: string; flag?: string; selection?: unknown } => {
        return typeof rule === "object" && rule !== null && (rule as { key?: unknown }).key === "ChoiceSet";
      })
      .map((rule) => {
        const flag = rule.flag || "choice";
        const flags = (item.flags?.pf2e as { rulesSelections?: Record<string, unknown> } | undefined)?.rulesSelections;
        const selection = flags && Object.hasOwn(flags, flag) ? flags[flag] : rule.selection;
        return `${flag}=${selection ?? "none"}`;
      });

    return selections.length > 0 ? selections.join(", ") : "none";
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

  private getChangeValue(changes: Record<string, unknown>, path: string): unknown {
    const nested = this.getNestedValue(changes, path);
    if (nested !== undefined) return nested;
    return changes[path];
  }

  private getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split(".");
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== "object") {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}
