import { normalizeEquipmentSlug } from "../import/slug-utils.js";
import { debugLog } from "../import/debug-log.js";
import type { CharacterData, CustomEngine, DemiplaneClient } from "@scooper4711/demiplane-api";
import { findCustomEngineByName } from "@scooper4711/demiplane-api";
import type { EquippedState, PendingChange, PendingItemChange } from "./change-buffer.js";

interface CharacterMetadata {
  name?: string | undefined;
  level?: number | undefined;
  avatarUrl?: string | undefined;
  viewPermission?: number | undefined;
  editPermission?: number | undefined;
}

export interface FetchedCharacter {
  data: CharacterData;
  meta: CharacterMetadata;
}

interface ResolvedItemChange {
  change: PendingItemChange;
  demiplaneId: string;
}

/**
 * Produces the Demiplane character payload to push. Given the server-fetched
 * character data and the buffered field/item changes, it applies override
 * engines, item quantity/equip/delete edits, and hand-slot assignment, then
 * returns the engines + metadata to push. Contains no push/retry/flush logic.
 */
export class PushPayloadBuilder {
  private readonly client: DemiplaneClient;

  constructor(client: DemiplaneClient) {
    this.client = client;
  }

  async buildUpdatedCharacterData(
    characterId: string,
    actor: Actor,
    changes: Map<string, PendingChange>,
    itemChanges: Map<string, PendingItemChange>
  ): Promise<FetchedCharacter | null> {
    let fetched: CharacterData;
    try {
      fetched = await this.client.fetchCharacterData(characterId);
    } catch {
      return null;
    }

    let updatedEngines: CustomEngine[] = fetched.engines as CustomEngine[];

    updatedEngines = this.applyFieldChanges(updatedEngines, changes);
    const resolved = this.resolveItemChanges(fetched, itemChanges);
    updatedEngines = this.applyItemChangeEngines(updatedEngines, resolved, actor);
    updatedEngines = this.applyHandSlotAssignment(updatedEngines, resolved);

    return {
      data: {
        engines: updatedEngines,
        engineCacheIdsBySource: fetched.engineCacheIdsBySource ?? {},
      },
      meta: {
        name: fetched.name,
        level: fetched.level,
        avatarUrl: fetched.avatarUrl,
        viewPermission: fetched.viewPermission,
        editPermission: fetched.editPermission,
      },
    };
  }

  private applyFieldChanges(updatedEngines: CustomEngine[], changes: Map<string, PendingChange>): CustomEngine[] {
    let engines = updatedEngines;
    for (const change of changes.values()) {
      const existing = findCustomEngineByName(engines, change.field);
      if (existing) {
        engines = engines.map((e) => (e === existing ? { ...e, value: change.value } : e));
      } else {
        // The character has no override engine for this field yet (e.g. hit points,
        // hero points, or a currency that Demiplane stores only as a computed value).
        // Create one so the push actually reflects the change instead of being
        // silently dropped — Demiplane accepts a CustomDemiplaneEngine override.
        const created = this.createOverrideEngine(change.field, change.value);
        engines = [...engines, created];
        debugLog(`[push] created override engine ${change.field} with value ${String(change.value)}`);
      }
    }
    return engines;
  }

  private createOverrideEngine(name: string, value: number): CustomEngine {
    return {
      id: `custom_${name}`,
      name,
      value,
      type: "CustomDemiplaneEngine",
      saveType: "CharacterSheet",
      storeType: "override",
      demiplaneEngineId: crypto.randomUUID(),
      args: { id: null },
    };
  }

