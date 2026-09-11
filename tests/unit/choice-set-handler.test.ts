import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFoundryMocks, createMockPack } from "./foundry-mocks.js";
import { ChoiceSetHandler, formatChoiceSetFallback } from "../../src/import/choice-set-handler.js";
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

  // A feat taken more than once (Energized Spark at L1 and L2) yields one
  // generic-choice engine per copy, each linked to its feat instance by
  // parentEngine === the feat engine's demiplaneEngineId.
  function sparkChoice(name: string, parentEngineId: string) {
    return eng({
      name: "shared/selection/generic-choice/index.eng",
      args: {
        name,
        slug: `energized-spark-rm-choice-${name.toLowerCase()}`,
        choiceID: "energized-spark-rm-choice",
        parentEngine: parentEngineId,
      },
    });
  }

  it("scopes a multi-take feat's generic choice to the matching feat instance", async () => {
    const handler = new ChoiceSetHandler();
    handler.setEngines([sparkChoice("Vitality", "engine-L1"), sparkChoice("Electricity", "engine-L2")]);

    const itemData: Record<string, unknown> = {
      name: "Energized Spark",
      system: { rules: [{ key: "ChoiceSet", flag: "energizedSpark" }] },
    };
    // The level-2 instance (engine id engine-L2) must resolve to Electricity,
    // not the first-in-list Vitality.
    await handler.presetChoiceSelections(itemData, "energized-spark-rm", "engine-L2");
    expect((itemData.system as { rules: Array<Record<string, unknown>> }).rules[0].selection).toBe("electricity");
  });

  it("scopes the other instance of the same feat to its own choice", async () => {
    const handler = new ChoiceSetHandler();
    handler.setEngines([sparkChoice("Vitality", "engine-L1"), sparkChoice("Electricity", "engine-L2")]);

    const itemData: Record<string, unknown> = {
      name: "Energized Spark",
      system: { rules: [{ key: "ChoiceSet", flag: "energizedSpark" }] },
    };
    await handler.presetChoiceSelections(itemData, "energized-spark-rm", "engine-L1");
    expect((itemData.system as { rules: Array<Record<string, unknown>> }).rules[0].selection).toBe("vitality");
  });

  it("falls back to slug matching when the feat instance has no scoped choice", async () => {
    // No generic-choice engine points at this feat instance; the slug-based
    // path resolves the selection instead (a single-take feat's normal flow).
    const handler = new ChoiceSetHandler();
    handler.setEngines([eng({ args: { sourceRow: "select-feat-fighter-rm", slug: "power-attack-rm" } })]);
    const itemData: Record<string, unknown> = {
      name: "Foo",
      system: { rules: [{ key: "ChoiceSet", flag: "choice" }] },
    };
    await handler.presetChoiceSelections(itemData, "fighter-rm", "engine-unmatched");
    expect((itemData.system as { rules: Array<Record<string, unknown>> }).rules[0].selection).toBe("power-attack");
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

  it("selects a predicate-narrowed sole option without recording a fallback", async () => {
    const builtin = installChoiceSetPrototype();
    const handler = new ChoiceSetHandler();
    // Guardian Dedication on a Fighter: the character is already trained in
    // light and medium armor, so only the "heavy" option survives PF2e's
    // predicate. The engine data carries only unrelated skill selections, which
    // would otherwise fall back to the first (only) choice and flag it noisily.
    handler.setEngines([
      eng({ name: "core/selection/skill/increase/index.eng", args: { slug: "acrobatics" } }),
      eng({ name: "core/selection/skill/increase/index.eng", args: { slug: "survival" } }),
    ]);
    handler.enable();

    const choices = [{ value: "heavy", label: "Heavy" }];
    const ctx = makeContext({
      choices,
      inflateChoices: async () => choices,
      rollOption: "guardian-dedication",
      item: { flags: {}, getRollOptions: () => [], rules: [], name: "Guardian Dedication" },
    });
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Guardian Dedication" } });

    expect(ctx.selection).toBe("heavy");
    // The choice was determined by the character's state, not guessed.
    expect(handler.drainFallbacks()).toHaveLength(0);
  });

  function sanctificationCtx(makeContext: (o?: Record<string, unknown>) => Record<string, unknown>, values: string[]) {
    const choices = values.map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) }));
    return makeContext({
      choices,
      inflateChoices: async () => choices,
      rollOption: "sanctification",
      item: { flags: {}, getRollOptions: () => [], rules: [], name: "Deity (Cleric)" },
    });
  }

  it("auto-selects a 'must be' deity's sole sanctification with no decision to review", async () => {
    const builtin = installChoiceSetPrototype();
    const handler = new ChoiceSetHandler();
    handler.setEngines([]);
    handler.enable();

    // A "must be" deity leaves a single predicate-passing option (e.g. Iomedae → Holy).
    const ctx = sanctificationCtx(makeContext, ["holy"]);
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Deity (Cleric)" } });

    expect(ctx.selection).toBe("holy");
    expect(handler.drainFallbacks()).toHaveLength(0);
    // A single-option "must be" deity is deterministic — no decision to surface.
    expect(handler.drainSanctificationDecision()).toBeUndefined();
  });

  it("defaults a 'can be' deity to the affirmative sanctification and records a decision to confirm", async () => {
    const builtin = installChoiceSetPrototype();
    const handler = new ChoiceSetHandler();
    handler.setEngines([]);
    handler.enable();

    // A "can be" deity leaves the affirmative option plus the "none" opt-out
    // (e.g. Sarenrae → Holy / None).
    const ctx = sanctificationCtx(makeContext, ["holy", "none"]);
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Deity (Cleric)" } });

    expect(ctx.selection).toBe("holy");
    // No generic ChoiceSet fallback — the sanctification note is owned by the orchestrator.
    expect(handler.drainFallbacks()).toHaveLength(0);
    const decision = handler.drainSanctificationDecision();
    expect(decision).toEqual({ options: ["holy", "none"], selected: "holy", fromPreference: false });
  });

  it("honors a stored sanctification preference over the affirmative default", async () => {
    const builtin = installChoiceSetPrototype();
    const handler = new ChoiceSetHandler();
    handler.setEngines([]);
    handler.setSanctificationPreference("none");
    handler.enable();

    const ctx = sanctificationCtx(makeContext, ["holy", "none"]);
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Deity (Cleric)" } });

    expect(ctx.selection).toBe("none");
    const decision = handler.drainSanctificationDecision();
    expect(decision).toEqual({ options: ["holy", "none"], selected: "none", fromPreference: true });
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

  // --- Exemplar weapon-ikon resolution ---------------------------------------

  /** Minimal PF2e Predicate supporting the string / {or} forms ikon filters use. */
  class FakePredicate {
    constructor(private readonly raw: unknown[]) {}
    test(options: string[] | Set<string>): boolean {
      const set = new Set(options);
      const holds = (stmt: unknown): boolean => {
        if (typeof stmt === "string") return set.has(stmt);
        if (stmt && typeof stmt === "object" && Array.isArray((stmt as { or?: unknown[] }).or)) {
          return (stmt as { or: unknown[] }).or.some(holds);
        }
        return false;
      };
      return this.raw.every(holds);
    }
  }

  const SLASHING_MELEE = ["item:melee", { or: ["item:damage:type:slashing", "item:damage:type:piercing"] }];
  const POLEARM = [{ or: ["item:group:polearm", "item:group:axe"] }];

  /** A classfeatures-pack ikon whose existingIkon ChoiceSet carries a weapon filter. */
  const ikonPackItem = (slug: string, predicate: unknown[]) => ({
    _id: `ikon-${slug}`,
    name: slug,
    type: "feat",
    system: {
      slug,
      rules: [
        {
          key: "ChoiceSet",
          flag: "existingIkon",
          choices: { ownedItems: true, predicate },
          rollOption: `${slug}-origin`,
        },
      ],
    },
  });

  /** A Demiplane class-feature engine naming a chosen ikon. */
  const ikonEngine = (slug: string) => eng({ name: `tabula/class-feature/${slug}.eng`, args: { slug } });

  /**
   * Installs the ChoiceSet prototype, the FakePredicate, and a classfeatures pack
   * holding the given ikons. Merges into the game object installed by
   * installFoundryMocks so game.packs/settings remain available for compendium
   * resolution.
   */
  function installIkonPrototype(ikonItems: ReturnType<typeof ikonPackItem>[] = []) {
    installFoundryMocks({ "pf2e.classfeatures": createMockPack(ikonItems) });
    const builtin = { ChoiceSet: { prototype: { preCreate: vi.fn().mockResolvedValue(undefined) } } };
    const g = (globalThis as unknown as { game: Record<string, unknown> }).game;
    g.pf2e = { RuleElements: { builtin }, Predicate: FakePredicate };
    return builtin;
  }

  function ikonActor() {
    return {
      getRollOptions: () => [],
      itemTypes: {
        weapon: [
          {
            id: "falchion",
            category: "martial",
            getRollOptions: () => ["item:melee", "item:group:sword", "item:damage:type:slashing"],
          },
          {
            id: "fauchard",
            category: "martial",
            getRollOptions: () => ["item:melee", "item:group:polearm", "item:damage:type:slashing"],
          },
        ],
      },
    };
  }

  /** Both weapon ikons the Exemplar chose, as classfeatures-pack items. */
  function bothIkonItems() {
    return [ikonPackItem("barrows-edge", SLASHING_MELEE), ikonPackItem("mortal-harvest", POLEARM)];
  }

  /** Engines naming both chosen ikons (the resolver's source of truth). */
  function bothIkonEngines() {
    return [ikonEngine("barrows-edge-rm"), ikonEngine("mortal-harvest-rm")];
  }

  const ikonOriginCtx = (slug: string, choices: { value: string; label: string }[]) =>
    makeContext({
      choices,
      inflateChoices: async () => choices,
      rollOption: `${slug}-origin`,
      item: { flags: {}, getRollOptions: () => [], rules: [{ ignored: true }], name: slug, slug },
      actor: ikonActor(),
    });

  it("selects 'existing' for a weapon ikon's origin choice", async () => {
    const builtin = installIkonPrototype(bothIkonItems());
    const handler = new ChoiceSetHandler();
    handler.setEngines(bothIkonEngines());
    handler.enable();

    const choices = [
      { value: "granted", label: "Grant me a new item." },
      { value: "existing", label: "Use an existing item in my inventory." },
    ];
    const ctx = ikonOriginCtx("mortal-harvest", choices);
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Mortal Harvest" }, tempItems: [] });

    expect(ctx.selection).toBe("existing");
  });

  it("selects the assigned owned weapon for the existingIkon choice", async () => {
    const builtin = installIkonPrototype(bothIkonItems());
    const handler = new ChoiceSetHandler();
    handler.setEngines(bothIkonEngines());
    handler.enable();

    // Mortal Harvest accepts only the fauchard (polearm), so it resolves there.
    const choices = [
      { value: "falchion", label: "Falchion" },
      { value: "fauchard", label: "Fauchard" },
    ];
    const ctx = makeContext({
      choices,
      inflateChoices: async () => choices,
      flag: "existingIkon",
      rollOption: "",
      item: {
        flags: {},
        getRollOptions: () => [],
        rules: [{ ignored: true }],
        name: "Mortal Harvest",
        slug: "mortal-harvest",
      },
      actor: ikonActor(),
    });
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Mortal Harvest" }, tempItems: [] });

    expect(ctx.selection).toBe("fauchard");
  });

  it("defers the existingIkon choice when the ikon got no assignment", async () => {
    // Only a bow is owned; the polearm ikon is unassigned, so its existingIkon
    // choice falls through rather than picking a weapon.
    const builtin = installIkonPrototype([ikonPackItem("mortal-harvest", POLEARM)]);
    const handler = new ChoiceSetHandler();
    handler.setEngines([ikonEngine("mortal-harvest-rm")]);
    handler.enable();

    const choices = [{ value: "bow", label: "Shortbow" }];
    const bowActor = {
      getRollOptions: () => [],
      itemTypes: {
        weapon: [{ id: "bow", category: "martial", getRollOptions: () => ["item:ranged", "item:group:bow"] }],
      },
    };
    const ctx = makeContext({
      choices,
      inflateChoices: async () => choices,
      flag: "existingIkon",
      rollOption: "",
      item: {
        flags: {},
        getRollOptions: () => [],
        rules: [{ ignored: true }],
        name: "Mortal Harvest",
        slug: "mortal-harvest",
      },
      actor: bowActor,
    });
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Mortal Harvest" }, tempItems: [] });

    // Fell through to the generic path (first option), not the ikon path.
    expect(ctx.selection).toBe("bow");
  });

  it("defers the existingIkon choice when the assigned weapon is absent from the options", async () => {
    // The resolver assigns the fauchard, but the offered choices don't include
    // it, so the ikon path defers rather than selecting a non-option.
    const builtin = installIkonPrototype(bothIkonItems());
    const handler = new ChoiceSetHandler();
    handler.setEngines(bothIkonEngines());
    handler.enable();

    const choices = [{ value: "some-other-id", label: "Other" }];
    const ctx = makeContext({
      choices,
      inflateChoices: async () => choices,
      flag: "existingIkon",
      rollOption: "",
      item: {
        flags: {},
        getRollOptions: () => [],
        rules: [{ ignored: true }],
        name: "Mortal Harvest",
        slug: "mortal-harvest",
      },
      actor: ikonActor(),
    });
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Mortal Harvest" }, tempItems: [] });

    expect(ctx.selection).toBe("some-other-id");
  });

  it("defers the origin choice when no 'existing' option is offered", async () => {
    const builtin = installIkonPrototype(bothIkonItems());
    const handler = new ChoiceSetHandler();
    handler.setEngines(bothIkonEngines());
    handler.enable();

    // Assigned by the resolver, but the origin ChoiceSet only offers "granted".
    const choices = [{ value: "granted", label: "Grant me a new item." }];
    const ctx = ikonOriginCtx("mortal-harvest", choices);
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Mortal Harvest" }, tempItems: [] });

    expect(ctx.selection).toBe("granted");
  });

  it("handles an actor with no itemTypes", async () => {
    // Defensive: itemTypes absent entirely. The origin choice defers (no owned
    // weapons to match) instead of throwing.
    const builtin = installIkonPrototype([ikonPackItem("mortal-harvest", POLEARM)]);
    const handler = new ChoiceSetHandler();
    handler.setEngines([ikonEngine("mortal-harvest-rm")]);
    handler.enable();

    const choices = [
      { value: "granted", label: "Grant me a new item." },
      { value: "existing", label: "Use an existing item in my inventory." },
    ];
    const ctx = makeContext({
      choices,
      inflateChoices: async () => choices,
      rollOption: "mortal-harvest-origin",
      item: {
        flags: {},
        getRollOptions: () => [],
        rules: [{ ignored: true }],
        name: "Mortal Harvest",
        slug: "mortal-harvest",
      },
      actor: { getRollOptions: () => [] }, // no itemTypes at all
    });
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Mortal Harvest" }, tempItems: [] });

    expect(ctx.selection).toBe("granted");
  });

  it("handles an actor whose itemTypes lacks a weapon list", async () => {
    // Defensive: itemTypes present but no `weapon` array (the `?? []` fallback).
    const builtin = installIkonPrototype([ikonPackItem("mortal-harvest", POLEARM)]);
    const handler = new ChoiceSetHandler();
    handler.setEngines([ikonEngine("mortal-harvest-rm")]);
    handler.enable();

    const choices = [
      { value: "granted", label: "Grant me a new item." },
      { value: "existing", label: "Use an existing item in my inventory." },
    ];
    const ctx = makeContext({
      choices,
      inflateChoices: async () => choices,
      rollOption: "mortal-harvest-origin",
      item: {
        flags: {},
        getRollOptions: () => [],
        rules: [{ ignored: true }],
        name: "Mortal Harvest",
        slug: "mortal-harvest",
      },
      actor: { getRollOptions: () => [], itemTypes: {} },
    });
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Mortal Harvest" }, tempItems: [] });

    expect(ctx.selection).toBe("granted");
  });

  it("skips a chosen ikon whose compendium item is missing or has no rules", async () => {
    // The engine names an ikon, but its compendium item carries no system.rules
    // (e.g. an unmapped/odd entry): it must be skipped, not throw.
    const noRules = { _id: "ikon-x", name: "x", type: "feat", system: { slug: "mortal-harvest" } };
    const builtin = installIkonPrototype([noRules]);
    const handler = new ChoiceSetHandler();
    handler.setEngines([ikonEngine("mortal-harvest-rm")]);
    handler.enable();

    const choices = [
      { value: "granted", label: "Grant me a new item." },
      { value: "existing", label: "Use an existing item in my inventory." },
    ];
    const ctx = ikonOriginCtx("mortal-harvest", choices);
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Mortal Harvest" }, tempItems: [] });

    expect(ctx.selection).toBe("granted");
  });

  it("ignores an engine ikon that has no existingIkon rule (body/worn ikon)", async () => {
    // Skin Hard as Horn is a chosen ikon but not a weapon ikon; the resolver
    // must skip it, leaving no assignment and deferring the origin choice.
    const bodyIkon = {
      _id: "ikon-skin",
      name: "skin-hard-as-horn",
      type: "feat",
      system: { slug: "skin-hard-as-horn", rules: [] },
    };
    const builtin = installIkonPrototype([bodyIkon]);
    const handler = new ChoiceSetHandler();
    handler.setEngines([ikonEngine("skin-hard-as-horn-rm")]);
    handler.enable();

    const choices = [
      { value: "granted", label: "Grant me a new item." },
      { value: "existing", label: "Use an existing item in my inventory." },
    ];
    const ctx = ikonOriginCtx("skin-hard-as-horn", choices);
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Skin Hard as Horn" }, tempItems: [] });

    expect(ctx.selection).toBe("granted");
  });

  it("does not crash when a slugged item's ChoiceSet has a null rollOption", async () => {
    // PF2e leaves rollOption null for most ChoiceSets; the ikon origin check
    // must guard it rather than calling endsWith on null (which aborted imports).
    const builtin = installIkonPrototype();
    const handler = new ChoiceSetHandler();
    handler.setEngines([eng({ name: "core/selection/skill/increase/index.eng", args: { slug: "society-rm" } })]);
    handler.enable();

    const choices = [
      { value: "society", label: "Society" },
      { value: "crafting", label: "Crafting" },
    ];
    const ctx = makeContext({
      choices,
      inflateChoices: async () => choices,
      flag: "choice",
      rollOption: null,
      item: {
        flags: {},
        getRollOptions: () => [],
        rules: [{ ignored: true }],
        name: "Some Feature",
        slug: "some-feature",
      },
    });
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Some Feature" }, tempItems: [] });

    expect(ctx.selection).toBe("society");
  });

  it("ignores a non-ikon ChoiceSet on a slugged item", async () => {
    // The item has a slug but the ChoiceSet is neither the origin (-origin
    // rollOption) nor the existingIkon flag, so ikon handling defers and the
    // generic path resolves it.
    const builtin = installIkonPrototype();
    const handler = new ChoiceSetHandler();
    handler.setEngines([eng({ name: "core/selection/skill/increase/index.eng", args: { slug: "society-rm" } })]);
    handler.enable();

    const choices = [
      { value: "society", label: "Society" },
      { value: "crafting", label: "Crafting" },
    ];
    const ctx = makeContext({
      choices,
      inflateChoices: async () => choices,
      flag: "choice",
      rollOption: "foo",
      item: { flags: {}, getRollOptions: () => [], rules: [{ ignored: true }], name: "Some Feat", slug: "some-feat" },
    });
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Some Feat" }, tempItems: [] });

    expect(ctx.selection).toBe("society");
  });

  it("defers a weapon ikon's origin choice when no owned weapon matches", async () => {
    const builtin = installIkonPrototype([ikonPackItem("mortal-harvest", POLEARM)]);
    const handler = new ChoiceSetHandler();
    handler.setEngines([ikonEngine("mortal-harvest-rm")]);
    handler.enable();

    const choices = [
      { value: "granted", label: "Grant me a new item." },
      { value: "existing", label: "Use an existing item in my inventory." },
    ];
    // Actor owns only a bow: the polearm filter matches nothing, so the origin
    // choice is left to fall back to the default (first option, "granted").
    const bowActor = {
      getRollOptions: () => [],
      itemTypes: {
        weapon: [{ id: "bow", category: "martial", getRollOptions: () => ["item:ranged", "item:group:bow"] }],
      },
    };
    const ctx = makeContext({
      choices,
      inflateChoices: async () => choices,
      rollOption: "mortal-harvest-origin",
      item: {
        flags: {},
        getRollOptions: () => [],
        rules: [{ ignored: true }],
        name: "Mortal Harvest",
        slug: "mortal-harvest",
      },
      actor: bowActor,
    });
    const proto = builtin.ChoiceSet.prototype as unknown as { preCreate: (this: unknown, p: unknown) => Promise<void> };
    await proto.preCreate.call(ctx, { ruleSource: {}, itemSource: { name: "Mortal Harvest" }, tempItems: [] });

    // Fell through to the generic path, which defaults to the first option.
    expect(ctx.selection).toBe("granted");
  });

  describe("user choice overrides (last resort)", () => {
    const twoSkills = () => [
      { value: "acrobatics", label: "Acrobatics" },
      { value: "crafting", label: "Crafting" },
    ];

    async function runPreCreate(
      handler: ChoiceSetHandler,
      ctx: Record<string, unknown>,
      itemName = "Test Feat",
      ruleSource: Record<string, unknown> = {}
    ): Promise<string> {
      const builtin = installChoiceSetPrototype();
      handler.enable();
      const proto = builtin.ChoiceSet.prototype as unknown as {
        preCreate: (this: unknown, p: unknown) => Promise<void>;
      };
      const itemSource = { name: itemName };
      await proto.preCreate.call(ctx, { ruleSource, itemSource, tempItems: [] });
      return itemSource.name;
    }

    function unmatchedHandler(): ChoiceSetHandler {
      const handler = new ChoiceSetHandler();
      handler.setEngines([eng({ args: {} })]);
      return handler;
    }

    it("applies a stored override when automatic matching fails", async () => {
      const handler = unmatchedHandler();
      handler.setChoiceOverrides({ "test-feat::choice": "crafting" });
      const choices = twoSkills();
      const ctx = makeContext({ choices, inflateChoices: async () => choices });
      await runPreCreate(handler, ctx);

      expect(ctx.selection).toBe("crafting");
      // Applied as a decision, not a guess: no fallback text — but recorded
      // as an override record so the dialog shows what is in effect.
      expect(handler.drainFallbacks()).toHaveLength(0);
      const [record] = handler.drainUnresolvedChoices();
      expect(record?.source).toBe("override");
      expect(record?.key).toBe("test-feat::choice");
    });

    it("lets an automatic match win over a stored override", async () => {
      const handler = new ChoiceSetHandler();
      handler.setEngines([eng({ name: "core/selection/skill/increase/index.eng", args: { slug: "society-rm" } })]);
      handler.setChoiceOverrides({ "test-feat::choice": "crafting" });
      const choices = [
        { value: "society", label: "Society" },
        { value: "crafting", label: "Crafting" },
      ];
      const ctx = makeContext({ choices, inflateChoices: async () => choices });
      await runPreCreate(handler, ctx);

      // The override names a valid option, but the matchers found society —
      // automatic resolution always wins.
      expect(ctx.selection).toBe("society");
      expect(handler.drainFallbacks()).toHaveLength(0);
      expect(handler.drainUnresolvedChoices()).toHaveLength(0);
    });

    it("ignores a stale override and records the ChoiceSet as unresolved", async () => {
      const handler = unmatchedHandler();
      handler.setChoiceOverrides({ "test-feat::choice": "survival" });
      const choices = twoSkills();
      const ctx = makeContext({ choices, inflateChoices: async () => choices });
      await runPreCreate(handler, ctx);

      // "survival" is not among today's options: blind guess, flagged both ways.
      expect(ctx.selection).toBe("acrobatics");
      expect(handler.drainFallbacks()).toHaveLength(1);
      expect(handler.drainUnresolvedChoices()).toEqual([
        {
          key: "test-feat::choice",
          source: "guess",
          prompt: "Test Feat",
          options: [
            { value: "acrobatics", label: "Acrobatics" },
            { value: "crafting", label: "Crafting" },
          ],
          guessedValue: "acrobatics",
        },
      ]);
    });

    it("records an override-applied choice with source override", async () => {
      const handler = unmatchedHandler();
      handler.setChoiceOverrides({ "test-feat::choice": "crafting" });
      const choices = twoSkills();
      const ctx = makeContext({ choices, inflateChoices: async () => choices });
      await runPreCreate(handler, ctx);

      expect(ctx.selection).toBe("crafting");
      // Applied as the user's decision: no fallback text, but recorded so the
      // dialog can show what is in effect (with a delete option).
      expect(handler.drainFallbacks()).toHaveLength(0);
      expect(handler.drainUnresolvedChoices()).toEqual([
        {
          key: "test-feat::choice",
          source: "override",
          prompt: "Test Feat",
          options: [
            { value: "acrobatics", label: "Acrobatics" },
            { value: "crafting", label: "Crafting" },
          ],
          guessedValue: "acrobatics",
        },
      ]);
    });

    it("labels the record with the ChoiceSet prompt when present", async () => {
      const handler = unmatchedHandler();
      const choices = twoSkills();
      const ctx = makeContext({ choices, inflateChoices: async () => choices, prompt: "Choose a skill" });
      await runPreCreate(handler, ctx);

      const [record] = handler.drainUnresolvedChoices();
      expect(record?.prompt).toBe("Choose a skill");
    });

    it("keys by item slug when the item has one", async () => {
      const handler = unmatchedHandler();
      handler.setChoiceOverrides({ "domain-initiate::choice": "crafting" });
      const choices = twoSkills();
      const ctx = makeContext({
        choices,
        inflateChoices: async () => choices,
        item: { flags: {}, getRollOptions: () => [], rules: [], name: "Domain Initiate", slug: "domain-initiate" },
      });
      await runPreCreate(handler, ctx);

      expect(ctx.selection).toBe("crafting");
      const [record] = handler.drainUnresolvedChoices();
      expect(record?.source).toBe("override");
      expect(record?.key).toBe("domain-initiate::choice");
    });

    it("records nothing for a predicate-narrowed sole option, even with an override stored", async () => {
      const handler = unmatchedHandler();
      handler.setChoiceOverrides({ "test-feat::choice": "other" });
      const choices = [{ value: "heavy", label: "Heavy" }];
      const ctx = makeContext({ choices, inflateChoices: async () => choices });
      await runPreCreate(handler, ctx);

      expect(ctx.selection).toBe("heavy");
      expect(handler.drainFallbacks()).toHaveLength(0);
      expect(handler.drainUnresolvedChoices()).toHaveLength(0);
    });

    it("renames the item for the applied fallback choice", async () => {
      const handler = unmatchedHandler();
      const choices = [
        { value: "acting", label: "Acting" },
        { value: "winds", label: "Winds" },
      ];
      const ctx = makeContext({ choices, inflateChoices: async () => choices });
      const name = await runPreCreate(handler, ctx, "Virtuosic Performer");

      expect(ctx.selection).toBe("acting");
      expect(name).toBe("Virtuosic Performer (Acting)");
    });

    it("renames the item for a stored override", async () => {
      const handler = unmatchedHandler();
      handler.setChoiceOverrides({ "test-feat::choice": "winds" });
      const choices = [
        { value: "acting", label: "Acting" },
        { value: "winds", label: "Winds" },
      ];
      const ctx = makeContext({ choices, inflateChoices: async () => choices });
      const name = await runPreCreate(handler, ctx, "Virtuosic Performer");

      expect(ctx.selection).toBe("winds");
      expect(name).toBe("Virtuosic Performer (Winds)");
    });

    it("renames the item for an automatic match", async () => {
      const handler = new ChoiceSetHandler();
      handler.setEngines([eng({ name: "core/selection/skill/increase/index.eng", args: { slug: "society-rm" } })]);
      const choices = [
        { value: "society", label: "Society" },
        { value: "crafting", label: "Crafting" },
      ];
      const ctx = makeContext({ choices, inflateChoices: async () => choices });
      const name = await runPreCreate(handler, ctx, "Additional Lore");

      expect(ctx.selection).toBe("society");
      expect(name).toBe("Additional Lore (Society)");
    });

    it("localizes translation-key labels before renaming", async () => {
      const gameGlobal = globalThis as unknown as { game?: { i18n?: unknown } };
      const savedGame = gameGlobal.game;
      try {
        gameGlobal.game = {
          ...((savedGame ?? {}) as Record<string, unknown>),
          i18n: { localize: (key: string) => (key === "PF2E.SpecificRule.VirtuosicPerformer.Winds" ? "Winds" : key) },
        };
        const handler = unmatchedHandler();
        handler.setChoiceOverrides({ "test-feat::choice": "winds" });
        const choices = [{ value: "winds", label: "PF2E.SpecificRule.VirtuosicPerformer.Winds" }];
        const ctx = makeContext({ choices, inflateChoices: async () => choices });
        const name = await runPreCreate(handler, ctx, "Virtuosic Performer");

        expect(name).toBe("Virtuosic Performer (Winds)");
      } finally {
        gameGlobal.game = savedGame;
      }
    });

    it("does not double the suffix when already present", async () => {
      const handler = unmatchedHandler();
      handler.setChoiceOverrides({ "test-feat::choice": "winds" });
      const choices = [{ value: "winds", label: "Winds" }];
      const ctx = makeContext({ choices, inflateChoices: async () => choices });
      const name = await runPreCreate(handler, ctx, "Virtuosic Performer (Winds)");

      expect(name).toBe("Virtuosic Performer (Winds)");
    });

    it("leaves the name alone for string-form adjustName templates", async () => {
      const handler = unmatchedHandler();
      handler.setChoiceOverrides({ "test-feat::choice": "winds" });
      const choices = [{ value: "winds", label: "Winds" }];
      const ctx = makeContext({ choices, inflateChoices: async () => choices });
      const name = await runPreCreate(handler, ctx, "Kinetic Gate", { adjustName: "Gate ({element}): {choice}" });

      expect(ctx.selection).toBe("winds");
      expect(name).toBe("Kinetic Gate");
    });
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

  it("records a fallback with offered options and candidate slugs when nothing matches", async () => {
    installFoundryMocks();
    installChoiceSetPrototype();
    const { wrappers } = activateLibWrapper();

    const handler = new ChoiceSetHandler();
    // The character's only selection is unrelated to either offered option, so
    // no strategy matches and the importer falls back to the first choice.
    handler.setEngines([
      eng({
        name: "tabula/feat/something-else-wizard.eng",
        args: { sourceRow: "select-feat-x", slug: "something-else-wizard" },
      }),
    ]);
    handler.enable();

    const choices = [
      { value: "Compendium.pf2e.feats-srd.Item.AAAA", label: "Reach Spell" },
      { value: "Compendium.pf2e.feats-srd.Item.BBBB", label: "Widen Spell" },
    ];
    const ctx = {
      selection: null as unknown,
      choices,
      item: { flags: {}, getRollOptions: () => [], rules: [{ ignored: true }], name: "Experimental Spellshaping" },
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
    await wrapper!.call(ctx, wrapped, { ruleSource: {}, itemSource: { name: "Experimental Spellshaping" } });

    // Still applies the first-choice guess so the import stays usable.
    expect(ctx.selection).toBe("Compendium.pf2e.feats-srd.Item.AAAA");

    const fallbacks = handler.drainFallbacks();
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toEqual({
      itemName: "Experimental Spellshaping",
      chosenLabel: "Reach Spell",
      offeredLabels: ["Reach Spell", "Widen Spell"],
      candidateSlugs: ["something-else-wizard"],
    });
    // Draining clears the list.
    expect(handler.drainFallbacks()).toHaveLength(0);
  });

  it("resolves the class-suffixed selection to its metamagic feat, scoped by feature", async () => {
    // Regression for Ezren: the character's "widen-spell-wizard" selection
    // (scoped to School of Unified Magical Theory) must resolve to Widen Spell,
    // not fall back. The compendium choice labels are unsuffixed ("Widen Spell").
    installFoundryMocks();
    installChoiceSetPrototype();
    const { wrappers } = activateLibWrapper();

    const handler = new ChoiceSetHandler();
    handler.setEngines([
      eng({
        name: "tabula/feat/widen-spell-wizard-rm.eng",
        args: {
          slug: "widen-spell-wizard-rm",
          sourceRow: "abc_select-feat-school-of-unified-magical-theory-rm-xyz",
        },
      }),
      eng({
        name: "tabula/feat/reach-spell-wizard-rm.eng",
        args: {
          slug: "reach-spell-wizard-rm",
          sourceRow: "def_select-feat-experimental-spellshaping-rm-xyz",
        },
      }),
    ]);
    handler.enable();

    const choices = [
      { value: "Compendium.pf2e.feats-srd.Item.RS", label: "Reach Spell" },
      { value: "Compendium.pf2e.feats-srd.Item.WS", label: "Widen Spell" },
      { value: "Compendium.pf2e.feats-srd.Item.CS", label: "Counterspell (Prepared)" },
    ];
    const ctx = {
      selection: null as unknown,
      choices,
      item: {
        flags: {},
        getRollOptions: () => [],
        rules: [{ ignored: true }],
        name: "School of Unified Magical Theory",
      },
      actor: { getRollOptions: () => [] },
      resolveInjectedProperties: () => ({ test: () => true }),
      predicate: {},
      inflateChoices: async () => choices,
      flag: "feat",
      rollOption: "foo",
      prompt: undefined,
    };

    const wrapper = wrappers.get("game.pf2e.RuleElements.builtin.ChoiceSet.prototype.preCreate");
    await wrapper!.call(ctx, vi.fn().mockResolvedValue(undefined), {
      ruleSource: {},
      itemSource: { name: "School of Unified Magical Theory" },
    });

    // Scoped to the school's own selection → Widen Spell, and no fallback.
    expect(ctx.selection).toBe("Compendium.pf2e.feats-srd.Item.WS");
    expect(handler.drainFallbacks()).toHaveLength(0);
  });

  it("does not record a fallback when a choice matches", async () => {
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
    await wrapper!.call(ctx, vi.fn().mockResolvedValue(undefined), {
      ruleSource: {},
      itemSource: { name: "Test Feat" },
    });

    expect(handler.drainFallbacks()).toHaveLength(0);
  });
});

describe("formatChoiceSetFallback", () => {
  it("includes the item, the guess, the options, and the character's selections", () => {
    const msg = formatChoiceSetFallback({
      itemName: "Experimental Spellshaping",
      chosenLabel: "Reach Spell",
      offeredLabels: ["Reach Spell", "Widen Spell"],
      candidateSlugs: ["widen-spell-wizard"],
    });
    expect(msg).toContain("Experimental Spellshaping");
    expect(msg).toContain('defaulted to "Reach Spell"');
    expect(msg).toContain("Reach Spell, Widen Spell");
    expect(msg).toContain("widen-spell-wizard");
  });

  it("omits the options and selections lines when there is nothing to show", () => {
    const msg = formatChoiceSetFallback({
      itemName: "Some Feat",
      chosenLabel: "Only Option",
      offeredLabels: ["Only Option"],
      candidateSlugs: [],
    });
    expect(msg).toContain("Some Feat");
    expect(msg).not.toContain("Options:");
    expect(msg).not.toContain("Your character had:");
  });
});
