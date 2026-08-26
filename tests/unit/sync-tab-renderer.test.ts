import { describe, it, expect, vi, beforeEach } from "vitest";

const hookCallbacks: Record<string, ((...args: unknown[]) => void)[]> = {};

vi.stubGlobal("Hooks", {
  on: (event: string, callback: (...args: unknown[]) => void) => {
    if (!hookCallbacks[event]) {
      hookCallbacks[event] = [];
    }
    hookCallbacks[event].push(callback);
    return 1;
  },
});

class MockActorSheet {
  rendered = false;
  render(_force: boolean) {
    this.rendered = true;
  }
}

vi.stubGlobal("ActorSheet", MockActorSheet);
vi.stubGlobal("ui", { windows: {} as Record<string, unknown> });

import { SyncTabRenderer } from "../../src/sync-tab-renderer.js";
import type { SyncTabData } from "../../src/sync-tab-renderer.js";

function createBaseSyncTabData(overrides: Partial<SyncTabData> = {}): SyncTabData {
  return {
    characterId: "abc-123",
    lastSyncTimestamp: undefined,
    pendingChanges: [],
    unresolvedSlugs: [],
    lastImportSummary: undefined,
    dryRunEnabled: false,
    operationInProgress: false,
    ...overrides,
  };
}

function triggerHook(event: string, ...args: unknown[]): void {
  const callbacks = hookCallbacks[event] ?? [];
  for (const callback of callbacks) {
    callback(...args);
  }
}

