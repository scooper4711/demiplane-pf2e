import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  beginSyncPause,
  endSyncPause,
  isSyncActive,
  isRemoteSyncActive,
  clearSyncPause,
} from "../../src/sync-pause.js";

function makeActor(characterId: string | null, flags: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...flags };
  if (characterId !== null) store.characterId = characterId;
  return {
    getFlag: (_m: string, key: string) => store[key],
    setFlag: vi.fn(async (_m: string, key: string, value: unknown) => {
      store[key] = value;
      return value;
    }),
    _store: store,
  } as unknown as Actor & { _store: Record<string, unknown> };
}

const tokensOf = (actor: ReturnType<typeof makeActor>) =>
  (actor._store["syncActiveTokens"] as string[] | undefined) ?? [];

describe("sync-pause", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("beginSyncPause marks the character syncing for all clients", async () => {
    const actor = makeActor("char-1");
    await beginSyncPause(actor);

    expect(tokensOf(actor)).toHaveLength(1);
    expect(isSyncActive(actor)).toBe(true);
  });

  it("endSyncPause removes only our token and clears the active state", async () => {
    const actor = makeActor("char-2");
    await beginSyncPause(actor);
    await endSyncPause(actor);

    expect(tokensOf(actor)).toHaveLength(0);
    expect(isSyncActive(actor)).toBe(false);
  });

  it("does not treat our own in-flight sync as a remote one", async () => {
    const actor = makeActor("char-3");
    await beginSyncPause(actor);

    // Our flush must never be blocked by the mark we just set.
    expect(isRemoteSyncActive(actor)).toBe(false);
  });

  it("is a no-op for an actor with no linked character", async () => {
    const actor = makeActor(null);
    await beginSyncPause(actor);
    expect(isSyncActive(actor)).toBe(false);
    expect(tokensOf(actor)).toHaveLength(0);
  });

  it("does not clobber another client's sync token", async () => {
    const actor = makeActor("char-4", { syncActiveTokens: ["remote-token"] });
    expect(isRemoteSyncActive(actor)).toBe(true);

    // We begin our own sync while the remote one is active.
    await beginSyncPause(actor);
    expect(isRemoteSyncActive(actor)).toBe(true);

    // Ending our sync must leave the remote token intact.
    await endSyncPause(actor);
    expect(tokensOf(actor)).toEqual(["remote-token"]);
    expect(isRemoteSyncActive(actor)).toBe(true);
  });

  it("clearSyncPause empties all tokens", async () => {
    const actor = makeActor("char-5", { syncActiveTokens: ["stale-token"] });
    await clearSyncPause(actor);
    expect(tokensOf(actor)).toEqual([]);
    expect(isSyncActive(actor)).toBe(false);
  });
});
