import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFoundryMocks, createMockActor } from "./foundry-mocks.js";
import { ExportManager } from "../../src/export-manager.js";
import {
  exportLinkedCharacter,
  importLinkedCharacter,
  pushCharacterEngines,
  recoverStaleSyncPauses,
  notifyConflict,
  reimportActorOnConflict,
  handlePushConflict,
} from "../../src/sync-flows.js";
import { isSyncActive } from "../../src/sync-pause.js";
import { MODULE_ID } from "../../src/import/types.js";

const CHARACTER_ID = "char-123";
const TOKEN = "token-abc";

function summary(overrides = {}) {
  return { itemsImported: 3, itemsSkipped: 0, unmapped: [], errors: [], log: [], ...overrides };
}

function makeDeps(overrides = {}) {
  const importCharacter = vi.fn().mockResolvedValue(summary());
  const exportManager = new ExportManager({});
  return {
    deps: { exportManager, importOrchestrator: { importCharacter }, ...overrides },
    importCharacter,
    exportManager,
  };
}

function linkedActor() {
  const actor = createMockActor({ name: "Valeros" });
  actor.flags[MODULE_ID] = { characterId: CHARACTER_ID };
  // queueAllDetailChanges subtracts granted languages from the full list.
  actor.system.build.languages = { granted: [] };
  return actor;
}

