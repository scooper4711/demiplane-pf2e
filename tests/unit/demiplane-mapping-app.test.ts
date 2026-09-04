import { describe, it, expect, beforeEach, vi } from "vitest";
import { installFoundryMocks, createMockActor, createMockPack } from "./foundry-mocks.js";
import {
  browseAction,
  clearAction,
  collectSections,
  dropOntoRow,
  EXPECTED_TYPES,
  getDemiplaneMappingAppClass,
  isAcceptedType,
  openFinder,
  registerDemiplaneMappingTemplates,
  registerMappingSyncHook,
} from "../../src/demiplane-mapping-app.js";
import { getAllMappings, registerSlugMappingSettings, setMapping, clearMapping } from "../../src/slug-mapping.js";
import type { UnmappedSlug } from "../../src/import/types.js";

const HALF_PLATE = "Compendium.pf2e.equipment-srd.Item.hp1";

/** Builds an actor linked to a Demiplane character, holding the given unmapped slugs. */
function linkedActor(name: string, unmapped: UnmappedSlug[]) {
  const flags: Record<string, unknown> = { characterId: `char-${name}`, unmappedSlugs: unmapped };
  const actor = createMockActor({ name });
  actor.getFlag = vi.fn((_module: string, key: string) => flags[key]);
  return actor;
}

