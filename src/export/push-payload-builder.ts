import { normalizeEquipmentSlug, rawEquipmentSlug } from "../import/slug-utils.js";
import { debugLog } from "../import/debug-log.js";
import type { CharacterData, CustomEngine, DemiplaneClient } from "@scooper4711/demiplane-api";
import { findCustomEngineByName } from "@scooper4711/demiplane-api";
import type { CastChange, ContainerChange, EquippedState, PendingChange, PendingItemChange } from "./change-buffer.js";

interface CharacterMetadata {
  name?: string | undefined;
  level?: number | undefined;
  avatarUrl?: string | undefined;
  viewPermission?: number | undefined;
  editPermission?: number | undefined;
  /**
   * Builder-maintained display blob read by the character overview page.
   * Passed through untouched on every push — omitting it nulls the
   * overview subtitle ("Lvl X Class").
   */
  formatedData?: unknown;
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
 * Finds the `tabula/item` engine matching a Demiplane/equipment slug. Class-kit
 * items carry no `args.slug`, so fall back to the engine name — exactly like the
 * import side does when stamping items. Shared by item-change resolution and
 * container-target resolution.
 */
function findItemEngineBySlug(engines: CharacterData["engines"], slug: string): CustomEngine | undefined {
  const normalized = normalizeEquipmentSlug(slug);
  return engines.find(
    (e) =>
      e.type === "DemiplaneEngine" &&
      e.name.startsWith("tabula/item/") &&
      normalizeEquipmentSlug(rawEquipmentSlug(e)) === normalized
  ) as CustomEngine | undefined;
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
    updatedEngines = this.applyItemChangeEngines(updatedEngines, resolved);
    updatedEngines = this.applyHandSlotAssignment(updatedEngines, resolved);
    updatedEngines = this.applyCastChanges(updatedEngines, itemChanges);

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
        formatedData: fetched.formatedData,
      },
    };
  }

  /**
   * Applies cast/expended changes for prepared spell slots. A cast change's
   * `itemSlug` is the prepared spell's Demiplane engine id (not a compendium
   * slug), so it's handled here rather than through slug-based item resolution.
   * Casting sets the `<engineId>-is-cast` flag to 1 (created if absent); undoing
   * it removes the flag, matching how the importer reads it (absent = not cast).
   */
  private applyCastChanges(
    updatedEngines: CustomEngine[],
    itemChanges: Map<string, PendingItemChange>
  ): CustomEngine[] {
    let engines = updatedEngines;
    for (const change of itemChanges.values()) {
      if (change.changeType !== "cast") continue;
      const engineId = change.itemSlug;
      const { expended } = change.value as CastChange;
      const flagName = `${engineId}-is-cast`;
      const existing = findCustomEngineByName(engines, flagName);

      if (expended) {
        engines = existing
          ? engines.map((e) => (e === existing ? { ...e, value: 1 } : e))
          : [...engines, this.createCastEngine(flagName, engineId)];
      } else if (existing) {
        engines = engines.filter((e) => e !== existing);
      }
      debugLog(`[push] cast: ${flagName} → ${expended ? "1" : "removed"}`);
    }
    return engines;
  }

  private createCastEngine(flagName: string, parentEngineId: string): CustomEngine {
    return {
      id: `custom_${flagName}`,
      name: flagName,
      value: 1,
      type: "CustomDemiplaneEngine",
      saveType: "CharacterSheet",
      storeType: "override",
      demiplaneEngineId: crypto.randomUUID(),
      args: { id: null, parentEngine: parentEngineId },
    };
  }

  private applyFieldChanges(updatedEngines: CustomEngine[], changes: Map<string, PendingChange>): CustomEngine[] {
    let engines = updatedEngines;
    debugLog(
      `[push] applying ${String(changes.size)} field change(s):`,
      [...changes.values()].map((c) => `${c.field}=${String(c.value)}`)
    );
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

  private createOverrideEngine(name: string, value: number | string): CustomEngine {
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
      const itemEngine = findItemEngineBySlug(fetched.engines, matchSlug);
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

  private applyItemChangeEngines(updatedEngines: CustomEngine[], resolved: ResolvedItemChange[]): CustomEngine[] {
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
            const qtyValue = itemChange.value as number;
            debugLog(`[push] created new quantity engine ${qtyName} with value ${String(qtyValue)}`);
          }
        }
      } else if (itemChange.changeType === "equipped") {
        engines = this.applyEquippedEngine(engines, itemChange, demiplaneId);
      } else if (itemChange.changeType === "container") {
        engines = this.applyContainerEngine(engines, itemChange, demiplaneId);
      }
    }
    return engines;
  }

  /**
   * Reflects a container move: the moved item's `<itemId>-container` custom
   * engine holds the parent container's engine id (the same representation the
   * importer reads). Moving into a container creates or updates that engine;
   * moving to the top level removes it. A move whose target container can't be
   * resolved to an engine is skipped rather than writing a dangling link.
   */
  private applyContainerEngine(
    engines: CustomEngine[],
    itemChange: PendingItemChange,
    demiplaneId: string
  ): CustomEngine[] {
    const { containerSlug } = itemChange.value as ContainerChange;
    const engineName = `${demiplaneId}-container`;
    const existing = findCustomEngineByName(engines, engineName);

    if (containerSlug === null) {
      // Moved out to the top level: drop the container link if present.
      if (!existing) return engines;
      debugLog(`[push] container: ${itemChange.itemSlug} moved to top level (removed ${engineName})`);
      return engines.filter((e) => e !== existing);
    }

    const containerEngine = findItemEngineBySlug(engines, containerSlug);
    if (!containerEngine) {
      debugLog(`[push] container: target "${containerSlug}" for ${itemChange.itemSlug} not found; skipping`);
      return engines;
    }
    const containerId = containerEngine.demiplaneEngineId;

    debugLog(`[push] container: ${itemChange.itemSlug} → ${containerSlug} (${engineName}=${containerId})`);
    if (existing) {
      return engines.map((e) => (e === existing ? { ...e, value: containerId } : e));
    }
    return [
      ...engines,
      {
        id: `custom_${engineName}`,
        name: engineName,
        value: containerId,
        type: "CustomDemiplaneEngine",
        saveType: "CharacterSheet",
        storeType: "override",
        demiplaneEngineId: crypto.randomUUID(),
        args: { id: null, parentEngine: demiplaneId },
      },
    ];
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
      // Remove the base item engine matching the deleted slug (same
      // name-fallback as resolveItemChanges for slug-less class-kit items).
      if (e.name.startsWith("tabula/item/")) {
        if (normalizeEquipmentSlug(rawEquipmentSlug(e)) === normalizeEquipmentSlug(matchSlug)) return false;
      }
      // Remove any custom engine owned by this item's engine id.
      const name = e.name ?? "";
      return (
        name !== `${demiplaneId}--quantity` &&
        name !== `${demiplaneId}-is-equipped` &&
        name !== `${demiplaneId}-container`
      );
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
      `[push] equipped state for ${itemChange.itemSlug}: carryType=${carryType}, inSlot=${equippedState.inSlot}, isArmor=${isArmor}, isEquipped=${isEquipped}, invested=${equippedState.invested}, engine=${equippedName} found=${existingEquipped !== undefined}`
    );

    let engines = existingEquipped
      ? updatedEngines.map((e) => (e === existingEquipped ? { ...e, value: isEquipped ? 1 : 0 } : e))
      : updatedEngines;

    engines = this.applyInvestedEngine(engines, equippedState, demiplaneId);
    return engines;
  }

  /**
   * Writes the item's `value--is-invested--<id>` flag when the invested state is
   * known. Investment is a Foundry-editable toggle that Demiplane tracks
   * separately from equipped, so it is pushed even when the item isn't held/worn
   * (e.g. a pendant). The engine is created if the character has none yet.
   */
  private applyInvestedEngine(
    engines: CustomEngine[],
    equippedState: EquippedState,
    demiplaneId: string
  ): CustomEngine[] {
    if (typeof equippedState.invested !== "boolean") return engines;

    const investedName = `value--is-invested--${demiplaneId}`;
    const value = equippedState.invested ? 1 : 0;
    const existing = findCustomEngineByName(engines, investedName);
    if (existing) {
      return engines.map((e) => (e === existing ? { ...e, value } : e));
    }
    return [
      ...engines,
      {
        id: `custom_${investedName}`,
        name: investedName,
        value,
        type: "CustomDemiplaneEngine",
        saveType: "CharacterSheet",
        storeType: "override",
        demiplaneEngineId: crypto.randomUUID(),
        args: { id: null, parentEngine: demiplaneId },
      },
    ];
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
      if (existingPrimary?.value === id)
        engines = engines.map((e) => (e === existingPrimary ? { ...e, value: "na" } : e));
      if (existingOffhand?.value === id)
        engines = engines.map((e) => (e === existingOffhand ? { ...e, value: "na" } : e));
      if (existingBoth?.value === id) engines = engines.map((e) => (e === existingBoth ? { ...e, value: "na" } : e));
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
