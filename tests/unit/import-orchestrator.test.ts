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
});
