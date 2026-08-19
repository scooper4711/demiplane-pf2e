import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@scooper4711/demiplane-api", () => ({
  isDemiplaneEngine: (e: { type: string }) => e.type === "DemiplaneEngine",
  findCustomEngineByName: (
    engines: { name: string; type: string; value?: unknown }[],
    storeName: string,
  ) => engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === storeName),
}));

// Mock Foundry globals
vi.stubGlobal("fromUuid", vi.fn());

import { ImportOrchestrator } from "../../src/import-orchestrator.js";

function createMockClient(overrides = {}) {
  return {
    fetchCharacterData: vi.fn().mockResolvedValue({
      engines: [
        {
          id: "eng-1",
          name: "character_name",
          value: "Valeros",
          type: "CustomDemiplaneEngine",
          saveType: "CharacterBuilder",
          storeType: "override",
          demiplaneEngineId: "de-1",
          args: {},
        },
        {
          id: "eng-2",
          name: "character_level",
          value: 5,
          type: "CustomDemiplaneEngine",
          saveType: "CharacterBuilder",
          storeType: "override",
          demiplaneEngineId: "de-2",
          args: {},
        },
        {
          id: "eng-3",
          demiplaneEngineId: "de-3",
          name: "tabula/class/fighter-rm.eng",
          type: "DemiplaneEngine",
          saveType: "CharacterBuilder",
          args: { slug: "fighter-rm" },
        },
        {
          id: "eng-4",
          demiplaneEngineId: "de-4",
          name: "tabula/ancestry/human-rm.eng",
          type: "DemiplaneEngine",
          saveType: "CharacterBuilder",
          args: { slug: "human-rm" },
        },
        {
          id: "eng-5",
          demiplaneEngineId: "de-5",
          name: "tabula/feat/power-attack.eng",
          type: "DemiplaneEngine",
          saveType: "CharacterBuilder",
          args: { slug: "power-attack" },
        },
      ],
    }),
    fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 3 }),
    ...overrides,
  };
}

function createMockSlugMapper(overrides = {}) {
  return {
    resolve: vi.fn().mockImplementation((slug: string) => {
      const resolved: Record<string, { uuid: string; packKey: string; slug: string }> = {
        "fighter-rm": { uuid: "Compendium.pf2e.classes.Item.fighter1", packKey: "pf2e.classes", slug: "fighter" },
        "human-rm": { uuid: "Compendium.pf2e.ancestries.Item.human1", packKey: "pf2e.ancestries", slug: "human" },
        "power-attack": { uuid: "Compendium.pf2e.feats-srd.Item.pa1", packKey: "pf2e.feats-srd", slug: "power-attack" },
      };
      return Promise.resolve(resolved[slug]);
    }),
    ...overrides,
  };
}