describe("collectSections", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.equipment-srd": createMockPack([
        { _id: "hp1", name: "Half Plate", system: { slug: "half-plate" }, type: "armor" },
      ]),
      "pf2e.spells-srd": createMockPack([{ _id: "sp1", name: "Heal", system: { slug: "heal" }, type: "spell" }]),
    });
    registerSlugMappingSettings();
  });

  it("returns nothing when no actor has unmapped slugs", async () => {
    (globalThis as unknown as { game: { actors: { contents: unknown[] } } }).game.actors.contents = [];
    expect(await collectSections()).toEqual([]);
  });

  it("groups slugs by kind across all characters", async () => {
    (globalThis as unknown as { game: { actors: { contents: unknown[] } } }).game.actors.contents = [
      linkedActor("Kyra", [
        { slug: "religious-symbol", kind: "equipment" },
        { slug: "heal-rm", kind: "spell" },
      ]),
      linkedActor("Ezren", [{ slug: "religious-symbol", kind: "equipment" }]),
    ] as never;

    const sections = await collectSections();
    const equipment = sections.find((s) => s.kind === "equipment");
    const spells = sections.find((s) => s.kind === "spell");

    expect(equipment?.rows).toHaveLength(1);
    // Characters are merged rather than duplicated.
    expect(equipment?.rows[0]?.characters.split(", ").sort()).toEqual(["Ezren", "Kyra"]);
    expect(spells?.rows[0]?.characters).toBe("Kyra");
  });

  it("shows a mapping even when the slug is no longer reported unmapped", async () => {
    await setMapping("equipment", "was-unmapped", { uuid: HALF_PLATE, name: "Half Plate" });
    (globalThis as unknown as { game: { actors: { contents: unknown[] } } }).game.actors.contents = [] as never;

    const sections = await collectSections();
    const row = sections.find((s) => s.kind === "equipment")?.rows[0];

    expect(row?.slug).toBe("was-unmapped");
    expect(row?.mappedName).toBe("Half Plate");
    expect(row?.mappingMissing).toBe(false);
  });

  it("flags a mapping whose target has disappeared", async () => {
    await setMapping("equipment", "stale", { uuid: "Compendium.pf2e.equipment-srd.Item.gone", name: "Gone" });
    (globalThis as unknown as { game: { actors: { contents: unknown[] } } }).game.actors.contents = [] as never;

    const sections = await collectSections();
    const row = sections.find((s) => s.kind === "equipment")?.rows[0];

    expect(row?.mappingMissing).toBe(true);
  });

  it("marks mapped rows as not unmapped and reports the section as fully mapped", async () => {
    await setMapping("equipment", "resolved", { uuid: HALF_PLATE, name: "Half Plate" });
    (globalThis as unknown as { game: { actors: { contents: unknown[] } } }).game.actors.contents = [] as never;

    const equipment = (await collectSections()).find((s) => s.kind === "equipment");
    expect(equipment?.rows[0]?.unmapped).toBe(false);
    expect(equipment?.hasUnmapped).toBe(false);
  });

  it("flags an unmapped slug and its section as having unmapped rows", async () => {
    (globalThis as unknown as { game: { actors: { contents: unknown[] } } }).game.actors.contents = [
      linkedActor("Kyra", [{ slug: "not-in-compendium", kind: "equipment" }]),
    ] as never;

    const equipment = (await collectSections()).find((s) => s.kind === "equipment");
    expect(equipment?.rows[0]?.unmapped).toBe(true);
    expect(equipment?.hasUnmapped).toBe(true);
  });

  it("keeps a section marked unmapped when it mixes mapped and unmapped rows", async () => {
    await setMapping("equipment", "resolved", { uuid: HALF_PLATE, name: "Half Plate" });
    (globalThis as unknown as { game: { actors: { contents: unknown[] } } }).game.actors.contents = [
      linkedActor("Kyra", [{ slug: "not-in-compendium", kind: "equipment" }]),
    ] as never;

    const equipment = (await collectSections()).find((s) => s.kind === "equipment");
    expect(equipment?.rows).toHaveLength(2);
    expect(equipment?.hasUnmapped).toBe(true);
  });

  it("reads the mapped item's icon from the pack index", async () => {
    installFoundryMocks({
      "pf2e.equipment-srd": createMockPack([
        { _id: "hp1", name: "Half Plate", system: { slug: "half-plate" }, img: "icons/armor/half-plate.webp" },
      ]),
    });
    registerSlugMappingSettings();
    await setMapping("equipment", "resolved", { uuid: HALF_PLATE, name: "Half Plate" });
    (globalThis as unknown as { game: { actors: { contents: unknown[] } } }).game.actors.contents = [] as never;

    const row = (await collectSections()).find((s) => s.kind === "equipment")?.rows[0];
    expect(row?.icon).toBe("icons/armor/half-plate.webp");
    expect(row?.mappingMissing).toBe(false);
  });

  it("resolves several mappings in one pack without a per-item document load", async () => {
    const pack = createMockPack([
      { _id: "hp1", name: "Half Plate", system: { slug: "half-plate" } },
      { _id: "hp2", name: "Full Plate", system: { slug: "full-plate" } },
    ]);
    installFoundryMocks({ "pf2e.equipment-srd": pack });
    registerSlugMappingSettings();
    await setMapping("equipment", "one", { uuid: "Compendium.pf2e.equipment-srd.Item.hp1", name: "Half Plate" });
    await setMapping("equipment", "two", { uuid: "Compendium.pf2e.equipment-srd.Item.hp2", name: "Full Plate" });
    (globalThis as unknown as { game: { actors: { contents: unknown[] } } }).game.actors.contents = [] as never;

    const rows = (await collectSections()).find((s) => s.kind === "equipment")?.rows ?? [];
    expect(rows.every((row) => !row.mappingMissing)).toBe(true);
    // Resolved from the index, not by loading each item document.
    expect(pack.getDocument).not.toHaveBeenCalled();
    expect(pack.getIndex).toHaveBeenCalled();
  });

  it("flags every row when its pack is not installed", async () => {
    installFoundryMocks(); // no packs registered
    registerSlugMappingSettings();
    await setMapping("equipment", "orphan", {
      uuid: "Compendium.pf2e.equipment-srd.Item.hp1",
      name: "Half Plate",
    });
    (globalThis as unknown as { game: { actors: { contents: unknown[] } } }).game.actors.contents = [] as never;

    const row = (await collectSections()).find((s) => s.kind === "equipment")?.rows[0];
    expect(row?.mappingMissing).toBe(true);
  });

  it("ignores actors that aren't linked to a Demiplane character", async () => {
    const unlinked = createMockActor({ name: "Homemade" });
    unlinked.getFlag = vi.fn((_module: string, key: string) =>
      key === "unmappedSlugs" ? [{ slug: "should-be-ignored", kind: "equipment" }] : undefined
    );
    (globalThis as unknown as { game: { actors: { contents: unknown[] } } }).game.actors.contents = [unlinked] as never;

    expect(await collectSections()).toEqual([]);
  });
});

