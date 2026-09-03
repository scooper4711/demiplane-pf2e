import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFoundryMocks, createMockPack } from "./foundry-mocks.js";
import { ChoiceSetHandler } from "../../src/import/choice-set-handler.js";
import type { DemiplaneEngineEntry } from "../../src/import/types.js";

function eng(overrides: Partial<DemiplaneEngineEntry>): DemiplaneEngineEntry {
  return {
    id: "e1",
    name: "tabula/feat/foo.eng",
    type: "DemiplaneEngine",
    args: {},
    ...overrides,
  } as DemiplaneEngineEntry;
}

function installChoiceSetPrototype() {
  const builtin = {
    ChoiceSet: {
      prototype: { preCreate: vi.fn().mockResolvedValue(undefined) },
    },
  };
  ((globalThis as unknown as { game: { pf2e?: unknown } }).game as { pf2e: unknown }).pf2e = {
    RuleElements: { builtin },
  };
  return builtin;
}

describe("ChoiceSetHandler.presetChoiceSelections", () => {
  beforeEach(() =>
    installFoundryMocks({
      "pf2e.feats-srd": createMockPack([{ _id: "f1", name: "Power Attack", system: { slug: "power-attack" } }]),
    })
  );

  it("returns early when there are no rules", async () => {
    const handler = new ChoiceSetHandler();
    const itemData: Record<string, unknown> = { name: "Foo", system: {} };
    await handler.presetChoiceSelections(itemData, "fighter-rm");
    expect(itemData.system).toEqual({});
  });

  it("resolves a select-skill pattern to a foundry slug", async () => {
    const handler = new ChoiceSetHandler();
    handler.setEngines([
      eng({ name: "tabula/feat/foo.eng", args: { sourceRow: "select-skill-fighter-rm", slug: "society-rm" } }),
    ]);
    const itemData: Record<string, unknown> = {
      name: "Foo",
      system: { rules: [{ key: "ChoiceSet", flag: "choice" }] },
    };
    await handler.presetChoiceSelections(itemData, "fighter-rm");
    expect((itemData.system as { rules: Array<Record<string, unknown>> }).rules[0].selection).toBe("society");
  });

  it("resolves a select-feat pattern", async () => {
    const handler = new ChoiceSetHandler();
    handler.setEngines([eng({ args: { sourceRow: "select-feat-fighter-rm", slug: "power-attack-rm" } })]);
    const itemData: Record<string, unknown> = {
      name: "Foo",
      system: { rules: [{ key: "ChoiceSet", flag: "choice" }] },
    };
    await handler.presetChoiceSelections(itemData, "fighter-rm");
    expect((itemData.system as { rules: Array<Record<string, unknown>> }).rules[0].selection).toBe("power-attack");
  });

  it("resolves a select-feat pattern to a compendium UUID when choices are a compendium set", async () => {
    const handler = new ChoiceSetHandler();
    handler.setEngines([eng({ args: { sourceRow: "select-feat-fighter-rm", slug: "power-attack-rm" } })]);
    const itemData: Record<string, unknown> = {
      name: "Foo",
      system: { rules: [{ key: "ChoiceSet", flag: "choice", choices: { filter: () => [] } }] },
    };
    await handler.presetChoiceSelections(itemData, "fighter-rm");
    expect((itemData.system as { rules: Array<Record<string, unknown>> }).rules[0].selection).toBe(
      "Compendium.pf2e.feats-srd.Item.f1"
    );
  });

  it("derives the skill from the additional-lore engine name", async () => {
    const handler = new ChoiceSetHandler();
    handler.setEngines([
      eng({
        name: "core/selection/skill/custom-selection/index.eng",
        args: { name: "Forest Lore", slug: "lore-rm", sourceRow: "select-feat-gnome-obsession-rm" },
      }),
    ]);
    const itemData: Record<string, unknown> = {
      name: "Foo",
      system: { rules: [{ key: "ChoiceSet", flag: "choice" }] },
    };
    await handler.presetChoiceSelections(itemData, "gnome-obsession-rm");
    expect((itemData.system as { rules: Array<Record<string, unknown>> }).rules[0].selection).toBe("forest-lore");
  });

  it("derives a generic-feature name from engine args.name", async () => {
    const handler = new ChoiceSetHandler();
    handler.setEngines([
      eng({
        name: "tabula/generic-feature/athletics-rm.eng",
        args: {
          sourceRow: "select-generic-feature-fighter-rm",
          slug: "martial-disciple-rm-athletics-rm",
          name: "Athletics",
        },
      }),
    ]);
    const itemData: Record<string, unknown> = {
      name: "Foo",
      system: { rules: [{ key: "ChoiceSet", flag: "choice" }] },
    };
    await handler.presetChoiceSelections(itemData, "fighter-rm");
    expect((itemData.system as { rules: Array<Record<string, unknown>> }).rules[0].selection).toBe("athletics");
  });

  it("resolves a direct class-feature child engine by sourceRow", async () => {
    const handler = new ChoiceSetHandler();
    handler.setEngines([
      eng({
        name: "tabula/class-feature/weapon-training-rm.eng",
        args: { sourceRow: "fighter-rm", slug: "weapon-training-rm" },
      }),
    ]);
    const itemData: Record<string, unknown> = {
      name: "Foo",
      system: { rules: [{ key: "ChoiceSet", flag: "choice" }] },
    };
    await handler.presetChoiceSelections(itemData, "fighter-rm");
    expect((itemData.system as { rules: Array<Record<string, unknown>> }).rules[0].selection).toBe("weapon-training");
  });

  it("leaves selection unset when no engine matches", async () => {
    const handler = new ChoiceSetHandler();
    handler.setEngines([eng({ args: { sourceRow: "unrelated", slug: "x-rm" } })]);
    const itemData: Record<string, unknown> = {
      name: "Foo",
      system: { rules: [{ key: "ChoiceSet", flag: "choice" }] },
    };
    await handler.presetChoiceSelections(itemData, "fighter-rm");
    expect((itemData.system as { rules: Array<Record<string, unknown>> }).rules[0].selection).toBeUndefined();
  });
});

