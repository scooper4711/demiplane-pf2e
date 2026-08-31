import { describe, it, expect, beforeAll, vi } from "vitest";
import { installFoundryMocks } from "./foundry-mocks.js";

vi.mock("@scooper4711/demiplane-api", () => ({
  DemiplaneClient: class {
    setToken(): void {}
    async validateToken(): Promise<void> {}
  },
  findCustomEngineByName: () => undefined,
}));

describe("module entrypoint", () => {
  let hooksOn: ReturnType<typeof vi.fn>;
  let button: { addEventListener: ReturnType<typeof vi.fn> };
  let actionButtons: { querySelector: ReturnType<typeof vi.fn>; appendChild: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    installFoundryMocks();
    hooksOn = vi.fn();
    (globalThis as unknown as { Hooks: { on: unknown } }).Hooks.on = hooksOn;
    button = { addEventListener: vi.fn() };
    actionButtons = { querySelector: vi.fn().mockReturnValue(null), appendChild: vi.fn() };
    (globalThis as unknown as { document: { createElement: ReturnType<typeof vi.fn> } }).document = {
      createElement: vi.fn(() => button),
    };
    await import("../../src/module.js");
  });

  function onHook(event: string): ((...args: unknown[]) => void) | undefined {
    const calls = hooksOn.mock.calls as Array<[string, (...args: unknown[]) => void]>;
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
});
