import { MODULE_ID } from "./import/types.js";
import { isRemoteSyncActive } from "./sync-pause.js";
import { isEligibleWriter } from "./sync-election.js";

/**
 * Tells the other eligible writers when a sync (import, push, or conflict
 * re-import) begins on a character, and again when it finishes, so a character
 * being rewritten out from under them is never silent and they know when it is
 * safe to edit again.
 *
 * The client actually performing the sync already surfaces its own start/finish
 * notifications (see sync-flows). Everyone *else* who could have been the writer
 * — other GMs, Assistant GMs, and the character's owning player — previously saw
 * their actor's HP, spells, and inventory change with no explanation. This hook
 * closes that gap with a paired "hold off" / "all clear" toast.
 *
 * The audience is exactly {@link isEligibleWriter} minus the elected writer, so
 * it stays in lockstep with the election rule rather than re-deriving it.
 */
export function registerSyncNotice(): void {
  const notice = new SyncNotice();
  Hooks.on("updateActor", ((actor: Actor, changes: Record<string, unknown>) => {
    notice.onActorUpdate(actor, changes);
  }) as (...args: unknown[]) => void);
}

/**
 * Emits the paired hold-off / all-clear toasts, tracking per-actor whether this
 * client has an outstanding "hold off" so it only clears one it actually showed.
 * A class (not free functions) so the per-actor state has a clear owner.
 */
class SyncNotice {
  /**
   * Actor ids for which this client has shown a "hold off" toast and not yet
   * shown the matching "all clear". Guards against emitting an unpaired all-clear
   * (e.g. the falling edge of a sync that started before this client eligible)
   * and against re-toasting on intermediate token-count changes.
   */
  private readonly warned = new Set<string>();

  onActorUpdate(actor: Actor, changes: Record<string, unknown>): void {
    if (!syncTokensChanged(changes)) return;
    const actorId = (actor as { id?: string }).id;
    if (!actorId) return;

    const active = syncTokensNowActive(changes);
    if (active) {
      this.onSyncStarted(actor, actorId);
    } else {
      this.onSyncFinished(actor, actorId);
    }
  }

  /** Rising edge: a sync just began. Warn the eligible non-writers once. */
  private onSyncStarted(actor: Actor, actorId: string): void {
    if (this.warned.has(actorId)) return; // already warned; an intermediate token add
    // The elected writer is the client that set the token and already has its
    // own sync-flow notifications; `isRemoteSyncActive` is false for it.
    if (!isRemoteSyncActive(actor)) return;
    const me = game.user;
    if (!me || !isEligibleWriter(me, actor)) return;

    this.warned.add(actorId);
    ui.notifications.info(`"${actor.name}" is being updated from Demiplane — hold off on changes until it finishes.`);
  }

  /** Falling edge: the sync finished. Clear only if this client warned. */
  private onSyncFinished(actor: Actor, actorId: string): void {
    if (!this.warned.delete(actorId)) return; // never warned here — nothing to clear
    ui.notifications.info(`"${actor.name}" finished updating from Demiplane — safe to edit again.`);
  }
}

/** Whether this actor update touched the module's `syncActiveTokens` flag at all. */
function syncTokensChanged(changes: Record<string, unknown>): boolean {
  return readSyncTokens(changes) !== undefined;
}

/** Whether the update left `syncActiveTokens` non-empty (a sync is now in flight). */
function syncTokensNowActive(changes: Record<string, unknown>): boolean {
  const tokens = readSyncTokens(changes);
  return Array.isArray(tokens) && tokens.length > 0;
}

/** Reads the new `syncActiveTokens` value out of an `updateActor` changes object, if present. */
function readSyncTokens(changes: Record<string, unknown>): unknown {
  const flags = changes.flags as Record<string, Record<string, unknown>> | undefined;
  const moduleFlags = flags?.[MODULE_ID];
  if (!moduleFlags || !("syncActiveTokens" in moduleFlags)) return undefined;
  return moduleFlags.syncActiveTokens;
}
