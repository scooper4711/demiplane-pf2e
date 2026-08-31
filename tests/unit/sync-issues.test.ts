import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getImportIssues,
  getExportIssues,
  hasActiveIssues,
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