describe("sync-flows", () => {
  beforeEach(() => {
    installFoundryMocks();
  });

  describe("importLinkedCharacter", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      // Drain the pending sync-release timer so it can't leak into sibling
      // describe blocks (which run with real timers), then restore real timers.
      vi.runAllTimers();
      vi.useRealTimers();
    });

    it("imports without wiping by default and records unmapped slugs and issues", async () => {
      const { deps, importCharacter } = makeDeps();
      const actor = linkedActor();
      importCharacter.mockResolvedValue(summary({ unmapped: [{ slug: "nope", kind: "feat" }], errors: ["boom"] }));

      const result = await importLinkedCharacter(actor, CHARACTER_ID, TOKEN, deps);

      expect(importCharacter).toHaveBeenCalledWith(actor, CHARACTER_ID, { token: TOKEN });
      expect(result.itemsImported).toBe(3);
      expect(actor.setFlag).toHaveBeenCalledWith(MODULE_ID, "unmappedSlugs", [{ slug: "nope", kind: "feat" }]);
      expect(actor.setFlag).toHaveBeenCalledWith(MODULE_ID, "importIssues", ["boom"]);
      // The guard is held through the grace window so late import-induced hooks
      // stay suppressed; it releases only after the grace timer fires.
      expect(isSyncActive(actor)).toBe(true);
      await vi.runAllTimersAsync();
      expect(isSyncActive(actor)).toBe(false);
    });

    it("keeps the sync guard active through the grace window after import returns", async () => {
      // Regression: an import creates/deletes items, but Foundry fires the item
      // hooks (and PF2e re-prepares) on later ticks. If the guard released the
      // instant import returned, a late deleteItem would push a deletion to
      // Demiplane. The guard must stay active until the grace window elapses.
      const { deps } = makeDeps();
      const actor = linkedActor();

      await importLinkedCharacter(actor, CHARACTER_ID, TOKEN, deps);

      expect(isSyncActive(actor)).toBe(true);
      // Still held just before the grace window closes...
      await vi.advanceTimersByTimeAsync(4000);
      expect(isSyncActive(actor)).toBe(true);
      // ...released after it does.
      await vi.advanceTimersByTimeAsync(2000);
      expect(isSyncActive(actor)).toBe(false);
    });

    it("deletes previously imported items when wiping", async () => {
      const { deps, importCharacter } = makeDeps();
      const stale = {
        id: "old-1",
        _id: "old-1",
        name: "Old Feat",
        type: "feat",
        flags: { [MODULE_ID]: { imported: true } },
        system: {},
      };
      const actor = createMockActor({ name: "Valeros", items: [stale] });
      actor.flags[MODULE_ID] = { characterId: CHARACTER_ID };
      actor.system.build.languages = { granted: [] };

      await importLinkedCharacter(actor, CHARACTER_ID, TOKEN, deps, { wipe: true });

      expect(importCharacter).toHaveBeenCalledTimes(1);
      expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["old-1"]);
    });

    it("still imports when the pre-wipe delete fails", async () => {
      const { deps, importCharacter } = makeDeps();
      const actor = linkedActor();
      actor.deleteEmbeddedDocuments = vi.fn().mockRejectedValueOnce(new Error("nope"));

      await importLinkedCharacter(actor, CHARACTER_ID, TOKEN, deps, { wipe: true });

      expect(importCharacter).toHaveBeenCalledTimes(1);
      await vi.runAllTimersAsync();
      expect(isSyncActive(actor)).toBe(false);
    });

    it("releases the sync pause and resumes even when the import throws", async () => {
      const { deps, importCharacter } = makeDeps();
      const actor = linkedActor();
      importCharacter.mockRejectedValueOnce(new Error("import failed"));

      await expect(importLinkedCharacter(actor, CHARACTER_ID, TOKEN, deps)).rejects.toThrow("import failed");
      // The guard still releases after the grace window even on failure.
      await vi.runAllTimersAsync();
      expect(isSyncActive(actor)).toBe(false);
    });
  });

  describe("exportLinkedCharacter", () => {
    it("warns and reports failure when auto-sync is off", async () => {
      const { deps } = makeDeps();
      const actor = linkedActor();
      const ui = globalThis.ui;

      const result = await exportLinkedCharacter(actor, deps);

      expect(result).toEqual({ success: false, error: "Writing to Demiplane is off" });
      expect(ui.notifications.warn).toHaveBeenCalledWith(expect.stringContaining("Writing to Demiplane is off"));
    });

    it("pushes engines and exports string campaign notes on success", async () => {
      const { deps, exportManager } = makeDeps();
      await globalThis.game.settings.set(MODULE_ID, "syncWriteLevel", "text-quantity-delete");
      const notes = vi.spyOn(exportManager, "exportCampaignNotes").mockResolvedValue(undefined);
      vi.spyOn(exportManager, "flush").mockResolvedValue({ success: true });
      const actor = linkedActor();
      actor.system.details.biography = { campaignNotes: "Party notes" };

      const result = await exportLinkedCharacter(actor, deps);

      expect(result).toEqual({ success: true });
      expect(notes).toHaveBeenCalledWith(actor, "Party notes");
    });

    it("skips the journal push when campaign notes are not a string", async () => {
      const { deps, exportManager } = makeDeps();
      await globalThis.game.settings.set(MODULE_ID, "syncWriteLevel", "text-quantity-delete");
      const notes = vi.spyOn(exportManager, "exportCampaignNotes").mockResolvedValue(undefined);
      vi.spyOn(exportManager, "flush").mockResolvedValue({ success: true });

      await exportLinkedCharacter(linkedActor(), deps);

      expect(notes).not.toHaveBeenCalled();
    });

    it("runs a real flush through the manager when pushing", async () => {
      const client = {
        isAuthenticated: () => true,
        fetchCharacterData: vi.fn().mockResolvedValue({ engines: [], updated: "2026-01-01T00:00:00.000Z" }),
        fetchCharacterUpdated: vi.fn().mockResolvedValue("2026-01-01T00:00:00.000Z"),
        updateCharacter: vi.fn().mockResolvedValue({ success: true, updated: "2026-01-01T00:00:00.000Z" }),
        updateLastAccess: vi.fn().mockResolvedValue(undefined),
      };
      const exportManager = new ExportManager(client);
      const importCharacter = vi.fn().mockResolvedValue(summary());
      await globalThis.game.settings.set(MODULE_ID, "syncWriteLevel", "text-quantity-delete");

      const result = await exportLinkedCharacter(linkedActor(), {
        exportManager,
        importOrchestrator: { importCharacter },
      });

      expect(result.success).toBe(true);
      expect(globalThis.ui.notifications.info).toHaveBeenCalledWith(expect.stringContaining("Pushed character data"));
    });
  });

  describe("pushCharacterEngines", () => {
    it("returns the conflict result and defers recovery to the registered handler", async () => {
      // Conflict recovery is owned by the handler flush fires (handlePushConflict);
      // the manual path re-arms the warn guard and returns the conflict result
      // without its own recovery, so both paths behave identically.
      const { deps, importCharacter } = makeDeps();
      const actor = linkedActor();
      vi.spyOn(deps.exportManager, "flush").mockResolvedValue({ success: false, conflict: true });

      const result = await pushCharacterEngines(actor, deps);

      expect(result).toEqual({ success: false, conflict: true });
      expect(importCharacter).not.toHaveBeenCalled();
      // Re-armed the guard so the handler will surface this conflict to the user.
      expect(actor.setFlag).toHaveBeenCalledWith(MODULE_ID, "conflictNotified", false);
      expect(isSyncActive(actor)).toBe(false);
    });

    it("stays silent on a plain failure", async () => {
      const { deps } = makeDeps();
      const actor = linkedActor();
      vi.spyOn(deps.exportManager, "flush").mockResolvedValue({ success: false, error: "offline" });

      const result = await pushCharacterEngines(actor, deps);

      expect(result).toEqual({ success: false, error: "offline" });
      expect(globalThis.ui.notifications.info).not.toHaveBeenCalled();
      expect(globalThis.ui.notifications.warn).not.toHaveBeenCalled();
    });
  });

  describe("notifyConflict", () => {
    it("warns the user and records an export issue without re-importing", async () => {
      const actor = linkedActor();

      notifyConflict(actor);

      expect(globalThis.ui.notifications.warn).toHaveBeenCalledWith(
        expect.stringContaining("re-importing overwrites your local changes")
      );
      // Persisted as an export issue so the sync indicator lights up.
      expect(actor.setFlag).toHaveBeenCalledWith(MODULE_ID, "exportIssues", [expect.stringContaining("Re-import")]);
      // The once-per-conflict guard is set so retries don't re-toast.
      expect(actor.setFlag).toHaveBeenCalledWith(MODULE_ID, "conflictNotified", true);
    });

    it("does not re-warn while the conflict is still unresolved", async () => {
      const actor = linkedActor();
      actor.flags[MODULE_ID].conflictNotified = true;

      notifyConflict(actor);

      // Repeat auto-pushes (~every 2s) must not spam the toast...
      expect(globalThis.ui.notifications.warn).not.toHaveBeenCalled();
      // ...but the issue is still recorded so the indicator stays lit.
      expect(actor.setFlag).toHaveBeenCalledWith(MODULE_ID, "exportIssues", [expect.stringContaining("Re-import")]);
    });
  });

  describe("reimportActorOnConflict", () => {
    it("warns when the actor is not linked", async () => {
      const { deps, importCharacter } = makeDeps();
      const actor = createMockActor({ name: "Orphan" });

      await reimportActorOnConflict(actor, deps);

      expect(importCharacter).not.toHaveBeenCalled();
      expect(globalThis.ui.notifications.warn).toHaveBeenCalledWith(expect.stringContaining("missing character link"));
    });

    it("warns when no token is configured", async () => {
      const { deps, importCharacter } = makeDeps();

      await reimportActorOnConflict(linkedActor(), deps);

      expect(importCharacter).not.toHaveBeenCalled();
      expect(globalThis.ui.notifications.warn).toHaveBeenCalled();
    });

    it("re-imports with wipe and reports the item count", async () => {
      const { deps, importCharacter } = makeDeps();
      await globalThis.game.settings.set(MODULE_ID, "demiplaneToken", TOKEN);
      const actor = linkedActor();

      await reimportActorOnConflict(actor, deps);

      expect(importCharacter).toHaveBeenCalledWith(actor, CHARACTER_ID, { token: TOKEN });
      expect(globalThis.ui.notifications.info).toHaveBeenCalledWith(expect.stringContaining("Re-imported"));
    });
  });

  describe("handlePushConflict", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      vi.runAllTimers();
      vi.useRealTimers();
    });

    it("re-imports (not warn-only) when quantity or higher is being written", async () => {
      const { deps, importCharacter } = makeDeps();
      await globalThis.game.settings.set(MODULE_ID, "syncWriteLevel", "text-quantity");
      await globalThis.game.settings.set(MODULE_ID, "demiplaneToken", TOKEN);
      const actor = linkedActor();

      await handlePushConflict(actor, deps);

      // Session info is already on Demiplane at this tier, so a re-import is safe
      // and keeps both sides consistent.
      expect(importCharacter).toHaveBeenCalledWith(actor, CHARACTER_ID, { token: TOKEN });
      expect(globalThis.ui.notifications.info).toHaveBeenCalledWith(expect.stringContaining("re-importing to stay"));
      await vi.runAllTimersAsync();
    });

    it("warns without re-importing at the text-only tier", async () => {
      const { deps, importCharacter } = makeDeps();
      await globalThis.game.settings.set(MODULE_ID, "syncWriteLevel", "text");
      const actor = linkedActor();

      await handlePushConflict(actor, deps);

      // At text-only, session info is NOT pushed, so a re-import would clobber it.
      expect(importCharacter).not.toHaveBeenCalled();
      expect(globalThis.ui.notifications.warn).toHaveBeenCalledWith(
        expect.stringContaining("re-importing overwrites your local changes")
      );
    });
  });

  describe("recoverStaleSyncPauses", () => {
    it("clears marks left by a crashed session and skips clean actors", async () => {
      installFoundryMocks();
      const stale = linkedActor();
      stale.flags[MODULE_ID].syncActiveTokens = ["stale-token"];
      const clean = linkedActor();
      const unlinked = createMockActor({ name: "Orphan" });
      globalThis.game.actors.contents = [stale, clean, unlinked];

      await recoverStaleSyncPauses();

      expect(stale.setFlag).toHaveBeenCalledWith(MODULE_ID, "syncActiveTokens", []);
      expect(clean.setFlag).not.toHaveBeenCalled();
      expect(unlinked.setFlag).not.toHaveBeenCalled();
    });

    it("does nothing when no actors carry sync marks", async () => {
      installFoundryMocks();
      const actor = linkedActor();
      globalThis.game.actors.contents = [actor];

      await recoverStaleSyncPauses();

      expect(actor.setFlag).not.toHaveBeenCalled();
    });
  });
});