describe("ChoiceSetHandler preCreate monkey-patch", () => {
  function makeContext(overrides: Record<string, unknown> = {}) {
    const itemFlags: Record<string, unknown> = {};
    return {
      selection: null,
      choices: [],
      item: { flags: itemFlags, getRollOptions: () => [], rules: [{ ignored: true }], name: "Test Feat" },
      actor: { getRollOptions: () => [] },
      resolveInjectedProperties: () => ({ test: () => true }),
      predicate: {},
      inflateChoices: async () => overrides.inflateChoices ?? [],
      flag: "choice",
      rollOption: "foo",
      prompt: undefined,
      ...overrides,
    };
  }

  it("matches a skill slug from the engine list", async () => {
    const builtin = installChoiceSetPrototype();
    const handler = new ChoiceSetHandler();
    handler.setEngines([eng({ name: "core/selection/skill/increase/index.eng", args: { slug: "society-rm" } })]);
    handler.enable();

    const choices = [
      { value: "society", label: "Society" },
      { value: "crafting", label: "Crafting" },
    ];
    const ctx = makeContext({ choices, inflateChoices: async () => choices });
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Test Feat" } });

    expect(ctx.selection).toBe("society");
  });

  it("matches an additional-lore engine name to a skill choice", async () => {
    const builtin = installChoiceSetPrototype();
    const handler = new ChoiceSetHandler();
    handler.setEngines([
      eng({
        name: "core/selection/skill/custom-selection/index.eng",
        args: { name: "Forest Lore", sourceRow: "gnome-obsession-rm" },
      }),
    ]);
    handler.enable();

    const choices = [{ value: "forest-lore", label: "Forest Lore" }];
    const ctx = makeContext({
      choices,
      inflateChoices: async () => choices,
      item: { flags: {}, getRollOptions: () => [], rules: [], name: "Gnome Obsession" },
    });
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Gnome Obsession" } });

    expect(ctx.selection).toBe("forest-lore");
  });

  it("falls back to the first choice when nothing matches", async () => {
    const builtin = installChoiceSetPrototype();
    const handler = new ChoiceSetHandler();
    handler.setEngines([eng({ args: {} })]);
    handler.enable();

    const choices = [{ value: "foo", label: "Foo" }];
    const ctx = makeContext({ choices, inflateChoices: async () => choices });
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Test Feat" } });

    expect(ctx.selection).toBe("foo");
  });

  it("passes through a valid pre-set selection without re-resolving", async () => {
    const builtin = installChoiceSetPrototype();
    const original = builtin.ChoiceSet.prototype.preCreate;
    const handler = new ChoiceSetHandler();
    handler.setEngines([eng({ name: "core/selection/skill/increase/index.eng", args: { slug: "society-rm" } })]);
    handler.enable();

    const choices = [{ value: "society", label: "Society" }];
    const ctx = makeContext({ selection: "society", choices, inflateChoices: async () => choices });
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Test Feat" } });

    expect(original).toHaveBeenCalled();
    expect(ctx.selection).toBe("society");
  });

  it("re-resolves an invalid pre-set selection", async () => {
    const builtin = installChoiceSetPrototype();
    const handler = new ChoiceSetHandler();
    handler.setEngines([eng({ name: "core/selection/skill/increase/index.eng", args: { slug: "society-rm" } })]);
    handler.enable();

    const choices = [{ value: "society", label: "Society" }];
    const ctx = makeContext({ selection: "bogus", choices, inflateChoices: async () => choices });
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Test Feat" } });

    expect(ctx.selection).toBe("society");
  });

  it("disables the monkey-patch and restores the original", async () => {
    const builtin = installChoiceSetPrototype();
    const handler = new ChoiceSetHandler();
    handler.enable();
    handler.disable();
    expect(builtin.ChoiceSet.prototype.preCreate).toHaveBeenCalledTimes(0);
  });

  it("does not clobber a wrapper another module installed after enable()", () => {
    const builtin = installChoiceSetPrototype();
    const original = builtin.ChoiceSet.prototype.preCreate;
    const handler = new ChoiceSetHandler();
    handler.enable();

    // A different module wraps preCreate after us.
    const otherModuleWrapper = vi.fn().mockResolvedValue(undefined);
    builtin.ChoiceSet.prototype.preCreate = otherModuleWrapper;

    handler.disable();

    // Our restore must leave the newer wrapper in place, not the original.
    expect(builtin.ChoiceSet.prototype.preCreate).toBe(otherModuleWrapper);
    expect(builtin.ChoiceSet.prototype.preCreate).not.toBe(original);
  });
});

