import { MODULE_ID } from "../import/types.js";

const DEBOUNCE_MS = 2000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_CALLS = 30;

export interface PendingChange {
  field: string;
  value: number;
  timestamp: number;
}

export type ItemChangeType = "quantity" | "equipped" | "delete";

export interface EquippedState {
  carryType: string;
  handsHeld?: number | undefined;
  inSlot?: boolean | undefined;
}

export interface PendingItemChange {
  itemSlug: string;
  demiplaneSlug: string | undefined;
  changeType: ItemChangeType;
  value: number | string | EquippedState;
  itemType: string | undefined;
  /** True when queued from a user edit (vs. a bulk refresh). Used to gate edit-only warnings. */
  edited?: boolean;
  timestamp: number;
}

/**
 * Owns the per-character pending change maps, debounce timers, and rate-limit
 * tracking for the export path. Purely a buffer: it knows how to queue, peek,
 * clear, suspend/resume, and judge the rate limit, but has no opinion about how
 * the queued changes become a payload or how a push is retried.
 *
 * The debounce timer fires a flush callback supplied by the owner, so the
 * buffer never reaches into push orchestration.
 */
export class ChangeBuffer {
  private readonly pendingChanges: Map<string, Map<string, PendingChange>> = new Map();
  private readonly pendingItemChanges: Map<string, Map<string, PendingItemChange>> = new Map();
  private readonly debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly apiCallTimestamps: Map<string, number[]> = new Map();
  private readonly suspendCounts = new Map<string, number>();
  private readonly flushTrigger: (actor: Actor) => void;

  constructor(flushTrigger: (actor: Actor) => void) {
    this.flushTrigger = flushTrigger;
  }

  isSuspended(characterId: string): boolean {
    return (this.suspendCounts.get(characterId) ?? 0) > 0;
  }

  /**
   * Suppresses pushes for a single character while it is being re-imported, so
   * items created/deleted by the import are not echoed back to Demiplane.
   * Ref-counted and keyed per character so concurrent imports of different
   * actors (or an import racing a manual push) cannot prematurely resume
   * another character's exports.
   */
  suspend(characterId: string): void {
    const count = (this.suspendCounts.get(characterId) ?? 0) + 1;
    this.suspendCounts.set(characterId, count);
    if (count > 1) return; // already suppressed; keep the first suspension's state

    const timer = this.debounceTimers.get(characterId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(characterId);
    }
    this.pendingChanges.delete(characterId);
    this.pendingItemChanges.delete(characterId);
  }

  resume(characterId: string): void {
    const count = this.suspendCounts.get(characterId) ?? 0;
    if (count <= 1) this.suspendCounts.delete(characterId);
    else this.suspendCounts.set(characterId, count - 1);
  }

  private resolveCharacterId(actor: Actor): string | undefined {
    return actor.getFlag(MODULE_ID, "characterId") as string | undefined;
  }

  queueChange(actor: Actor, field: string, value: number): void {
    const characterId = this.resolveCharacterId(actor);
    if (!characterId) return;
    if (this.isSuspended(characterId)) return;

    if (!this.pendingChanges.has(characterId)) {
      this.pendingChanges.set(characterId, new Map());
    }

    this.pendingChanges.get(characterId)!.set(field, {
      field,
      value,
      timestamp: Date.now(),
    });

    this.scheduleFlush(actor, characterId);
  }

  queueItemChange(
    actor: Actor,
    itemSlug: string,
    demiplaneSlug: string | undefined,
    changeType: ItemChangeType,
    value: number | string | EquippedState,
    itemType?: string,
    edited?: boolean
  ): void {
    const characterId = this.resolveCharacterId(actor);
    if (!characterId) return;
    if (this.isSuspended(characterId)) return;

    const key = `${itemSlug}:${changeType}`;
    if (!this.pendingItemChanges.has(characterId)) {
      this.pendingItemChanges.set(characterId, new Map());
    }

    const entry: PendingItemChange = {
      itemSlug,
      demiplaneSlug,
      changeType,
      value,
      itemType,
      timestamp: Date.now(),
    };
    if (edited !== undefined) entry.edited = edited;

    this.pendingItemChanges.get(characterId)!.set(key, entry);
    this.scheduleFlush(actor, characterId);
  }

  /**
   * Queues the deletion of an item from Demiplane when it is removed from a
   * linked Foundry actor. The matching engine (and its related custom engines)
   * are stripped from the character data on the next push.
   *
   * @param actor - The linked actor the item was removed from.
   * @param slot - The demiplane/equipment slug of the deleted item.
   */
  queueItemDelete(actor: Actor, slot: string): void {
    if (!slot) return;

    const characterId = this.resolveCharacterId(actor);
    if (!characterId) return;
    if (this.isSuspended(characterId)) return;

    const key = `${slot}:delete`;
    if (!this.pendingItemChanges.has(characterId)) {
      this.pendingItemChanges.set(characterId, new Map());
    }
    this.pendingItemChanges.get(characterId)!.set(key, {
      itemSlug: slot,
      demiplaneSlug: slot,
      changeType: "delete",
      value: 0,
      itemType: undefined,
      timestamp: Date.now(),
    });
    this.scheduleFlush(actor, characterId);
  }

  /** Re-arms the debounce timer for a character (used to defer a flush). */
  rearmFlush(actor: Actor, characterId: string): void {
    this.scheduleFlush(actor, characterId);
  }

  private scheduleFlush(actor: Actor, characterId: string): void {
    const existingTimer = this.debounceTimers.get(characterId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(characterId);
      this.flushTrigger(actor);
    }, DEBOUNCE_MS);

    this.debounceTimers.set(characterId, timer);
  }

  clearDebounceTimer(characterId: string): void {
    const timer = this.debounceTimers.get(characterId);
    if (!timer) return;
    clearTimeout(timer);
    this.debounceTimers.delete(characterId);
  }

  /** Returns the current pending field/item change maps for a character (or undefined). */
  peek(characterId: string): {
    changes: Map<string, PendingChange> | undefined;
    itemChanges: Map<string, PendingItemChange> | undefined;
  } {
    return {
      changes: this.pendingChanges.get(characterId),
      itemChanges: this.pendingItemChanges.get(characterId),
    };
  }

  /** Drops all pending changes for a character (field + item). */
  clear(characterId: string): void {
    this.pendingChanges.delete(characterId);
    this.pendingItemChanges.delete(characterId);
  }

  getPendingChanges(characterId: string): PendingChange[] {
    const changes = this.pendingChanges.get(characterId);
    return changes ? Array.from(changes.values()) : [];
  }

  hasPendingChanges(characterId: string): boolean {
    const changes = this.pendingChanges.get(characterId);
    return changes !== undefined && changes.size > 0;
  }

  /** Whether a character has any buffered field or item changes to push. */
  hasPendingWork(characterId: string): boolean {
    const changes = this.pendingChanges.get(characterId);
    const itemChanges = this.pendingItemChanges.get(characterId);
    return (changes !== undefined && changes.size > 0) || (itemChanges !== undefined && itemChanges.size > 0);
  }

  isWithinRateLimit(characterId: string): boolean {
    const timestamps = this.apiCallTimestamps.get(characterId) ?? [];
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    const recentCalls = timestamps.filter((t) => t > windowStart);
    this.apiCallTimestamps.set(characterId, recentCalls);
    return recentCalls.length < RATE_LIMIT_MAX_CALLS;
  }

  recordApiCall(characterId: string): void {
    const timestamps = this.apiCallTimestamps.get(characterId) ?? [];
    timestamps.push(Date.now());
    this.apiCallTimestamps.set(characterId, timestamps);
  }
}
