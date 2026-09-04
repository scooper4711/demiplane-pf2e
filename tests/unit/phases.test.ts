import { describe, it, expect, beforeEach, vi } from "vitest";
import { installFoundryMocks, createMockActor, createMockPack } from "./foundry-mocks.js";
import {
  BatchItemsPhase,
  buildSelectionData,
  categorizeEngines,
  collectLoreNames,
  LoreItemsPhase,
  PostProcessingPhase,
  RemoveDuplicatesPhase,
  ResolveGrantsPhase,
  SequentialItemsPhase,
} from "../../src/import/phases.js";
import { MODULE_ID } from "../../src/import/types.js";

const SCHOLAR = { _id: "bg-scholar", name: "Scholar", type: "background", system: { slug: "scholar" } };
const PLAIN_BG = { _id: "bg-plain", name: "Plain", type: "background", system: { slug: "plain" } };
const LORE_BG = {
  _id: "bg-lore",
  name: "Lore Background",
  type: "background",
  system: { slug: "lore-bg", trainedSkills: { lore: ["Scribing Lore"] } },
};
const FARMHAND_BG = {
  _id: "bg-farmhand",
  name: "Farmhand",
  type: "background",
  system: { slug: "farmhand", trainedSkills: { lore: ["Farming Lore"] } },
};
const POWER_ATTACK = { _id: "feat-pa", name: "Power Attack", type: "feat", system: { slug: "power-attack" } };
const GRANTED_FEAT = { _id: "feat-granted", name: "Granted Feat", type: "feat", system: { slug: "granted-feat" } };
const NO_SLUG_FEAT = { _id: "feat-noslug", name: "No Slug", type: "feat", system: {} };
const LONGSWORD = { _id: "eq-long", name: "Longsword", type: "weapon", system: { slug: "longsword" } };

const GRANT_UUID = "Compendium.pf2e.feats-srd.Item.feat-granted";

function packs() {
  return {
    "pf2e.backgrounds": createMockPack([SCHOLAR, PLAIN_BG, LORE_BG, FARMHAND_BG]),
    "pf2e.feats-srd": createMockPack([POWER_ATTACK, GRANTED_FEAT, NO_SLUG_FEAT]),
    "pf2e.equipment-srd": createMockPack([LONGSWORD]),
  };
}

function summary() {
  return { itemsImported: 0, itemsSkipped: 0, unmapped: [], errors: [], log: [] };
}

function makeCtx(engines = [], overrides = {}) {
  return {
    engines,
    summary: summary(),
    choiceSetHandler: { presetChoiceSelections: vi.fn().mockResolvedValue(undefined) },
    categorized: { ancestry: [], heritage: [], background: [], class: [], feat: [], equipment: [] },
    selectionData: { grantedFeatSlugs: new Set(), selectedFeats: [] },
    grantResolvedSlugs: new Set(),
    ...overrides,
  };
}

let engineSeq = 0;
function demiEngine(name, args = {}) {
  engineSeq += 1;
  return { id: `eng-${engineSeq}`, name, type: "DemiplaneEngine", args };
}

function customEngine(name, value) {
  engineSeq += 1;
  return { id: `eng-${engineSeq}`, name, type: "CustomDemiplaneEngine", value };
}

function slugged(category, slug, extraArgs = {}) {
  return { ...demiEngine(`tabula/${category}/x.eng`, { slug, ...extraArgs }), _slug: slug };
}

