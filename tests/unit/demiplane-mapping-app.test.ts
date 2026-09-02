import { describe, it, expect, beforeEach, vi } from "vitest";
import { installFoundryMocks, createMockActor, createMockPack } from "./foundry-mocks.js";
import {
  collectSections,
  EXPECTED_TYPES,
  isAcceptedType,
  openFinder,
  registerMappingSyncHook,
} from "../../src/demiplane-mapping-app.js";
import { registerSlugMappingSettings, setMapping } from "../../src/slug-mapping.js";
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
    const applicationClass = vi.fn().mockImplementation(() => ({ render }));
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
  /** refresh() drives reload() on the open instance; capture it. */
  let reload: ReturnType<typeof vi.fn>;

  function updateSettingCallback(): (setting: { key?: string }) => void {
    const hooks = globalThis as unknown as { Hooks: { on: ReturnType<typeof vi.fn> } };
    const calls = hooks.Hooks.on.mock.calls as Array<[string, (setting: { key?: string }) => void]>;
    return calls.find((call) => call[0] === "updateSetting")![1];
  }

  beforeEach(() => {
    installFoundryMocks();
    reload = vi.fn();
    const foundryGlobal = globalThis as unknown as {
      foundry: { applications: { instances: { get: ReturnType<typeof vi.fn> } } };
    };
    foundryGlobal.foundry.applications.instances = { get: vi.fn().mockReturnValue({ reload }) };
    registerMappingSyncHook();
  });

  it("reloads the open editor when a mapping setting changes on another client", () => {
    updateSettingCallback()({ key: "demiplane-pf2e.slugMappingsFeat" });
    expect(reload).toHaveBeenCalled();
  });

  it("ignores unrelated setting changes", () => {
    updateSettingCallback()({ key: "demiplane-pf2e.demiplaneToken" });
    expect(reload).not.toHaveBeenCalled();
  });
});
