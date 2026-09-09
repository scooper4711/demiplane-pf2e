import { MODULE_ID, INVENTORY_ITEM_TYPES } from "./import/types.js";
import { debugLog } from "./import/debug-log.js";
import type { ExportManager } from "./export-manager.js";
import type { EquippedState } from "./export/change-buffer.js";
import { isSyncActive } from "./sync-pause.js";
import { canWriteText, canWriteQuantity, canWriteDeletes, isSoftDeleteEnabled } from "./write-level.js";
import { DEMIPLANE_ICON_SRC } from "./config.js";
import { characterSystem, itemSystem, localizeLanguage, type Pf2eSpellSlotRank } from "./pf2e-types.js";

/**
 * Field mapping from Foundry actor data paths to Demiplane store names.
 *
 * Keys are the nested property paths within the `changes` object passed
 * to the `updateActor` hook. Values are the Demiplane Custom_Engine store
 * names used by ExportManager.queueChange.
 */
/**
 * Demiplane store name for the character's additional (user-added) languages.
 * Demiplane persists only the languages the user typed in; ancestry/heritage
 * grants are recomputed on its side and are not writable. So on export we push
 * the character's full language list minus the ancestry/heritage/feat grants,
 * mirroring how the import merges this field on top of the granted ones.
 */
const LANGUAGES_STORE_NAME = "character-languages-user";

/** Separator Demiplane uses between languages in the free-text field. */
const LANGUAGE_SEPARATOR = ", ";

/** The Foundry actor path holding the character's full (merged) language list. */
const LANGUAGES_PATH = "system.details.languages.value";

const ACTOR_FIELD_MAPPINGS: Record<string, string> = {
  "system.attributes.hp.value": "character_hit-points_current",
  "system.attributes.hp.temp": "character_hit-points_temp",
  "system.resources.heroPoints.value": "character_hero-points",
  "system.details.gender.value": "character_appearance_gender",
  "system.details.age.value": "character_appearance_age",
  "system.details.ethnicity.value": "character_appearance_ethnicity",
  "system.details.nationality.value": "character_appearance_nationality",
  "system.details.height.value": "character_appearance_height",
  "system.details.weight.value": "character_appearance_weight",
  "system.details.biography.birthPlace": "character_appearance_birthplace",
  "system.details.biography.appearance": "character_appearance_appearance",
  "system.details.biography.catchphrases": "character_personality_catchphrases",
  "system.details.biography.attitude": "character_personality_attitude",
  "system.details.biography.likes": "character_personality_likes",
  "system.details.biography.dislikes": "character_personality_dislikes",
  "system.details.biography.allies": "character_campaign_allies",
  "system.details.biography.enemies": "character_campaign_enemies",
  "system.details.biography.organizations": "character_campaign_organizations",
  "system.details.biography.edicts": "character_personality_edicts",
  "system.details.biography.anathema": "character_personality_anathema",
};

const TREASURE_ITEM_MAP: Record<string, string> = {
  "platinum-pieces": "character_currency_platinum",
  "gold-pieces": "character_currency_gold",
  "silver-pieces": "character_currency_silver",
  "copper-pieces": "character_currency_copper",
};

// INVENTORY_ITEM_TYPES (the physical/inventory item `type`s eligible for delete
// propagation) is defined in import/types.js as the single source of truth.

/** A spellcasting entry's prepared slots, keyed `slot{rank}`, as read for cast tracking. */
type LiveSlots = Record<string, Pf2eSpellSlotRank>;

/** A deleted inventory item resolved for propagation to Demiplane. */
interface DeletableItem {
  /** The slug used to match the item's Demiplane engine (`demiplaneSlug ?? slug`). */
  slot: string;
  /** The PF2e system slug, needed to queue a soft-delete quantity change. */
  slug: string | undefined;
  /** The stamped Demiplane slug, if any. */
  demiplaneSlug: string | undefined;
  /** The PF2e item type (weapon, consumable, …). */
  itemType: string;
}

