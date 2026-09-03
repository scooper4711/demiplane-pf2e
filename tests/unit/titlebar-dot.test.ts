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

function syncedActor(
  id: string,
  issues?: { importIssues?: string[]; exportIssues?: string[] }
): Record<string, unknown> {
  return {
    id,
    getFlag: (_m: string, key: string) => {
      if (key === "characterId") return "uuid";
      if (key === "importIssues") return issues?.importIssues;
      if (key === "exportIssues") return issues?.exportIssues;
      return undefined;
    },
  };
}

describe("titlebar demiplane icon state", () => {
  beforeEach(() => {
    installFoundryMocks();
    (globalThis as unknown as { ui: { windows: Record<string, unknown>; notifications: unknown } }).ui = {
      windows: {},
      notifications: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    };
  });

  it("registers render, issues-changed, and updateActor hooks", () => {
    registerTitlebarDot();
    expect(typeof hookCallback("renderActorSheet")).toBe("function");
    expect(typeof hookCallback(ISSUES_CHANGED_EVENT)).toBe("function");
    expect(typeof hookCallback("updateActor")).toBe("function");
  });

  it("clears the error class when the character has no issues", () => {
    registerTitlebarDot();
    const button = { classList: { toggle: vi.fn() } };
    const sheet = { actor: syncedActor("a1"), element: [{ querySelector: () => button }] };

    hookCallback("renderActorSheet")?.(sheet);

    expect(button.classList.toggle).toHaveBeenCalledWith(SYNC_ISSUES_CLASS, false);
  });

  it("sets the error class when the character has active import issues", () => {
    registerTitlebarDot();
    const button = { classList: { toggle: vi.fn() } };
    const sheet = { actor: syncedActor("a1", { importIssues: ["boom"] }), element: [{ querySelector: () => button }] };

    hookCallback("renderActorSheet")?.(sheet);

    expect(button.classList.toggle).toHaveBeenCalledWith(SYNC_ISSUES_CLASS, true);
  });

  it("refreshes open sheets when issues change", () => {
    registerTitlebarDot();
    const button = { classList: { toggle: vi.fn() } };
    const actor = syncedActor("a1", { exportIssues: ["x"] });
    (globalThis as unknown as { ui: { windows: Record<string, unknown> } }).ui.windows = {
      "1": { rendered: true, object: { id: "a1" }, element: [{ querySelector: () => button }] },
    };

    hookCallback(ISSUES_CHANGED_EVENT)?.(actor);

    expect(button.classList.toggle).toHaveBeenCalledWith(SYNC_ISSUES_CLASS, true);
  });

  it("refreshes open sheets on an updateActor that touches module flags", () => {
    registerTitlebarDot();
    const button = { classList: { toggle: vi.fn() } };
    const actor = syncedActor("a1", { exportIssues: ["x"] });
    (globalThis as unknown as { ui: { windows: Record<string, unknown> } }).ui.windows = {
      "1": { rendered: true, object: { id: "a1" }, element: [{ querySelector: () => button }] },
    };

    hookCallback("updateActor")?.(actor, { flags: { "demiplane-pf2e": {} } });

    expect(button.classList.toggle).toHaveBeenCalledWith(SYNC_ISSUES_CLASS, true);
  });

  it("ignores an updateActor that does not touch module flags", () => {
    registerTitlebarDot();
    const button = { classList: { toggle: vi.fn() } };
    const actor = syncedActor("a1", { exportIssues: ["x"] });
    (globalThis as unknown as { ui: { windows: Record<string, unknown> } }).ui.windows = {
      "1": { rendered: true, object: { id: "a1" }, element: [{ querySelector: () => button }] },
    };

    hookCallback("updateActor")?.(actor, { name: "renamed" });

    expect(button.classList.toggle).not.toHaveBeenCalled();
  });
});
