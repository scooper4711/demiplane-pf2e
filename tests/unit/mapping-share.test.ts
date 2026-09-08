import { describe, it, expect, beforeEach, vi } from "vitest";
import { installFoundryMocks, createMockPack } from "./foundry-mocks.js";
import { exportAction, importAction } from "../../src/mapping-share.js";
import { getAllMappings, registerSlugMappingSettings, setMapping } from "../../src/slug-mapping.js";

const HP = "Compendium.pf2e.equipment-srd.Item.hp1";
const MISSING = "Compendium.pf2e.equipment-srd.Item.gone";

describe("mapping share", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.equipment-srd": createMockPack([
        { _id: "hp1", name: "Half Plate", system: { slug: "half-plate" }, type: "armor" },
      ]),
    });
    registerSlugMappingSettings();
    globalThis.foundry.applications.api.DialogV2 = {
      wait: vi.fn(),
      prompt: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("exportAction writes a JSON file of all mappings", async () => {
    await setMapping("equipment", "religious-symbol", { uuid: HP, name: "Half Plate" });

    await exportAction();

    const save = globalThis.foundry.utils.saveDataToFile;
    expect(save).toHaveBeenCalledTimes(1);
    const [payload, mime, filename] = save.mock.calls[0];
    expect(mime).toBe("application/json");
    expect(filename).toContain("test-world");
    const parsed = JSON.parse(payload);
    expect(parsed.mappings.equipment["religious-symbol"]).toEqual({ uuid: HP, name: "Half Plate" });
  });

  it("exportAction only notifies when there are no mappings", async () => {
    await exportAction();

    expect(globalThis.foundry.utils.saveDataToFile).not.toHaveBeenCalled();
    expect(globalThis.ui.notifications.info).toHaveBeenCalledWith(expect.stringContaining("No mappings"));
  });

  /** Stubs the import dialog to resolve with a chosen file's text and overwrite flag. */
  function stubImportDialog(fileText: string | null, overwrite = false): void {
    globalThis.foundry.applications.api.DialogV2.wait = vi.fn().mockImplementation(async (config) => {
      const importButton = config.buttons.find((b) => b.action === "import");
      const dialog = {
        element: {
          querySelector: (sel) => {
            if (sel === 'input[name="file"]') {
              return { files: fileText === null ? [] : [{ text: async () => fileText }] };
            }
            if (sel === 'input[name="overwrite"]') return { checked: overwrite };
            return null;
          },
        },
      };
      return importButton.callback({}, {}, dialog);
    });
  }

  it("importAction merges resolvable mappings, skips missing, and refreshes", async () => {
    const onImported = vi.fn();
    const file = JSON.stringify({
      version: 1,
      mappings: {
        equipment: {
          "res-symbol": { uuid: HP, name: "Half Plate" },
          "gone-item": { uuid: MISSING, name: "Removed" },
        },
      },
    });
    stubImportDialog(file);

    await importAction(onImported);

    expect(getAllMappings("equipment")["res-symbol"]).toEqual({ uuid: HP, name: "Half Plate" });
    expect(getAllMappings("equipment")["gone-item"]).toBeUndefined();
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(globalThis.foundry.applications.api.DialogV2.prompt).toHaveBeenCalled();
  });

  it("importAction honors the overwrite flag", async () => {
    await setMapping("equipment", "res-symbol", { uuid: HP, name: "Local Choice" });
    stubImportDialog(
      JSON.stringify({ version: 1, mappings: { equipment: { "res-symbol": { uuid: HP, name: "Imported" } } } }),
      true
    );

    await importAction(vi.fn());

    expect(getAllMappings("equipment")["res-symbol"]?.name).toBe("Imported");
  });

  it("importAction rejects a malformed file without refreshing", async () => {
    const onImported = vi.fn();
    stubImportDialog("{not json");

    await importAction(onImported);

    expect(globalThis.ui.notifications.error).toHaveBeenCalledWith(expect.stringContaining("valid"));
    expect(onImported).not.toHaveBeenCalled();
    expect(getAllMappings("equipment")).toEqual({});
  });

  it("importAction does nothing when the dialog is cancelled", async () => {
    const onImported = vi.fn();
    globalThis.foundry.applications.api.DialogV2.wait = vi.fn().mockResolvedValue("cancel");

    await importAction(onImported);

    expect(getAllMappings("equipment")).toEqual({});
    expect(onImported).not.toHaveBeenCalled();
    expect(globalThis.foundry.applications.api.DialogV2.prompt).not.toHaveBeenCalled();
  });

  it("importAction warns when no file was chosen", async () => {
    stubImportDialog(null);

    await importAction(vi.fn());

    expect(globalThis.ui.notifications.warn).toHaveBeenCalledWith(expect.stringContaining("Choose a file"));
    expect(getAllMappings("equipment")).toEqual({});
  });

  it("summary counts entries already mapped in this world", async () => {
    await setMapping("equipment", "res-symbol", { uuid: HP, name: "Local Choice" });
    stubImportDialog(
      JSON.stringify({ version: 1, mappings: { equipment: { "res-symbol": { uuid: HP, name: "Imported" } } } })
    );

    await importAction(vi.fn());

    // Non-overwrite: the local entry is kept and reported as skipped-existing.
    expect(getAllMappings("equipment")["res-symbol"]?.name).toBe("Local Choice");
    const summary = globalThis.foundry.applications.api.DialogV2.prompt.mock.calls[0][0].content;
    expect(summary).toContain("already mapped");
  });

  it("summary truncates a long list of missing targets with '…and N more'", async () => {
    const equipment = {};
    // 12 missing targets exceeds the 10-entry sample limit, so the summary
    // should name 10 and say "…and 2 more".
    for (let i = 0; i < 12; i++) {
      equipment[`missing-${i}`] = { uuid: `Compendium.pf2e.equipment-srd.Item.gone${i}`, name: `Gone ${i}` };
    }
    stubImportDialog(JSON.stringify({ version: 1, mappings: { equipment } }));

    await importAction(vi.fn());

    const summary = globalThis.foundry.applications.api.DialogV2.prompt.mock.calls[0][0].content;
    expect(summary).toContain("…and 2 more");
  });
});