describe("ChoiceSetHandler with libWrapper active", () => {
  afterEach(() => {
    delete (globalThis as unknown as { libWrapper?: unknown }).libWrapper;
  });

  function activateLibWrapper() {
    const wrappers = new Map<string, (this: unknown, wrapped: unknown, ...args: unknown[]) => unknown>();
    const register = vi.fn(
      (_pkg: string, target: string, fn: (this: unknown, wrapped: unknown, ...args: unknown[]) => unknown) => {
        wrappers.set(target, fn);
        return 1;
      }
    );
    const unregister = vi.fn((_pkg: string, target: string) => {
      wrappers.delete(target);
    });

    (globalThis as unknown as { libWrapper: unknown }).libWrapper = { register, unregister };
    const g = (globalThis as unknown as { game: { modules: { get: ReturnType<typeof vi.fn> } } }).game;
    g.modules.get = vi.fn().mockImplementation((id: string) => (id === "lib-wrapper" ? { active: true } : undefined));

    return { register, unregister, wrappers };
  }

  it("registers a MIXED wrapper through libWrapper instead of patching the prototype", () => {
    installFoundryMocks();
    const builtin = installChoiceSetPrototype();
    const untouched = builtin.ChoiceSet.prototype.preCreate;
    const { register } = activateLibWrapper();

    const handler = new ChoiceSetHandler();
    handler.enable();

    expect(register).toHaveBeenCalledWith(
      "demiplane-pf2e",
      "game.pf2e.RuleElements.builtin.ChoiceSet.prototype.preCreate",
      expect.any(Function),
      "MIXED"
    );
    // The prototype method itself is left for libWrapper to manage.
    expect(builtin.ChoiceSet.prototype.preCreate).toBe(untouched);
  });

  it("unregisters through libWrapper on disable()", () => {
    installFoundryMocks();
    installChoiceSetPrototype();
    const { unregister } = activateLibWrapper();

    const handler = new ChoiceSetHandler();
    handler.enable();
    handler.disable();

    expect(unregister).toHaveBeenCalledWith(
      "demiplane-pf2e",
      "game.pf2e.RuleElements.builtin.ChoiceSet.prototype.preCreate"
    );
  });

  it("auto-selects through the libWrapper-registered wrapper", async () => {
    installFoundryMocks();
    installChoiceSetPrototype();
    const { wrappers } = activateLibWrapper();

    const handler = new ChoiceSetHandler();
    handler.setEngines([eng({ name: "core/selection/skill/increase/index.eng", args: { slug: "society-rm" } })]);
    handler.enable();

    const choices = [
      { value: "society", label: "Society" },
      { value: "crafting", label: "Crafting" },
    ];
    const ctx = {
      selection: null as unknown,
      choices,
      item: { flags: {}, getRollOptions: () => [], rules: [{ ignored: true }], name: "Test Feat" },
      actor: { getRollOptions: () => [] },
      resolveInjectedProperties: () => ({ test: () => true }),
      predicate: {},
      inflateChoices: async () => choices,
      flag: "choice",
      rollOption: "foo",
      prompt: undefined,
    };

    const wrapper = wrappers.get("game.pf2e.RuleElements.builtin.ChoiceSet.prototype.preCreate");
    const wrapped = vi.fn().mockResolvedValue(undefined);
    await wrapper!.call(ctx, wrapped, { ruleSource: {}, itemSource: { name: "Test Feat" } });

    expect(ctx.selection).toBe("society");
  });
});
