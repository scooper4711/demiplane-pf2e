import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@scooper4711/demiplane-api", () => ({
  updateCustomEngineValue: vi.fn(
    (
      engines: { name: string; value?: unknown }[],
      storeName: string,
      value: unknown,
    ) => engines.map((e) => (e.name === storeName ? { ...e, value } : e)),
  ),
}));

vi.stubGlobal("ui", {
  notifications: { error: vi.fn() },
});

import { ExportManager } from "../../src/export-manager.js";

function createMockActor(characterId = "char-123", storedVersion?: number) {
  return {
    getFlag: (_moduleId: string, key: string) => {
      if (key === "characterId") return characterId;
      if (key === "lastKnownVersion") return storedVersion;
      return undefined;
    },
    setFlag: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockClient(overrides = {}) {
  return {
    fetchCharacterData: vi.fn().mockResolvedValue({
      engines: [
        {
          id: "eng-1",
          name: "character_hit-points_current",
          value: 30,
          type: "CustomDemiplaneEngine",
          saveType: "CharacterSheet",
          storeType: "override",
          demiplaneEngineId: "de-1",
          args: { id: null },
        },
      ],
    }),
    fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 5 }),
    updateCharacter: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("ExportManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("queueChange accumulates changes and resets timer", () => {
    it("accumulates multiple field changes for the same character", () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueChange(actor as never, "character_hit-points_current", 25);
      manager.queueChange(actor as never, "character_hero-points", 2);

      const pending = manager.getPendingChanges("char-123");
      expect(pending).toHaveLength(2);
      expect(
        pending.find((c) => c.field === "character_hit-points_current")?.value,
      ).toBe(25);
      expect(
        pending.find((c) => c.field === "character_hero-points")?.value,
      ).toBe(2);
    });

    it("overwrites previous value for the same field", () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueChange(actor as never, "character_hit-points_current", 25);
      manager.queueChange(actor as never, "character_hit-points_current", 20);

      const pending = manager.getPendingChanges("char-123");
      expect(pending).toHaveLength(1);
      expect(pending[0].value).toBe(20);
    });

    it("does nothing when actor has no characterId", () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = createMockActor(undefined as unknown as string);

      manager.queueChange(actor as never, "character_hit-points_current", 25);

      expect(manager.hasPendingChanges("undefined")).toBe(false);
    });

    it("resets the debounce timer on each new change", async () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueChange(actor as never, "character_hit-points_current", 25);
      vi.advanceTimersByTime(1500);

      manager.queueChange(actor as never, "character_hit-points_current", 20);
      vi.advanceTimersByTime(1500);

      // Only 3000ms total, but timer was reset at 1500ms.
      // At this point only 1500ms since last change — no flush yet.
      expect(client.fetchCharacterData).not.toHaveBeenCalled();

      vi.advanceTimersByTime(600);
      await vi.runAllTimersAsync();

      // After the debounce fires, flush is called
      expect(client.fetchCharacterData).toHaveBeenCalled();
    });
  });

  describe("flush returns pending changes as preview in dry run mode", () => {
    it("returns preview array without sending API call", async () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueChange(actor as never, "character_hit-points_current", 25);
      manager.queueChange(actor as never, "character_hero-points", 1);

      const result = await manager.flush(actor as never, { dryRun: true });

      expect(result.success).toBe(true);
      expect(result.preview).toHaveLength(2);
      expect(
        result.preview?.find((c) => c.field === "character_hit-points_current")
          ?.value,
      ).toBe(25);
      expect(client.updateCharacter).not.toHaveBeenCalled();
    });

    it("performs conflict detection in dry run mode", async () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = createMockActor("char-123", 3);

      manager.queueChange(actor as never, "character_hit-points_current", 25);

      const result = await manager.flush(actor as never, { dryRun: true });

      expect(result.success).toBe(true);
      expect(result.conflictDetected).toBe(true);
      expect(client.fetchCharacterVersion).toHaveBeenCalled();
    });
  });

  describe("flush clears pending changes on success", () => {
    it("removes pending changes after successful push", async () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueChange(actor as never, "character_hit-points_current", 25);
      expect(manager.hasPendingChanges("char-123")).toBe(true);

      await manager.flush(actor as never);

      expect(manager.hasPendingChanges("char-123")).toBe(false);
    });

    it("updates version flags after successful push", async () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueChange(actor as never, "character_hit-points_current", 25);
      await manager.flush(actor as never);

      expect(actor.setFlag).toHaveBeenCalledWith(
        "foundry-demiplane-pf2e",
        "lastKnownVersion",
        5,
      );
      expect(actor.setFlag).toHaveBeenCalledWith(
        "foundry-demiplane-pf2e",
        "lastSyncTimestamp",
        expect.any(Number),
      );
    });
  });

  describe("flush retains pending changes on failure", () => {
    it("keeps pending changes when all retries fail", async () => {
      const client = createMockClient({
        updateCharacter: vi.fn().mockResolvedValue(false),
      });
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueChange(actor as never, "character_hit-points_current", 25);

      // Advance past debounce to trigger the flush naturally
      await vi.advanceTimersByTimeAsync(2000);

      // Advance through all backoff delays: 1s, 2s, 4s
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);

      expect(manager.hasPendingChanges("char-123")).toBe(true);
    });

    it("displays ui.notifications.error on failure", async () => {
      const client = createMockClient({
        updateCharacter: vi.fn().mockResolvedValue(false),
      });
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueChange(actor as never, "character_hit-points_current", 25);

      // Advance past debounce to trigger the flush naturally
      await vi.advanceTimersByTimeAsync(2000);

      // Advance through all backoff delays
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);

      expect(ui.notifications.error).toHaveBeenCalledWith(
        expect.stringContaining("Demiplane sync failed"),
      );
    });
  });

  describe("flush returns rate limit error when exceeded", () => {
    it("rejects flush when 30 calls have been made in 60 seconds", async () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      // Simulate 30 successful flushes to fill the rate limit window
      for (let i = 0; i < 30; i++) {
        manager.queueChange(actor as never, "character_hit-points_current", i);
        await manager.flush(actor as never);
      }

      // The 31st should be rate limited
      manager.queueChange(actor as never, "character_hit-points_current", 99);
      const result = await manager.flush(actor as never);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Rate limit exceeded");
    });
  });

  describe("exponential backoff retries", () => {
    it("retries up to 3 times with increasing delays", async () => {
      let callCount = 0;
      const updateMock = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount >= 4);
      });

      const client = createMockClient({
        updateCharacter: updateMock,
      });
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      // Queue a change then advance past debounce to trigger flush naturally
      manager.queueChange(actor as never, "character_hit-points_current", 25);

      // Advance past the debounce window to trigger the single flush
      await vi.advanceTimersByTimeAsync(2000);

      // Now advance through backoff delays: 1s, 2s, 4s
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);

      // 4 attempts total: initial + 3 retries
      expect(updateMock).toHaveBeenCalledTimes(4);
    });

    it("fails after all retry attempts are exhausted", async () => {
      const client = createMockClient({
        updateCharacter: vi.fn().mockResolvedValue(false),
      });
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueChange(actor as never, "character_hit-points_current", 25);

      // Advance past debounce to trigger flush
      await vi.advanceTimersByTimeAsync(2000);

      // Advance through all backoff delays
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);

      // Pending changes should still be there since all attempts failed
      expect(manager.hasPendingChanges("char-123")).toBe(true);
      expect(ui.notifications.error).toHaveBeenCalledWith(
        expect.stringContaining("Demiplane sync failed"),
      );
    });

    it("succeeds immediately without backoff when first attempt works", async () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueChange(actor as never, "character_hit-points_current", 25);
      const result = await manager.flush(actor as never);

      expect(result.success).toBe(true);
      expect(client.updateCharacter).toHaveBeenCalledTimes(1);
    });
  });

  describe("flush with no pending changes", () => {
    it("returns success with no API call when no changes are pending", async () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      const result = await manager.flush(actor as never);

      expect(result.success).toBe(true);
      expect(client.updateCharacter).not.toHaveBeenCalled();
    });
  });

  describe("flush with no characterId", () => {
    it("returns error when actor has no linked character", async () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = {
        getFlag: () => undefined,
        setFlag: vi.fn(),
      };

      const result = await manager.flush(actor as never);

      expect(result.success).toBe(false);
      expect(result.error).toContain("no linked character ID");
    });
  });
});
