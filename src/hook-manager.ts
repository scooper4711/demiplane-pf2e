/* eslint-disable max-lines -- Hook reactions plus their manual-push re-queue helpers are cohesive; per-capability gating is inherently branchy and splitting would scatter one concern */
import { MODULE_ID, INVENTORY_ITEM_TYPES } from "./import/types.js";
import { debugLog } from "./import/debug-log.js";
import type { ExportManager } from "./export-manager.js";
import type { EquippedState } from "./export/change-buffer.js";
import { isSyncActive } from "./sync-pause.js";
import {
  canWriteBiography,
  canWriteLanguages,
  canWriteOrganizedPlayId,
  canWriteCampaignNotes,
  canWriteHitPoints,
  canWriteHeroPoints,
  canWriteFocusPoints,
  canWriteCurrency,
  canWriteSpellSlots,
  canWriteInventoryQuantity,
  canWriteInventoryEquipped,
  canWriteInventoryContainer,
  canSoftDeleteInventory,
  canDeleteInventory,
  isWritingEnabled,
} from "./write-level.js";
import { DEMIPLANE_ICON_SRC } from "./config.js";
import { characterSystem, itemSystem, localizeLanguage } from "./pf2e-types.js";
import { queueSpellcastingEntryChanges, queueSpellSlotResync } from "./export/spellcasting-entry-sync.js";

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

