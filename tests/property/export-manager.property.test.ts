import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";

vi.mock("@scooper4711/demiplane-api", () => ({
  updateCustomEngineValue: vi.fn(
    (
      engines: { name: string; value?: unknown }[],
      storeName: string,
      value: unknown,
    ) =>
      engines.map((e) =>
        e.name === storeName ? { ...e, value } : e,
      ),
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
    fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 1 }),
    updateCharacter: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

/**
 * Validates: Requirements 10.3
 */
describe("Feature: demiplane-foundry-sync, Property 9: Debounce batching collapses rapid changes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("for any sequence of changes within a 2-second window, only one flush fires with only the last value per field", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            field: fc.constantFrom(
              "character_hit-points_current",
              "character_hit-points_temp",
              "character_hero-points",
              "character_focus_current",
              "character_currency_gold",
            ),
            value: fc.integer({ min: 0, max: 999 }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (changes) => {
          vi.clearAllMocks();

          const client = createMockClient();
          const manager = new ExportManager(client as never);
          const actor = createMockActor();

          // Queue all changes within the debounce window
          for (const change of changes) {
            manager.queueChange(actor as never, change.field, change.value);
          }

          // Compute expected last value per field
          const expectedLastValues = new Map<string, number>();
          for (const change of changes) {
            expectedLastValues.set(change.field, change.value);
          }

          // Verify pending changes contain only the last value for each field
          const pending = manager.getPendingChanges("char-123");
          expect(pending).toHaveLength(expectedLastValues.size);

          for (const pendingChange of pending) {
            expect(pendingChange.value).toBe(
              expectedLastValues.get(pendingChange.field),
            );
          }

          // Verify the debounce has NOT yet fired (still within window)
          expect(client.fetchCharacterData).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("triggers exactly one API call after the debounce window elapses", async () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            field: fc.constantFrom(
              "character_hit-points_current",
              "character_hero-points",
              "character_focus_current",
            ),
            value: fc.integer({ min: 0, max: 100 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (changes) => {
          vi.clearAllMocks();

          const client = createMockClient();
          const manager = new ExportManager(client as never);
          const actor = createMockActor();

          for (const change of changes) {
            manager.queueChange(actor as never, change.field, change.value);
          }

          // Advance past debounce window
          vi.advanceTimersByTime(2100);

          // Exactly one fetch (part of flush) should have been triggered
          expect(client.fetchCharacterData).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Validates: Requirements 10.4
 */
describe("Feature: demiplane-foundry-sync, Property 10: Rate limiter never exceeds threshold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("for any number of flush operations within 60 seconds, no more than 30 API calls succeed", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 31, max: 50 }),
        async (flushCount) => {
          vi.clearAllMocks();

          const client = createMockClient();
          const manager = new ExportManager(client as never);
          const actor = createMockActor();

          let successfulCalls = 0;

          for (let i = 0; i < flushCount; i++) {
            manager.queueChange(
              actor as never,
              "character_hit-points_current",
              i,
            );
            const result = await manager.flush(actor as never);
            if (result.success && !result.preview) {
              successfulCalls++;
            }
          }

          // Rate limiter should cap at 30 successful API calls
          expect(successfulCalls).toBeLessThanOrEqual(30);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("allows calls again after the 60-second window expires", async () => {
    const client = createMockClient();
    const manager = new ExportManager(client as never);
    const actor = createMockActor();

    // Fill the rate limit window
    for (let i = 0; i < 30; i++) {
      manager.queueChange(actor as never, "character_hit-points_current", i);
      await manager.flush(actor as never);
    }

    // Should be rate limited now
    manager.queueChange(actor as never, "character_hit-points_current", 99);
    const limitedResult = await manager.flush(actor as never);
    expect(limitedResult.success).toBe(false);
    expect(limitedResult.error).toContain("Rate limit");

    // Advance time past the 60-second window
    vi.advanceTimersByTime(61_000);

    // Should succeed again
    manager.queueChange(actor as never, "character_hit-points_current", 100);
    const result = await manager.flush(actor as never);
    expect(result.success).toBe(true);
  });
});
