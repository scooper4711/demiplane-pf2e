import { describe, it, expect, afterEach, vi } from "vitest";
import { readConfiguredToken, syncClientToken } from "../../src/token-source.js";
import { MODULE_ID } from "../../src/import/types.js";

/** Minimal client stand-in that records the last token it was given. */
function createClientSpy() {
  const setToken = vi.fn();
  return { setToken, isAuthenticated: vi.fn() } as {
    setToken: typeof setToken;
    isAuthenticated: ReturnType<typeof vi.fn>;
  };
}

/** Stubs game.settings.get to return `value` for the demiplaneToken key. */
function stubTokenSetting(value: unknown): void {
  vi.stubGlobal("game", {
    settings: {
      get: (_moduleId: string, key: string) => (key === "demiplaneToken" ? value : undefined),
    },
  });
}

describe("token-source", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("readConfiguredToken", () => {
    it("normalizes the configured token (trim + strip Bearer)", () => {
      stubTokenSetting("  Bearer abc.def.ghi  ");
      expect(readConfiguredToken()).toBe("abc.def.ghi");
    });

    it("returns an empty string when the setting is unset", () => {
      stubTokenSetting(undefined);
      expect(readConfiguredToken()).toBe("");
    });
  });

  describe("syncClientToken", () => {
    it("pushes the normalized token into the client and reports it configured", () => {
      stubTokenSetting("Bearer abc.def.ghi");
      const client = createClientSpy();

      const configured = syncClientToken(client as never);

      expect(configured).toBe(true);
      expect(client.setToken).toHaveBeenCalledWith("abc.def.ghi");
    });

    it("clears the client and reports not-configured when the setting is empty", () => {
      // A blank/whitespace value must still call setToken so a token cleared
      // after startup clears the client rather than leaving a stale credential.
      stubTokenSetting("   ");
      const client = createClientSpy();

      const configured = syncClientToken(client as never);

      expect(configured).toBe(false);
      expect(client.setToken).toHaveBeenCalledWith("");
    });

    it("reconciles from the live setting on every call", () => {
      const client = createClientSpy();

      stubTokenSetting("");
      expect(syncClientToken(client as never)).toBe(false);

      stubTokenSetting("fresh-token");
      expect(syncClientToken(client as never)).toBe(true);
      expect(client.setToken).toHaveBeenLastCalledWith("fresh-token");
    });
  });

  it("reads from the demiplane-pf2e module namespace", () => {
    const get = vi.fn((_moduleId: string, _key: string) => "");
    vi.stubGlobal("game", { settings: { get } });

    readConfiguredToken();

    expect(get).toHaveBeenCalledWith(MODULE_ID, "demiplaneToken");
  });
});
