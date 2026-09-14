import { describe, it, expect, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ validateToken: vi.fn(), setToken: vi.fn() }));

vi.mock("@scooper4711/demiplane-api", () => ({
  DemiplaneClient: class {
    setToken(token: string): void {
      hoisted.setToken(token);
    }
    validateToken(): unknown {
      return hoisted.validateToken();
    }
  },
}));

import { registerSettings } from "../../src/settings.js";
import { TOKEN_HELP_URL } from "../../src/token.js";

describe("settings", () => {
  let register: ReturnType<typeof vi.fn>;
  let registerMenu: ReturnType<typeof vi.fn>;
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
  let tokenInput: { value: string };
  let input: { closest: ReturnType<typeof vi.fn> };
  let html: { querySelector: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    register = vi.fn();
    registerMenu = vi.fn();
    hooksOn = vi.fn();
    settingsGet = vi.fn().mockImplementation((_m: string, k: string) => (k === "demiplaneToken" ? "tok" : undefined));
    prompt = vi.fn().mockResolvedValue(undefined);
    user = { isGM: true };

    formFields = { appendChild: vi.fn() };
    tokenInput = { value: "tok" };
    formGroup = {
      querySelector: vi.fn((sel: string) => {
        if (sel === ".form-fields") return formFields;
        if (sel.includes("demiplaneToken")) return tokenInput;
        return null;
      }),
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
      settings: { register, registerMenu, get: settingsGet },
      user,
    };
    (globalThis as unknown as { Hooks: unknown }).Hooks = {
      on: hooksOn,
      once: vi.fn(),
      off: vi.fn(),
    };
    (globalThis as unknown as { foundry: unknown }).foundry = {
      applications: {
        api: {
          DialogV2: { prompt },
          // The slug mapper app resolves its base class when the menu is registered.
          ApplicationV2: class {},
          HandlebarsApplicationMixin: (base: unknown) => base,
        },
      },
    };
    (globalThis as unknown as { ui: { notifications: Record<string, ReturnType<typeof vi.fn>> } }).ui = {
      notifications: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    };
    hoisted.validateToken.mockReset();
    hoisted.setToken.mockReset();
  });

  function settingsCallback(): ((html: unknown) => void) | undefined {
    const calls = hooksOn.mock.calls as Array<[string, (html: unknown) => void]>;
    return calls.find((c) => c[0] === "renderSettingsConfig")?.[1];
  }

  it("registers the user-facing module settings", () => {
    registerSettings();
    const keys = register.mock.calls.map((c) => c[1]);
    expect(keys).toEqual(expect.arrayContaining(["syncWriteLevel", "demiplaneToken", "debugImport"]));
  });

  it("no longer registers a soft-delete setting", () => {
    registerSettings();
    const keys = register.mock.calls.map((c) => c[1]);
    expect(keys).not.toContain("syncSoftDelete");
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

  it("registers a GM-only menu for the slug mapping screen", () => {
    registerSettings();
    expect(registerMenu).toHaveBeenCalledTimes(1);
    const [moduleId, key, config] = registerMenu.mock.calls[0];
    expect(moduleId).toBe("demiplane-pf2e");
    expect(key).toBe("slugMapper");
    expect(config.restricted).toBe(true);
    expect(typeof config.type).toBe("function");
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

  it("validates the token currently in the input, not the saved setting", async () => {
    registerSettings();
    settingsCallback()?.({}, html);
    // The saved setting is "tok"; the GM has pasted a new, unsaved value.
    tokenInput.value = "freshly-pasted-token";
    hoisted.validateToken.mockResolvedValue({ valid: true });
    await button._handler?.();
    expect(hoisted.setToken).toHaveBeenCalledWith("freshly-pasted-token");
    expect(settingsGet).not.toHaveBeenCalledWith("demiplane-pf2e", "demiplaneToken");
  });

  it("strips a pasted Bearer prefix before validating", async () => {
    registerSettings();
    settingsCallback()?.({}, html);
    tokenInput.value = "Bearer freshly-pasted-token";
    hoisted.validateToken.mockResolvedValue({ valid: true });
    await button._handler?.();
    expect(hoisted.setToken).toHaveBeenCalledWith("freshly-pasted-token");
  });

  it("does not call the API when the token input is empty", async () => {
    registerSettings();
    settingsCallback()?.({}, html);
    tokenInput.value = "   ";
    await button._handler?.();
    expect(hoisted.validateToken).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Enter a Demiplane authorization token") })
    );
  });

  describe("Token how-to link", () => {
    it("registers a plain-text hint and appends the link live in the DOM", () => {
      registerSettings();
      const call = register.mock.calls.find((c) => c[1] === "demiplaneToken");
      expect(call).toBeDefined();
      // Foundry escapes hint strings, so markup here would show as source.
      expect(call![2].hint).not.toContain("<a");

      const appended: unknown[] = [];
      const hintEl = {
        appendChild: vi.fn((node: unknown) => {
          appended.push(node);
        }),
        dataset: {} as Record<string, string>,
      } as unknown as HTMLElement;
      const group = {
        querySelector: vi.fn((sel: string) =>
          String(sel).includes("hint") || String(sel).includes("notes") ? hintEl : null
        ),
      };
      const tokenField = { closest: vi.fn().mockReturnValue(group), querySelector: vi.fn() };
      const htmlWithHint = {
        querySelector: vi.fn((sel: string) => (String(sel).includes("demiplaneToken") ? tokenField : null)),
      } as unknown as Parameters<NonNullable<ReturnType<typeof settingsCallback>>>[1];

      // Render twice: the link must be appended exactly once.
      settingsCallback()?.({}, htmlWithHint);
      settingsCallback()?.({}, htmlWithHint);

      const links = appended.filter(
        (node): node is HTMLAnchorElement =>
          typeof node === "object" && node !== null && "href" in (node as Record<string, unknown>)
      );
      expect(links).toHaveLength(1);
      expect(links[0]!.href).toBe(TOKEN_HELP_URL);
      expect(links[0]!.textContent).toBe("How to get your token");
    });
  });

  describe("Write to Demiplane hint", () => {
    it("registers the hint as the default level's description", () => {
      registerSettings();
      const call = register.mock.calls.find((c) => c[1] === "syncWriteLevel");
      expect(call).toBeDefined();
      // Must be the short per-level text, not the old wall that listed all tiers.
      expect(call![2].hint).toContain("Nothing is written to Demiplane");
      expect(call![2].hint).not.toContain("Text fields only");
    });

    it("shows the hint for the currently selected value without saving", () => {
      registerSettings();
      const cb = settingsCallback();
      expect(cb).toBeTypeOf("function");

      const hintEl = { textContent: "initial", setAttribute: vi.fn() } as unknown as HTMLElement;
      const hintQuery = vi.fn((sel: string) =>
        String(sel).includes("hint") || String(sel).includes("notes") ? hintEl : null
      );
      const writeSelect = {
        value: "story",
        closest: vi.fn(() => ({ querySelector: hintQuery }) as unknown as HTMLElement),
        addEventListener: vi.fn(),
        dataset: {} as Record<string, string>,
      } as unknown as HTMLSelectElement;

      const htmlWithSelect = {
        querySelector: vi.fn((sel: string) => {
          if (String(sel).includes("syncWriteLevel")) return writeSelect;
          if (String(sel).includes("demiplaneToken")) return input;
          return null;
        }),
      } as unknown as Parameters<NonNullable<ReturnType<typeof settingsCallback>>>[1];

      cb!({}, htmlWithSelect);

      // Immediately reflects the pending selection, not just the saved value.
      expect(hintEl.textContent).toContain("Biography and appearance");
      expect(hintEl.setAttribute).toHaveBeenCalledWith("data-write-level", "story");

      // Simulate the GM picking another value — hint updates live via the
      // change listener, without pressing Save.
      const changeHandler = (writeSelect.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === "change"
      )?.[1] as (() => void) | undefined;
      expect(changeHandler).toBeTypeOf("function");
      (writeSelect as { value: string }).value = "full";
      changeHandler!();
      expect(hintEl.textContent).toContain("actually removes it from Demiplane");
      expect(hintEl.setAttribute).toHaveBeenCalledWith("data-write-level", "full");
    });
  });
});