/**
 * Queues current HP, temporary HP, and hero points from a linked actor
 * so they can be flushed immediately (manual push / exportNow).
 */
export function queueCombatResourceChanges(exportManager: ExportManager, actor: Actor): void {
  // HP, hero points, and currency are text-tier fields: a manual push at a
  // lower tier must not write them (the master switch in exportLinkedCharacter
  // only blocks level `none`, so each re-queue entry point enforces its own tier).
  if (!canWriteText()) return;
  const hitPoints = characterSystem(actor).attributes?.hp;
  if (typeof hitPoints?.value === "number") {
    exportManager.queueChange(actor, "character_hit-points_current", hitPoints.value);
  }
  if (typeof hitPoints?.temp === "number") {
    exportManager.queueChange(actor, "character_hit-points_temp", hitPoints.temp);
  }
  const heroPoints = characterSystem(actor).resources?.heroPoints?.value;
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
  // Levels apply to manual pushes too: currency is text-tier, but quantity
  // and equipped state require the quantity tier. Without per-kind gating a
  // manual push at "text fields only" would leak item writes past the bound.
  const writeText = canWriteText();
  const writeQuantity = canWriteQuantity();
  // `actor.items` is typed as the common base collection, but at runtime (and
  // in the PF2e system) every entry is a client Item. Narrow once here so the
  // PF2e field reads below type-check.
  // eslint-disable-next-line no-restricted-syntax -- base-collection → client Item narrowing; runtime-guaranteed
  const items = Array.from(actor.items) as unknown as Item[];
  for (const item of items) {
    queueSingleItemChanges(exportManager, actor, item, writeText, writeQuantity);
  }
}

function queueSingleItemChanges(
  exportManager: ExportManager,
  actor: Actor,
  item: Item,
  writeText: boolean,
  writeQuantity: boolean
): void {
  const system = itemSystem(item);
  const slug = system?.slug;
  if (typeof slug !== "string") return;

  const dpFlags = (item.flags?.[MODULE_ID] as { demiplaneSlug?: unknown } | undefined) ?? {};
  const demiplaneSlug = typeof dpFlags.demiplaneSlug === "string" ? dpFlags.demiplaneSlug : undefined;

  if (typeof system?.quantity === "number") {
    if (slug in TREASURE_ITEM_MAP) {
      if (!writeText) return;
      exportManager.queueChange(actor, TREASURE_ITEM_MAP[slug]!, system.quantity);
    } else {
      if (!writeQuantity) return;
      exportManager.queueItemChange(actor, slug, demiplaneSlug, "quantity", system.quantity);
    }
  }

  if (writeQuantity) {
    queueEquippedIfChanged(exportManager, actor, item, slug, demiplaneSlug, system);
    queueContainerState(exportManager, actor, item, slug, demiplaneSlug, system);
  }
}

/** Queues the item's equipped state when it carries one. */
function queueEquippedIfChanged(
  exportManager: ExportManager,
  actor: Actor,
  item: Item,
  slug: string,
  demiplaneSlug: string | undefined,
  system: ReturnType<typeof itemSystem>
): void {
  if (typeof system?.equipped?.carryType !== "string") return;
  queueEquipped(exportManager, actor, item, slug, demiplaneSlug, system.equipped);
}

/**
 * Queues an inventory item's current container placement for a full re-sync
 * push: the container's slug when stowed, or `null` when at the top level.
 *
 * The null case matters — it's how a re-sync removes a stale `-container` link
 * for an item that was pulled out of a container in Foundry. Without it, the
 * full push could add container links but never clear them, so an item moved
 * out of a bag stayed "in" the bag on Demiplane. (An earlier version only
 * queued stowed items, which is exactly that gap.)
 *
 * Scoped to inventory item types, since only physical items live in containers;
 * a stowed item whose container can't be resolved is skipped rather than writing
 * a dangling link.
 */
