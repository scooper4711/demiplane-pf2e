import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@scooper4711/demiplane-api", () => ({
  findCustomEngineByName: vi.fn(
    (engines: { name: string; type: string; value?: unknown; id?: string }[], storeName: string) =>
      engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === storeName)
  ),
}));

vi.stubGlobal("ui", {
  notifications: { error: vi.fn() },
});

import { ExportManager } from "../../src/export-manager.js";

function createMockActor(characterId = "char-123") {
  return {
    getFlag: (_moduleId: string, key: string) => {
      if (key === "characterId") return characterId;
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
          id: "eng-hp",
          name: "character_hit-points_current",
          value: 30,
          type: "CustomDemiplaneEngine",
          saveType: "CharacterSheet",
          storeType: "override",
          demiplaneEngineId: "de-hp",
          args: { id: null },
        },
        {
          id: "eng-hero",
          name: "character_hero-points",
          value: 1,
          type: "CustomDemiplaneEngine",
          saveType: "CharacterSheet",
          storeType: "override",
          demiplaneEngineId: "de-hero",
          args: { id: null },
        },
      ],
      engineCacheIdsBySource: { "pathfinder2e-v2": ["eng-hp", "eng-hero"] },
      name: "Test Character",
      level: 5,
      avatarUrl: "https://example.com/avatar.png",
      viewPermission: 0,
      editPermission: 0,
    }),
    updateCharacter: vi.fn().mockResolvedValue({ success: true, message: null, result: null }),
    isAuthenticated: vi.fn().mockReturnValue(true),
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
      expect(pending.find((c) => c.field === "character_hit-points_current")?.value).toBe(25);
      expect(pending.find((c) => c.field === "character_hero-points")?.value).toBe(2);
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
      expect(client.updateCharacter).not.toHaveBeenCalled();

      vi.advanceTimersByTime(600);
      await vi.runAllTimersAsync();

      // After the debounce fires, flush is called
      expect(client.updateCharacter).toHaveBeenCalled();
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
      expect(result.preview?.find((c) => c.field === "character_hit-points_current")?.value).toBe(25);
      expect(client.updateCharacter).not.toHaveBeenCalled();
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

    it("updates sync timestamp after successful push", async () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueChange(actor as never, "character_hit-points_current", 25);
      await manager.flush(actor as never);

      expect(actor.setFlag).toHaveBeenCalledWith("demiplane-pf2e", "lastExportTimestamp", expect.any(Number));
    });
  });

  describe("flush retains pending changes on failure", () => {
    it("keeps pending changes when all retries fail", async () => {
      const client = createMockClient({
        updateCharacter: vi.fn().mockResolvedValue({ success: false, message: "test error", result: null }),
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
        updateCharacter: vi.fn().mockResolvedValue({ success: false, message: "test error", result: null }),
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

      expect(ui.notifications.error).toHaveBeenCalledWith(expect.stringContaining("Demiplane sync failed"));
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
        return Promise.resolve({ success: callCount >= 4, message: null, result: null });
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
        updateCharacter: vi.fn().mockResolvedValue({ success: false, message: "test error", result: null }),
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
      expect(ui.notifications.error).toHaveBeenCalledWith(expect.stringContaining("Demiplane sync failed"));
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

    it("sends all engines with updated values for changed fields", async () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueChange(actor as never, "character_hit-points_current", 25);
      await manager.flush(actor as never);

      expect(client.fetchCharacterData).toHaveBeenCalledWith("char-123");
      expect(client.updateCharacter).toHaveBeenCalledWith({
        id: "char-123",
        data: {
          engineCacheIdsBySource: { "pathfinder2e-v2": ["eng-hp", "eng-hero"] },
          engines: [
            {
              id: "eng-hp",
              name: "character_hit-points_current",
              value: 25,
              type: "CustomDemiplaneEngine",
              saveType: "CharacterSheet",
              storeType: "override",
              demiplaneEngineId: "de-hp",
              args: { id: null },
            },
            {
              id: "eng-hero",
              name: "character_hero-points",
              value: 1,
              type: "CustomDemiplaneEngine",
              saveType: "CharacterSheet",
              storeType: "override",
              demiplaneEngineId: "de-hero",
              args: { id: null },
            },
          ],
        },
        name: "Test Character",
        level: 5,
        avatarUrl: "https://example.com/avatar.png",
        viewPermission: 0,
        editPermission: 0,
      });
    });

    it("batches multiple changed fields into a single payload", async () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueChange(actor as never, "character_hit-points_current", 25);
      manager.queueChange(actor as never, "character_hero-points", 2);
      await manager.flush(actor as never);

      expect(client.updateCharacter).toHaveBeenCalledTimes(1);
      const payload = vi.mocked(client.updateCharacter).mock.calls[0][0];
      expect(payload.data.engines).toHaveLength(2);
      expect(payload.data.engines.map((e: { name: string }) => e.name)).toEqual(
        expect.arrayContaining(["character_hit-points_current", "character_hero-points"])
      );
      expect(payload.data.engines.map((e: { id: string }) => e.id)).toEqual(
        expect.arrayContaining(["eng-hp", "eng-hero"])
      );
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

  describe("flush without authentication", () => {
    it("returns an error and notifies the user when no token is configured", async () => {
      const client = createMockClient({
        isAuthenticated: vi.fn().mockReturnValue(false),
      });
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueChange(actor as never, "character_hit-points_current", 25);
      const result = await manager.flush(actor as never);

      expect(result.success).toBe(false);
      expect(result.error).toContain("No Demiplane token");
      expect(client.updateCharacter).not.toHaveBeenCalled();
      expect(ui.notifications.error).toHaveBeenCalledWith(expect.stringContaining("Demiplane sync failed"));
    });
  });

  describe("suspend during import", () => {
    it("ignores queued changes and drops pending state while suspended", () => {
      const client = createMockClient();
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueChange(actor as never, "character_hit-points_current", 25);
      expect(manager.hasPendingChanges("char-123")).toBe(true);

      manager.suspend();
      expect(manager.hasPendingChanges("char-123")).toBe(false);

      manager.queueChange(actor as never, "character_hero-points", 2);
      expect(manager.hasPendingChanges("char-123")).toBe(false);

      manager.resume();
      manager.queueChange(actor as never, "character_hero-points", 3);
      expect(manager.hasPendingChanges("char-123")).toBe(true);
    });
  });

  describe("item hand slot assignment", () => {
    function makeClientWithItems(itemEngines: Record<string, unknown>[]) {
      const base = createMockClient();
      base.fetchCharacterData.mockResolvedValue({
        engines: [
          {
            id: "eng-hp",
            name: "character_hit-points_current",
            value: 30,
            type: "CustomDemiplaneEngine",
            saveType: "CharacterSheet",
            storeType: "override",
            demiplaneEngineId: "de-hp",
            args: { id: null },
          },
          {
            id: "hand-primary",
            name: "character_hand_primary_equipped-id",
            value: "na",
            type: "CustomDemiplaneEngine",
            saveType: "CharacterSheet",
            storeType: "override",
            demiplaneEngineId: "de-primary",
            args: { id: null },
          },
          {
            id: "hand-offhand",
            name: "character_hand_offhand_equipped-id",
            value: "na",
            type: "CustomDemiplaneEngine",
            saveType: "CharacterSheet",
            storeType: "override",
            demiplaneEngineId: "de-offhand",
            args: { id: null },
          },
          {
            id: "hand-both",
            name: "character_hand_both_equipped-id",
            value: "na",
            type: "CustomDemiplaneEngine",
            saveType: "CharacterSheet",
            storeType: "override",
            demiplaneEngineId: "de-both",
            args: { id: null },
          },
          ...itemEngines,
        ],
        engineCacheIdsBySource: { "pathfinder2e-v2": ["eng-hp"] },
        name: "Test Character",
        level: 5,
        avatarUrl: "https://example.com/avatar.png",
        viewPermission: 0,
        editPermission: 0,
      });
      return base;
    }

    function itemEngine(slug: string, demiplaneId: string) {
      return {
        id: `eng-${slug}`,
        demiplaneEngineId: demiplaneId,
        name: `tabula/item/${slug}.eng`,
        type: "DemiplaneEngine",
        saveType: "CharacterSheet",
        args: { id: null, slug },
      };
    }

    function findEngine(payload: { data: { engines: { name: string; value: unknown }[] } }, name: string) {
      return payload.data.engines.find((e) => e.name === name)?.value;
    }

    it("assigns first 1H to primary, second 1H to offhand", async () => {
      const client = makeClientWithItems([itemEngine("sword-a", "id-a"), itemEngine("sword-b", "id-b")]);
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueItemChange(
        actor as never,
        "sword-a",
        undefined,
        "equipped",
        { carryType: "held", handsHeld: 1 },
        "weapon"
      );
      manager.queueItemChange(
        actor as never,
        "sword-b",
        undefined,
        "equipped",
        { carryType: "held", handsHeld: 1 },
        "weapon"
      );
      await manager.flush(actor as never);

      const payload = vi.mocked(client.updateCharacter).mock.calls[0][0];
      expect(findEngine(payload, "character_hand_primary_equipped-id")).toBe("id-a");
      expect(findEngine(payload, "character_hand_offhand_equipped-id")).toBe("id-b");
      expect(findEngine(payload, "character_hand_both_equipped-id")).toBe("na");
    });

    it("ignores third and subsequent 1H items", async () => {
      const client = makeClientWithItems([
        itemEngine("sword-a", "id-a"),
        itemEngine("sword-b", "id-b"),
        itemEngine("sword-c", "id-c"),
      ]);
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueItemChange(
        actor as never,
        "sword-a",
        undefined,
        "equipped",
        { carryType: "held", handsHeld: 1 },
        "weapon"
      );
      manager.queueItemChange(
        actor as never,
        "sword-b",
        undefined,
        "equipped",
        { carryType: "held", handsHeld: 1 },
        "weapon"
      );
      manager.queueItemChange(
        actor as never,
        "sword-c",
        undefined,
        "equipped",
        { carryType: "held", handsHeld: 1 },
        "weapon"
      );
      await manager.flush(actor as never);

      const payload = vi.mocked(client.updateCharacter).mock.calls[0][0];
      expect(findEngine(payload, "character_hand_primary_equipped-id")).toBe("id-a");
      expect(findEngine(payload, "character_hand_offhand_equipped-id")).toBe("id-b");
    });

    it("places a 2H weapon in both hands and ignores subsequent held items", async () => {
      const client = makeClientWithItems([itemEngine("greatsword", "id-gs"), itemEngine("sword-a", "id-a")]);
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueItemChange(
        actor as never,
        "greatsword",
        undefined,
        "equipped",
        { carryType: "held", handsHeld: 2 },
        "weapon"
      );
      manager.queueItemChange(
        actor as never,
        "sword-a",
        undefined,
        "equipped",
        { carryType: "held", handsHeld: 1 },
        "weapon"
      );
      await manager.flush(actor as never);

      const payload = vi.mocked(client.updateCharacter).mock.calls[0][0];
      expect(findEngine(payload, "character_hand_both_equipped-id")).toBe("id-gs");
      expect(findEngine(payload, "character_hand_primary_equipped-id")).toBe("na");
      expect(findEngine(payload, "character_hand_offhand_equipped-id")).toBe("na");
    });

    it("ignores a 2H that follows a 1H, then assigns next 1H to offhand", async () => {
      const client = makeClientWithItems([
        itemEngine("sword-a", "id-a"),
        itemEngine("greatsword", "id-gs"),
        itemEngine("sword-b", "id-b"),
      ]);
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueItemChange(
        actor as never,
        "sword-a",
        undefined,
        "equipped",
        { carryType: "held", handsHeld: 1 },
        "weapon"
      );
      manager.queueItemChange(
        actor as never,
        "greatsword",
        undefined,
        "equipped",
        { carryType: "held", handsHeld: 2 },
        "weapon"
      );
      manager.queueItemChange(
        actor as never,
        "sword-b",
        undefined,
        "equipped",
        { carryType: "held", handsHeld: 1 },
        "weapon"
      );
      await manager.flush(actor as never);

      const payload = vi.mocked(client.updateCharacter).mock.calls[0][0];
      expect(findEngine(payload, "character_hand_primary_equipped-id")).toBe("id-a");
      expect(findEngine(payload, "character_hand_offhand_equipped-id")).toBe("id-b");
      expect(findEngine(payload, "character_hand_both_equipped-id")).toBe("na");
    });

    it("clears hands when a held item is unequipped", async () => {
      const client = makeClientWithItems([itemEngine("sword-a", "id-a")]);
      client.fetchCharacterData.mockResolvedValue({
        engines: [
          {
            id: "hand-primary",
            name: "character_hand_primary_equipped-id",
            value: "id-a",
            type: "CustomDemiplaneEngine",
            saveType: "CharacterSheet",
            storeType: "override",
            demiplaneEngineId: "de-primary",
            args: { id: null },
          },
          itemEngine("sword-a", "id-a"),
        ],
        engineCacheIdsBySource: {},
        name: "Test Character",
        level: 5,
        avatarUrl: "https://example.com/avatar.png",
        viewPermission: 0,
        editPermission: 0,
      });

      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueItemChange(
        actor as never,
        "sword-a",
        undefined,
        "equipped",
        { carryType: "stowed", handsHeld: 0 },
        "weapon"
      );
      await manager.flush(actor as never);

      const payload = vi.mocked(client.updateCharacter).mock.calls[0][0];
      expect(findEngine(payload, "character_hand_primary_equipped-id")).toBe("na");
    });

    it("resolves a remastered (-rm) engine slug from a stripped Foundry slug", async () => {
      const client = makeClientWithItems([itemEngine("bastard-sword-rm", "id-bastard")]);
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueItemChange(
        actor as never,
        "bastard-sword",
        undefined,
        "equipped",
        { carryType: "held", handsHeld: 1 },
        "weapon"
      );
      await manager.flush(actor as never);

      const payload = vi.mocked(client.updateCharacter).mock.calls[0][0];
      expect(findEngine(payload, "character_hand_primary_equipped-id")).toBe("id-bastard");
    });

    it("sets armor -is-equipped to 0 when worn but not in its slot", async () => {
      const client = makeClientWithItems([
        itemEngine("armored-coat", "id-coat"),
        {
          id: "eng-coat-equipped",
          name: "id-coat-is-equipped",
          value: 1,
          type: "CustomDemiplaneEngine",
          saveType: "CharacterSheet",
          storeType: "override",
          demiplaneEngineId: "de-coat-equipped",
          args: { id: null },
        },
      ]);
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueItemChange(
        actor as never,
        "armored-coat",
        undefined,
        "equipped",
        { carryType: "worn", handsHeld: 0, inSlot: false },
        "armor"
      );
      await manager.flush(actor as never);

      const payload = vi.mocked(client.updateCharacter).mock.calls[0][0];
      expect(findEngine(payload, "id-coat-is-equipped")).toBe(0);
    });

    it("sets armor -is-equipped to 1 when worn in its slot", async () => {
      const client = makeClientWithItems([
        itemEngine("armored-coat", "id-coat"),
        {
          id: "eng-coat-equipped",
          name: "id-coat-is-equipped",
          value: 0,
          type: "CustomDemiplaneEngine",
          saveType: "CharacterSheet",
          storeType: "override",
          demiplaneEngineId: "de-coat-equipped",
          args: { id: null },
        },
      ]);
      const manager = new ExportManager(client as never);
      const actor = createMockActor();

      manager.queueItemChange(
        actor as never,
        "armored-coat",
        undefined,
        "equipped",
        { carryType: "worn", handsHeld: 0, inSlot: true },
        "armor"
      );
      await manager.flush(actor as never);

      const payload = vi.mocked(client.updateCharacter).mock.calls[0][0];
      expect(findEngine(payload, "id-coat-is-equipped")).toBe(1);
    });
  });
});
