import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getImportIssues,
  getExportIssues,
  hasActiveIssues,
  shouldShowIndicator,
  acknowledgeIssues,
  setUnmappedSlugs,
  getUnresolvedChoices,
  setUnresolvedChoices,
  getChoiceOverrides,
  setChoiceOverride,
  removeChoiceOverride,
  resetImportIssues,
  clearAllIssues,
  addImportIssue,
  addImportIssues,
  addExportIssue,
  ISSUES_CHANGED_EVENT,
} from "../../src/sync-issues.js";

function createFlagActor() {
  const flags: Record<string, Record<string, unknown>> = {};
  const actor = {
    getFlag: vi.fn((_scope: string, key: string) => {
      const moduleFlags = flags["demiplane-pf2e"];
      return moduleFlags ? moduleFlags[key] : undefined;
    }),
    setFlag: vi.fn(async (_scope: string, key: string, value: unknown) => {
      flags["demiplane-pf2e"] = { ...(flags["demiplane-pf2e"] ?? {}), [key]: value };
    }),
  };
  return actor;
}

/**
 * An actor whose `setFlag` defers the in-memory update until the returned
 * promise resolves — matching real Foundry, where `getFlag` only reflects a
 * write after its `setFlag` promise settles. This exposes the read-modify-write
 * race that a synchronous mock hides: an un-awaited loop of single-issue writes
 * all read the same stale value and clobber each other.
 */
function createDeferredFlagActor() {
  const flags: Record<string, Record<string, unknown>> = {};
  const actor = {
    getFlag: vi.fn((_scope: string, key: string) => {
      const moduleFlags = flags["demiplane-pf2e"];
      return moduleFlags ? moduleFlags[key] : undefined;
    }),
    setFlag: vi.fn(async (_scope: string, key: string, value: unknown) => {
      await Promise.resolve();
      flags["demiplane-pf2e"] = { ...(flags["demiplane-pf2e"] ?? {}), [key]: value };
    }),
  };
  return actor;
}