function queueContainerState(
  exportManager: ExportManager,
  actor: Actor,
  item: Item,
  slug: string,
  demiplaneSlug: string | undefined,
  system: ReturnType<typeof itemSystem>
): void {
  if (!INVENTORY_ITEM_TYPES.has(item.type)) return;

  const containerId = system?.containerId;
  const isStowed = typeof containerId === "string" && containerId.length > 0;
  if (!isStowed) {
    exportManager.queueItemChange(actor, slug, demiplaneSlug, "container", { containerSlug: null }, item.type);
    return;
  }

  const containerSlug = resolveContainerSlug(actor, containerId);
  if (containerSlug === null) return;
  exportManager.queueItemChange(actor, slug, demiplaneSlug, "container", { containerSlug }, item.type);
}

/**
 * Resolves a Foundry container item id to the container's Demiplane/equipment
 * slug (what the push matches against the character's item engines). Returns
 * null when the container can't be resolved. Shared by the per-edit hook and the
 * full re-sync path.
 */
function resolveContainerSlug(actor: Actor, containerId: string): string | null {
  const container = actor.items.get(containerId);
  if (!container) return null;
  const flags = (container.flags?.[MODULE_ID] as { demiplaneSlug?: unknown } | undefined) ?? {};
  if (typeof flags.demiplaneSlug === "string") return flags.demiplaneSlug;
  return itemSystem(container).slug ?? null;
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

/**
 * Queues every syncable character-detail field from a linked actor's current
 * state: biography/appearance/personality/campaign fields, languages, and
 * organized play ID. This is the manual-push counterpart to the per-field
 * `updateActor` hook — the hook reacts to individual edits, while this re-syncs
 * the full detail state on demand (e.g. the "Update to Demiplane" button).
 *
 * Deity is deliberately absent: it is build-derived (a cleric's deity comes
 * from the class choice, not the text field), so pushing it can only write a
 * value the next import overwrites. The import side still reads it.
 */
export function queueAllDetailChanges(exportManager: ExportManager, actor: Actor): void {
  // Detail fields are text-tier; a manual push below that tier writes nothing.
  if (!canWriteText()) return;
  queueMappedDetailFields(exportManager, actor);
  queueOrganizedPlayId(exportManager, actor);
  queueAdditionalLanguages(exportManager, actor);
}

/** Queues each ACTOR_FIELD_MAPPINGS field from the actor's current value. */
function queueMappedDetailFields(exportManager: ExportManager, actor: Actor): void {
  for (const [actorPath, storeName] of Object.entries(ACTOR_FIELD_MAPPINGS)) {
    const value = readActorPath(actor, actorPath);
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      exportManager.queueChange(actor, storeName, value.join("; "));
    } else if (typeof value === "number" || typeof value === "string") {
      exportManager.queueChange(actor, storeName, value);
    }
  }
}

/** Queues the combined organized play ID when both PFS numbers are present. */
function queueOrganizedPlayId(exportManager: ExportManager, actor: Actor): void {
  const pfs = characterSystem(actor).pfs;
  if (typeof pfs?.playerNumber === "number" && typeof pfs?.characterNumber === "number") {
    exportManager.queueChange(actor, "character_organizedplayid", `${pfs.playerNumber}-${pfs.characterNumber}`);
  }
}

/**
 * Queues the character's additional (user-added) languages as Demiplane display
 * names: the actor's full language list minus the ancestry/heritage/feat grants.
 *
 * Foundry's `system.details.languages.value` merges granted and chosen languages,
 * but Demiplane only stores the user-added ones, so the granted set — read from
 * the derived `build.languages.granted` — is subtracted before pushing.
 */