  private resolveItemChanges(
    fetched: CharacterData,
    itemChanges: Map<string, PendingItemChange>
  ): ResolvedItemChange[] {
    const resolved: ResolvedItemChange[] = [];
    for (const itemChange of itemChanges.values()) {
      const matchSlug = itemChange.demiplaneSlug ?? itemChange.itemSlug;
      const itemEngine = fetched.engines.find((e) => {
        if (e.type !== "DemiplaneEngine" || !e.name.startsWith("tabula/item/")) return false;
        const engineSlug = (e.args?.slug as string) ?? "";
        return normalizeEquipmentSlug(engineSlug) === normalizeEquipmentSlug(matchSlug);
      });
      if (!itemEngine) continue;
      resolved.push({ change: itemChange, demiplaneId: itemEngine.demiplaneEngineId });
    }

    debugLog(
      `[push] resolved ${String(resolved.length)} item change(s) of ${String(itemChanges.size)} pending:`,
      resolved.map(({ change, demiplaneId }) => ({
        slug: change.itemSlug,
        demiplaneSlug: change.demiplaneSlug,
        changeType: change.changeType,
        value: change.value,
        demiplaneId,
      }))
    );

    return resolved;
  }

  private applyItemChangeEngines(
    updatedEngines: CustomEngine[],
    resolved: ResolvedItemChange[],
    _actor: Actor
  ): CustomEngine[] {
    let engines = updatedEngines;
    for (const { change: itemChange, demiplaneId } of resolved) {
      if (itemChange.changeType === "delete") {
        engines = this.applyItemDelete(engines, itemChange, demiplaneId);
      } else if (itemChange.changeType === "quantity") {
        const qtyName = `${demiplaneId}--quantity`;
        const existing = findCustomEngineByName(engines, qtyName);
        if (existing) {
          engines = engines.map((e) => (e === existing ? { ...e, value: itemChange.value as number } : e));
        } else {
          const newEngine: CustomEngine = {
            id: `custom_${qtyName}`,
            name: qtyName,
            value: itemChange.value as number,
            type: "CustomDemiplaneEngine",
            saveType: "CharacterSheet",
            storeType: "override",
            demiplaneEngineId: crypto.randomUUID(),
            args: { id: null, parentEngine: demiplaneId },
          };
          engines = [...engines, newEngine];
          if (itemChange.edited) {
            debugLog(`[push] created new quantity engine ${qtyName} with value ${String(itemChange.value)}`);
          }
        }
      } else if (itemChange.changeType === "equipped") {
        engines = this.applyEquippedEngine(engines, itemChange, demiplaneId);
      }
    }
    return engines;
  }

  /**
   * Removes an item from the engine list, including its base engine and any
   * custom engines tied to it (quantity, equipped state), so the item is
   * deleted from the Demiplane character on the next push.
   *
   * @param engines - Current engine list.
   * @param itemChange - The pending delete change.
   * @param demiplaneId - The resolved Demiplane engine ID of the deleted item.
   * @returns The engine list without the deleted item's engines.
   */
  private applyItemDelete(engines: CustomEngine[], itemChange: PendingItemChange, demiplaneId: string): CustomEngine[] {
    const matchSlug = itemChange.demiplaneSlug ?? itemChange.itemSlug;
    const kept = engines.filter((e) => {
      // Remove the base item engine matching the deleted slug.
      if (e.name.startsWith("tabula/item/") && e.args?.slug) {
        if (normalizeEquipmentSlug(String(e.args.slug)) === normalizeEquipmentSlug(matchSlug)) return false;
      }
      // Remove any custom engine owned by this item's engine id.
      const name = e.name ?? "";
      return name !== `${demiplaneId}--quantity` && name !== `${demiplaneId}-is-equipped`;
    });

    debugLog(
      `[push] delete ${matchSlug}: removed ${String(engines.length - kept.length)} engine(s) ` +
        `(demiplaneId=${demiplaneId})`
    );
    return kept;
  }

  private applyEquippedEngine(
    updatedEngines: CustomEngine[],
    itemChange: PendingItemChange,
    demiplaneId: string
  ): CustomEngine[] {
    const equippedState = itemChange.value as EquippedState;
    const carryType = equippedState.carryType;
    const isArmor = itemChange.itemType === "armor";
    const isEquipped = isArmor
      ? carryType === "worn" && equippedState.inSlot !== false
      : carryType === "worn" || carryType === "held";

    const equippedName = `${demiplaneId}-is-equipped`;
    const existingEquipped = findCustomEngineByName(updatedEngines, equippedName);
    debugLog(
      `[push] equipped state for ${itemChange.itemSlug}: carryType=${carryType}, inSlot=${equippedState.inSlot}, isArmor=${isArmor}, isEquipped=${isEquipped}, engine=${equippedName} found=${existingEquipped !== undefined}`
    );
    if (!existingEquipped) return updatedEngines;
    return updatedEngines.map((e) => (e === existingEquipped ? { ...e, value: isEquipped ? 1 : 0 } : e));
  }

