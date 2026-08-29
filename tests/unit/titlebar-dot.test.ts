import { describe, it, expect, beforeEach, vi } from "vitest";
import { installFoundryMocks } from "./foundry-mocks.js";
import { registerTitlebarDot, SYNC_ISSUES_CLASS } from "../../src/titlebar-dot.js";
import { ISSUES_CHANGED_EVENT } from "../../src/sync-issues.js";

function hookCallback(event: string): ((...args: unknown[]) => void) | undefined {
  const calls = (globalThis as unknown as { Hooks: { on: ReturnType<typeof vi.fn> } }).Hooks.on.mock.calls as Array<
    [string, (...args: unknown[]) => void]
  >;
  return calls.find((c) => c[0] === event)?.[1];
}

describe("titlebar dot", () => {
  beforeEach(() => {
    installFoundryMocks();
    (globalThis as unknown as { ui: { windows: Record<string, unknown>; notifications: unknown } }).ui = {
      windows: {},
      notifications: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    };
  });

  it("registers a renderActorSheet hook and an issues-changed hook", () => {
    registerTitlebarDot();
    expect(typeof hookCallback("renderActorSheet")).toBe("function");
    expect(typeof hookCallback(ISSUES_CHANGED_EVENT)).toBe("function");
  });

  it("toggles the indicator off when the character has no issues", () => {
    registerTitlebarDot();
    const button = { classList: { toggle: vi.fn() } };
    const actor: Record<string, unknown> = {
      getFlag: (_m: string, key: string) => (key === "characterId" ? "uuid" : undefined),
    };
    const sheet = { actor, element: [{ querySelector: () => button }] };
    hookCallback("renderActorSheet")?.(sheet);
    expect(button.classList.toggle).toHaveBeenCalledWith(SYNC_ISSUES_CLASS, false);
  });

  it("toggles the indicator on when the character has active import issues", () => {
    registerTitlebarDot();
    const button = { classList: { toggle: vi.fn() } };
    const actor: Record<string, unknown> = {
      getFlag: (_m: string, key: string) =>
        key === "characterId" ? "uuid" : key === "importIssues" ? ["boom"] : undefined,
    };
    const sheet = { actor, element: [{ querySelector: () => button }] };
    hookCallback("renderActorSheet")?.(sheet);
    expect(button.classList.toggle).toHaveBeenCalledWith(SYNC_ISSUES_CLASS, true);
  });

  it("refreshes open sheets when issues change", () => {
    registerTitlebarDot();
    const button = { classList: { toggle: vi.fn() } };
    const actor: Record<string, unknown> = {
      id: "a1",
      getFlag: (_m: string, key: string) =>
        key === "characterId" ? "uuid" : key === "exportIssues" ? ["x"] : undefined,
    };
    (globalThis as unknown as { ui: { windows: Record<string, unknown> } }).ui.windows = {
      "1": {
        rendered: true,
        object: { id: "a1" },
        element: [{ querySelector: () => button }],
      },
    };
    hookCallback(ISSUES_CHANGED_EVENT)?.(actor);
    expect(button.classList.toggle).toHaveBeenCalledWith(SYNC_ISSUES_CLASS, true);
  });
});
