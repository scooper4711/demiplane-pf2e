import { MODULE_ID } from "./import/types.js";

/**
 * Cross-client sync coordination.
 *
 * When a character is imported or pushed on one client, the actor changes are
 * replicated to every other connected client. On those clients the normal
 * session-state hooks would queue a push back to Demiplane, which updates the
 * server, which can trigger yet another import — an infinite update loop.
 *
 * To break the loop we mark the character as "syncing" on the actor document
 * itself. Actor flags replicate to all clients, so any client that sees the mark
 * pauses its own pushes (and imports) for that character until the sync ends.
 *
 * A per-character *array* of sync tokens (one per in-flight sync) is used rather
 * than a single boolean so that two clients syncing the same character
 * concurrently do not clear each other's mark. `beginSyncPause` adds our token;
 * `endSyncPause` removes exactly that token.
 */

const SYNC_TOKENS_FLAG = "syncActiveTokens";

/** characterId → the token this client added (so we never block our own sync). */
const localTokens = new Map<string, string>();

function newToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `t-${Date.now()}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function readTokens(actor: Actor | null | undefined): string[] {
  const raw = actor?.getFlag(MODULE_ID, SYNC_TOKENS_FLAG);
  return Array.isArray(raw) ? (raw as string[]) : [];
}

/** Marks `actor` as syncing (import or push) for all connected clients. */
export async function beginSyncPause(actor: Actor): Promise<void> {
  const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
  if (!characterId) return;
  const token = newToken();
  localTokens.set(characterId, token);
  const tokens = readTokens(actor);
  if (!tokens.includes(token)) tokens.push(token);
  await actor.setFlag(MODULE_ID, SYNC_TOKENS_FLAG, tokens);
}

/** Clears the mark set by `beginSyncPause` for `actor`. */
export async function endSyncPause(actor: Actor): Promise<void> {
  const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
  if (!characterId) return;
  const token = localTokens.get(characterId);
  localTokens.delete(characterId);
  const tokens = readTokens(actor).filter((t) => t !== token);
  try {
    await actor.setFlag(MODULE_ID, SYNC_TOKENS_FLAG, tokens);
  } catch {
    // Best-effort: a failed flag write should not abort the surrounding sync flow.
  }
}

/**
 * True when any client has an in-flight sync for this character. Used to block
 * hook-driven queueing everywhere, including on the client that started the sync.
 */
export function isSyncActive(actor: Actor | null | undefined): boolean {
  if (!actor) return false;
  const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
  if (characterId && localTokens.has(characterId)) return true;
  return readTokens(actor).length > 0;
}

/**
 * True only when a *different* client is syncing this character. Used by the
 * push path so we never block the sync our own client is actively performing.
 */
export function isRemoteSyncActive(actor: Actor | null | undefined): boolean {
  if (!actor) return false;
  const tokens = readTokens(actor);
  if (tokens.length === 0) return false;
  const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
  const myToken = characterId ? localTokens.get(characterId) : undefined;
  // True when some token belongs to a *different* client than this one.
  return tokens.some((t) => t !== myToken);
}

/** Recovery helper: clears any stale sync mark left by a crashed previous session. */
export async function clearSyncPause(actor: Actor): Promise<void> {
  const characterId = actor.getFlag(MODULE_ID, "characterId") as string | undefined;
  if (!characterId) return;
  localTokens.delete(characterId);
  try {
    await actor.setFlag(MODULE_ID, SYNC_TOKENS_FLAG, []);
  } catch {
    // ignore
  }
}
