import { MODULE_ID } from "./import/types.js";
import { debugLog } from "./import/debug-log.js";
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

/**
 * Queues quantity and equipped-state changes for every syncable item on a
 * linked actor so a manual push re-syncs full item state (including hand
 * slots) rather than only combat resources.
 */
export function queueAllItemChanges(exportManager: ExportManager, actor: Actor): void {
  for (const item of actor.items) {
    const system = item.system as {
      slug?: string;
      equipped?: { carryType?: string; handsHeld?: number; inSlot?: boolean };
      quantity?: number;
    };
    const slug = system?.slug;
    if (typeof slug !== "string") continue;

    const dpFlags = (item.flags?.[MODULE_ID] as { demiplaneSlug?: unknown } | undefined) ?? {};
    const demiplaneSlug = typeof dpFlags.demiplaneSlug === "string" ? dpFlags.demiplaneSlug : undefined;

    if (typeof system?.quantity === "number") {
      if (slug in TREASURE_ITEM_MAP) {
        exportManager.queueChange(actor, TREASURE_ITEM_MAP[slug]!, system.quantity);
      } else {
        exportManager.queueItemChange(actor, slug, demiplaneSlug, "quantity", system.quantity);
      }
    }

    const carryType = system?.equipped?.carryType;
    if (typeof carryType === "string") {
      queueEquipped(exportManager, actor, item, slug, demiplaneSlug, system.equipped);
    }
  }
}

function queueEquipped(
  exportManager: ExportManager,
  actor: Actor,
  item: Item,
  slug: string,
  demiplaneSlug: string | undefined,
  equipped: { carryType?: string; handsHeld?: number; inSlot?: boolean } | undefined
): void {
  const handsHeld = typeof equipped?.handsHeld === "number" ? (equipped.handsHeld as number) : undefined;
  const inSlot = typeof equipped?.inSlot === "boolean" ? (equipped.inSlot as boolean) : undefined;
  exportManager.queueItemChange(
    actor,
    slug,
    demiplaneSlug,
    "equipped",
    { carryType: equipped?.carryType ?? "stowed", handsHeld, inSlot },
    item.type
  );
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

    const slug: string | undefined = (item as { system?: { slug?: string } })?.system?.slug;
    const dpFlags = (item as { flags?: Record<string, Record<string, unknown>> })?.flags?.["demiplane-pf2e"];
    const demiplaneSlug = typeof dpFlags?.demiplaneSlug === "string" ? dpFlags.demiplaneSlug : undefined;

    const quantity = this.getNestedValue(changes, "system.quantity");
    if (typeof quantity === "number") {
      if (typeof slug === "string" && slug in TREASURE_ITEM_MAP) {
        this.exportManager.queueChange(actor, TREASURE_ITEM_MAP[slug]!, quantity);
      } else if (typeof slug === "string") {
        this.exportManager.queueItemChange(actor, slug, demiplaneSlug, "quantity", quantity);
      }
    }

    this.handleEquippedChange(item, actor, slug, demiplaneSlug, changes);
  }

  private handleEquippedChange(
    item: Item,
    actor: Actor,
    slug: string | undefined,
    demiplaneSlug: string | undefined,
    changes: Record<string, unknown>
  ): void {
    const equippedChanged =
      Object.keys(changes).some((key) => key === "system.equipped" || key.startsWith("system.equipped.")) ||
      this.getNestedValue(changes, "system.equipped") !== undefined;
    if (!equippedChanged || typeof slug !== "string") return;

    const itemType = (item as { type?: string })?.type;
    const changeCarryType = this.getNestedValue(changes, "system.equipped.carryType");
    const changeHandsHeld = this.getNestedValue(changes, "system.equipped.handsHeld");
    const liveEquipped = (
      item.system as unknown as {
        equipped?: { carryType?: string; handsHeld?: number; inSlot?: boolean };
      }
    )?.equipped;
    const effectiveCarryType =
      typeof changeCarryType === "string" ? changeCarryType : (liveEquipped?.carryType ?? "stowed");
    const effectiveHandsHeld =
      typeof changeHandsHeld === "number" ? changeHandsHeld : (liveEquipped?.handsHeld ?? undefined);
    const effectiveInSlot = typeof liveEquipped?.inSlot === "boolean" ? (liveEquipped.inSlot as boolean) : undefined;

    debugLog(
      `Equipped change: ${slug} -> carryType=${effectiveCarryType}, handsHeld=${effectiveHandsHeld}, inSlot=${effectiveInSlot}, type=${itemType}`
    );

    this.exportManager.queueItemChange(
      actor,
      slug,
      demiplaneSlug,
      "equipped",
      { carryType: effectiveCarryType, handsHeld: effectiveHandsHeld, inSlot: effectiveInSlot },
      itemType
    );
  }

  private onItemCreate(item: Item): void {
    const actor = item.actor;
    if (!actor || !this.isLinkedCharacterActor(actor)) return;
    debugLog(`Item created on linked actor: ${item.name}; granted choices: ${this.getGrantedChoiceLog(item)}`);
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
    debugLog(`Item deleted from linked actor: ${item.name}`);
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