describe("openFinder", () => {
  /** Access the mutable game global the mocks install. */
  const gameGlobal = () => globalThis as unknown as { game: Record<string, unknown> };

  beforeEach(() => {
    installFoundryMocks();
  });

  it("opens the individual compendium pack window for a kind without a browser tab", async () => {
    const render = vi.fn();
    // vitest 4 requires a constructable implementation (not an arrow) because
    // the code under test invokes this mock with `new`.
    const applicationClass = vi.fn().mockImplementation(function () {
      return { render };
    });
    const classesPack = { applicationClass };
    gameGlobal().game.packs = { get: vi.fn().mockReturnValue(classesPack) };

    await openFinder("class");

    // Mirrors the sidebar: instantiate the pack's own application, then render.
    expect(applicationClass).toHaveBeenCalledWith({ collection: classesPack });
    expect(render).toHaveBeenCalledWith({ force: true });
  });

  it("warns when a kind has no compendium source", async () => {
    gameGlobal().game.packs = { get: vi.fn().mockReturnValue(null) };
    gameGlobal().game.pf2e = undefined;

    await openFinder("class");

    expect(ui.notifications.warn).toHaveBeenCalledWith(expect.stringContaining("No compendium source"));
  });

  it("opens the PF2e Compendium Browser tab for a browsable kind", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const getFilterData = vi.fn().mockResolvedValue({});
    gameGlobal().game.pf2e = { compendiumBrowser: { tabs: { equipment: { getFilterData, open } } } };

    await openFinder("equipment");

    expect(getFilterData).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith({ filter: {} });
  });

  it("warns when the browser tab is unavailable", async () => {
    gameGlobal().game.pf2e = undefined;

    await openFinder("equipment");

    expect(ui.notifications.warn).toHaveBeenCalledWith(expect.stringContaining("Compendium Browser is not available"));
  });
});

describe("isAcceptedType", () => {
  it("accepts physical item types for an equipment slug", () => {
    expect(isAcceptedType("equipment", "consumable")).toBe(true);
    expect(isAcceptedType("equipment", "weapon")).toBe(true);
    expect(isAcceptedType("equipment", "armor")).toBe(true);
  });

  it("rejects a spell dropped onto an equipment slug", () => {
    expect(isAcceptedType("equipment", "spell")).toBe(false);
  });

  it("keeps every kind strict about its own type", () => {
    expect(isAcceptedType("spell", "spell")).toBe(true);
    expect(isAcceptedType("spell", "feat")).toBe(false);
    expect(isAcceptedType("feat", "feat")).toBe(true);
    expect(isAcceptedType("feat", "class")).toBe(false);
    expect(isAcceptedType("class", "class")).toBe(true);
  });
});

describe("registerMappingSyncHook", () => {
  /** refresh() re-renders the open instance; capture it. */
  let render: ReturnType<typeof vi.fn>;

  function updateSettingCallback(): (setting: { key?: string }) => void {
    const hooks = globalThis as unknown as { Hooks: { on: ReturnType<typeof vi.fn> } };
    const calls = hooks.Hooks.on.mock.calls as Array<[string, (setting: { key?: string }) => void]>;
    return calls.find((call) => call[0] === "updateSetting")![1];
  }

  beforeEach(() => {
    installFoundryMocks();
    render = vi.fn();
    const foundryGlobal = globalThis as unknown as {
      foundry: { applications: { instances: { get: ReturnType<typeof vi.fn> } } };
    };
    foundryGlobal.foundry.applications.instances = { get: vi.fn().mockReturnValue({ render }) };
    registerMappingSyncHook();
  });

  it("re-renders the open editor when a mapping setting changes on another client", () => {
    updateSettingCallback()({ key: "demiplane-pf2e.slugMappingsFeat" });
    expect(render).toHaveBeenCalledWith({ force: true });
  });

  it("ignores unrelated setting changes", () => {
    updateSettingCallback()({ key: "demiplane-pf2e.demiplaneToken" });
    expect(render).not.toHaveBeenCalled();
  });

  it("ignores setting payloads without a key", () => {
    updateSettingCallback()({});
    expect(render).not.toHaveBeenCalled();
  });
});

