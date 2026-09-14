import { describe, it, expect, beforeEach, vi } from "vitest";

// The notice's audience/edge logic is what's under test; its two collaborators
// (remote-sync detection and writer eligibility) are mocked so each test can set
// the scenario directly.
vi.mock("../../src/sync-pause.js", () => ({
  isRemoteSyncActive: vi.fn(),
}));
vi.mock("../../src/sync-election.js", () => ({
  isEligibleWriter: vi.fn(),
}));

import { registerSyncNotice } from "../../src/sync-notice.js";
import { isRemoteSyncActive } from "../../src/sync-pause.js";
import { isEligibleWriter } from "../../src/sync-election.js";
import { MODULE_ID } from "../../src/import/types.js";

const remoteActive = vi.mocked(isRemoteSyncActive);
const eligible = vi.mocked(isEligibleWriter);

let updateActorHandler: (actor: unknown, changes: unknown) => void;

function installHooks(): void {
  (globalThis as unknown as { Hooks: unknown }).Hooks = {
    on: (event: string, fn: (actor: unknown, changes: unknown) => void) => {
      if (event === "updateActor") updateActorHandler = fn;
    },
  };
}

const infoToast = vi.fn();

function installUi(): void {
  (globalThis as unknown as { ui: unknown }).ui = { notifications: { info: infoToast } };
  (globalThis as unknown as { game: unknown }).game = { user: { id: "me", name: "Me" } };
}

const actor = { id: "actor-1", name: "John Shieldman" };

/** An `updateActor` changes object setting syncActiveTokens to the given array. */
function tokensChange(tokens: string[]): Record<string, unknown> {
  return { flags: { [MODULE_ID]: { syncActiveTokens: tokens } } };
}

describe("sync-notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installHooks();
    installUi();
    registerSyncNotice();
  });

  it("warns an eligible non-writer when a sync starts, then clears when it finishes", () => {
    remoteActive.mockReturnValue(true); // a different client is doing the sync
    eligible.mockReturnValue(true); // this client could have been the writer

    updateActorHandler(actor, tokensChange(["t1"]));
    expect(infoToast).toHaveBeenCalledTimes(1);
    expect(infoToast.mock.calls[0][0]).toContain("hold off");

    remoteActive.mockReturnValue(false); // tokens now empty on the clear
    updateActorHandler(actor, tokensChange([]));
    expect(infoToast).toHaveBeenCalledTimes(2);
    expect(infoToast.mock.calls[1][0]).toContain("safe to edit");
  });

  it("does not warn the client performing the sync (not remote-active)", () => {
    remoteActive.mockReturnValue(false); // this IS the syncing client
    eligible.mockReturnValue(true);

    updateActorHandler(actor, tokensChange(["t1"]));
    // A subsequent clear must not emit an unpaired all-clear either.
    updateActorHandler(actor, tokensChange([]));
    expect(infoToast).not.toHaveBeenCalled();
  });

  it("does not warn a client that is not eligible to write the actor", () => {
    remoteActive.mockReturnValue(true);
    eligible.mockReturnValue(false); // e.g. a non-owning player

    updateActorHandler(actor, tokensChange(["t1"]));
    updateActorHandler(actor, tokensChange([]));
    expect(infoToast).not.toHaveBeenCalled();
  });

  it("warns only once across intermediate token additions", () => {
    remoteActive.mockReturnValue(true);
    eligible.mockReturnValue(true);

    updateActorHandler(actor, tokensChange(["t1"]));
    updateActorHandler(actor, tokensChange(["t1", "t2"])); // overlapping sync, still active
    expect(infoToast).toHaveBeenCalledTimes(1); // no second "hold off"
  });

  it("ignores actor updates that do not touch the sync-tokens flag", () => {
    remoteActive.mockReturnValue(true);
    eligible.mockReturnValue(true);

    updateActorHandler(actor, { flags: { [MODULE_ID]: { engineSig: "abc" } } });
    updateActorHandler(actor, { system: { attributes: { hp: { value: 10 } } } });
    expect(infoToast).not.toHaveBeenCalled();
  });

  it("does not emit an all-clear if it never warned (sync started before this client was eligible)", () => {
    // Rising edge missed / not eligible at start...
    eligible.mockReturnValue(false);
    remoteActive.mockReturnValue(true);
    updateActorHandler(actor, tokensChange(["t1"]));
    expect(infoToast).not.toHaveBeenCalled();

    // ...so the falling edge must not produce a lone "safe to edit" toast.
    updateActorHandler(actor, tokensChange([]));
    expect(infoToast).not.toHaveBeenCalled();
  });
});