describe("import phases", () => {
  beforeEach(() => {
    installFoundryMocks(packs());
    engineSeq = 0;
  });

  describe("buildSelectionData", () => {
    it("collects granted and selected feats from select-feat engines", () => {
      const engines = [
        demiEngine("tabula/feat/power-attack.eng", { slug: "power-attack", sourceRow: "select-feat-1" }),
        demiEngine("tabula/class/fighter.eng", { slug: "fighter" }),
        demiEngine("tabula/feat/toughness.eng", {}),
      ];

      const { grantedFeatSlugs, selectedFeats } = buildSelectionData(engines);

      expect([...grantedFeatSlugs]).toEqual(["power-attack"]);
      expect(selectedFeats).toEqual(["power-attack"]);
    });

    it("ignores engines without a feat slug or marker", () => {
      const { grantedFeatSlugs, selectedFeats } = buildSelectionData([
        demiEngine("tabula/feat/x.eng", { sourceRow: "select-feat-1" }),
        demiEngine("tabula/feat/y.eng", { slug: "y" }),
      ]);

      expect(grantedFeatSlugs.size).toBe(0);
      expect(selectedFeats).toEqual([]);
    });
  });

  describe("categorizeEngines", () => {
    it("sorts engines into categories and skips the rest", () => {
      const feat = demiEngine("tabula/feat/power-attack.eng", { slug: "power-attack" });
      const custom = customEngine("character_name", "Valeros");
      const noSlug = demiEngine("tabula/feat/naked", {});
      const unknown = demiEngine("tabula/classfeature/x.eng", { slug: "x" });

      const categorized = categorizeEngines([
        demiEngine("tabula/ancestry/dwarf.eng", { slug: "dwarf" }),
        demiEngine("tabula/heritage/death-wife.eng", { slug: "hw" }),
        demiEngine("tabula/background/scholar.eng", { slug: "scholar" }),
        demiEngine("tabula/class/fighter.eng", { slug: "fighter" }),
        feat,
        demiEngine("tabula/equipment/longsword.eng", { slug: "longsword" }),
        custom,
        noSlug,
        unknown,
      ]);

      expect(categorized.ancestry.map((e) => e._slug)).toEqual(["dwarf"]);
      expect(categorized.heritage.map((e) => e._slug)).toEqual(["hw"]);
      expect(categorized.background.map((e) => e._slug)).toEqual(["scholar"]);
      expect(categorized.class.map((e) => e._slug)).toEqual(["fighter"]);
      expect(categorized.feat.map((e) => e._slug)).toEqual(["power-attack"]);
      expect(categorized.equipment.map((e) => e._slug)).toEqual(["longsword"]);
    });
  });

  describe("collectLoreNames", () => {
    it("passes background lores through and merges custom skills", () => {
      const engines = [
        demiEngine("core/selection/skill/custom-skill/index.eng", { name: "Sailing Lore" }),
        demiEngine("core/selection/skill/custom-skill/index.eng", { name: "Sailing Lore" }),
        demiEngine("core/selection/skill/custom-selection/index.eng", { name: "Forest Lore" }),
        demiEngine("core/selection/skill/custom-selection/index.eng", { name: "Not Related" }),
        demiEngine("core/selection/skill/custom-selection/index.eng", {}),
      ];

      expect(collectLoreNames(engines, ["Scribing Lore"])).toEqual(["Scribing Lore", "Sailing Lore", "Forest Lore"]);
    });
  });

  describe("LoreItemsPhase", () => {
    it("does nothing without a background engine", async () => {
      const actor = createMockActor();
      const ctx = makeCtx([customEngine("character_name", "Valeros")]);

      await new LoreItemsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("does nothing when the background has no slug", async () => {
      const actor = createMockActor();
      const ctx = makeCtx([demiEngine("tabula/background/missing", {})]);

      await new LoreItemsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("does nothing when the background is not in the compendium", async () => {
      const actor = createMockActor();
      const ctx = makeCtx([demiEngine("tabula/background/unknown.eng", { slug: "unknown" })]);

      await new LoreItemsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("does nothing when the background grants no lore", async () => {
      const actor = createMockActor();
      const ctx = makeCtx([demiEngine("tabula/background/plain.eng", { slug: "plain" })]);

      await new LoreItemsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("creates lore items from background training", async () => {
      const actor = createMockActor();
      const ctx = makeCtx([demiEngine("tabula/background/lore-bg.eng", { slug: "lore-bg" })]);

      await new LoreItemsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
      const data = actor.createEmbeddedDocuments.mock.calls[0][1];
      expect(data[0].name).toBe("Scribing Lore");
      expect(data[0].type).toBe("lore");
      expect(ctx.summary.log).toContain("+ lore: [Scribing Lore]");
    });

    it("creates background lore when the engine carries no slug (Farmhand regression)", async () => {
      // Regression from the real Valeros character: Demiplane sends the Farmhand
      // background as tabula/background/farmhand-rm.eng with args {id: null} and
      // no slug. Requiring args.slug dropped the background, so Farming Lore was
      // never granted. getSlug() must fall back to the engine name.
      const actor = createMockActor();
      const ctx = makeCtx([
        {
          id: "ddd39521-b0df-403a-b942-c4b106b95f3c",
          name: "tabula/background/farmhand-rm.eng",
          type: "DemiplaneEngine",
          args: { id: null },
        },
      ]);

      await new LoreItemsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
      const data = actor.createEmbeddedDocuments.mock.calls[0][1];
      expect(data[0].name).toBe("Farming Lore");
      expect(ctx.summary.log).toContain("+ lore: [Farming Lore]");
    });

    it("skips lore the actor already has", async () => {
      const actor = createMockActor({
        items: [{ id: "l1", _id: "l1", name: "Scribing Lore", type: "lore", flags: {}, system: {} }],
      });
      const ctx = makeCtx([demiEngine("tabula/background/lore-bg.eng", { slug: "lore-bg" })]);

      await new LoreItemsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("collects custom-skill lore without any background", async () => {
      const actor = createMockActor();
      const ctx = makeCtx([demiEngine("core/selection/skill/custom-skill/index.eng", { name: "Sailing Lore" })]);

      await new LoreItemsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
      expect(ctx.summary.log).toContain("+ lore: [Sailing Lore]");
    });
  });

  describe("SequentialItemsPhase", () => {
    it("imports a found item and records a missing one", async () => {
      const actor = createMockActor();
      const ctx = makeCtx([], {
        categorized: {
          ancestry: [slugged("ancestry", "unknown-ancestry")],
          heritage: [],
          background: [slugged("background", "scholar")],
          class: [],
          feat: [],
          equipment: [],
        },
      });

      await new SequentialItemsPhase().run(actor, ctx);

      expect(ctx.choiceSetHandler.presetChoiceSelections).toHaveBeenCalledTimes(1);
      expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
      expect(ctx.summary.itemsImported).toBe(1);
      expect(ctx.summary.itemsSkipped).toBe(1);
      expect(ctx.summary.unmapped).toEqual([{ slug: "unknown-ancestry", kind: "ancestry" }]);
      expect(ctx.summary.log).toContain("+ background: Scholar");
      expect(ctx.summary.log).toContain("- ancestry: unknown-ancestry (not found)");
    });
  });

  describe("ResolveGrantsPhase", () => {
    function grantor(rules, flags = {}) {
      return { id: "g1", _id: "g1", name: "Grantor", type: "feat", system: { rules }, flags };
    }

    it("does nothing when no item carries grant rules", async () => {
      const actor = createMockActor({ items: [{ id: "x", name: "Plain", type: "feat", system: {}, flags: {} }] });
      const ctx = makeCtx();

      await new ResolveGrantsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
      expect(ctx.selectionData.grantedFeatSlugs.size).toBe(0);
    });

    it("creates the granted item and records its slug", async () => {
      const actor = createMockActor({
        items: [grantor([{ key: "GrantItem", uuid: GRANT_UUID }])],
      });
      const ctx = makeCtx();

      await new ResolveGrantsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
      expect(ctx.selectionData.grantedFeatSlugs.has("granted-feat")).toBe(true);
      expect(ctx.grantResolvedSlugs.has("granted-feat")).toBe(true);
      expect(ctx.summary.itemsImported).toBe(1);
    });

    it("resolves template uuids through rules selections", async () => {
      const actor = createMockActor({
        items: [
          grantor([{ key: "GrantItem", uuid: "{item|flags.pf2e.rulesSelections.choice}" }], {
            pf2e: { rulesSelections: { choice: GRANT_UUID } },
          }),
        ],
      });
      const ctx = makeCtx();

      await new ResolveGrantsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
      expect(ctx.selectionData.grantedFeatSlugs.has("granted-feat")).toBe(true);
    });

    it("skips unresolvable template uuids", async () => {
      const actor = createMockActor({
        items: [grantor([{ key: "GrantItem", uuid: "{item|flags.pf2e.rulesSelections.missing}" }], { pf2e: {} })],
      });
      const ctx = makeCtx();

      await new ResolveGrantsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("skips non-compendium uuids and filtered rules", async () => {
      const actor = createMockActor({
        items: [
          grantor([
            { key: "GrantItem", uuid: "Item.local-id" },
            { key: "GrantItem", uuid: 42 },
            { key: "GrantItem", uuid: GRANT_UUID, predicate: { all: ["x"] } },
            { key: "SomethingElse", uuid: GRANT_UUID },
          ]),
        ],
      });
      const ctx = makeCtx();

      await new ResolveGrantsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("skips grants already fulfilled by source id", async () => {
      const actor = createMockActor({
        items: [
          grantor([{ key: "GrantItem", uuid: GRANT_UUID }]),
          { id: "e1", name: "Existing", type: "feat", system: {}, flags: { core: { sourceId: GRANT_UUID } } },
        ],
      });
      const ctx = makeCtx();

      await new ResolveGrantsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("skips grants already fulfilled by direct source id", async () => {
      const actor = createMockActor({
        items: [
          grantor([{ key: "GrantItem", uuid: GRANT_UUID }]),
          { id: "e2", name: "Existing", type: "feat", system: {}, flags: {}, sourceId: GRANT_UUID },
        ],
      });
      const ctx = makeCtx();

      await new ResolveGrantsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("skips grants fulfilled by a grantedBy compendium source", async () => {
      const actor = createMockActor({
        items: [
          grantor([{ key: "GrantItem", uuid: GRANT_UUID }]),
          {
            id: "e3",
            name: "Existing",
            type: "feat",
            system: {},
            flags: { pf2e: { grantedBy: { id: "g1" } } },
            _stats: { compendiumSource: GRANT_UUID },
          },
        ],
      });
      const ctx = makeCtx();

      await new ResolveGrantsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("proceeds when grantedBy points elsewhere", async () => {
      const actor = createMockActor({
        items: [
          grantor([{ key: "GrantItem", uuid: GRANT_UUID }]),
          {
            id: "e4",
            name: "Other",
            type: "feat",
            system: {},
            flags: { pf2e: { grantedBy: { id: "g9" } } },
            _stats: { compendiumSource: "Compendium.pf2e.feats-srd.Item.other" },
          },
        ],
      });
      const ctx = makeCtx();

      await new ResolveGrantsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
    });

    it("records nothing when the granted document is missing", async () => {
      const actor = createMockActor({
        items: [grantor([{ key: "GrantItem", uuid: "Compendium.pf2e.feats-srd.Item.missing" }])],
      });
      const ctx = makeCtx();

      await new ResolveGrantsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
      expect(ctx.selectionData.grantedFeatSlugs.size).toBe(0);
    });

    it("records nothing when the grant target has no slug", async () => {
      const actor = createMockActor({
        items: [grantor([{ key: "GrantItem", uuid: "Compendium.pf2e.feats-srd.Item.feat-noslug" }])],
      });
      const ctx = makeCtx();

      await new ResolveGrantsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
      expect(ctx.selectionData.grantedFeatSlugs.size).toBe(0);
    });

    it("records nothing when resolution throws", async () => {
      const actor = createMockActor({
        items: [grantor([{ key: "GrantItem", uuid: GRANT_UUID }])],
      });
      globalThis.fromUuid.mockRejectedValueOnce(new Error("broken"));
      const ctx = makeCtx();

      await new ResolveGrantsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });
  });

  describe("BatchItemsPhase", () => {
    it("skips already-granted slugs", async () => {
      const actor = createMockActor();
      const ctx = makeCtx([], {
        categorized: {
          ancestry: [],
          heritage: [],
          background: [],
          class: [],
          feat: [slugged("feat", "power-attack")],
          equipment: [],
        },
        selectionData: { grantedFeatSlugs: new Set(["power-attack"]), selectedFeats: [] },
      });

      await new BatchItemsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
      expect(ctx.summary.log).toContain("~ feat: power-attack (already granted)");
    });

    it("records unmapped slugs", async () => {
      const actor = createMockActor();
      const ctx = makeCtx([], {
        categorized: {
          ancestry: [],
          heritage: [],
          background: [],
          class: [],
          feat: [slugged("feat", "missing")],
          equipment: [],
        },
      });

      await new BatchItemsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
      expect(ctx.summary.unmapped).toEqual([{ slug: "missing", kind: "feat" }]);
      expect(ctx.summary.itemsSkipped).toBe(1);
    });

    it("applies feat slots from the source row", async () => {
      const actor = createMockActor();
      const eng = slugged("feat", "power-attack", { sourceRow: "class-feats-level-4" });
      const ctx = makeCtx([], {
        categorized: { ancestry: [], heritage: [], background: [], class: [], feat: [eng], equipment: [] },
      });

      await new BatchItemsPhase().run(actor, ctx);

      const data = actor.createEmbeddedDocuments.mock.calls[0][1][0];
      expect(data.system.location).toBe("class-4");
      expect(data.system.level.taken).toBe(4);
      expect(ctx.summary.itemsImported).toBe(1);
    });

    it("imports feats without slots and equipment untouched", async () => {
      const actor = createMockActor();
      const ctx = makeCtx([], {
        categorized: {
          ancestry: [],
          heritage: [],
          background: [],
          class: [],
          feat: [slugged("feat", "power-attack")],
          equipment: [slugged("equipment", "longsword")],
        },
      });

      await new BatchItemsPhase().run(actor, ctx);

      expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
      const batch = actor.createEmbeddedDocuments.mock.calls[0][1];
      expect(batch).toHaveLength(2);
      expect(ctx.summary.log).toContain("+ feat: Power Attack");
    });
  });

  describe("PostProcessingPhase", () => {
    function identityEngines() {
      return [
        customEngine("character_name", "Valeros"),
        customEngine("character_level", 5),
        customEngine("character_avatar", "avatars/valeros.webp"),
        customEngine("character_hit-points_current", 20),
        customEngine("character_hero-points", 2),
      ];
    }

    it("sets identity and session state", async () => {
      const actor = createMockActor();
      const ctx = makeCtx(identityEngines());

      await new PostProcessingPhase().run(actor, ctx);

      expect(actor.update).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Valeros",
          "system.details.level.value": 5,
          img: "avatars/valeros.webp",
          "prototypeToken.texture.src": "avatars/valeros.webp",
        })
      );
      expect(actor.update).toHaveBeenCalledWith(
        expect.objectContaining({
          "system.attributes.hp.value": 20,
          "system.attributes.hp.temp": 0,
          "system.resources.heroPoints.value": 2,
        })
      );
    });

    it("falls back to defaults without engines", async () => {
      const actor = createMockActor();
      const ctx = makeCtx([]);

      await new PostProcessingPhase().run(actor, ctx);

      expect(actor.update).toHaveBeenCalledTimes(1);
      expect(actor.update).toHaveBeenCalledWith(
        expect.objectContaining({
          "system.attributes.hp.value": 50,
          "system.attributes.hp.temp": 0,
          "system.resources.heroPoints.value": 1,
        })
      );
    });
  });

  describe("RemoveDuplicatesPhase", () => {
    function item(id, type, name, flags) {
      return { _id: id, id, type, name, flags, system: {} };
    }

    it("does nothing without duplicates", async () => {
      const actor = createMockActor({
        items: [item("1", "feat", "A", {}), item("2", "feat", "B", { core: { sourceId: "x" } })],
      });
      const ctx = makeCtx();

      await new RemoveDuplicatesPhase().run(actor, ctx);

      expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("prefers the native copy over an import-stamped duplicate", async () => {
      const actor = createMockActor({
        items: [item("1", "feat", "Same", {}), item("2", "feat", "Same", { [MODULE_ID]: { imported: true } })],
      });
      const ctx = makeCtx();

      await new RemoveDuplicatesPhase().run(actor, ctx);

      expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["2"]);
      expect(ctx.summary.log).toContain("- removed 1 duplicate item(s)");
    });

    it("prefers the native copy regardless of order", async () => {
      const actor = createMockActor({
        items: [item("1", "feat", "Same", { [MODULE_ID]: { imported: true } }), item("2", "feat", "Same", {})],
      });
      const ctx = makeCtx();

      await new RemoveDuplicatesPhase().run(actor, ctx);

      expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["1"]);
    });

    it("drops the later copy when both or neither are stamped", async () => {
      const bothStamped = createMockActor({
        items: [
          item("1", "feat", "Same", { [MODULE_ID]: { imported: true } }),
          item("2", "feat", "Same", { [MODULE_ID]: { imported: true } }),
        ],
      });
      await new RemoveDuplicatesPhase().run(bothStamped, makeCtx());
      expect(bothStamped.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["2"]);

      const neitherStamped = createMockActor({
        items: [item("1", "feat", "Same", {}), item("2", "feat", "Same", {})],
      });
      await new RemoveDuplicatesPhase().run(neitherStamped, makeCtx());
      expect(neitherStamped.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["2"]);
    });

    it("keys duplicates by compendium source id", async () => {
      const actor = createMockActor({
        items: [
          item("1", "feat", "Renamed", { core: { sourceId: "Compendium.x" } }),
          { _id: "2", id: "2", type: "feat", name: "Original", system: {} },
        ],
      });
      const ctx = makeCtx();

      await new RemoveDuplicatesPhase().run(actor, ctx);

      // Different keys (source id vs name) — no duplicate detected.
      expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
    });
  });
});