describe("mapping actions", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.equipment-srd": createMockPack([
        { _id: "hp1", name: "Half Plate", type: "armor", system: { slug: "half-plate" } },
        { _id: "fe1", name: "Power Attack", type: "feat", system: { slug: "power-attack" } },
        { _id: "noname", type: "weapon", system: { slug: "nameless-blade" } },
        { _id: "notype", name: "Nameless", system: { slug: "typeless-thing" } },
      ]),
    });
    registerSlugMappingSettings();
    globalThis.foundry.applications.api.DialogV2 = { prompt: vi.fn().mockResolvedValue(undefined) };
    globalThis.foundry.applications.instances = { get: vi.fn().mockReturnValue(undefined) };
  });

  function dropData(payload) {
    return { getData: (format) => (format === "text/plain" ? payload : "") };
  }

  /** fromUuid stub resolving plain document-likes (the shared mock returns wrappers). */
  function stubDroppedDocs(docs) {
    globalThis.fromUuid = vi.fn().mockImplementation(async (uuid) => docs[uuid.split(".").pop()] ?? null);
  }

  function dropPayload(uuid) {
    return dropData(JSON.stringify({ type: "Item", uuid }));
  }

  it("memoizes the application class", () => {
    expect(getDemiplaneMappingAppClass()).toBe(getDemiplaneMappingAppClass());
  });

  it("browseAction ignores buttons without a kind", async () => {
    await browseAction({});
    expect(globalThis.ui.notifications.warn).not.toHaveBeenCalled();
  });

  it("browseAction opens the browser tab for a browsable kind", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const getFilterData = vi.fn().mockResolvedValue({});
    globalThis.game.pf2e = { compendiumBrowser: { tabs: { feat: { getFilterData, open } } } };

    await browseAction({ kind: "feat" });

    expect(getFilterData).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith({ filter: {} });
  });

  it("clearAction ignores buttons without kind and slug", async () => {
    await clearAction({});
    await clearAction({ kind: "feat" });
    expect(getAllMappings("feat")).toEqual({});
  });

  it("clearAction removes the mapping and refreshes", async () => {
    const render = vi.fn();
    globalThis.foundry.applications.instances.get = vi.fn().mockReturnValue({ render });
    await setMapping("feat", "power-attack", { uuid: "x", name: "Power Attack" });

    await clearAction({ kind: "feat", slug: "power-attack" });

    expect(getAllMappings("feat")).toEqual({});
    expect(render).toHaveBeenCalledWith({ force: true });
  });

  it("dropOntoRow ignores rows without kind and slug", async () => {
    await dropOntoRow(undefined, "x", dropData("{}"));
    await dropOntoRow("feat", undefined, dropData("{}"));
    expect(getAllMappings("feat")).toEqual({});
    expect(globalThis.ui.notifications.warn).not.toHaveBeenCalled();
  });

  it("dropOntoRow warns when nothing usable was dropped", async () => {
    for (const payload of [
      null,
      "",
      "not-json",
      JSON.stringify({ type: "Actor", uuid: "x" }),
      JSON.stringify({ type: "Item" }),
    ]) {
      await dropOntoRow("equipment", "half-plate", payload === null ? null : dropData(payload));
    }
    expect(globalThis.ui.notifications.warn).toHaveBeenCalledTimes(5);
    expect(getAllMappings("equipment")).toEqual({});
  });

  it("dropOntoRow warns when the dropped document is gone", async () => {
    await dropOntoRow(
      "equipment",
      "half-plate",
      dropData(JSON.stringify({ type: "Item", uuid: "Compendium.pf2e.equipment-srd.Item.gone" }))
    );

    expect(globalThis.ui.notifications.warn).toHaveBeenCalledTimes(1);
  });

  it("dropOntoRow rejects a mismatched item type with a dialog", async () => {
    const prompt = globalThis.foundry.applications.api.DialogV2.prompt;
    stubDroppedDocs({ fe1: { name: "Power Attack", type: "feat" } });

    await dropOntoRow("equipment", "half-plate", dropPayload("Compendium.pf2e.equipment-srd.Item.fe1"));

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ window: expect.objectContaining({ title: expect.stringContaining("doesn't match") }) })
    );
    expect(getAllMappings("equipment")).toEqual({});
  });

  it("dropOntoRow falls back to Unknown for nameless documents", async () => {
    const render = vi.fn();
    globalThis.foundry.applications.instances.get = vi.fn().mockReturnValue({ render });
    stubDroppedDocs({ noname: { type: "weapon" } });

    await dropOntoRow("equipment", "nameless-blade", dropPayload("Compendium.pf2e.equipment-srd.Item.noname"));

    expect(getAllMappings("equipment")["nameless-blade"]).toEqual({
      uuid: "Compendium.pf2e.equipment-srd.Item.noname",
      name: "Unknown",
    });
    expect(render).toHaveBeenCalledWith({ force: true });
  });

  it("dropOntoRow rejects documents without a type", async () => {
    stubDroppedDocs({ notype: { name: "Nameless" } });

    await dropOntoRow("equipment", "typeless-thing", dropPayload("Compendium.pf2e.equipment-srd.Item.notype"));

    expect(globalThis.foundry.applications.api.DialogV2.prompt).toHaveBeenCalled();
    expect(getAllMappings("equipment")).toEqual({});
  });

  it("dropOntoRow maps a matching drop and refreshes", async () => {
    const render = vi.fn();
    globalThis.foundry.applications.instances.get = vi.fn().mockReturnValue({ render });
    stubDroppedDocs({ hp1: { name: "Half Plate", type: "armor" } });

    await dropOntoRow("equipment", "half-plate", dropPayload("Compendium.pf2e.equipment-srd.Item.hp1"));

    expect(getAllMappings("equipment")["half-plate"]).toEqual({
      uuid: "Compendium.pf2e.equipment-srd.Item.hp1",
      name: "Half Plate",
    });
    expect(render).toHaveBeenCalledWith({ force: true });
  });
});

