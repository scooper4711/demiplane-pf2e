import { describe, it, expect, beforeEach, vi } from "vitest";
import { installFoundryMocks, createMockActor } from "./foundry-mocks.js";
import { ExportManager } from "../../src/export-manager.js";
import {
  exportLinkedCharacter,
  importLinkedCharacter,
  pushCharacterEngines,
  recoverStaleSyncPauses,
  reimportActorOnConflict,
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
    it("imports without wiping by default and records unmapped slugs and issues", async () => {
      const { deps, importCharacter } = makeDeps();
      const actor = linkedActor();
      importCharacter.mockResolvedValue(summary({ unmapped: [{ slug: "nope", kind: "feat" }], errors: ["boom"] }));

      const result = await importLinkedCharacter(actor, CHARACTER_ID, TOKEN, deps);

      expect(importCharacter).toHaveBeenCalledWith(actor, CHARACTER_ID, { token: TOKEN });
      expect(result.itemsImported).toBe(3);
      expect(actor.setFlag).toHaveBeenCalledWith(MODULE_ID, "unmappedSlugs", [{ slug: "nope", kind: "feat" }]);
      expect(actor.setFlag).toHaveBeenCalledWith(MODULE_ID, "importIssues", ["boom"]);
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
      expect(isSyncActive(actor)).toBe(false);
    });

    it("releases the sync pause and resumes even when the import throws", async () => {
      const { deps, importCharacter } = makeDeps();
      const actor = linkedActor();
      importCharacter.mockRejectedValueOnce(new Error("import failed"));

      await expect(importLinkedCharacter(actor, CHARACTER_ID, TOKEN, deps)).rejects.toThrow("import failed");
      expect(isSyncActive(actor)).toBe(false);
    });
  });

  describe("exportLinkedCharacter", () => {
    it("warns and reports failure when auto-sync is off", async () => {
      const { deps } = makeDeps();
      const actor = linkedActor();
      const ui = globalThis.ui;

      const result = await exportLinkedCharacter(actor, deps);

      expect(result).toEqual({ success: false, error: "Auto-sync is off" });
      expect(ui.notifications.warn).toHaveBeenCalledWith(expect.stringContaining("Auto-sync is off"));
    });

    it("pushes engines and exports string campaign notes on success", async () => {
      const { deps, exportManager } = makeDeps();
      await globalThis.game.settings.set(MODULE_ID, "autoSync", true);
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
      await globalThis.game.settings.set(MODULE_ID, "autoSync", true);
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
      await globalThis.game.settings.set(MODULE_ID, "autoSync", true);

      const result = await exportLinkedCharacter(linkedActor(), {
        exportManager,
        importOrchestrator: { importCharacter },
      });

      expect(result.success).toBe(true);
      expect(globalThis.ui.notifications.info).toHaveBeenCalledWith(expect.stringContaining("Pushed character data"));
    });
  });

  describe("pushCharacterEngines", () => {
    it("warns on an optimistic-concurrency conflict", async () => {
      const { deps } = makeDeps();
      const actor = linkedActor();
      vi.spyOn(deps.exportManager, "flush").mockResolvedValue({ success: false, conflict: true });

      const result = await pushCharacterEngines(actor, deps);

      expect(result).toEqual({ success: false, conflict: true });
      expect(globalThis.ui.notifications.warn).toHaveBeenCalledWith(expect.stringContaining("changed on the server"));
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