export function queueAdditionalLanguages(exportManager: ExportManager, actor: Actor): void {
  const all = characterSystem(actor).details.languages?.value ?? [];
  const granted = new Set(characterSystem(actor).build.languages.granted.map((entry) => entry.slug));
  const additional = all
    .filter((slug) => !granted.has(slug))
    .map((slug) => localizeLanguage(slug) ?? titleCaseSlug(slug));
  exportManager.queueChange(actor, LANGUAGES_STORE_NAME, additional.join(LANGUAGE_SEPARATOR));
}

/** Falls back to a readable name for a language slug the PF2e config doesn't know. */
function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/** Reads a dotted `system.…` path off the live actor, returning undefined if absent. */
function readActorPath(actor: Actor, path: string): unknown {
  let current: unknown = actor;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
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

  constructor(exportManager: ExportManager) {
    this.exportManager = exportManager;
  }

  register(): void {
    Hooks.on("updateActor", this.onActorUpdate.bind(this) as (...args: unknown[]) => void);
    Hooks.on("updateItem", this.onItemUpdate.bind(this) as (...args: unknown[]) => void);
    Hooks.on("createItem", this.onItemCreate.bind(this) as (...args: unknown[]) => void);
    Hooks.on("deleteItem", this.onItemDelete.bind(this) as (...args: unknown[]) => void);
  }

  private onActorUpdate(actor: Actor, changes: Record<string, unknown>): void {
    if (!this.isLinkedCharacterActor(actor)) return;
    // While any client is importing or pushing this character, actor updates are
    // just the sync echoing to other clients — don't queue them back to Demiplane.
    // Checked before the write-level guard so an import doesn't log a misleading
    // "nothing pushed" note for its own writes.
    if (isSyncActive(actor)) return;
    if (!this.writeAllowed("text", actor.name)) return;

    for (const [actorPath, storeName] of Object.entries(ACTOR_FIELD_MAPPINGS)) {
      const value = this.getChangeValue(changes, actorPath);
      if (value === undefined || value === null) continue;

      // Array fields (edicts, anathema) are stored as arrays in Foundry but as
      // semicolon-separated strings in Demiplane.
      if (Array.isArray(value)) {
        this.exportManager.queueChange(actor, storeName, value.join("; "));
      } else if (typeof value === "number" || typeof value === "string") {
        this.exportManager.queueChange(actor, storeName, value);
      }
    }

    // Organized play ID is a single Demiplane field ("123456-2001") that maps
    // to two Foundry fields (playerNumber + characterNumber).
    this.queueOrganizedPlayChange(actor, changes);

    // Campaign Notes maps to a "Campaign" journal entry, not an engine override.
    this.queueCampaignNotesChange(actor, changes);

    // Languages need the granted set subtracted, so they can't be a plain
    // ACTOR_FIELD_MAPPINGS entry.
    this.queueLanguagesChange(actor, changes);
  }

  /**
   * Queues the character's additional languages when the language list changes.
   *
   * Foundry's `system.details.languages.value` is the full list (ancestry and
   * feat grants merged with the user's picks), but Demiplane only stores the
   * user-added languages. So we subtract the granted languages — read from the
   * live actor's derived `build.languages.granted` — before pushing, and convert
   * the remaining slugs to Demiplane's display-name, comma-separated format.
   */
  private queueLanguagesChange(actor: Actor, changes: Record<string, unknown>): void {
    if (this.getChangeValue(changes, LANGUAGES_PATH) === undefined) return;
    queueAdditionalLanguages(this.exportManager, actor);
  }

  private queueOrganizedPlayChange(actor: Actor, changes: Record<string, unknown>): void {
    const pfs = this.getChangeValue(changes, "system.pfs.playerNumber");
    const charNum = this.getChangeValue(changes, "system.pfs.characterNumber");
    if (pfs === undefined && charNum === undefined) return;

    const system = characterSystem(actor);
    const player = typeof pfs === "number" ? pfs : system?.pfs?.playerNumber;
    const character = typeof charNum === "number" ? charNum : system?.pfs?.characterNumber;

    if (typeof player === "number" && typeof character === "number") {
      this.exportManager.queueChange(actor, "character_organizedplayid", `${player}-${character}`);
    }
  }

  private queueCampaignNotesChange(actor: Actor, changes: Record<string, unknown>): void {
    const notes = this.getChangeValue(changes, "system.details.biography.campaignNotes");
    if (typeof notes !== "string") return;
    void this.exportManager.exportCampaignNotes(actor, notes);
  }

  private onItemUpdate(item: Item, changes: Record<string, unknown>): void {
    const actor = item.actor;
    if (!actor || !this.isLinkedCharacterActor(actor)) return;
    if (isSyncActive(actor)) return;
    if (!this.writeAllowed("quantity", actor.name)) return;

    // A spellcasting entry has no slug; its updates carry cast/expended slot
    // changes, handled separately from physical-item quantity/equipped edits.
    if ((item as { type?: string }).type === "spellcastingEntry") {
      this.handleCastChange(item, actor, changes);
      return;
    }

    const slug = itemSystem(item).slug ?? undefined;
    const dpFlags = (item.flags?.[MODULE_ID] as { demiplaneSlug?: unknown } | undefined) ?? {};
    const demiplaneSlug = typeof dpFlags?.demiplaneSlug === "string" ? dpFlags.demiplaneSlug : undefined;

    const quantity = this.getNestedValue(changes, "system.quantity");
    if (typeof quantity === "number") {
      if (typeof slug === "string" && slug in TREASURE_ITEM_MAP) {
        this.exportManager.queueChange(actor, TREASURE_ITEM_MAP[slug]!, quantity);
      } else if (typeof slug === "string") {
        this.exportManager.queueItemChange(actor, slug, demiplaneSlug, "quantity", quantity, undefined, true);
      }
    }

    this.handleEquippedChange(item, actor, slug, demiplaneSlug, changes);
    this.handleContainerChange(item, actor, slug, demiplaneSlug, changes);
  }

  /**
   * Queues a container move when an item's `system.containerId` changes: moved
   * into a container, out to the top level, or from one container to another.
   * This is an item update (not a delete), so it rides the same quantity tier as
   * equipped/quantity edits — the guard is already applied in `onItemUpdate`.
   *
   * The queued value carries the target container's identifying slug so the push
   * can resolve it to the container's Demiplane engine id; `null` means top-level
   * (moved out of any container).
   */
  private handleContainerChange(
    item: Item,
    actor: Actor,
    slug: string | undefined,
    demiplaneSlug: string | undefined,
    changes: Record<string, unknown>
  ): void {
    if (!this.containerIdChanged(changes) || typeof slug !== "string") return;

    const containerId = this.resolveContainerIdChange(changes);
    const containerSlug = containerId === null ? null : resolveContainerSlug(actor, containerId);

    debugLog(`Container change: ${slug} -> container=${containerSlug ?? "(top level)"}`);
    this.exportManager.queueItemChange(actor, slug, demiplaneSlug, "container", { containerSlug }, item.type);
  }

  /** Whether an item update touched `system.containerId` (as a flat key or nested). */
  private containerIdChanged(changes: Record<string, unknown>): boolean {
    if (Object.prototype.hasOwnProperty.call(changes, "system.containerId")) return true;
    const system = changes.system;
    return typeof system === "object" && system !== null && "containerId" in system;
  }

  /** The new `containerId` from an update: a string when moved into a container, null for top level. */
  private resolveContainerIdChange(changes: Record<string, unknown>): string | null {
    const value = this.getNestedValue(changes, "system.containerId");
    return typeof value === "string" && value.length > 0 ? value : null;
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
    const equipped = this.resolveEffectiveEquipped(item, changes);

    debugLog(
      `Equipped change: ${slug} -> carryType=${equipped.carryType}, handsHeld=${equipped.handsHeld}, inSlot=${equipped.inSlot}, invested=${equipped.invested}, type=${itemType}`
    );

    this.exportManager.queueItemChange(actor, slug, demiplaneSlug, "equipped", equipped, itemType);
  }

  /**
   * Merges the incoming equipped changes with the item's live equipped state so
   * a partial update (e.g. only `invested` toggled) still pushes the full state.
   * Prefers the changed value when present, else the live value, else a default.
   */
  private resolveEffectiveEquipped(item: Item, changes: Record<string, unknown>): EquippedState {
    const live = itemSystem(item)?.equipped;
    const changeCarryType = this.getNestedValue(changes, "system.equipped.carryType");
    const changeHandsHeld = this.getNestedValue(changes, "system.equipped.handsHeld");
    const changeInvested = this.getNestedValue(changes, "system.equipped.invested");
    return {
      carryType: typeof changeCarryType === "string" ? changeCarryType : (live?.carryType ?? "stowed"),
      handsHeld: typeof changeHandsHeld === "number" ? changeHandsHeld : (live?.handsHeld ?? undefined),
      inSlot: typeof live?.inSlot === "boolean" ? (live.inSlot as boolean) : undefined,
      invested: typeof changeInvested === "boolean" ? changeInvested : (live?.invested ?? undefined),
    };
  }

  /**
   * Queues cast/expended changes when a prepared spellcasting entry's slots are
   * updated (a slot cast or restored on the sheet). Demiplane tracks a cast slot
   * with a `<preparedEngineId>-is-cast` flag; the entry carries a
   * `preparedSlotEngineIds` map (stamped on import) so each slot position resolves
   * to the engine whose flag to set. Rides the quantity tier (guarded in
   * `onItemUpdate`).
   */
  private handleCastChange(item: Item, actor: Actor, changes: Record<string, unknown>): void {
    const changedSlots = this.getNestedValue(changes, "system.slots");
    if (typeof changedSlots !== "object" || changedSlots === null) return;

    const slotEngineIds = this.preparedSlotEngineIds(item);
    if (!slotEngineIds) return;

    const liveSlots: LiveSlots | undefined = itemSystem(item).slots;

    for (const [slotKey, slotChange] of Object.entries(changedSlots as Record<string, unknown>)) {
      const prepared = (slotChange as { prepared?: Record<string, { expended?: boolean }> }).prepared;
      const engineIds = slotEngineIds[slotKey];
      if (!prepared || !engineIds) continue;

      // `prepared` may arrive as an array or an index-keyed object; iterate entries.
      for (const [indexKey, slot] of Object.entries(prepared)) {
        const engineId = engineIds[Number(indexKey)];
        if (!engineId) continue;
        const expended = this.resolveExpended(slot, liveSlots, slotKey, Number(indexKey));
        this.exportManager.queueItemChange(actor, engineId, engineId, "cast", { expended }, "spell");
      }
    }
  }

  /** The import-stamped `slot{rank}` → prepared-engine-id map on a spellcasting entry. */
  private preparedSlotEngineIds(item: Item): Record<string, string[]> | undefined {
    const flags = (item.flags?.[MODULE_ID] as { preparedSlotEngineIds?: unknown } | undefined) ?? {};
    const map = flags.preparedSlotEngineIds;
    return typeof map === "object" && map !== null ? (map as Record<string, string[]>) : undefined;
  }

  /**
   * The effective expended state for a changed slot: the changed value if present,
   * else the live slot's value. A partial update may omit `expended`, so fall back
   * to the item's current state rather than assuming false.
   */
  private resolveExpended(
    slotChange: { expended?: boolean },
    liveSlots: LiveSlots | undefined,
    slotKey: string,
    index: number
  ): boolean {
    if (typeof slotChange.expended === "boolean") return slotChange.expended;
    const live = liveSlots?.[slotKey]?.prepared?.[index]?.expended;
    return typeof live === "boolean" ? live : false;
  }

  private onItemCreate(item: Item): void {
    const actor = item.actor;
    if (!actor || !this.isLinkedCharacterActor(actor)) return;
    if (isSyncActive(actor)) return;
    // Creates are never pushed to Demiplane (only logged for diagnostics); the
    // text-tier gate keeps the console note consistent with the other handlers.
    if (!this.writeAllowed("text", actor.name)) return;
    debugLog(`Item created on linked actor: ${item.name}; granted choices: ${this.getGrantedChoiceLog(item)}`);
  }

  private getGrantedChoiceLog(item: Item): string {
    const rules = itemSystem(item)?.rules ?? [];
    const selections = rules
      .filter((rule): rule is { key: string; flag?: string; selection?: unknown } => {
        return typeof rule === "object" && rule !== null && (rule as { key?: unknown }).key === "ChoiceSet";
      })
      .map((rule) => {
        const flag = rule.flag || "choice";
        const flags = (item.flags?.pf2e as { rulesSelections?: Record<string, unknown> } | undefined)?.rulesSelections;
        const selection = flags && Object.hasOwn(flags, flag) ? flags[flag] : rule.selection;
        const isNullish = selection === null || selection === undefined;
        const defaultSelectionText = isNullish ? "none" : JSON.stringify(selection);
        const selectionText = typeof selection === "string" ? selection : defaultSelectionText;
        return `${flag}=${selectionText}`;
      });

    return selections.length > 0 ? selections.join(", ") : "none";
  }

  private onItemDelete(item: Item): void {
    const actor = item.actor;
    if (!actor || !this.isLinkedCharacterActor(actor)) return;
    if (isSyncActive(actor)) return;
    if (!this.writeAllowed("delete", actor.name)) return;

    const target = this.resolveDeletableItem(item);
    if (!target) return;

    // The item is already gone from Foundry by the time this hook fires, so the
    // prompt governs only whether the removal is propagated to Demiplane. Guarding
    // a destructive, hard-to-reverse write behind explicit confirmation is the
    // whole point of this handler; write to Demiplane only if the user confirms.
    void this.confirmAndQueueDelete(actor, item.name ?? "item", target);
  }

  /**
   * The details needed to propagate a deleted item to Demiplane, or `undefined`
   * when the deletion must not be propagated. Only a Demiplane-controlled
   * inventory item with a resolvable slug qualifies; each skip is logged.
   *
   * - Non-inventory items (feats, class, deity, …) are never pushed — deity in
   *   particular is build-derived, so a local delete must not clear it remotely.
   * - A homemade item (no `imported` flag) was never on Demiplane, so deleting
   *   it must not push a removal there even if its slug happens to resolve.
   */
  private resolveDeletableItem(item: Item): DeletableItem | undefined {
    const itemType = (item as { type?: string })?.type;
    if (!itemType || !INVENTORY_ITEM_TYPES.has(itemType)) {
      debugLog(`Item deleted from linked actor (not inventory, skipping push): ${item.name} (type=${itemType})`);
      return undefined;
    }

    const dpFlags = (item.flags?.[MODULE_ID] as { demiplaneSlug?: unknown; imported?: unknown } | undefined) ?? {};
    if (dpFlags.imported !== true) {
      debugLog(`Item deleted from linked actor (not Demiplane-controlled, skipping push): ${item.name}`);
      return undefined;
    }

    const demiplaneSlug = typeof dpFlags.demiplaneSlug === "string" ? dpFlags.demiplaneSlug : undefined;
    const slug = itemSystem(item).slug ?? undefined;
    const slot = demiplaneSlug ?? slug;
    if (!slot) {
      debugLog(`Item deleted from linked actor (no demiplane slug, skipping push): ${item.name}`);
      return undefined;
    }
    return { slot, slug, demiplaneSlug, itemType };
  }

  /**
   * Propagates a deleted inventory item to Demiplane. Only reached for a
   * Demiplane-controlled inventory item deleted while the write level permits
   * deletions and no import/sync is in flight.
   *
   * In soft-delete mode the item's Demiplane quantity is set to 0 — a reversible
   * change with no data loss (it's restored by raising the quantity), so it
   * needs no confirmation and is queued immediately. A hard delete is
   * irreversible from here, so it stays behind an explicit confirmation dialog.
   */
  private async confirmAndQueueDelete(actor: Actor, itemName: string, target: DeletableItem): Promise<void> {
    if (isSoftDeleteEnabled() && typeof target.slug === "string") {
      debugLog(`Item soft-deleted (quantity 0) on Demiplane, no prompt: ${itemName} (${target.slot})`);
      this.exportManager.queueItemChange(actor, target.slug, target.demiplaneSlug, "quantity", 0, target.itemType);
      return;
    }

    if (!(await this.confirmHardDelete(actor, itemName))) {
      debugLog(`Item delete NOT propagated (user declined): ${itemName} (${target.slot})`);
      return;
    }

    debugLog(`Item deleted from linked actor: ${itemName} (${target.slot})`);
    this.exportManager.queueItemDelete(actor, target.slot);
  }

  /**
   * Confirms an irreversible hard delete of an inventory item on Demiplane.
   * Returns true only when the user explicitly chooses to delete.
   *
   * Uses `DialogV2.wait` with an explicit buttons array (rather than the confirm
   * shorthand) so `default: true` both focuses "Keep on Demiplane" for Enter AND
   * gives it the highlighted default-button styling. "Keep" is the safe,
   * non-destructive choice, so it is the default.
   */
  private async confirmHardDelete(actor: Actor, itemName: string): Promise<boolean> {
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: "Delete on Demiplane?" },
      // Constrain the width so long item/actor names and body text wrap instead
      // of stretching the dialog across the screen (DialogV2 sizes to content).
      content:
        `<div style="max-width:26em;">` +
        `<div style="display:flex;align-items:flex-start;gap:0.75em;">` +
        `<img src="${DEMIPLANE_ICON_SRC}" alt="Demiplane" style="height:2.8em;width:2.8em;flex:0 0 auto;border:none;" />` +
        `<p style="margin:0;">Remove <strong>${itemName}</strong> from <strong>${actor.name}</strong> on Demiplane too?</p>` +
        `</div>` +
        `<p>This deletes the item from the linked Demiplane character. It can't be undone from here — you'd have to re-add it in Demiplane.</p>` +
        `<p>If you keep it on Demiplane, it will reappear here the next time this character is updated from Demiplane.</p>` +
        `</div>`,
      buttons: [
        { action: "delete", label: "Delete on Demiplane", icon: "fa-solid fa-trash" },
        { action: "keep", label: "Keep on Demiplane", icon: "fa-solid fa-cloud", default: true },
      ],
    });

    return choice === "delete";
  }

  private isLinkedCharacterActor(actor: Actor): boolean {
    if (actor.type !== "character") return false;
    const characterId = actor.getFlag(MODULE_ID, "characterId");
    return characterId !== undefined && characterId !== null;
  }

  /**
   * Whether the active write level permits `kind`. When it doesn't, logs a calm,
   * reassuring note (so a reader of the console sees the change was noticed and
   * deliberately not pushed) rather than staying silent or hinting at a push
   * that never happens.
   */
  private writeAllowed(kind: "text" | "quantity" | "delete", actorName: string | null | undefined): boolean {
    const predicate: Record<typeof kind, () => boolean> = {
      text: canWriteText,
      quantity: canWriteQuantity,
      delete: canWriteDeletes,
    };
    if (predicate[kind]()) return true;
    debugLog(
      `"${actorName ?? "character"}" changed (${kind}), but the write level does not permit it — nothing pushed to Demiplane.`
    );
    return false;
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
