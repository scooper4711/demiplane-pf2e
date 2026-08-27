import { describe, it, expect, vi } from "vitest";

import { SyncTabRenderer } from "../../src/sync-tab-renderer.js";
import type { SyncTabData } from "../../src/sync-tab-renderer.js";

function createBaseSyncTabData(overrides: Partial<SyncTabData> = {}): SyncTabData {
  return {
    characterId: "abc-123",
    lastImportTimestamp: undefined,
    lastExportTimestamp: undefined,
    pendingChanges: [],
    unresolvedSlugs: [],
    lastImportSummary: undefined,
    operationInProgress: false,
    ...overrides,
  };
}

describe("SyncTabRenderer", () => {
  describe("action button labels", () => {
    it("shows 'Import from Demiplane' and 'Push to Demiplane'", () => {
      const renderer = new SyncTabRenderer();
      const data = createBaseSyncTabData();

      const html = createMockHtml();
      renderer.renderTab(createMockSheet(), html, data);

      const content = html.bodyContent;
      expect(content).toContain("Import from Demiplane");
      expect(content).toContain("Push to Demiplane");
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