  private applyHandSlotAssignment(updatedEngines: CustomEngine[], resolved: ResolvedItemChange[]): CustomEngine[] {
    let engines = updatedEngines;
    const existingPrimary = findCustomEngineByName(engines, "character_hand_primary_equipped-id");
    const existingOffhand = findCustomEngineByName(engines, "character_hand_offhand_equipped-id");
    const existingBoth = findCustomEngineByName(engines, "character_hand_both_equipped-id");

    debugLog(
      `[push] hand engines found: primary=${existingPrimary !== undefined}, offhand=${existingOffhand !== undefined}, both=${existingBoth !== undefined}; values before: primary=${existingPrimary?.value}, offhand=${existingOffhand?.value}, both=${existingBoth?.value}`
    );

    const setPrimary = (id: string) => {
      if (existingPrimary) engines = engines.map((e) => (e === existingPrimary ? { ...e, value: id } : e));
    };
    const setOffhand = (id: string) => {
      if (existingOffhand) engines = engines.map((e) => (e === existingOffhand ? { ...e, value: id } : e));
    };
    const setBoth = (id: string) => {
      if (existingBoth) engines = engines.map((e) => (e === existingBoth ? { ...e, value: id } : e));
    };
    const clearAllHands = (id: string) => {
      if (existingPrimary && existingPrimary.value === id)
        engines = engines.map((e) => (e === existingPrimary ? { ...e, value: "na" } : e));
      if (existingOffhand && existingOffhand.value === id)
        engines = engines.map((e) => (e === existingOffhand ? { ...e, value: "na" } : e));
      if (existingBoth && existingBoth.value === id)
        engines = engines.map((e) => (e === existingBoth ? { ...e, value: "na" } : e));
    };

    const assignments = this.computeHandAssignments(this.heldHandItems(resolved));
    if (assignments.primary) setPrimary(assignments.primary);
    if (assignments.offhand) setOffhand(assignments.offhand);
    if (assignments.both) setBoth(assignments.both);

    for (const { change: itemChange, demiplaneId: id } of resolved) {
      if (itemChange.changeType !== "equipped") continue;
      const equippedState = itemChange.value as EquippedState;
      const isArmor = itemChange.itemType === "armor";
      if (equippedState.carryType !== "held" || isArmor) {
        clearAllHands(id);
      }
    }

    debugLog(
      `[push] hand values after: primary=${existingPrimary?.value}, offhand=${existingOffhand?.value}, both=${existingBoth?.value}`
    );

    return engines;
  }

  private heldHandItems(resolved: ResolvedItemChange[]): { id: string; handsHeld: number }[] {
    return resolved
      .filter(({ change }) => {
        if (change.changeType !== "equipped") return false;
        const equippedState = change.value as EquippedState;
        return equippedState.carryType === "held" && change.itemType !== "armor";
      })
      .map(({ change, demiplaneId }) => ({
        id: demiplaneId,
        handsHeld:
          typeof (change.value as EquippedState).handsHeld === "number"
            ? (change.value as EquippedState).handsHeld!
            : 1,
      }));
  }

  private computeHandAssignments(heldItems: { id: string; handsHeld: number }[]): {
    primary?: string;
    offhand?: string;
    both?: string;
  } {
    const assignments: { primary?: string; offhand?: string; both?: string } = {};
    let primaryUsed = false;
    let offhandUsed = false;
    let bothUsed = false;

    for (const item of heldItems) {
      if (bothUsed) continue;
      if (item.handsHeld >= 2) {
        if (primaryUsed) continue;
        assignments.both = item.id;
        bothUsed = true;
        continue;
      }
      if (!primaryUsed) {
        assignments.primary = item.id;
        primaryUsed = true;
      } else if (!offhandUsed) {
        assignments.offhand = item.id;
        offhandUsed = true;
      }
    }

    return assignments;
  }
}
