import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@scooper4711/demiplane-api", () => ({
  updateCustomEngineValue: vi.fn(
    (engines: unknown[], _storeName: string, _value: unknown) => engines,
  ),
}));

import { updateCustomEngineValue } from "@scooper4711/demiplane-api";
import { ConflictResolver } from "../../src/conflict-resolver.js";

const MODULE_ID = "foundry-demiplane-pf2e";

function createMockClient(overrides = {}) {
  return {
    fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 5 }),
    fetchCharacterData: vi.fn().mockResolvedValue({
      engines: [
        {
          id: "eng-1",
          name: "character_hit-points_current",
          value: 42,
          type: "CustomDemiplaneEngine",
          saveType: "CharacterSheet",
          storeType: "override",
          demiplaneEngineId: "de-1",
          args: { id: null },
        },
      ],
      engineCacheIdsBySource: { source1: ["cache-1"] },
    }),
    updateCharacter: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function createMockActor(flags: Record<string, unknown> = {}) {
  const flagStore: Record<string, unknown> = { ...flags };
  return {
    getFlag: (_moduleId: string, key: string) => flagStore[key],
    setFlag: vi.fn((_moduleId: string, key: string, value: unknown) => {
      flagStore[key] = value;
      return Promise.resolve();
    }),
  };
}