describe("SyncTabRenderer", () => {
  beforeEach(() => {
    for (const key of Object.keys(hookCallbacks)) {
      delete hookCallbacks[key];
    }
    (ui as { windows: Record<string, unknown> }).windows = {};
  });

  describe("registerSettingsHook", () => {
    it("registers an updateSetting hook", () => {
      SyncTabRenderer.registerSettingsHook();

      expect(hookCallbacks["updateSetting"]).toBeDefined();
      expect(hookCallbacks["updateSetting"].length).toBeGreaterThan(0);
    });

    it("re-renders open ActorSheet windows when dryRun setting changes", () => {
      const sheet = new MockActorSheet();
      (ui as { windows: Record<string, unknown> }).windows = { "1": sheet };

      SyncTabRenderer.registerSettingsHook();
      triggerHook("updateSetting", { key: "demiplane-pf2e.dryRun" });

      expect(sheet.rendered).toBe(true);
    });

    it("does not re-render when an unrelated setting changes", () => {
      const sheet = new MockActorSheet();
      (ui as { windows: Record<string, unknown> }).windows = { "1": sheet };

      SyncTabRenderer.registerSettingsHook();
      triggerHook("updateSetting", { key: "demiplane-pf2e.autoSync" });

      expect(sheet.rendered).toBe(false);
    });

    it("does not re-render non-ActorSheet windows", () => {
      const otherWindow = { render: vi.fn() };
      (ui as { windows: Record<string, unknown> }).windows = {
        "1": otherWindow,
      };

      SyncTabRenderer.registerSettingsHook();
      triggerHook("updateSetting", { key: "demiplane-pf2e.dryRun" });

      expect(otherWindow.render).not.toHaveBeenCalled();
    });

    it("re-renders multiple open ActorSheet windows", () => {
      const sheet1 = new MockActorSheet();
      const sheet2 = new MockActorSheet();
      (ui as { windows: Record<string, unknown> }).windows = {
        "1": sheet1,
        "2": sheet2,
      };

      SyncTabRenderer.registerSettingsHook();
      triggerHook("updateSetting", { key: "demiplane-pf2e.dryRun" });

      expect(sheet1.rendered).toBe(true);
      expect(sheet2.rendered).toBe(true);
    });
  });

  describe("dry run UI indicators", () => {
    it("renders dry run banner when dryRunEnabled is true", () => {
      const renderer = new SyncTabRenderer();
      const data = createBaseSyncTabData({ dryRunEnabled: true });

      const html = createMockHtml();
      renderer.renderTab(createMockSheet(), html, data);

      const content = html.bodyContent;
      expect(content).toContain("dry-run-indicator");
      expect(content).toContain("Dry Run Mode Active");
      expect(content).toContain("No changes will be written to Foundry or Demiplane");
    });

    it("does not render dry run banner when dryRunEnabled is false", () => {
      const renderer = new SyncTabRenderer();
      const data = createBaseSyncTabData({ dryRunEnabled: false });

      const html = createMockHtml();
      renderer.renderTab(createMockSheet(), html, data);

      const content = html.bodyContent;
      expect(content).not.toContain("dry-run-indicator");
      expect(content).not.toContain("Dry Run Mode Active");
    });
  });

  describe("dynamic button labels", () => {
    it("shows 'Preview Import' and 'Preview Push' when dry run is enabled", () => {
      const renderer = new SyncTabRenderer();
      const data = createBaseSyncTabData({ dryRunEnabled: true });

      const html = createMockHtml();
      renderer.renderTab(createMockSheet(), html, data);

      const content = html.bodyContent;
      expect(content).toContain("Preview Import");
      expect(content).toContain("Preview Push");
      expect(content).not.toContain("Import from Demiplane");
      expect(content).not.toContain("Push to Demiplane");
    });

    it("shows 'Import from Demiplane' and 'Push to Demiplane' when dry run is disabled", () => {
      const renderer = new SyncTabRenderer();
      const data = createBaseSyncTabData({ dryRunEnabled: false });

      const html = createMockHtml();
      renderer.renderTab(createMockSheet(), html, data);

      const content = html.bodyContent;
      expect(content).toContain("Import from Demiplane");
      expect(content).toContain("Push to Demiplane");
      expect(content).not.toContain("Preview Import");
      expect(content).not.toContain("Preview Push");
    });
  });

  describe("operation in-progress state", () => {
    it("disables buttons and shows spinner when operation is in progress", () => {
      const renderer = new SyncTabRenderer();
      const data = createBaseSyncTabData({ operationInProgress: true });

      const html = createMockHtml();
      renderer.renderTab(createMockSheet(), html, data);

      const content = html.bodyContent;
      expect(content).toContain("disabled");
      expect(content).toContain("fa-spinner fa-spin");
    });

    it("does not disable buttons when no operation is in progress", () => {
      const renderer = new SyncTabRenderer();
      const data = createBaseSyncTabData({ operationInProgress: false });

      const html = createMockHtml();
      renderer.renderTab(createMockSheet(), html, data);

      const content = html.bodyContent;
      expect(content).not.toContain("disabled");
      expect(content).not.toContain("fa-spinner fa-spin");
    });

    it("dry run indicator is distinct from in-progress spinner", () => {
      const renderer = new SyncTabRenderer();
      const data = createBaseSyncTabData({
        dryRunEnabled: true,
        operationInProgress: true,
      });

      const html = createMockHtml();
      renderer.renderTab(createMockSheet(), html, data);

      const content = html.bodyContent;
      // Both indicators should be present simultaneously
      expect(content).toContain("dry-run-indicator");
      expect(content).toContain("fa-spinner fa-spin");
    });
  });
});

// Minimal jQuery-like mock for testing HTML rendering
function createMockHtml() {
  let tabsContent = "";
  let bodyContent = "";

  const html = {
    get tabsContent() {
      return tabsContent;
    },
    get bodyContent() {
      return bodyContent;
    },
    find(selector: string) {
      if (selector === ".sheet-tabs") {
        return {
          append(content: string) {
            tabsContent += content;
          },
        };
      }
      if (selector === ".sheet-body") {
        return {
          append(content: string) {
            bodyContent += content;
          },
        };
      }
      return {
        on: vi.fn(),
        append: vi.fn(),
      };
    },
  };

  return html as unknown as JQuery & {
    tabsContent: string;
    bodyContent: string;
  };
}

function createMockSheet() {
  return {
    element: {
      trigger: vi.fn(),
    },
  } as unknown as ActorSheet;
}
