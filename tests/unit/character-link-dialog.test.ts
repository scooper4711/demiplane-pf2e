import { describe, it, expect, beforeEach, vi } from "vitest";
import { CharacterLinkDialog } from "../../src/character-link-dialog.js";

const DEMI_UUID = "12345678-1234-1234-1234-123456789012";

function makeWait(clickedAction: string) {
  return vi.fn(async (opts: { buttons: Array<{ action: string; callback?: (...a: unknown[]) => unknown }> }) => {
    const btn = opts.buttons.find((b) => b.action === clickedAction);
    if (!btn) return null;
    if (!btn.callback) return btn.action;
    return await btn.callback({}, {}, { element: { querySelector: () => ({ value: DEMI_UUID }) } });
  });
}

describe("CharacterLinkDialog", () => {
  let client: { fetchCharacterVersion: ReturnType<typeof vi.fn>; setToken: ReturnType<typeof vi.fn> };
  let actor: {
    id: string;
    getFlag: ReturnType<typeof vi.fn>;
    setFlag: ReturnType<typeof vi.fn>;
    unsetFlag: ReturnType<typeof vi.fn>;
  };
  let wait: ReturnType<typeof vi.fn>;
  let clickedAction: string;

  beforeEach(() => {
    client = {
      setToken: vi.fn(),
      fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 1 }),
    };
    actor = {
      id: "self",
      getFlag: vi.fn().mockImplementation((_m: string, key: string) => (key === "characterId" ? undefined : undefined)),
      setFlag: vi.fn().mockResolvedValue(undefined),
      unsetFlag: vi.fn().mockResolvedValue(undefined),
    };
    clickedAction = "link";
    wait = makeWait(clickedAction);
    (globalThis as unknown as { foundry: { applications: { api: { DialogV2: { wait: unknown } } } } }).foundry = {
      applications: { api: { DialogV2: { wait } } },
    };
    (globalThis as unknown as { ui: { notifications: Record<string, ReturnType<typeof vi.fn>> } }).ui = {
      notifications: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    };
  });

  it("links a valid UUID after verifying it exists on Demiplane", async () => {
    const dlg = new CharacterLinkDialog(client as never);
    await dlg.open(actor as never);
    expect(client.fetchCharacterVersion).toHaveBeenCalledWith(DEMI_UUID);
    expect(actor.setFlag).toHaveBeenCalledWith("demiplane-pf2e", "characterId", DEMI_UUID);
    expect(ui.notifications.info).toHaveBeenCalledWith(`Character linked: ${DEMI_UUID}`);
  });

  it("reports an error and does not link on invalid input", async () => {
    clickedAction = "link";
    wait = makeWait("link");
    (
      globalThis as unknown as { foundry: { applications: { api: { DialogV2: { wait: unknown } } } } }
    ).foundry.applications.api.DialogV2.wait = wait;
    wait.mockImplementationOnce(async () => "not-a-uuid");
    const dlg = new CharacterLinkDialog(client as never);
    await dlg.open(actor as never);
    expect(client.fetchCharacterVersion).not.toHaveBeenCalled();
    expect(actor.setFlag).not.toHaveBeenCalled();
    expect(ui.notifications.error).toHaveBeenCalled();
  });

  it("reports an error when Demiplane rejects the character", async () => {
    client.fetchCharacterVersion.mockRejectedValue(new Error("nope"));
    const dlg = new CharacterLinkDialog(client as never);
    await dlg.open(actor as never);
    expect(actor.setFlag).not.toHaveBeenCalled();
    expect(ui.notifications.error).toHaveBeenCalled();
  });

  it("unlinks when the unlink action is chosen", async () => {
    clickedAction = "unlink";
    wait = makeWait("unlink");
    (
      globalThis as unknown as { foundry: { applications: { api: { DialogV2: { wait: unknown } } } } }
    ).foundry.applications.api.DialogV2.wait = wait;
    const dlg = new CharacterLinkDialog(client as never);
    await dlg.open(actor as never);
    expect(actor.unsetFlag).toHaveBeenCalledWith("demiplane-pf2e", "characterId");
    expect(ui.notifications.info).toHaveBeenCalledWith("Character unlinked.");
  });

  it("refuses to link a character already linked to another actor", async () => {
    (globalThis as unknown as { game: unknown }).game = {
      actors: {
        contents: [
          {
            id: "other",
            name: "Other Actor",
            getFlag: (_m: string, key: string) => (key === "characterId" ? DEMI_UUID : undefined),
          },
        ],
      },
    };
    const dlg = new CharacterLinkDialog(client as never);
    await dlg.open(actor as never);
    expect(actor.setFlag).not.toHaveBeenCalled();
    expect(client.fetchCharacterVersion).not.toHaveBeenCalled();
    expect(ui.notifications.error).toHaveBeenCalled();
    delete (globalThis as unknown as { game?: unknown }).game;
  });
});