function createMockActor(existingImportedItems: { id: string; imported: boolean }[] = []) {
  const items = existingImportedItems.map((item) => ({
    id: item.id,
    getFlag: (_moduleId: string, key: string) => {
      if (key === "imported") return item.imported;
      return undefined;
    },
  }));

  return {
    items: {
      filter: (fn: (item: unknown) => boolean) => items.filter(fn),
      map: (fn: (item: unknown) => unknown) => items.map(fn),
    },
    update: vi.fn(),
    createEmbeddedDocuments: vi.fn().mockResolvedValue([]),
    deleteEmbeddedDocuments: vi.fn().mockResolvedValue([]),
    setFlag: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ImportOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("dry run mode", () => {
    it("returns summary with preview: true when dryRun is enabled", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      const summary = await orchestrator.importCharacter(
        actor as never,
        "char-uuid-123",
        { dryRun: true },
      );

      expect(summary.preview).toBe(true);
    });

    it("counts items that would be imported without writing", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      const summary = await orchestrator.importCharacter(
        actor as never,
        "char-uuid-123",
        { dryRun: true },
      );

      // 3 resolved slugs: fighter-rm (class), human-rm (ancestry), power-attack (feat)
      expect(summary.itemsImported).toBe(3);
      expect(summary.itemsSkipped).toBe(0);
    });

    it("does not call createEmbeddedDocuments in dry run mode", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123", {
        dryRun: true,
      });

      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("does not call deleteEmbeddedDocuments in dry run mode", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor([
        { id: "existing-1", imported: true },
        { id: "existing-2", imported: true },
      ]);
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123", {
        dryRun: true,
      });

      expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("does not call actor.update in dry run mode", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123", {
        dryRun: true,
      });

      expect(actor.update).not.toHaveBeenCalled();
    });

    it("does not call actor.setFlag in dry run mode", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123", {
        dryRun: true,
      });

      expect(actor.setFlag).not.toHaveBeenCalled();
    });

    it("does not fetch character version in dry run mode", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123", {
        dryRun: true,
      });

      expect(client.fetchCharacterVersion).not.toHaveBeenCalled();
    });

    it("still fetches character data in dry run mode", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123", {
        dryRun: true,
      });

      expect(client.fetchCharacterData).toHaveBeenCalledWith("char-uuid-123");
    });

    it("still resolves slugs in dry run mode", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123", {
        dryRun: true,
      });

      expect(slugMapper.resolve).toHaveBeenCalledWith("fighter-rm");
      expect(slugMapper.resolve).toHaveBeenCalledWith("human-rm");
      expect(slugMapper.resolve).toHaveBeenCalledWith("power-attack");
    });

    it("tracks skipped items for unresolved slugs in dry run mode", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper({
        resolve: vi.fn().mockImplementation((slug: string) => {
          if (slug === "power-attack") return Promise.resolve(undefined);
          const resolved: Record<string, { uuid: string; packKey: string; slug: string }> = {
            "fighter-rm": { uuid: "Compendium.pf2e.classes.Item.fighter1", packKey: "pf2e.classes", slug: "fighter" },
            "human-rm": { uuid: "Compendium.pf2e.ancestries.Item.human1", packKey: "pf2e.ancestries", slug: "human" },
          };
          return Promise.resolve(resolved[slug]);
        }),
      });
      const actor = createMockActor();
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const summary = await orchestrator.importCharacter(
        actor as never,
        "char-uuid-123",
        { dryRun: true },
      );
      warnSpy.mockRestore();

      expect(summary.itemsImported).toBe(2);
      expect(summary.itemsSkipped).toBe(1);
    });

    it("returns early with error when fetch fails in dry run mode", async () => {
      const client = createMockClient({
        fetchCharacterData: vi.fn().mockRejectedValue(new Error("Network error")),
      });
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      const summary = await orchestrator.importCharacter(
        actor as never,
        "char-uuid-123",
        { dryRun: true },
      );

      expect(summary.preview).toBe(true);
      expect(summary.errors).toContain(
        "Failed to fetch character data: Network error",
      );
      expect(summary.itemsImported).toBe(0);
    });

    it("computes reconciliation preview without deleting items", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor([
        { id: "stale-item-1", imported: true },
        { id: "stale-item-2", imported: true },
        { id: "non-imported", imported: false },
      ]);
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123", {
        dryRun: true,
      });

      // The actor items filter is called (reconciliation computed) but no deletion occurs
      expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
    });
  });

  describe("normal mode (non-dry-run)", () => {
    it("returns summary with preview: false by default", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();

      vi.mocked(globalThis.fromUuid).mockResolvedValue({
        toObject: () => ({ name: "Test Item", flags: {} }),
      });

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      const summary = await orchestrator.importCharacter(
        actor as never,
        "char-uuid-123",
      );

      expect(summary.preview).toBe(false);
    });

    it("calls createEmbeddedDocuments in normal mode", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();

      vi.mocked(globalThis.fromUuid).mockResolvedValue({
        toObject: () => ({ name: "Test Item", flags: {} }),
      });

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123");

      expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    });

    it("calls deleteEmbeddedDocuments for stale imported items", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor([
        { id: "stale-1", imported: true },
        { id: "stale-2", imported: true },
      ]);

      vi.mocked(globalThis.fromUuid).mockResolvedValue({
        toObject: () => ({ name: "Test Item", flags: {} }),
      });

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123");

      expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith(
        "Item",
        ["stale-1", "stale-2"],
      );
    });
  });

  describe("sequential ordering", () => {
    it("adds ancestry before heritage, background, and class in separate calls", async () => {
      const client = createMockClient({
        fetchCharacterData: vi.fn().mockResolvedValue({
          engines: [
            {
              id: "eng-ancestry",
              demiplaneEngineId: "de-ancestry",
              name: "tabula/ancestry/human-rm.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "human-rm" },
            },
            {
              id: "eng-heritage",
              demiplaneEngineId: "de-heritage",
              name: "tabula/heritage/versatile-human-rm.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "versatile-human-rm" },
            },
            {
              id: "eng-background",
              demiplaneEngineId: "de-background",
              name: "tabula/background/warrior-rm.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "warrior-rm" },
            },
            {
              id: "eng-class",
              demiplaneEngineId: "de-class",
              name: "tabula/class/fighter-rm.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "fighter-rm" },
            },
            {
              id: "eng-feat",
              demiplaneEngineId: "de-feat",
              name: "tabula/feat/power-attack.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "power-attack" },
            },
          ],
        }),
        fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 3 }),
      });

      const slugMapper = createMockSlugMapper({
        resolve: vi.fn().mockImplementation((slug: string) => {
          const resolved: Record<string, { uuid: string; packKey: string; slug: string }> = {
            "human-rm": { uuid: "Compendium.pf2e.ancestries.Item.human1", packKey: "pf2e.ancestries", slug: "human" },
            "versatile-human-rm": { uuid: "Compendium.pf2e.heritages.Item.vh1", packKey: "pf2e.heritages", slug: "versatile-human" },
            "warrior-rm": { uuid: "Compendium.pf2e.backgrounds.Item.warrior1", packKey: "pf2e.backgrounds", slug: "warrior" },
            "fighter-rm": { uuid: "Compendium.pf2e.classes.Item.fighter1", packKey: "pf2e.classes", slug: "fighter" },
            "power-attack": { uuid: "Compendium.pf2e.feats-srd.Item.pa1", packKey: "pf2e.feats-srd", slug: "power-attack" },
          };
          return Promise.resolve(resolved[slug]);
        }),
      });

      const actor = createMockActor();
      vi.mocked(globalThis.fromUuid).mockResolvedValue({
        toObject: () => ({ name: "Test Item", flags: {} }),
      });

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123");

      const calls = actor.createEmbeddedDocuments.mock.calls;

      // Should have 5 calls: ancestry, heritage, background, class (sequential), then feats (batch)
      expect(calls.length).toBe(5);

      // All calls should be for "Item" type
      for (const call of calls) {
        expect(call[0]).toBe("Item");
      }
    });

    it("issues sequential calls in order: ancestry, heritage, background, class", async () => {
      const callOrder: string[] = [];

      const client = createMockClient({
        fetchCharacterData: vi.fn().mockResolvedValue({
          engines: [
            {
              id: "eng-class",
              demiplaneEngineId: "de-class",
              name: "tabula/class/fighter-rm.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "fighter-rm" },
            },
            {
              id: "eng-ancestry",
              demiplaneEngineId: "de-ancestry",
              name: "tabula/ancestry/human-rm.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "human-rm" },
            },
            {
              id: "eng-heritage",
              demiplaneEngineId: "de-heritage",
              name: "tabula/heritage/versatile-human-rm.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "versatile-human-rm" },
            },
            {
              id: "eng-background",
              demiplaneEngineId: "de-background",
              name: "tabula/background/warrior-rm.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "warrior-rm" },
            },
          ],
        }),
        fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 1 }),
      });

      const slugMapper = createMockSlugMapper({
        resolve: vi.fn().mockImplementation((slug: string) => {
          const resolved: Record<string, { uuid: string; packKey: string; slug: string }> = {
            "human-rm": { uuid: "Compendium.pf2e.ancestries.Item.human1", packKey: "pf2e.ancestries", slug: "human" },
            "versatile-human-rm": { uuid: "Compendium.pf2e.heritages.Item.vh1", packKey: "pf2e.heritages", slug: "versatile-human" },
            "warrior-rm": { uuid: "Compendium.pf2e.backgrounds.Item.warrior1", packKey: "pf2e.backgrounds", slug: "warrior" },
            "fighter-rm": { uuid: "Compendium.pf2e.classes.Item.fighter1", packKey: "pf2e.classes", slug: "fighter" },
          };
          return Promise.resolve(resolved[slug]);
        }),
      });

      const actor = createMockActor();

      vi.mocked(globalThis.fromUuid).mockImplementation(async (uuid: string) => {
        const categoryMap: Record<string, string> = {
          "Compendium.pf2e.ancestries.Item.human1": "ancestry",
          "Compendium.pf2e.heritages.Item.vh1": "heritage",
          "Compendium.pf2e.backgrounds.Item.warrior1": "background",
          "Compendium.pf2e.classes.Item.fighter1": "class",
        };
        const category = categoryMap[uuid] ?? "unknown";
        return {
          toObject: () => ({ name: `${category}-item`, flags: {}, _category: category }),
        };
      });

      actor.createEmbeddedDocuments.mockImplementation(
        async (_type: string, items: { name: string }[]) => {
          for (const item of items) {
            callOrder.push(item.name);
          }
          return [];
        },
      );

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123");

      // Regardless of input order, sequential categories are added in this order
      expect(callOrder).toEqual([
        "ancestry-item",
        "heritage-item",
        "background-item",
        "class-item",
      ]);
    });

    it("adds batch items (feats, equipment) after sequential categories", async () => {
      const callOrder: string[] = [];

      const client = createMockClient({
        fetchCharacterData: vi.fn().mockResolvedValue({
          engines: [
            {
              id: "eng-feat",
              demiplaneEngineId: "de-feat",
              name: "tabula/feat/power-attack.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "power-attack" },
            },
            {
              id: "eng-class",
              demiplaneEngineId: "de-class",
              name: "tabula/class/fighter-rm.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "fighter-rm" },
            },
          ],
        }),
        fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 1 }),
      });

      const slugMapper = createMockSlugMapper({
        resolve: vi.fn().mockImplementation((slug: string) => {
          const resolved: Record<string, { uuid: string; packKey: string; slug: string }> = {
            "fighter-rm": { uuid: "Compendium.pf2e.classes.Item.fighter1", packKey: "pf2e.classes", slug: "fighter" },
            "power-attack": { uuid: "Compendium.pf2e.feats-srd.Item.pa1", packKey: "pf2e.feats-srd", slug: "power-attack" },
          };
          return Promise.resolve(resolved[slug]);
        }),
      });

      const actor = createMockActor();

      vi.mocked(globalThis.fromUuid).mockImplementation(async (uuid: string) => {
        const nameMap: Record<string, string> = {
          "Compendium.pf2e.classes.Item.fighter1": "Fighter",
          "Compendium.pf2e.feats-srd.Item.pa1": "Power Attack",
        };
        return {
          toObject: () => ({ name: nameMap[uuid] ?? "Unknown", flags: {} }),
        };
      });

      actor.createEmbeddedDocuments.mockImplementation(
        async (_type: string, items: { name: string }[]) => {
          for (const item of items) {
            callOrder.push(item.name);
          }
          return [];
        },
      );

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123");

      // Class (sequential) comes before Power Attack (batch feat)
      expect(callOrder.indexOf("Fighter")).toBeLessThan(
        callOrder.indexOf("Power Attack"),
      );
    });
  });

  describe("unresolved slug handling", () => {
    it("skips unresolved slugs and continues importing remaining items", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper({
        resolve: vi.fn().mockImplementation((slug: string) => {
          if (slug === "human-rm") return Promise.resolve(undefined);
          const resolved: Record<string, { uuid: string; packKey: string; slug: string }> = {
            "fighter-rm": { uuid: "Compendium.pf2e.classes.Item.fighter1", packKey: "pf2e.classes", slug: "fighter" },
            "power-attack": { uuid: "Compendium.pf2e.feats-srd.Item.pa1", packKey: "pf2e.feats-srd", slug: "power-attack" },
          };
          return Promise.resolve(resolved[slug]);
        }),
      });
      const actor = createMockActor();

      vi.mocked(globalThis.fromUuid).mockResolvedValue({
        toObject: () => ({ name: "Test Item", flags: {} }),
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      const summary = await orchestrator.importCharacter(
        actor as never,
        "char-uuid-123",
      );
      warnSpy.mockRestore();

      expect(summary.itemsSkipped).toBe(1);
      expect(summary.itemsImported).toBe(2);
      expect(actor.createEmbeddedDocuments).toHaveBeenCalled();
    });

    it("logs a warning when a slug cannot be resolved", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper({
        resolve: vi.fn().mockImplementation((slug: string) => {
          if (slug === "power-attack") return Promise.resolve(undefined);
          const resolved: Record<string, { uuid: string; packKey: string; slug: string }> = {
            "fighter-rm": { uuid: "Compendium.pf2e.classes.Item.fighter1", packKey: "pf2e.classes", slug: "fighter" },
            "human-rm": { uuid: "Compendium.pf2e.ancestries.Item.human1", packKey: "pf2e.ancestries", slug: "human" },
          };
          return Promise.resolve(resolved[slug]);
        }),
      });
      const actor = createMockActor();

      vi.mocked(globalThis.fromUuid).mockResolvedValue({
        toObject: () => ({ name: "Test Item", flags: {} }),
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("power-attack"),
      );
      warnSpy.mockRestore();
    });

    it("increments itemsSkipped for each unresolved slug", async () => {
      const client = createMockClient({
        fetchCharacterData: vi.fn().mockResolvedValue({
          engines: [
            {
              id: "eng-1",
              demiplaneEngineId: "de-1",
              name: "tabula/feat/unknown-feat-1.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "unknown-feat-1" },
            },
            {
              id: "eng-2",
              demiplaneEngineId: "de-2",
              name: "tabula/feat/unknown-feat-2.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "unknown-feat-2" },
            },
            {
              id: "eng-3",
              demiplaneEngineId: "de-3",
              name: "tabula/class/fighter-rm.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "fighter-rm" },
            },
          ],
        }),
        fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 1 }),
      });

      const slugMapper = createMockSlugMapper({
        resolve: vi.fn().mockImplementation((slug: string) => {
          if (slug === "fighter-rm") {
            return Promise.resolve({
              uuid: "Compendium.pf2e.classes.Item.fighter1",
              packKey: "pf2e.classes",
              slug: "fighter",
            });
          }
          return Promise.resolve(undefined);
        }),
      });

      const actor = createMockActor();

      vi.mocked(globalThis.fromUuid).mockResolvedValue({
        toObject: () => ({ name: "Test Item", flags: {} }),
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      const summary = await orchestrator.importCharacter(
        actor as never,
        "char-uuid-123",
      );
      warnSpy.mockRestore();

      expect(summary.itemsSkipped).toBe(2);
      expect(summary.itemsImported).toBe(1);
    });
  });

  describe("API failure abort", () => {
    it("aborts import when fetchCharacterData throws and preserves actor state", async () => {
      const client = createMockClient({
        fetchCharacterData: vi.fn().mockRejectedValue(new Error("API timeout")),
      });
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor([
        { id: "existing-1", imported: true },
      ]);
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      const summary = await orchestrator.importCharacter(
        actor as never,
        "char-uuid-123",
      );

      expect(summary.preview).toBe(false);
      expect(summary.errors).toContain(
        "Failed to fetch character data: API timeout",
      );
      expect(summary.itemsImported).toBe(0);
      expect(summary.itemsSkipped).toBe(0);
      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
      expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
      expect(actor.update).not.toHaveBeenCalled();
      expect(actor.setFlag).not.toHaveBeenCalled();
    });

    it("includes descriptive error message for network failures", async () => {
      const client = createMockClient({
        fetchCharacterData: vi.fn().mockRejectedValue(
          new Error("ECONNREFUSED: connection refused"),
        ),
      });
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      const summary = await orchestrator.importCharacter(
        actor as never,
        "char-uuid-123",
      );

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("ECONNREFUSED");
    });

    it("handles non-Error thrown values gracefully", async () => {
      const client = createMockClient({
        fetchCharacterData: vi.fn().mockRejectedValue("string error"),
      });
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();
      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      const summary = await orchestrator.importCharacter(
        actor as never,
        "char-uuid-123",
      );

      expect(summary.errors).toContain(
        "Failed to fetch character data: string error",
      );
    });
  });

  describe("session state application", () => {
    it("applies session state values via actor.update after items are added", async () => {
      const client = createMockClient({
        fetchCharacterData: vi.fn().mockResolvedValue({
          engines: [
            {
              id: "eng-hp",
              name: "character_hit-points_current",
              value: 45,
              type: "CustomDemiplaneEngine",
              saveType: "CharacterSheet",
              storeType: "override",
              demiplaneEngineId: "de-hp",
              args: {},
            },
            {
              id: "eng-hero",
              name: "character_hero-points",
              value: 2,
              type: "CustomDemiplaneEngine",
              saveType: "CharacterSheet",
              storeType: "override",
              demiplaneEngineId: "de-hero",
              args: {},
            },
            {
              id: "eng-gold",
              name: "character_currency_gold",
              value: 150,
              type: "CustomDemiplaneEngine",
              saveType: "CharacterSheet",
              storeType: "override",
              demiplaneEngineId: "de-gold",
              args: {},
            },
            {
              id: "eng-focus",
              name: "character_focus_current",
              value: 1,
              type: "CustomDemiplaneEngine",
              saveType: "CharacterSheet",
              storeType: "override",
              demiplaneEngineId: "de-focus",
              args: {},
            },
          ],
        }),
        fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 5 }),
      });

      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123");

      // actor.update should be called with session state data
      expect(actor.update).toHaveBeenCalledWith(
        expect.objectContaining({
          "system.attributes.hp.value": 45,
          "system.resources.heroPoints.value": 2,
          "system.currency.gp": 150,
          "system.resources.focus.value": 1,
        }),
      );
    });

    it("maps all currency types to correct actor paths", async () => {
      const client = createMockClient({
        fetchCharacterData: vi.fn().mockResolvedValue({
          engines: [
            {
              id: "eng-gold",
              name: "character_currency_gold",
              value: 100,
              type: "CustomDemiplaneEngine",
              saveType: "CharacterSheet",
              storeType: "override",
              demiplaneEngineId: "de-gold",
              args: {},
            },
            {
              id: "eng-silver",
              name: "character_currency_silver",
              value: 50,
              type: "CustomDemiplaneEngine",
              saveType: "CharacterSheet",
              storeType: "override",
              demiplaneEngineId: "de-silver",
              args: {},
            },
            {
              id: "eng-copper",
              name: "character_currency_copper",
              value: 25,
              type: "CustomDemiplaneEngine",
              saveType: "CharacterSheet",
              storeType: "override",
              demiplaneEngineId: "de-copper",
              args: {},
            },
            {
              id: "eng-platinum",
              name: "character_currency_platinum",
              value: 5,
              type: "CustomDemiplaneEngine",
              saveType: "CharacterSheet",
              storeType: "override",
              demiplaneEngineId: "de-platinum",
              args: {},
            },
          ],
        }),
        fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 2 }),
      });

      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123");

      expect(actor.update).toHaveBeenCalledWith(
        expect.objectContaining({
          "system.currency.gp": 100,
          "system.currency.sp": 50,
          "system.currency.cp": 25,
          "system.currency.pp": 5,
        }),
      );
    });

    it("does not call actor.update for session state when no session values exist", async () => {
      const client = createMockClient({
        fetchCharacterData: vi.fn().mockResolvedValue({
          engines: [
            {
              id: "eng-class",
              demiplaneEngineId: "de-class",
              name: "tabula/class/fighter-rm.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "fighter-rm" },
            },
          ],
        }),
        fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 1 }),
      });

      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();

      vi.mocked(globalThis.fromUuid).mockResolvedValue({
        toObject: () => ({ name: "Fighter", flags: {} }),
      });

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123");

      // actor.update is not called for session state (may still be called for name/level)
      const sessionStateCalls = actor.update.mock.calls.filter(
        (call: [Record<string, unknown>]) => {
          const keys = Object.keys(call[0]);
          return keys.some((k) => k.startsWith("system.attributes") || k.startsWith("system.currency") || k.startsWith("system.resources"));
        },
      );
      expect(sessionStateCalls).toHaveLength(0);
    });
  });

  describe("version flag storage", () => {
    it("stores lastKnownVersion via actor.setFlag after import", async () => {
      const client = createMockClient({
        fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 7 }),
      });
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();

      vi.mocked(globalThis.fromUuid).mockResolvedValue({
        toObject: () => ({ name: "Test Item", flags: {} }),
      });

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123");

      expect(actor.setFlag).toHaveBeenCalledWith(
        "foundry-demiplane-pf2e",
        "lastKnownVersion",
        7,
      );
    });

    it("stores lastSyncTimestamp via actor.setFlag after import", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();

      vi.mocked(globalThis.fromUuid).mockResolvedValue({
        toObject: () => ({ name: "Test Item", flags: {} }),
      });

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      const before = Date.now();
      await orchestrator.importCharacter(actor as never, "char-uuid-123");
      const after = Date.now();

      expect(actor.setFlag).toHaveBeenCalledWith(
        "foundry-demiplane-pf2e",
        "lastSyncTimestamp",
        expect.any(Number),
      );

      const timestampCall = actor.setFlag.mock.calls.find(
        (call: [string, string, unknown]) => call[1] === "lastSyncTimestamp",
      );
      const timestamp = timestampCall[2] as number;
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it("fetches character version for flag storage in normal mode", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();

      vi.mocked(globalThis.fromUuid).mockResolvedValue({
        toObject: () => ({ name: "Test Item", flags: {} }),
      });

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123");

      expect(client.fetchCharacterVersion).toHaveBeenCalledWith("char-uuid-123");
    });

    it("includes error in summary when version flag storage fails", async () => {
      const client = createMockClient({
        fetchCharacterVersion: vi.fn().mockRejectedValue(
          new Error("Version fetch failed"),
        ),
      });
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor();

      vi.mocked(globalThis.fromUuid).mockResolvedValue({
        toObject: () => ({ name: "Test Item", flags: {} }),
      });

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      const summary = await orchestrator.importCharacter(
        actor as never,
        "char-uuid-123",
      );

      expect(summary.errors).toContain(
        "Failed to store version in flags: Version fetch failed",
      );
    });
  });

  describe("reconciliation logic", () => {
    it("removes only items flagged as imported during reconciliation", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor([
        { id: "imported-1", imported: true },
        { id: "manual-1", imported: false },
        { id: "imported-2", imported: true },
      ]);

      vi.mocked(globalThis.fromUuid).mockResolvedValue({
        toObject: () => ({ name: "Test Item", flags: {} }),
      });

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123");

      expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith(
        "Item",
        ["imported-1", "imported-2"],
      );
    });

    it("does not call deleteEmbeddedDocuments when no previously imported items exist", async () => {
      const client = createMockClient();
      const slugMapper = createMockSlugMapper();
      const actor = createMockActor([
        { id: "manual-1", imported: false },
        { id: "manual-2", imported: false },
      ]);

      vi.mocked(globalThis.fromUuid).mockResolvedValue({
        toObject: () => ({ name: "Test Item", flags: {} }),
      });

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123");

      expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("marks newly imported items with the imported flag", async () => {
      const client = createMockClient({
        fetchCharacterData: vi.fn().mockResolvedValue({
          engines: [
            {
              id: "eng-class",
              demiplaneEngineId: "de-class",
              name: "tabula/class/fighter-rm.eng",
              type: "DemiplaneEngine",
              saveType: "CharacterBuilder",
              args: { slug: "fighter-rm" },
            },
          ],
        }),
        fetchCharacterVersion: vi.fn().mockResolvedValue({ version: 1 }),
      });

      const slugMapper = createMockSlugMapper({
        resolve: vi.fn().mockResolvedValue({
          uuid: "Compendium.pf2e.classes.Item.fighter1",
          packKey: "pf2e.classes",
          slug: "fighter",
        }),
      });

      const actor = createMockActor();

      vi.mocked(globalThis.fromUuid).mockResolvedValue({
        toObject: () => ({ name: "Fighter", flags: {} }),
      });

      const orchestrator = new ImportOrchestrator(
        client as never,
        slugMapper as never,
      );

      await orchestrator.importCharacter(actor as never, "char-uuid-123");

      const itemData = actor.createEmbeddedDocuments.mock.calls[0][1];
      expect(itemData[0].flags["foundry-demiplane-pf2e"]).toEqual({
        imported: true,
      });
    });
  });
});
