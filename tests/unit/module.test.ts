import { describe, it, expect, beforeAll, vi } from "vitest";
import { installFoundryMocks } from "./foundry-mocks.js";
import { DemiplaneClient } from "@scooper4711/demiplane-api";

vi.mock("@scooper4711/demiplane-api", () => ({
  DemiplaneClient: class {
    setToken(): void {}
    async validateToken(): Promise<void> {}
  },
  findCustomEngineByName: () => undefined,
}));

describe("module entrypoint", () => {
  let hooksOn: ReturnType<typeof vi.fn>;
  let hooksOnce: ReturnType<typeof vi.fn>;
  let button: { addEventListener: ReturnType<typeof vi.fn> };
  let actionButtons: { querySelector: ReturnType<typeof vi.fn>; appendChild: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    installFoundryMocks();
    // Node has no DOM; directory-icon probes `instanceof HTMLElement`, so a
    // stand-in constructor is enough for those checks to resolve false.
    vi.stubGlobal("HTMLElement", class FakeHTMLElement {});
    globalThis.game.settings.registerMenu = vi.fn();
    hooksOn = vi.fn();
    (globalThis as unknown as { Hooks: { on: unknown } }).Hooks.on = hooksOn;
    hooksOnce = (globalThis as unknown as { Hooks: { once: ReturnType<typeof vi.fn> } }).Hooks.once;
    button = { addEventListener: vi.fn() };
    actionButtons = { querySelector: vi.fn().mockReturnValue(null), appendChild: vi.fn() };
    (globalThis as unknown as { document: { createElement: ReturnType<typeof vi.fn> } }).document = {
      createElement: vi.fn(() => button),
    };
    globalThis.foundry.applications.api.DialogV2 = {
      input: vi.fn(),
      prompt: vi.fn().mockResolvedValue(undefined),
      confirm: vi.fn(),
    };
    globalThis.game.actors.contents = [];
    await import("../../src/module.js");
  });

  function onHook(event: string): ((...args: unknown[]) => void) | undefined {
    const calls = hooksOn.mock.calls as Array<[string, (...args: unknown[]) => void]>;
    return calls.find((c) => c[0] === event)?.[1];
  }

  function onHooks(event: string): Array<(...args: unknown[]) => void> {
    const calls = hooksOn.mock.calls as Array<[string, (...args: unknown[]) => void]>;
    return calls.filter((c) => c[0] === event).map((c) => c[1]);
  }

  function onceHook(event: string): ((...args: unknown[]) => void) | undefined {
    const calls = hooksOnce.mock.calls as Array<[string, (...args: unknown[]) => void]>;
    return calls.find((c) => c[0] === event)?.[1];
  }

  it("registers the directory and context-menu hooks", () => {
    expect(typeof onHook("renderActorDirectory")).toBe("function");
    expect(typeof onHook("getActorContextOptions")).toBe("function");
  });

  it("adds an Update from Demiplane context menu entry", () => {
    const cb = onHook("getActorContextOptions");
    const items: Array<{ label: string }> = [];
    cb({}, items);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("Update from Demiplane");
  });

  it("renders an Import Demiplane Character directory button for GMs", () => {
    const cb = onHook("renderActorDirectory");
    const html = {
      querySelector: (sel: string) => (sel.includes("action-buttons") ? actionButtons : null),
    };
    (globalThis as unknown as { game: { user: { isGM: boolean; can: () => boolean } } }).game.user = {
      isGM: true,
      can: () => true,
    };
    cb({}, html);
    expect(actionButtons.appendChild).toHaveBeenCalledWith(button);
  });

  it("does not render the Import button without GM or create-actor permission", () => {
    const cb = onHook("renderActorDirectory");
    const html = {
      querySelector: (sel: string) => (sel.includes("action-buttons") ? actionButtons : null),
    };
    actionButtons.appendChild.mockClear();
    (globalThis as unknown as { game: { user: { isGM: boolean; can: () => boolean } } }).game.user = {
      isGM: false,
      can: () => false,
    };
    cb({}, html);
    expect(actionButtons.appendChild).not.toHaveBeenCalled();
  });

  it("runs init registration without throwing", async () => {
    await onceHook("init")?.();
    expect(onHook("renderSettingsConfig")).toBeDefined();
  });

  it("initializes the module on ready without auto-sync or a stored token", async () => {
    await onceHook("ready")?.();

    expect(typeof onHook("createActor")).toBe("function");
    expect(typeof onHook("updateActor")).toBe("function");
    expect(typeof onHook("updateSetting")).toBe("function");
    // HookManager wiring registered its item hooks.
    expect(typeof onHook("updateItem")).toBe("function");
    expect(typeof onHook("createItem")).toBe("function");
    expect(typeof onHook("deleteItem")).toBe("function");
  });

  it("shows the pre-release warning when auto-sync is enabled at ready", async () => {
    await globalThis.game.settings.set("demiplane-pf2e", "autoSync", true);
    const prompt = globalThis.foundry.applications.api.DialogV2.prompt;
    prompt.mockClear();

    await onceHook("ready")?.();

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ window: expect.objectContaining({ title: expect.stringContaining("Pre-Release") }) })
    );
    await globalThis.game.settings.set("demiplane-pf2e", "autoSync", false);
  });

  it("stores a newly configured token on updateSetting", async () => {
    const setToken = vi.spyOn(DemiplaneClient.prototype, "setToken");
    await onceHook("ready")?.();
    await globalThis.game.settings.set("demiplane-pf2e", "demiplaneToken", "tok-1");
    setToken.mockClear();

    for (const cb of onHooks("updateSetting")) {
      await cb({ key: "demiplane-pf2e.demiplaneToken" });
    }

    expect(setToken).toHaveBeenCalledWith("tok-1");
    setToken.mockRestore();
    await globalThis.game.settings.set("demiplane-pf2e", "demiplaneToken", "");
  });

  it("re-shows the pre-release warning when auto-sync is switched on", async () => {
    await onceHook("ready")?.();
    await globalThis.game.settings.set("demiplane-pf2e", "autoSync", true);
    const prompt = globalThis.foundry.applications.api.DialogV2.prompt;
    prompt.mockClear();

    for (const cb of onHooks("updateSetting")) {
      await cb({ key: "demiplane-pf2e.autoSync" });
    }

    expect(prompt).toHaveBeenCalled();
    await globalThis.game.settings.set("demiplane-pf2e", "autoSync", false);
  });

  it("ignores unrelated setting updates", async () => {
    await onceHook("ready")?.();
    const prompt = globalThis.foundry.applications.api.DialogV2.prompt;
    prompt.mockClear();

    for (const cb of onHooks("updateSetting")) {
      await cb({ key: "demiplane-pf2e.debugImport" });
    }

    expect(prompt).not.toHaveBeenCalled();
  });

  it("reconciles duplicate links on createActor", async () => {
    await onceHook("ready")?.();
    const ui = globalThis.ui;
    ui.notifications.warn.mockClear();

    await onHook("createActor")?.({ getFlag: () => undefined });

    expect(ui.notifications.warn).not.toHaveBeenCalled();
  });

  it("reconciles duplicate links when module flags change", async () => {
    await onceHook("ready")?.();
    const flags = { "demiplane-pf2e": { characterId: "uuid-1" } };
    const first = { id: "a1", getFlag: (_s, key) => (key === "characterId" ? "uuid-1" : undefined) };
    const copy = {
      id: "a2",
      getFlag: (_s, key) => (key === "characterId" ? "uuid-1" : undefined),
      unsetFlag: vi.fn().mockResolvedValue(undefined),
    };
    globalThis.game.actors.contents = [first, copy];
    const ui = globalThis.ui;
    ui.notifications.warn.mockClear();

    // Several updateActor hooks exist (sync queueing, sidebar badge, guard);
    // the guard is the one that reconciles on module-flag changes.
    for (const cb of onHooks("updateActor")) {
      await cb(copy, { flags });
    }

    expect(copy.unsetFlag).toHaveBeenCalledWith("demiplane-pf2e", "characterId");
    expect(ui.notifications.warn).toHaveBeenCalled();
    globalThis.game.actors.contents = [];
  });

  it("skips duplicate reconciliation for unrelated actor updates", async () => {
    await onceHook("ready")?.();
    const ui = globalThis.ui;
    ui.notifications.warn.mockClear();

    for (const cb of onHooks("updateActor")) {
      await cb({ id: "a1" }, { name: "renamed" });
    }

    expect(ui.notifications.warn).not.toHaveBeenCalled();
  });

  it("returns from the import click when the dialog is cancelled", async () => {
    const cb = onHook("renderActorDirectory");
    const html = {
      querySelector: (sel: string) => (sel.includes("action-buttons") ? actionButtons : null),
    };
    (globalThis as unknown as { game: { user: { isGM: boolean; can: () => boolean } } }).game.user = {
      isGM: true,
      can: () => true,
    };
    globalThis.Actor.create.mockClear();
    cb({}, html);

    const click = button.addEventListener.mock.calls.find((c) => c[0] === "click")?.[1];
    globalThis.foundry.applications.api.DialogV2.input.mockResolvedValue(null);
    await click();

    expect(globalThis.Actor.create).not.toHaveBeenCalled();
  });

  it("ignores non-array context menu payloads", () => {
    const cb = onHook("getActorContextOptions");
    expect(() => cb({}, {})).not.toThrow();
  });
});