describe("mapping app rendering", () => {
  function fakeRow(dataset = {}) {
    const listeners = {};
    return {
      dataset,
      classList: { add: vi.fn(), remove: vi.fn() },
      addEventListener: vi.fn((type, fn) => {
        listeners[type] = fn;
      }),
      listeners,
    };
  }

  function fakeHtml({ rows = [], checkbox = undefined, list = undefined } = {}) {
    return {
      querySelectorAll: (sel) => (sel === ".mapping-row" ? rows : []),
      querySelector: (sel) => {
        if (sel === ".only-unmapped-toggle") return checkbox ?? null;
        if (sel === ".mapping-scroll") return list ?? null;
        return null;
      },
    };
  }

  beforeEach(() => {
    installFoundryMocks();
    registerSlugMappingSettings();
    globalThis.foundry.applications.instances = { get: vi.fn().mockReturnValue(undefined) };
  });

  async function openApp() {
    const AppClass = getDemiplaneMappingAppClass();
    return new AppClass();
  }

  it("prepares context with the unmapped filter on when rows are unmapped", async () => {
    globalThis.game.actors.contents = [linkedActor("Kyra", [{ slug: "x", kind: "feat" }])];
    const app = await openApp();

    const context = await app._prepareContext({});

    expect(context.onlyUnmapped).toBe(true);
    expect(context.anyUnmapped).toBe(true);
    expect(context.hasRows).toBe(true);
  });

  it("prepares context with the filter off when everything is mapped", async () => {
    await setMapping("feat", "power-attack", { uuid: "x", name: "Power Attack" });
    globalThis.game.actors.contents = [];
    const app = await openApp();

    const context = await app._prepareContext({});

    expect(context.onlyUnmapped).toBe(false);
    expect(context.hasRows).toBe(true);
  });

  it("preserves the filter choice across renders", async () => {
    globalThis.game.actors.contents = [linkedActor("Kyra", [{ slug: "x", kind: "feat" }])];
    const app = await openApp();
    await app._prepareContext({});
    globalThis.game.actors.contents = [];

    const context = await app._prepareContext({});

    // Still on: the user's (defaulted) choice wins over the recomputed value.
    expect(context.onlyUnmapped).toBe(true);
  });

  it("wires drop rows and the filter toggle", async () => {
    const row = fakeRow({ kind: "feat", slug: "power-attack" });
    const checkbox = { checked: true, addEventListener: vi.fn() };
    const list = { classList: { toggle: vi.fn() } };
    const app = await openApp();

    app._attachPartListeners("list", fakeHtml({ rows: [row], checkbox, list }), {});

    expect(list.classList.toggle).toHaveBeenCalledWith("only-unmapped", true);
    const change = checkbox.addEventListener.mock.calls.find((c) => c[0] === "change")?.[1];
    change();
    expect(list.classList.toggle).toHaveBeenCalledWith("only-unmapped", true);

    const event = { preventDefault: vi.fn(), dataTransfer: null };
    row.listeners.dragover(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(row.classList.add).toHaveBeenCalledWith("drop-target");
    row.listeners.dragleave();
    expect(row.classList.remove).toHaveBeenCalledWith("drop-target");
  });

  it("ignores rows without kind and slug on drop", async () => {
    const row = fakeRow({});
    const app = await openApp();
    app._attachPartListeners("list", fakeHtml({ rows: [row] }), {});

    await row.listeners.drop({ preventDefault: vi.fn(), dataTransfer: null });

    expect(globalThis.ui.notifications.warn).not.toHaveBeenCalled();
  });

  it("skips the filter toggle without its elements", async () => {
    const app = await openApp();

    expect(() => app._attachPartListeners("list", fakeHtml({}), {})).not.toThrow();
    expect(() =>
      app._attachPartListeners("list", fakeHtml({ checkbox: { checked: false, addEventListener: vi.fn() } }), {})
    ).not.toThrow();
  });

  it("registers the mapping templates", () => {
    registerDemiplaneMappingTemplates();
    expect(globalThis.foundry.applications.handlebars.loadTemplates).toHaveBeenCalledWith([
      expect.stringContaining("demiplane-mapping.hbs"),
    ]);
  });
});

describe("mapping target resolution", () => {
  beforeEach(() => {
    installFoundryMocks({
      "pf2e.equipment-srd": createMockPack([
        { _id: "hp1", name: "Half Plate", system: { slug: "half-plate" } },
        { _id: "noimg", name: "No Image", system: { slug: "no-image" } },
        { _id: "emptyimg", name: "Empty Image", system: { slug: "empty-image" }, img: "" },
      ]),
      "pf2e.ancestries": createMockPack([{ _id: "a1", name: "Dwarf", system: { slug: "dwarf" } }]),
    });
    registerSlugMappingSettings();
  });

  function sectionFor(kind, sections) {
    return sections.find((s) => s.kind === kind);
  }

  it("falls back to the placeholder icon when the index lacks an image", async () => {
    await setMapping("equipment", "a", { uuid: "Compendium.pf2e.equipment-srd.Item.noimg", name: "No Image" });
    await setMapping("equipment", "b", { uuid: "Compendium.pf2e.equipment-srd.Item.emptyimg", name: "Empty" });
    globalThis.game.actors.contents = [];

    const rows = sectionFor("equipment", await collectSections())?.rows ?? [];

    expect(rows.every((row) => !row.mappingMissing)).toBe(true);
    expect(rows.every((row) => row.icon.includes("unknown-item"))).toBe(true);
  });

  it("marks rows whose uuids do not parse as compendium references", async () => {
    await setMapping("equipment", "bad1", { uuid: "not-a-uuid", name: "Bad" });
    await setMapping("equipment", "bad2", { uuid: "Compendium..x.Item.", name: "Bad" });
    globalThis.game.actors.contents = [];

    const rows = sectionFor("equipment", await collectSections())?.rows ?? [];

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.mappingMissing)).toBe(true);
  });

  it("dedupes characters reporting the same slug", async () => {
    globalThis.game.actors.contents = [
      linkedActor("Kyra", [{ slug: "x", kind: "feat" }]),
      linkedActor("Kyra", [{ slug: "x", kind: "feat" }]),
    ];

    const rows = sectionFor("feat", await collectSections())?.rows ?? [];

    expect(rows[0]?.characters).toBe("Kyra");
  });

  it("reports whether a section can open a browser", async () => {
    globalThis.game.actors.contents = [linkedActor("Kyra", [{ slug: "dwarf", kind: "ancestry" }])];

    const ancestry = sectionFor("ancestry", await collectSections());

    expect(ancestry?.canBrowse).toBe(true);
  });

  it("reports sections without a browser or pack as not browsable", async () => {
    installFoundryMocks();
    registerSlugMappingSettings();
    globalThis.game.actors.contents = [linkedActor("Kyra", [{ slug: "dwarf", kind: "ancestry" }])];

    const ancestry = sectionFor("ancestry", await collectSections());

    expect(ancestry?.canBrowse).toBe(false);
  });
});
