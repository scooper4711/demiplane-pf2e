import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getImportIssues,
  getExportIssues,
  hasActiveIssues,
  shouldShowIndicator,
  acknowledgeIssues,
  setUnmappedSlugs,
  resetImportIssues,
  clearExportIssues,
  clearAllIssues,
  addImportIssue,
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

  it("resetImportIssues clears only the import set", async () => {
    const actor = createFlagActor() as unknown as Actor;
    addImportIssue(actor, "import problem");
    addExportIssue(actor, "export problem");

    resetImportIssues(actor);

    expect(getImportIssues(actor).size).toBe(0);
    expect(getExportIssues(actor).size).toBe(1);
    expect(hasActiveIssues(actor)).toBe(true);
  });

  it("clearExportIssues clears only the export set", async () => {
    const actor = createFlagActor() as unknown as Actor;
    addImportIssue(actor, "import problem");
    addExportIssue(actor, "export problem");

    clearExportIssues(actor);

    expect(getImportIssues(actor).size).toBe(1);
    expect(getExportIssues(actor).size).toBe(0);
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