describe("sync-issues", () => {
  let hooks: Array<{ event: string; args: unknown[] }>;

  beforeEach(() => {
    hooks = [];
    vi.stubGlobal("Hooks", {
      on: vi.fn(),
      callAll: vi.fn((event: string, ...args: unknown[]) => {
        hooks.push({ event, args });
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty sets for a fresh actor", () => {
    const actor = createFlagActor();
    expect(getImportIssues(actor as unknown as Actor).size).toBe(0);
    expect(getExportIssues(actor as unknown as Actor).size).toBe(0);
    expect(hasActiveIssues(actor as unknown as Actor)).toBe(false);
  });

  it("addImportIssue accumulates into the import set and fires the change hook", async () => {
    const actor = createFlagActor() as unknown as Actor;
    addImportIssue(actor, 'Could not import feat "foo": not found in compendium');
    addImportIssue(actor, 'Could not import feat "foo": not found in compendium');
    addImportIssue(actor, "Another import error");

    expect(getImportIssues(actor).size).toBe(2);
    expect(hasActiveIssues(actor)).toBe(true);
    expect(hooks.filter((h) => h.event === ISSUES_CHANGED_EVENT)).toHaveLength(3);
    expect(getImportIssues(actor).has("Another import error")).toBe(true);
  });

  it("addImportIssues persists every message in a single write", async () => {
    const actor = createFlagActor() as unknown as Actor;
    await addImportIssues(actor, ['Couldn\'t determine the choice for "Deity (Cleric)"', "Free Archetype variant"]);

    const issues = getImportIssues(actor);
    expect(issues.size).toBe(2);
    expect(issues.has('Couldn\'t determine the choice for "Deity (Cleric)"')).toBe(true);
    expect(issues.has("Free Archetype variant")).toBe(true);
    expect(hooks.filter((h) => h.event === ISSUES_CHANGED_EVENT)).toHaveLength(1);
  });

  it("addImportIssues does nothing (and does not fire the hook) for an empty list", async () => {
    const actor = createFlagActor() as unknown as Actor;
    await addImportIssues(actor, []);

    expect(getImportIssues(actor).size).toBe(0);
    expect(hooks.filter((h) => h.event === ISSUES_CHANGED_EVENT)).toHaveLength(0);
  });

  // Regression: against real Foundry, setFlag defers the visible flag update
  // until its promise resolves. Batching must survive that; a per-message loop
  // would keep only the last message.
  it("addImportIssues keeps all messages even when setFlag updates are deferred", async () => {
    const actor = createDeferredFlagActor() as unknown as Actor;
    await addImportIssues(actor, ["first", "second", "third"]);

    const issues = getImportIssues(actor);
    expect(issues.size).toBe(3);
    expect(issues.has("first")).toBe(true);
    expect(issues.has("third")).toBe(true);
  });

  it("resetImportIssues clears only the import set", async () => {
    const actor = createFlagActor() as unknown as Actor;
    addImportIssue(actor, "import problem");
    addExportIssue(actor, "export problem");

    resetImportIssues(actor);

    expect(getImportIssues(actor).size).toBe(0);
    expect(getExportIssues(actor).size).toBe(1);
    expect(hasActiveIssues(actor)).toBe(true);
  });

  it("clearAllIssues clears both sets", async () => {
    const actor = createFlagActor() as unknown as Actor;
    addImportIssue(actor, "import problem");
    addExportIssue(actor, "export problem");

    clearAllIssues(actor);

    expect(getImportIssues(actor).size).toBe(0);
    expect(getExportIssues(actor).size).toBe(0);
    expect(hasActiveIssues(actor)).toBe(false);
  });

  it("clearAllIssues fires the change hook so the titlebar dot can update", async () => {
    const actor = createFlagActor() as unknown as Actor;
    addExportIssue(actor, "export problem");
    hooks.length = 0;

    clearAllIssues(actor);

    expect(hooks.map((h) => h.event)).toContain(ISSUES_CHANGED_EVENT);
  });
});

describe("sync-issues indicator (acknowledgement)", () => {
  beforeEach(() => {
    vi.stubGlobal("Hooks", { on: vi.fn(), callAll: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the indicator for a fresh, unacknowledged issue", () => {
    const actor = createFlagActor() as unknown as Actor;
    addImportIssue(actor, "boom");
    expect(shouldShowIndicator(actor)).toBe(true);
  });

  it("shows the indicator for unmapped-only imports", () => {
    const actor = createFlagActor() as unknown as Actor;
    setUnmappedSlugs(actor, [{ slug: "goblin-blade", kind: "equipment" }]);
    expect(shouldShowIndicator(actor)).toBe(true);
  });

  it("hides the indicator after acknowledgement but keeps the issue data", () => {
    const actor = createFlagActor() as unknown as Actor;
    addImportIssue(actor, "boom");
    setUnmappedSlugs(actor, [{ slug: "goblin-blade", kind: "equipment" }]);

    acknowledgeIssues(actor);

    expect(shouldShowIndicator(actor)).toBe(false);
    // The data is still there for the dialog and the mapping editor.
    expect(hasActiveIssues(actor)).toBe(true);
    expect(getImportIssues(actor).has("boom")).toBe(true);
  });

  it("relights the indicator when a new issue arrives after acknowledgement", () => {
    const actor = createFlagActor() as unknown as Actor;
    addImportIssue(actor, "first");
    acknowledgeIssues(actor);
    expect(shouldShowIndicator(actor)).toBe(false);

    addExportIssue(actor, "later push failure");

    expect(shouldShowIndicator(actor)).toBe(true);
  });

  it("clears the indicator once a fresh import resolves everything", () => {
    const actor = createFlagActor() as unknown as Actor;
    addImportIssue(actor, "boom");
    acknowledgeIssues(actor);

    // A new import starts by resetting the import set and unmapped slugs.
    resetImportIssues(actor);
    setUnmappedSlugs(actor, []);

    expect(hasActiveIssues(actor)).toBe(false);
    expect(shouldShowIndicator(actor)).toBe(false);
  });

  it("does not show the indicator for empty unmapped records", () => {
    const actor = createFlagActor() as unknown as Actor;
    setUnmappedSlugs(actor, []);
    expect(shouldShowIndicator(actor)).toBe(false);
  });
});

describe("sync-issues choice overrides", () => {
  it("round-trips one pick per key", () => {
    const actor = createFlagActor() as unknown as Actor;
    setChoiceOverride(actor, "feat::choice", "crafting");
    setChoiceOverride(actor, "other::deity", "sarenrae");

    expect(getChoiceOverrides(actor)).toEqual({ "feat::choice": "crafting", "other::deity": "sarenrae" });
  });

  it("removes a single pick without touching the rest", () => {
    const actor = createFlagActor() as unknown as Actor;
    setChoiceOverride(actor, "feat::choice", "crafting");
    setChoiceOverride(actor, "other::deity", "sarenrae");

    removeChoiceOverride(actor, "feat::choice");

    expect(getChoiceOverrides(actor)).toEqual({ "other::deity": "sarenrae" });
  });

  it("ignores non-string stored values", () => {
    const actor = createFlagActor() as unknown as Actor;
    void actor.setFlag("demiplane-pf2e", "choiceOverrides", { good: "crafting", bad: 42 });

    expect(getChoiceOverrides(actor)).toEqual({ good: "crafting" });
  });

  it("storing a pick does not light the indicator", () => {
    const actor = createFlagActor() as unknown as Actor;
    setChoiceOverride(actor, "feat::choice", "crafting");

    // An override answers an issue; it is not itself an issue.
    expect(shouldShowIndicator(actor)).toBe(false);
  });

  it("resetImportIssues keeps overrides (they persist across imports)", () => {
    const actor = createFlagActor() as unknown as Actor;
    setChoiceOverride(actor, "feat::choice", "crafting");

    resetImportIssues(actor);

    expect(getChoiceOverrides(actor)).toEqual({ "feat::choice": "crafting" });
  });
});

describe("sync-issues unresolved choices", () => {
  const record = {
    key: "feat::choice",
    source: "guess",
    prompt: "Choose a skill",
    options: [
      { value: "acrobatics", label: "Acrobatics" },
      { value: "crafting", label: "Crafting" },
    ],
    guessedValue: "acrobatics",
  };

  it("round-trips records", () => {
    const actor = createFlagActor() as unknown as Actor;
    setUnresolvedChoices(actor, [record]);

    expect(getUnresolvedChoices(actor)).toEqual([record]);
  });

  it("replaces records wholesale so resolved choices drop out", () => {
    const actor = createFlagActor() as unknown as Actor;
    setUnresolvedChoices(actor, [record]);
    setUnresolvedChoices(actor, []);

    expect(getUnresolvedChoices(actor)).toEqual([]);
  });

  it("lights the indicator for unanswered choices", () => {
    const actor = createFlagActor() as unknown as Actor;
    setUnresolvedChoices(actor, [record]);

    expect(hasActiveIssues(actor)).toBe(true);
    expect(shouldShowIndicator(actor)).toBe(true);
  });

  it("does not light the indicator for applied picks alone", () => {
    const actor = createFlagActor() as unknown as Actor;
    setUnresolvedChoices(actor, [{ ...record, source: "override" }]);

    // A pick in effect is settled, not an issue — visible in the dialog,
    // but the dot stays off.
    expect(hasActiveIssues(actor)).toBe(false);
    expect(shouldShowIndicator(actor)).toBe(false);
  });

  it("stays lit when guesses remain alongside applied picks", () => {
    const actor = createFlagActor() as unknown as Actor;
    setUnresolvedChoices(actor, [record, { ...record, key: "other::choice", source: "override" }]);

    expect(hasActiveIssues(actor)).toBe(true);
    expect(shouldShowIndicator(actor)).toBe(true);
  });

  it("resetImportIssues clears records but keeps overrides", () => {
    const actor = createFlagActor() as unknown as Actor;
    setUnresolvedChoices(actor, [record]);
    setChoiceOverride(actor, "feat::choice", "crafting");

    resetImportIssues(actor);

    expect(getUnresolvedChoices(actor)).toEqual([]);
    expect(getChoiceOverrides(actor)).toEqual({ "feat::choice": "crafting" });
    expect(hasActiveIssues(actor)).toBe(false);
  });
});
