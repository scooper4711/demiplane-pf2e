import { describe, it, expect, beforeEach, vi } from "vitest";
import { showDemiplaneInfoDialog, registerDemiplaneInfoButton } from "../../src/demiplane-info-button.js";
import { MODULE_ID } from "../../src/import/types.js";

const DEMI_UUID = "12345678-1234-1234-1234-123456789012";

describe("demiplane-info-button", () => {
  let wait: ReturnType<typeof vi.fn>;
  let importFn: ReturnType<typeof vi.fn>;
  let exportFn: ReturnType<typeof vi.fn>;
  let autoSyncEnabled: boolean;
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
        if (k === "unmappedSlugs") return [{ slug: "goblin-blade", kind: "equipment" }];
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
    autoSyncEnabled = true;
    (globalThis as unknown as { game: unknown }).game = {
      user: { isGM: false },
      settings: {
        get: vi.fn((_m: string, k: string) => {
          if (k === "demiplaneToken") return "tok";
          if (k === "syncWriteLevel") return autoSyncEnabled ? "text-quantity-delete" : "none";
          return undefined;
        }),
      },
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

  function pushButton(): { disabled?: boolean; tooltip?: string } | undefined {
    const opts = wait.mock.calls[0][0] as { buttons: Array<{ action: string; disabled?: boolean; tooltip?: string }> };
    return opts.buttons.find((b) => b.action === "push");
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

  it("excludes activities and other unsynced item types from the manual list", async () => {
    // A player may copy many exploration/downtime/combat activities (all `action`
    // items) onto their sheet; the module never manages those, so they must not
    // flood the "not from Demiplane" list. Effects/conditions are transient too.
    actor.items.push(
      { id: "a1", name: "Investigate", type: "action", flags: {} },
      { id: "a2", name: "Repair", type: "action", flags: {} },
      { id: "e1", name: "Frightened 1", type: "effect", flags: {} },
      { id: "c1", name: "Off-Guard", type: "condition", flags: {} }
    );

    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    const opts = wait.mock.calls[0][0] as { content: string };

    // The genuine manual item is still listed…
    expect(opts.content).toContain("Manual Cloak");
    // …but activities/effects/conditions are not.
    expect(opts.content).not.toContain("Investigate");
    expect(opts.content).not.toContain("Repair");
    expect(opts.content).not.toContain("Frightened 1");
    expect(opts.content).not.toContain("Off-Guard");
    // Count reflects only the one real manual item, not the four excluded ones.
    expect(opts.content).toContain("Items not from Demiplane</strong> (1)");
  });

  it("omits the manual-items section entirely when only unsynced items remain", async () => {
    actor.items = [
      { id: "i1", name: "Imported Sword", type: "weapon", flags: { "demiplane-pf2e": { imported: true } } },
      { id: "a1", name: "Investigate", type: "action", flags: {} },
    ];

    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    const opts = wait.mock.calls[0][0] as { content: string };
    expect(opts.content).not.toContain("Items not from Demiplane");
  });

  it("separates unmapped items from sync issues", async () => {
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    const opts = wait.mock.calls[0][0] as { content: string };
    expect(opts.content).toContain("Sync issues");
    expect(opts.content).toContain("Unmapped items");
    // The unmapped slug is rendered through formatUnmapped, not listed as a sync issue.
    expect(opts.content).toContain("goblin-blade");
  });

  it("tells non-GM users their GM can fix the mapping", async () => {
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    const opts = wait.mock.calls[0][0] as { content: string };
    expect(opts.content).toContain("Your GM can map these");
    expect(opts.content).not.toContain("demiplane-open-mapping");
  });

  it("gives GMs a button to open the mapping editor", async () => {
    (globalThis as unknown as { game: { user: { isGM: boolean } } }).game.user.isGM = true;
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    const opts = wait.mock.calls[0][0] as { content: string };
    expect(opts.content).toContain("demiplane-open-mapping");
    expect(opts.content).not.toContain("Your GM can map these");
  });

  it("omits the sanctification selector when the character has no sanctification choice", async () => {
    // The default actor mock returns undefined for the sanctification flag.
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    const opts = wait.mock.calls[0][0] as { content: string };
    expect(opts.content).not.toContain("demiplane-sanctification-select");
  });

  it("renders a sanctification selector with the deity's options when the choice is real", async () => {
    actor.getFlag = vi.fn((_m: string, k: string) => {
      if (k === "characterId") return DEMI_UUID;
      if (k === "sanctification") return { options: ["holy", "none"], selected: "holy", acknowledged: false };
      return undefined;
    });
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    const opts = wait.mock.calls[0][0] as { content: string };
    expect(opts.content).toContain("demiplane-sanctification-select");
    expect(opts.content).toContain('<option value="holy" selected>Holy</option>');
    expect(opts.content).toContain('<option value="none">None</option>');
    // Only the deity's options appear — "Unholy" is not offered for a can-be-holy deity.
    expect(opts.content).not.toContain(">Unholy<");
  });

  it("flags the dialog when the latest sync has unacknowledged issues", async () => {
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    const withIssues = wait.mock.calls[0][0] as { classes: string[] };
    expect(withIssues.classes).toContain("has-sync-errors");
  });

  it("flags the dialog when only unmapped items exist and are unacknowledged", async () => {
    actor.getFlag = vi.fn((_m: string, k: string) => {
      if (k === "characterId") return DEMI_UUID;
      if (k === "unmappedSlugs") return [{ slug: "goblin-blade", kind: "equipment" }];
      return undefined;
    });
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    const opts = wait.mock.calls[0][0] as { classes: string[]; content: string };
    expect(opts.classes).toContain("has-sync-errors");
    expect(opts.content).toContain("Unmapped items");
    expect(opts.content).not.toContain("Sync issues");
  });

  it("pushes to Demiplane when the push button is clicked", async () => {
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    await clickAction("push");
    expect(exportFn).toHaveBeenCalledWith(actor);
  });

  it("enables the push button when auto-sync is on", async () => {
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    const push = pushButton();
    expect(push?.disabled).toBe(false);
    expect(push?.tooltip).toBe("");
  });

  it("disables the push button with an explanatory tooltip when auto-sync is off", async () => {
    autoSyncEnabled = false;
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    const push = pushButton();
    expect(push?.disabled).toBe(true);
    expect(push?.tooltip).toContain("Write to Demiplane");
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

  it("acknowledges issues on dismiss without deleting them", async () => {
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    await clickAction("dismiss");
    // Dismiss only sets the acknowledged flag; it must not wipe the issue sets,
    // so the mapping editor still has the unmapped slugs on the next open.
    expect(actor.setFlag).toHaveBeenCalledWith("demiplane-pf2e", "issuesAcknowledged", true);
    expect(actor.setFlag).not.toHaveBeenCalledWith("demiplane-pf2e", "importIssues", expect.anything());
    expect(actor.setFlag).not.toHaveBeenCalledWith("demiplane-pf2e", "unmappedSlugs", expect.anything());
  });

  it("does not acknowledge when the indicator is already clear", async () => {
    actor.getFlag = vi.fn((_m: string, k: string) => {
      if (k === "characterId") return DEMI_UUID;
      if (k === "issuesAcknowledged") return true;
      if (k === "importIssues") return ["imp issue"];
      return undefined;
    });
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    await clickAction("dismiss");
    expect(actor.setFlag).not.toHaveBeenCalledWith("demiplane-pf2e", "issuesAcknowledged", expect.anything());
  });

  it("does not flag the dialog once the issues are acknowledged", async () => {
    actor.getFlag = vi.fn((_m: string, k: string) => {
      if (k === "characterId") return DEMI_UUID;
      if (k === "issuesAcknowledged") return true;
      if (k === "importIssues") return ["imp issue"];
      if (k === "unmappedSlugs") return [{ slug: "goblin-blade", kind: "equipment" }];
      return undefined;
    });
    await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    const opts = wait.mock.calls[0][0] as { classes: string[]; content: string };
    // The dot is gone, but the issues are still shown on this second open.
    expect(opts.classes).not.toContain("has-sync-errors");
    expect(opts.content).toContain("imp issue");
    expect(opts.content).toContain("goblin-blade");
  });

  describe("unresolved choice dropdowns", () => {
    const choiceRecord = {
      key: "feat::choice",
      source: "guess",
      prompt: "Choose a skill",
      options: [
        { value: "acrobatics", label: "Acrobatics" },
        { value: "crafting", label: "Crafting" },
      ],
      guessedValue: "acrobatics",
    };

    function actorWithChoices(records: unknown[], overrides: Record<string, string>) {
      actor.getFlag = vi.fn((_m: string, k: string) => {
        if (k === "characterId") return DEMI_UUID;
        if (k === "importIssues") return [];
        if (k === "exportIssues") return [];
        if (k === "unmappedSlugs") return [];
        if (k === "unresolvedChoices") return records;
        if (k === "choiceOverrides") return overrides;
        return undefined;
      });
    }

    function dialogWithSelects(selects: Array<{ dataset: Record<string, string>; value: string }>) {
      const listeners: Record<string, Array<() => void>> = {};
      const fakeSelects = selects.map((select) => ({
        ...select,
        addEventListener: (event: string, fn: () => void) => {
          listeners[event] = [...(listeners[event] ?? []), fn];
        },
      }));
      const fakeDialog = {
        element: {
          querySelector: () => null,
          querySelectorAll: () => fakeSelects,
        },
      };
      return { fakeDialog, listeners };
    }

    async function openDialogWith(fakeDialog: unknown) {
      wait.mockImplementationOnce(async (opts: { render?: (event: unknown, dialog: unknown) => void }) => {
        opts.render?.({}, fakeDialog);
        return "close";
      });
      await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
    }

    it("renders one dropdown per unresolved choice with the stored pick preselected", async () => {
      actorWithChoices([choiceRecord], { "feat::choice": "crafting" });

      await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
      const opts = wait.mock.calls[0][0] as { content: string };

      expect(opts.content).toContain("Choices needing your input");
      expect(opts.content).toContain('data-choice-key="feat::choice"');
      // Explicit not-chosen state first, so a blind guess is never presented
      // as the user's decision.
      expect(opts.content).toContain("— choose —");
      expect(opts.content).toContain('value="crafting" selected');
      expect(opts.content).toContain("Guessed");
    });

    it("omits the choices section when nothing is unresolved", async () => {
      actorWithChoices([], {});

      await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
      const opts = wait.mock.calls[0][0] as { content: string };

      expect(opts.content).not.toContain("demiplane-choice-select");
      expect(opts.content).not.toContain("Choices needing your input");
    });

    it("persists a dropdown pick to the actor flag", async () => {
      actorWithChoices([choiceRecord], {});
      const { fakeDialog, listeners } = dialogWithSelects([
        { dataset: { choiceKey: "feat::choice" }, value: "crafting" },
      ]);
      await openDialogWith(fakeDialog);

      for (const fn of listeners["change"] ?? []) fn();

      expect(actor.setFlag).toHaveBeenCalledWith(MODULE_ID, "choiceOverrides", { "feat::choice": "crafting" });
    });

    it("removes the override when reset to not-chosen", async () => {
      actorWithChoices([choiceRecord], { "feat::choice": "crafting" });
      const { fakeDialog, listeners } = dialogWithSelects([{ dataset: { choiceKey: "feat::choice" }, value: "" }]);
      await openDialogWith(fakeDialog);

      for (const fn of listeners["change"] ?? []) fn();

      expect(actor.setFlag).toHaveBeenCalledWith(MODULE_ID, "choiceOverrides", {});
    });

    it("shows applied picks with a delete button", async () => {
      const applied = { ...choiceRecord, source: "override" };
      actorWithChoices([applied], { "feat::choice": "crafting" });

      await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
      const opts = wait.mock.calls[0][0] as { content: string };

      expect(opts.content).toContain("Your picks in effect");
      expect(opts.content).toContain("your pick");
      expect(opts.content).toContain('data-choice-key="feat::choice"');
      // No dropdown for an applied pick — only the delete.
      expect(opts.content).not.toContain("demiplane-choice-select");
    });

    it("shows stale picks with no record", async () => {
      actorWithChoices([], { "gone::choice": "crafting" });

      await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
      const opts = wait.mock.calls[0][0] as { content: string };

      expect(opts.content).toContain("Your picks in effect");
      expect(opts.content).toContain("stale");
      expect(opts.content).toContain('data-choice-key="gone::choice"');
    });

    it("omits the picks section when nothing is stored", async () => {
      actorWithChoices([choiceRecord], {});

      await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);
      const opts = wait.mock.calls[0][0] as { content: string };

      expect(opts.content).not.toContain("Your picks in effect");
    });

    it("deletes the pick and its row when the trashcan is clicked", async () => {
      actorWithChoices([{ ...choiceRecord, source: "override" }], { "feat::choice": "crafting" });
      let clicks = 0;
      const row = { remove: vi.fn() };
      const fakeButton = {
        dataset: { choiceKey: "feat::choice" },
        closest: () => row,
        addEventListener: (_event: string, fn: () => void) => {
          clicks += 1;
          fn();
        },
      };
      const fakeDialog = {
        element: {
          querySelector: () => null,
          querySelectorAll: (selector: string) => (selector === ".demiplane-choice-delete" ? [fakeButton] : []),
        },
      };
      wait.mockImplementationOnce(async (opts: { render?: (event: unknown, dialog: unknown) => void }) => {
        opts.render?.({}, fakeDialog);
        return "close";
      });
      await showDemiplaneInfoDialog(actor as never, DEMI_UUID, importFn as never, exportFn as never);

      expect(clicks).toBe(1);
      expect(actor.setFlag).toHaveBeenCalledWith(MODULE_ID, "choiceOverrides", {});
      expect(row.remove).toHaveBeenCalled();
    });
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
    expect(buttons).toHaveLength(1);
    expect(buttons[0].class).toBe("demiplane-info-btn");
  });

  it("adds the Demiplane button for character owners", () => {
    (globalThis as unknown as { game: { user: { isGM: boolean } } }).game = { user: { isGM: false } };
    registerDemiplaneInfoButton(importFn, exportFn);
    const buttons: Array<{ class?: string }> = [];
    capturedCallback()({ actor: linkedActor(true) }, buttons);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].class).toBe("demiplane-info-btn");
  });

  it("omits the button for non-GM, non-owner users", () => {
    (globalThis as unknown as { game: { user: { isGM: boolean } } }).game = { user: { isGM: false } };
    registerDemiplaneInfoButton(importFn, exportFn);
    const buttons: Array<{ class?: string }> = [];
    capturedCallback()({ actor: linkedActor(false) }, buttons);
    expect(buttons).toHaveLength(0);
  });
});
