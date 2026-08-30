import { describe, it, expect, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ validateToken: vi.fn() }));

vi.mock("@scooper4711/demiplane-api", () => ({
  DemiplaneClient: class {
    setToken(): void {}
    validateToken(): unknown {
      return hoisted.validateToken();
    }
  },
}));

import { registerSettings } from "../../src/settings.js";

describe("settings", () => {
  let register: ReturnType<typeof vi.fn>;
  let hooksOn: ReturnType<typeof vi.fn>;
  let settingsGet: ReturnType<typeof vi.fn>;
  let prompt: ReturnType<typeof vi.fn>;
  let user: { isGM: boolean };
  let button: {
    className: string;
    innerHTML: string;
    addEventListener: ReturnType<typeof vi.fn>;
    _handler?: () => void;
  };
  let formFields: { appendChild: ReturnType<typeof vi.fn> };
  let formGroup: { querySelector: ReturnType<typeof vi.fn>; remove?: ReturnType<typeof vi.fn> };
  let input: { closest: ReturnType<typeof vi.fn> };
  let html: { querySelector: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    register = vi.fn();
    hooksOn = vi.fn();
    settingsGet = vi.fn().mockImplementation((_m: string, k: string) => (k === "demiplaneToken" ? "tok" : undefined));
    prompt = vi.fn().mockResolvedValue(undefined);
    user = { isGM: true };

    formFields = { appendChild: vi.fn() };
    formGroup = {
      querySelector: vi.fn((sel: string) => (sel === ".form-fields" ? formFields : null)),
      remove: vi.fn(),
    };
    input = { closest: vi.fn().mockReturnValue(formGroup), querySelector: vi.fn() };
    html = { querySelector: vi.fn((sel: string) => (sel.includes("demiplaneToken") ? input : null)) };

    button = {
      className: "",
      innerHTML: "",
      addEventListener: vi.fn((_e: string, h: () => void) => {
        button._handler = h;
      }),
    };

    (globalThis as unknown as { document: { createElement: ReturnType<typeof vi.fn> } }).document = {
      createElement: vi.fn(() => button),
    };
    (globalThis as unknown as { game: unknown }).game = {
      settings: { register, get: settingsGet },
      user,
    };
    (globalThis as unknown as { Hooks: unknown }).Hooks = {
      on: hooksOn,
      once: vi.fn(),
      off: vi.fn(),
    };
    (globalThis as unknown as { foundry: { applications: { api: { DialogV2: { prompt: unknown } } } } }).foundry = {
      applications: { api: { DialogV2: { prompt } } },
    };
    (globalThis as unknown as { ui: { notifications: Record<string, ReturnType<typeof vi.fn>> } }).ui = {
      notifications: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    };
    hoisted.validateToken.mockReset();
  });

  function settingsCallback(): ((html: unknown) => void) | undefined {
    const calls = hooksOn.mock.calls as Array<[string, (html: unknown) => void]>;
    return calls.find((c) => c[0] === "renderSettingsConfig")?.[1];
  }

  it("registers the user-facing module settings", () => {
    registerSettings();
    const keys = register.mock.calls.map((c) => c[1]);
    expect(keys).toEqual(expect.arrayContaining(["autoSync", "demiplaneToken", "debugImport"]));
  });

  it("registers one slug mapping setting per kind", () => {
    registerSettings();
    const keys = register.mock.calls.map((c) => c[1]);
    const mappingKeys = keys.filter((k: string) => k.startsWith("slugMappings"));

    expect(mappingKeys).toHaveLength(7);
    // One setting per kind, so mappings of different kinds can't collide.
    expect(mappingKeys).toEqual(
      expect.arrayContaining([
        "slugMappingsAncestry",
        "slugMappingsHeritage",
        "slugMappingsBackground",
        "slugMappingsClass",
        "slugMappingsFeat",
        "slugMappingsEquipment",
        "slugMappingsSpell",
      ])
    );
  });

  it("keeps mapping settings out of the standard settings list", () => {
    registerSettings();
    for (const call of register.mock.calls) {
      if (String(call[1]).startsWith("slugMappings")) {
        expect(call[2].config).toBe(false);
      }
    }
  });

  it("registers a renderSettingsConfig hook", () => {
    registerSettings();
    expect(typeof settingsCallback()).toBe("function");
  });

  it("hides the token field for non-GMs", () => {
    registerSettings();
    user.isGM = false;
    settingsCallback()?.({}, html);
    expect(input.closest).toHaveBeenCalledWith(".form-group");
    expect(formGroup.remove).toHaveBeenCalled();
  });

  it("does not hide the token field for GMs", () => {
    registerSettings();
    user.isGM = true;
    settingsCallback()?.({}, html);
    expect(formGroup.remove).not.toHaveBeenCalled();
  });

  it("adds a token validation button for GMs", () => {
    registerSettings();
    settingsCallback()?.({}, html);
    expect(formFields.appendChild).toHaveBeenCalledWith(button);
    expect(button._handler).toBeTypeOf("function");
  });

  it("does not add a token validation button for non-GMs", () => {
    registerSettings();
    user.isGM = false;
    settingsCallback()?.({}, html);
    expect(formFields.appendChild).not.toHaveBeenCalled();
  });

  it("reports success when the token validates", async () => {
    registerSettings();
    settingsCallback()?.({}, html);
    hoisted.validateToken.mockResolvedValue({ valid: true });
    await button._handler?.();
    expect(hoisted.validateToken).toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("valid") }));
  });

  it("reports failure when the token is rejected", async () => {
    registerSettings();
    settingsCallback()?.({}, html);
    hoisted.validateToken.mockRejectedValue(new Error("bad token"));
    await button._handler?.();
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("could not be validated") })
    );
  });
});