describe("ConflictResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkForConflict", () => {
    it("returns conflicted: false when no characterId in flags", async () => {
      const client = createMockClient();
      const actor = createMockActor({});
      const resolver = new ConflictResolver(client as never);

      const result = await resolver.checkForConflict(actor as never);

      expect(result).toEqual({ conflicted: false });
      expect(client.fetchCharacterVersion).not.toHaveBeenCalled();
    });

    it("returns conflicted: false when no stored version", async () => {
      const client = createMockClient();
      const actor = createMockActor({ characterId: "abc-123" });
      const resolver = new ConflictResolver(client as never);

      const result = await resolver.checkForConflict(actor as never);

      expect(result).toEqual({ conflicted: false });
      expect(client.fetchCharacterVersion).not.toHaveBeenCalled();
    });

    it("returns conflicted: false when remote version equals stored version", async () => {
      const client = createMockClient({
        fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 3 }),
      });
      const actor = createMockActor({
        characterId: "abc-123",
        lastKnownVersion: 3,
      });
      const resolver = new ConflictResolver(client as never);

      const result = await resolver.checkForConflict(actor as never);

      expect(result).toEqual({ conflicted: false });
      expect(client.fetchCharacterVersion).toHaveBeenCalledWith("abc-123");
    });

    it("returns conflicted: true with versions when remote > stored", async () => {
      const client = createMockClient({
        fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 7 }),
      });
      const actor = createMockActor({
        characterId: "abc-123",
        lastKnownVersion: 4,
      });
      const resolver = new ConflictResolver(client as never);

      const result = await resolver.checkForConflict(actor as never);

      expect(result).toEqual({
        conflicted: true,
        localVersion: 4,
        remoteVersion: 7,
      });
    });

    it("returns conflicted: false when fetch fails", async () => {
      const client = createMockClient({
        fetchCharacterVersion: vi
          .fn()
          .mockRejectedValue(new Error("Network error")),
      });
      const actor = createMockActor({
        characterId: "abc-123",
        lastKnownVersion: 3,
      });
      const resolver = new ConflictResolver(client as never);

      const result = await resolver.checkForConflict(actor as never);

      expect(result).toEqual({ conflicted: false });
    });
  });

  describe("resolveConflict", () => {
    it("returns error when no characterId in actor flags", async () => {
      const client = createMockClient();
      const actor = createMockActor({});
      const resolver = new ConflictResolver(client as never);

      const result = await resolver.resolveConflict(
        actor as never,
        "reimport",
        [],
        new Map(),
      );

      expect(result).toEqual({
        success: false,
        error: "Actor has no linked character ID",
      });
    });

    describe("reimport strategy", () => {
      it("fetches fresh data, applies session state, pushes merged, and updates flags", async () => {
        const freshEngines = [
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
        ];
        const mergedEngines = [
          {
            id: "eng-1",
            name: "character_hit-points_current",
            value: 45,
            type: "CustomDemiplaneEngine",
            saveType: "CharacterSheet",
            storeType: "override",
            demiplaneEngineId: "de-1",
            args: { id: null },
          },
        ];
        const client = createMockClient({
          fetchCharacterData: vi.fn().mockResolvedValue({
            engines: freshEngines,
            engineCacheIdsBySource: { src: ["c1"] },
          }),
          fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 10 }),
          updateCharacter: vi.fn().mockResolvedValue(true),
        });

        // Make updateCustomEngineValue return mergedEngines on call
        vi.mocked(updateCustomEngineValue)
          .mockReturnValueOnce(mergedEngines as never);

        const actor = createMockActor({
          characterId: "char-uuid-456",
          lastKnownVersion: 5,
        });
        const localSessionState = new Map([
          ["character_hit-points_current", 45],
        ]);
        const resolver = new ConflictResolver(client as never);

        const result = await resolver.resolveConflict(
          actor as never,
          "reimport",
          [],
          localSessionState,
        );

        expect(result).toEqual({ success: true });
        expect(client.fetchCharacterData).toHaveBeenCalledWith("char-uuid-456");
        expect(updateCustomEngineValue).toHaveBeenCalledWith(
          freshEngines,
          "character_hit-points_current",
          45,
        );
        expect(client.updateCharacter).toHaveBeenCalledWith({
          id: "char-uuid-456",
          data: {
            engines: mergedEngines,
            engineCacheIdsBySource: { src: ["c1"] },
          },
        });
        expect(actor.setFlag).toHaveBeenCalledWith(
          MODULE_ID,
          "lastKnownVersion",
          10,
        );
        expect(actor.setFlag).toHaveBeenCalledWith(
          MODULE_ID,
          "lastSyncTimestamp",
          expect.any(Number),
        );
      });

      it("returns error when push fails", async () => {
        const client = createMockClient({
          fetchCharacterData: vi.fn().mockResolvedValue({
            engines: [],
            engineCacheIdsBySource: {},
          }),
          updateCharacter: vi.fn().mockResolvedValue(false),
        });
        const actor = createMockActor({
          characterId: "char-uuid-789",
          lastKnownVersion: 2,
        });
        const resolver = new ConflictResolver(client as never);

        const result = await resolver.resolveConflict(
          actor as never,
          "reimport",
          [],
          new Map(),
        );

        expect(result).toEqual({ success: false, error: "Merge push failed" });
      });

      it("returns error when fetchCharacterData throws", async () => {
        const client = createMockClient({
          fetchCharacterData: vi
            .fn()
            .mockRejectedValue(new Error("Fetch failed")),
        });
        const actor = createMockActor({
          characterId: "char-uuid-err",
          lastKnownVersion: 1,
        });
        const resolver = new ConflictResolver(client as never);

        const result = await resolver.resolveConflict(
          actor as never,
          "reimport",
          [],
          new Map(),
        );

        expect(result).toEqual({
          success: false,
          error: "Re-import failed: Fetch failed",
        });
      });
    });

    describe("force-push strategy", () => {
      it("pushes local engines directly", async () => {
        const localEngines = [
          {
            id: "eng-local",
            name: "character_hero-points",
            value: 3,
            type: "CustomDemiplaneEngine",
            saveType: "CharacterSheet",
            storeType: "override",
            demiplaneEngineId: "de-local",
            args: { id: null },
          },
        ];
        const client = createMockClient({
          updateCharacter: vi.fn().mockResolvedValue(true),
        });
        const actor = createMockActor({
          characterId: "char-uuid-fp",
          lastKnownVersion: 3,
        });
        const resolver = new ConflictResolver(client as never);

        const result = await resolver.resolveConflict(
          actor as never,
          "force-push",
          localEngines as never,
          new Map(),
        );

        expect(result).toEqual({ success: true });
        expect(client.updateCharacter).toHaveBeenCalledWith({
          id: "char-uuid-fp",
          data: {
            engines: localEngines,
            engineCacheIdsBySource: {},
          },
        });
      });

      it("returns error when push fails", async () => {
        const client = createMockClient({
          updateCharacter: vi.fn().mockResolvedValue(false),
        });
        const actor = createMockActor({
          characterId: "char-uuid-fp-fail",
          lastKnownVersion: 2,
        });
        const resolver = new ConflictResolver(client as never);

        const result = await resolver.resolveConflict(
          actor as never,
          "force-push",
          [],
          new Map(),
        );

        expect(result).toEqual({
          success: false,
          error: "Force push mutation failed",
        });
      });

      it("returns error when updateCharacter throws", async () => {
        const client = createMockClient({
          updateCharacter: vi
            .fn()
            .mockRejectedValue(new Error("Connection lost")),
        });
        const actor = createMockActor({
          characterId: "char-uuid-fp-err",
          lastKnownVersion: 1,
        });
        const resolver = new ConflictResolver(client as never);

        const result = await resolver.resolveConflict(
          actor as never,
          "force-push",
          [],
          new Map(),
        );

        expect(result).toEqual({
          success: false,
          error: "Force push failed: Connection lost",
        });
      });
    });

    describe("cancel strategy", () => {
      it("returns success immediately without making API calls", async () => {
        const client = createMockClient();
        const actor = createMockActor({
          characterId: "char-uuid-cancel",
          lastKnownVersion: 5,
        });
        const resolver = new ConflictResolver(client as never);

        const result = await resolver.resolveConflict(
          actor as never,
          "cancel",
          [],
          new Map(),
        );

        expect(result).toEqual({ success: true });
        expect(client.fetchCharacterData).not.toHaveBeenCalled();
        expect(client.fetchCharacterVersion).not.toHaveBeenCalled();
        expect(client.updateCharacter).not.toHaveBeenCalled();
        expect(actor.setFlag).not.toHaveBeenCalled();
      });
    });
  });
});
