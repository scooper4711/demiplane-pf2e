import { describe, it, expect, beforeEach, vi } from "vitest";
import { showDemiplaneInfoDialog, registerDemiplaneInfoButton } from "../../src/demiplane-info-button.js";

const DEMI_UUID = "12345678-1234-1234-1234-123456789012";

describe("demiplane-info-button", () => {
  let wait: ReturnType<typeof vi.fn>;
  let importFn: ReturnType<typeof vi.fn>;
  let exportFn: ReturnType<typeof vi.fn>;
  let actor: {
    id: string;
    name: string;
    getFlag: ReturnType<typeof vi.fn>;
    setFlag: ReturnType<typeof vi.fn>;
    deleteEmbeddedDocuments: ReturnType<typeof vi.fn>;
    items: Array<{ id: string; name: string; type: string; flags: Record<string, unknown> }>;
  };

  beforeEach(() => {
    importFn = vi.fn().mockResolvedValue({ errors: [], itemsImported: 3 });
    exportFn = vi.fn().mockResolvedValue({ success: true });
    wait = vi.fn().mockResolvedValue("close");
    actor = {
      id: "a1",
      name: "Bob",
      getFlag: vi.fn((_m: string, k: string) => {
        if (k === "characterId") return DEMI_UUID;
        if (k === "importIssues") return ["imp issue"];
        if (k === "exportIssues") return ["exp issue"];
        return undefined;
      }),
      setFlag: vi.fn().mockResolvedValue(undefined),
      deleteEmbeddedDocuments: vi.fn().mockResolvedValue(undefined),
      items: [
        {
          id: "i1",
          name: "Imported Sword",
          type: "weapon",
          flags: { "demiplane-pf2e": { imported: true } },
        },
        { id: "i2", name: "Manual Cloak", type: "equipment", flags: {} },
      ],
    };
    (globalThis as unknown as { game: unknown }).game = {
      settings: { get: vi.fn((_m: string, k: string) => (k === "demiplaneToken" ? "tok" : undefined)) },
    };
    (globalThis as unknown as { foundry: { applications: { api: { DialogV2: { wait: unknown } } } } }).foundry = {
      applications: { api: { DialogV2: { wait } } },
    };
    (globalThis as unknown as { ui: { notifications: Record<string, ReturnType<typeof vi.fn>> } }).ui = {
      notifications: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    };
  });

  function clickAction(action: string): Promise<unknown> {
    const opts = wait.mock.calls[0][0] as { buttons: Array<{ action: string; callback: () => unknown }> };
    const btn = opts.buttons.find((b) => b.action === action);
    return Promise.resolve(btn?.callback());
  }

  it("builds a dialog listing issues and manual items", async () => {
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    const opts = wait.mock.calls[0][0] as { content: string };
    expect(opts.content).toContain("imp issue");
    expect(opts.content).toContain("exp issue");
    expect(opts.content).toContain("Manual Cloak");
    expect(opts.content).toContain("(equipment)");
    expect(opts.content).not.toContain("Imported Sword");
  });

  it("pushes to Demiplane when the push button is clicked", async () => {
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    await clickAction("push");
    expect(exportFn).toHaveBeenCalledWith(actor);
  });

  it("updates from Demiplane when the update button is clicked", async () => {
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    await clickAction("update");
    expect(importFn).toHaveBeenCalledWith(actor, DEMI_UUID, "tok", { wipe: true });
  });

  it("delegates the imported-item wipe instead of deleting before the sync pause", async () => {
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    await clickAction("update");
    // Deleting here would run before the import establishes the sync pause, so the
    // delete hook would treat the removals as user edits and push them to
    // Demiplane — deleting the real items and faking a server-side conflict.
    expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it("escapes HTML in issue messages", async () => {
    actor.getFlag = vi.fn((_m: string, k: string) =>
      k === "characterId" ? DEMI_UUID : k === "importIssues" ? ["<script>x</script>"] : undefined
    );
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    const opts = wait.mock.calls[0][0] as { content: string };
    expect(opts.content).toContain("&lt;script&gt;");
    expect(opts.content).not.toContain("<script>x</script>");
  });

  it("clears issues on dismiss when issues are present", async () => {
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    await clickAction("dismiss");
    expect(actor.setFlag).toHaveBeenCalledWith("demiplane-pf2e", "importIssues", expect.anything());
  });
});

describe("registerDemiplaneInfoButton gating", () => {
  let importFn: ReturnType<typeof vi.fn>;
  let exportFn: ReturnType<typeof vi.fn>;
  let hooksOn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    importFn = vi.fn();
    exportFn = vi.fn();
    hooksOn = vi.fn();
    (globalThis as unknown as { Hooks: { on: unknown } }).Hooks = { on: hooksOn };
    (globalThis as unknown as { CONST: unknown }).CONST = {
      DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
    };
  });

  function capturedCallback(): (sheet: unknown, buttons: Array<{ class?: string }>) => void {
    const calls = hooksOn.mock.calls as Array<[string, (...args: unknown[]) => void]>;
    return calls.find((c) => c[0] === "getActorSheetHeaderButtons")?.[1] as never;
  }

  function linkedActor(isOwner: boolean): {
    getFlag: ReturnType<typeof vi.fn>;
    testUserPermission: ReturnType<typeof vi.fn>;
  } {
    return {
      getFlag: vi.fn((_m: string, k: string) => (k === "characterId" ? "char-123" : undefined)),
      testUserPermission: vi.fn(() => isOwner),
    };
  }

  it("adds the Demiplane button for GMs", () => {
    (globalThis as unknown as { game: { user: { isGM: boolean } } }).game = { user: { isGM: true } };
    registerDemiplaneInfoButton(importFn, exportFn);
    const buttons: Array<{ class?: string }> = [];
    capturedCallback()({ actor: linkedActor(false) }, buttons);
    expect(buttons.length).toBe(1);
    expect(buttons[0].class).toBe("demiplane-info-btn");
  });

  it("adds the Demiplane button for character owners", () => {
    (globalThis as unknown as { game: { user: { isGM: boolean } } }).game = { user: { isGM: false } };
    registerDemiplaneInfoButton(importFn, exportFn);
    const buttons: Array<{ class?: string }> = [];
    capturedCallback()({ actor: linkedActor(true) }, buttons);
    expect(buttons.length).toBe(1);
    expect(buttons[0].class).toBe("demiplane-info-btn");
  });

  it("omits the button for non-GM, non-owner users", () => {
    (globalThis as unknown as { game: { user: { isGM: boolean } } }).game = { user: { isGM: false } };
    registerDemiplaneInfoButton(importFn, exportFn);
    const buttons: Array<{ class?: string }> = [];
    capturedCallback()({ actor: linkedActor(false) }, buttons);
    expect(buttons.length).toBe(0);
  });
});