const STORY_FIELD_MAPPINGS: Record<string, string> = {
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

/**
 * Session-tier actor fields: everything ending in "points" (hit points,
 * temporary hit points, hero points, focus points). Each entry names its own
 * write capability so permissions move independently.
 */
const POINT_FIELD_WRITERS: Array<{ path: string; store: string; can: () => boolean; label: string }> = [
  {
    path: "system.attributes.hp.value",
    store: "character_hit-points_current",
    can: canWriteHitPoints,
    label: "hit points",
  },
  {
    path: "system.attributes.hp.temp",
    store: "character_hit-points_temp",
    can: canWriteHitPoints,
    label: "hit points",
  },
  {
    path: "system.resources.heroPoints.value",
    store: "character_hero-points",
    can: canWriteHeroPoints,
    label: "hero points",
  },
  {
    path: "system.resources.focus.value",
    store: "character_focus_current",
    can: canWriteFocusPoints,
    label: "focus points",
  },
];

const TREASURE_ITEM_MAP: Record<string, string> = {
  "platinum-pieces": "character_currency_platinum",
  "gold-pieces": "character_currency_gold",
  "silver-pieces": "character_currency_silver",
  "copper-pieces": "character_currency_copper",
};

// INVENTORY_ITEM_TYPES (the physical/inventory item `type`s eligible for delete
// propagation) is defined in import/types.js as the single source of truth.

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
 * Queues current HP, temporary HP, hero points, and focus points from a linked
 * actor so they can be flushed immediately (manual push / exportNow). Each
 * resource checks its own capability so permissions move independently.
 */
export function queueCombatResourceChanges(exportManager: ExportManager, actor: Actor): void {
  // Points fields are session-tier: a manual push at story mode must not write
  // them (the master switch in exportLinkedCharacter only blocks read-only, so
  // each re-queue entry point enforces its own capability).
  const hitPoints = characterSystem(actor).attributes?.hp;
  if (canWriteHitPoints()) {
    if (typeof hitPoints?.value === "number") {
      exportManager.queueChange(actor, "character_hit-points_current", hitPoints.value);
    }
    if (typeof hitPoints?.temp === "number") {
      exportManager.queueChange(actor, "character_hit-points_temp", hitPoints.temp);
    }
  }
  const heroPoints = characterSystem(actor).resources?.heroPoints?.value;
  if (canWriteHeroPoints() && typeof heroPoints === "number") {
    exportManager.queueChange(actor, "character_hero-points", heroPoints);
  }
  const focus = characterSystem(actor).resources?.focus?.value;
  if (canWriteFocusPoints() && typeof focus === "number") {
    exportManager.queueChange(actor, "character_focus_current", focus);
  }
}

/**
 * Queues quantity and equipped-state changes for every syncable item on a
 * linked actor so a manual push re-syncs full item state (including hand
 * slots) rather than only combat resources.
 */
export function queueAllItemChanges(exportManager: ExportManager, actor: Actor): void {
  // Levels apply to manual pushes too: each aspect checks its own capability.
  // Without gating, a manual push at story mode would leak session writes past
  // the bound.
  if (
    !canWriteInventoryQuantity() &&
    !canWriteCurrency() &&
    !canWriteInventoryEquipped() &&
    !canWriteInventoryContainer() &&
    !canWriteSpellSlots()
  ) {
    return;
  }
  // `actor.items` is typed as the common base collection, but at runtime (and
  // in the PF2e system) every entry is a client Item. Narrow once here so the
  // PF2e field reads below type-check.
  // eslint-disable-next-line no-restricted-syntax -- base-collection → client Item narrowing; runtime-guaranteed
  const items = Array.from(actor.items) as unknown as Item[];
  for (const item of items) {
    queueSingleItemChanges(exportManager, actor, item);
    if (canWriteSpellSlots()) queueSpellSlotResync(exportManager, actor, item);
  }
}

function queueSingleItemChanges(exportManager: ExportManager, actor: Actor, item: Item): void {
  const system = itemSystem(item);
  const slug = system?.slug;
  if (typeof slug !== "string") return;

  const dpFlags = (item.flags?.[MODULE_ID] as { demiplaneSlug?: unknown } | undefined) ?? {};
  const demiplaneSlug = typeof dpFlags.demiplaneSlug === "string" ? dpFlags.demiplaneSlug : undefined;

  if (typeof system?.quantity === "number") {
    if (slug in TREASURE_ITEM_MAP) {
      if (!canWriteCurrency()) return;
      exportManager.queueChange(actor, TREASURE_ITEM_MAP[slug]!, system.quantity);
    } else {
      if (!canWriteInventoryQuantity()) return;
      exportManager.queueItemChange(actor, slug, demiplaneSlug, "quantity", system.quantity);
    }
  }

  if (canWriteInventoryEquipped()) {
    queueEquippedIfChanged(exportManager, actor, item, slug, demiplaneSlug, system);
  }
  if (canWriteInventoryContainer()) {
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
    exportManager.queueItemChange(actor, slug, demiplaneSlug, "container", { containerEngineId: null }, item.type);
    return;
  }

  const containerEngineId = resolveContainerEngineId(actor, containerId);
  if (containerEngineId === null) return;
  exportManager.queueItemChange(actor, slug, demiplaneSlug, "container", { containerEngineId }, item.type);
}

/**
 * Resolves a Foundry container item id to the container's unique Demiplane engine
 * id (stamped on the container at import), which the push matches against the
 * character's item engines. Returns null when the container can't be resolved or
 * wasn't imported from Demiplane. An engine id — not a slug — is used so two
 * containers sharing a base type (two backpacks, two pouches) stay distinct.
 * Shared by the per-edit hook and the full re-sync path.
 */
function resolveContainerEngineId(actor: Actor, containerId: string): string | null {
  const container = actor.items.get(containerId);
  if (!container) return null;
  const flags = (container.flags?.[MODULE_ID] as { demiplaneEngineId?: unknown } | undefined) ?? {};
  return typeof flags.demiplaneEngineId === "string" ? flags.demiplaneEngineId : null;
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
  // Each detail aspect checks its own capability so permissions move
  // independently; a manual push below every detail capability writes nothing.
  if (!canWriteBiography() && !canWriteOrganizedPlayId() && !canWriteLanguages()) return;
  queueMappedDetailFields(exportManager, actor);
  queueOrganizedPlayId(exportManager, actor);
  queueAdditionalLanguages(exportManager, actor);
}

/** Queues each STORY_FIELD_MAPPINGS field from the actor's current value. */
function queueMappedDetailFields(exportManager: ExportManager, actor: Actor): void {
  if (!canWriteBiography()) return;
  for (const [actorPath, storeName] of Object.entries(STORY_FIELD_MAPPINGS)) {
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
  if (!canWriteOrganizedPlayId()) return;
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
  if (!canWriteLanguages()) return;
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
    // Checked before the capability guards so an import doesn't log a misleading
    // "nothing pushed" note for its own writes.
    if (isSyncActive(actor)) return;
    if (!isWritingEnabled()) {
      debugLog(
        `"${actor.name ?? "character"}" changed, but writing to Demiplane is off — nothing pushed to Demiplane.`
      );
      return;
    }

    if (canWriteBiography()) {
      for (const [actorPath, storeName] of Object.entries(STORY_FIELD_MAPPINGS)) {
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
    } else if (this.touchedAny(changes, Object.keys(STORY_FIELD_MAPPINGS))) {
      debugLog(
        `"${actor.name ?? "character"}" changed (biography), but the write level does not permit it — nothing pushed to Demiplane.`
      );
    }

    // Points fields (HP, temp HP, hero points, focus) are session-tier: story
    // mode edits biography without touching adventuring-day state.
    this.queuePointChanges(actor, changes);

    // Organized play ID is a single Demiplane field ("123456-2001") that maps
    // to two Foundry fields (playerNumber + characterNumber).
    this.queueOrganizedPlayChange(actor, changes);

    // Campaign Notes maps to a "Campaign" journal entry, not an engine override.
    this.queueCampaignNotesChange(actor, changes);

    // Languages need the granted set subtracted, so they can't be a plain
    // STORY_FIELD_MAPPINGS entry.
    this.queueLanguagesChange(actor, changes);
  }

  /**
   * Queues points changes (HP, temp HP, hero points, focus) when present. Each
   * resource checks its own capability — and only when that resource actually
   * changed, so story-only edits never log a points denial.
   */
  private queuePointChanges(actor: Actor, changes: Record<string, unknown>): void {
    const denied = new Set<string>();
    let queued = false;
    for (const { path, store, can, label } of POINT_FIELD_WRITERS) {
      const value = this.getChangeValue(changes, path);
      if (value === undefined || value === null || (typeof value !== "number" && typeof value !== "string")) {
        continue;
      }
      if (!can()) {
        denied.add(label);
        continue;
      }
      this.exportManager.queueChange(actor, store, value);
      queued = true;
    }
    if (denied.size > 0 && !queued) {
      this.denyWrite([...denied].join(", "), actor.name);
    } else if (denied.size > 0) {
      debugLog(
        `"${actor.name ?? "character"}" changed (${[...denied].join(", ")}), but the write level does not permit it — those fields were not pushed to Demiplane.`
      );
    }
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
    if (!canWriteLanguages()) {
      this.denyWrite("languages", actor.name);
      return;
    }
    queueAdditionalLanguages(this.exportManager, actor);
  }

  private queueOrganizedPlayChange(actor: Actor, changes: Record<string, unknown>): void {
    const pfs = this.getChangeValue(changes, "system.pfs.playerNumber");
    const charNum = this.getChangeValue(changes, "system.pfs.characterNumber");
    if (pfs === undefined && charNum === undefined) return;
    if (!canWriteOrganizedPlayId()) {
      this.denyWrite("organized play ID", actor.name);
      return;
    }

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
    if (!canWriteCampaignNotes()) {
      this.denyWrite("campaign notes", actor.name);
      return;
    }
    void this.exportManager.exportCampaignNotes(actor, notes);
  }

  private onItemUpdate(item: Item, changes: Record<string, unknown>): void {
    const actor = item.actor;
    if (!actor || !this.isLinkedCharacterActor(actor)) return;
    if (isSyncActive(actor)) return;

    // A spellcasting entry has no slug; its updates carry cast/expended slot
    // changes (prepared casters) or remaining-slot changes (spontaneous casters),
    // gated on the spell-slots capability inside the extracted handler rather
    // than by the physical-item guards below.
    if ((item as { type?: string }).type === "spellcastingEntry") {
      queueSpellcastingEntryChanges(this.exportManager, actor, item, changes);
      return;
    }

    const slug = itemSystem(item).slug ?? undefined;
    const dpFlags = (item.flags?.[MODULE_ID] as { demiplaneSlug?: unknown } | undefined) ?? {};
    const demiplaneSlug = typeof dpFlags?.demiplaneSlug === "string" ? dpFlags.demiplaneSlug : undefined;

    this.queueQuantityChange(actor, slug, demiplaneSlug, changes);
    this.queueEquippedUpdate(item, actor, slug, demiplaneSlug, changes);
    this.queueContainerUpdate(item, actor, slug, demiplaneSlug, changes);
  }

  /** Queues a quantity change, distinguishing currency (treasure) from inventory. */
  private queueQuantityChange(
    actor: Actor,
    slug: string | undefined,
    demiplaneSlug: string | undefined,
    changes: Record<string, unknown>
  ): void {
    const quantity = this.getNestedValue(changes, "system.quantity");
    if (typeof quantity !== "number" || typeof slug !== "string") return;
    if (slug in TREASURE_ITEM_MAP) {
      if (!canWriteCurrency()) {
        this.denyWrite("currency", actor.name);
        return;
      }
      this.exportManager.queueChange(actor, TREASURE_ITEM_MAP[slug]!, quantity);
      return;
    }
    if (!canWriteInventoryQuantity()) {
      this.denyWrite("inventory quantity", actor.name);
      return;
    }
    this.exportManager.queueItemChange(actor, slug, demiplaneSlug, "quantity", quantity, undefined, true);
  }

  /** Queues an equipped-state change when one is present and permitted. */
  private queueEquippedUpdate(
    item: Item,
    actor: Actor,
    slug: string | undefined,
    demiplaneSlug: string | undefined,
    changes: Record<string, unknown>
  ): void {
    if (!this.equippedChanged(changes) || typeof slug !== "string") return;
    if (!canWriteInventoryEquipped()) {
      this.denyWrite("equipped state", actor.name);
      return;
    }
    this.handleEquippedChange(item, actor, slug, demiplaneSlug, changes);
  }

  /** Queues a container move when one is present and permitted. */
  private queueContainerUpdate(
    item: Item,
    actor: Actor,
    slug: string | undefined,
    demiplaneSlug: string | undefined,
    changes: Record<string, unknown>
  ): void {
    if (!this.containerIdChanged(changes) || typeof slug !== "string") return;
    if (!canWriteInventoryContainer()) {
      this.denyWrite("container placement", actor.name);
      return;
    }
    this.handleContainerChange(item, actor, slug, demiplaneSlug, changes);
  }

  /** Whether an item update touched equipped state (as a flat key or nested). */
  private equippedChanged(changes: Record<string, unknown>): boolean {
    return (
      Object.keys(changes).some((key) => key === "system.equipped" || key.startsWith("system.equipped.")) ||
      this.getNestedValue(changes, "system.equipped") !== undefined
    );
  }

  /**
   * Queues a container move when an item's `system.containerId` changes: moved
   * into a container, out to the top level, or from one container to another.
   * This is an item update (not a delete), so it rides the container capability
   * like equipped/quantity edits — the guard is already applied in `onItemUpdate`.
   *
   * The queued value carries the target container's unique Demiplane engine id
   * (read from the container item's import stamp) so the push writes the right
   * container even when several share a base type; `null` means top-level (moved
   * out of any container).
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
    const containerEngineId = containerId === null ? null : resolveContainerEngineId(actor, containerId);

    debugLog(`Container change: ${slug} -> container=${containerEngineId ?? "(top level)"}`);
    this.exportManager.queueItemChange(actor, slug, demiplaneSlug, "container", { containerEngineId }, item.type);
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
    if (!this.equippedChanged(changes) || typeof slug !== "string") return;

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

  private onItemCreate(item: Item): void {
    const actor = item.actor;
    if (!actor || !this.isLinkedCharacterActor(actor)) return;
    if (isSyncActive(actor)) return;
    // Creates are never pushed to Demiplane (only logged for diagnostics); the
    // writing-enabled gate keeps the console note consistent with the other handlers.
    if (!isWritingEnabled()) {
      this.denyWrite("item creation", actor.name);
      return;
    }
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
    // Deletion needs a delete capability: soft delete (quantity 0) or hard
    // delete. Below those levels the deletion stays local.
    if (!canSoftDeleteInventory() && !canDeleteInventory()) {
      this.denyWrite("item deletion", actor.name);
      return;
    }

    const target = this.resolveDeletableItem(item);
    if (!target) return;

    // The item is already gone from Foundry by the time this hook fires, so this
    // governs only whether the removal is propagated to Demiplane. Soft-delete
    // queues immediately (reversible); hard delete prompts first (below).
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
   * Demiplane-controlled inventory item deleted while a delete capability is
   * permitted and no import/sync is in flight.
   *
   * A soft delete sets the item's Demiplane quantity to 0 — a reversible
   * change with no data loss (it's restored by raising the quantity), so it
   * needs no confirmation and is queued immediately. A hard delete is
   * irreversible from here, so it stays behind an explicit confirmation
   * dialog.
   */
  private async confirmAndQueueDelete(actor: Actor, itemName: string, target: DeletableItem): Promise<void> {
    if (!canDeleteInventory() && typeof target.slug === "string") {
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
   * Logs a calm, reassuring note when a change was noticed but deliberately not
   * pushed (so a reader of the console sees it wasn't missed) rather than
   * staying silent or hinting at a push that never happens.
   */
  private denyWrite(what: string, actorName: string | null | undefined): void {
    debugLog(
      `"${actorName ?? "character"}" changed (${what}), but the write level does not permit it — nothing pushed to Demiplane.`
    );
  }

  /** Whether an actor-update payload touched any of the given change paths. */
  private touchedAny(changes: Record<string, unknown>, paths: string[]): boolean {
    return paths.some((path) => this.getChangeValue(changes, path) !== undefined);
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
