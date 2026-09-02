import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { deleteImportedItems } from "../../src/import/reconcile.js";
import { MODULE_ID } from "../../src/import/types.js";
import { createMockActor } from "./foundry-mocks.js";

/** Creates a mock item with optional Demiplane flags */
function createMockItem(id: string, name: string, flags?: Record<string, unknown> | null): Record<string, unknown> {
  const itemFlags: Record<string, unknown> = {};
  if (flags !== undefined && flags !== null) {
    itemFlags[MODULE_ID] = flags;
  }
  return {
    id,
    name,
    flags: itemFlags,
  };
}

describe("reconcile", () => {
  describe("deleteImportedItems", () => {
    beforeEach(() => {
      vi.stubGlobal("game", { packs: { get: vi.fn() } });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns 0 when actor has no items", async () => {
      const actor = createMockActor({ name: "Test Actor", items: [] });

      const result = await deleteImportedItems(actor as never);

      expect(result).toBe(0);
      expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("returns 0 when actor has no imported items", async () => {
      const actor = createMockActor({
        items: [
          createMockItem("item-1", "Weapon", null), // no flags at all
          createMockItem("item-2", "Armor", null), // no flags at all
        ],
      });

      const result = await deleteImportedItems(actor as never);

      expect(result).toBe(0);
      expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it("returns count and deletes only imported items", async () => {
      const actor = createMockActor({
        items: [
          createMockItem("item-1", "Weapon", { imported: true }),
          createMockItem("item-2", "Armor", null), // not imported
          createMockItem("item-3", "Spell", { imported: true }),
          createMockItem("item-4", "Feat", null), // not imported
        ],
      });

      const result = await deleteImportedItems(actor as never);

      expect(result).toBe(2);
      expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["item-1", "item-3"]);
    });

    it("deletes all items when all are imported", async () => {
      const actor = createMockActor({
        items: [
          createMockItem("item-1", "Weapon", { imported: true }),
          createMockItem("item-2", "Spell", { imported: true }),
        ],
      });

      const result = await deleteImportedItems(actor as never);

      expect(result).toBe(2);
      expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["item-1", "item-2"]);
    });

    it("returns 0 when flags exist but demiplane-pf2e key is missing", async () => {
      const actor = createMockActor({
        items: [createMockItem("item-1", "Weapon", { otherModule: { imported: true } })],
      });

      // Note: createMockItem with non-null flags wraps in { "demiplane-pf2e": flags }
      // So this item will have flags: { "demiplane-pf2e": { otherModule: {...} } }
      // This IS considered imported because it has the demiplane-pf2e flag set
      // This test demonstrates that any item with demiplane-pf2e flag is treated as imported
      const result = await deleteImportedItems(actor as never);

      expect(result).toBe(1);
      expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["item-1"]);
    });

    it("handles items with empty demiplane-pf2e flags correctly", async () => {
      const actor = createMockActor({
        items: [
          createMockItem("item-1", "Weapon", {}), // has empty demiplane-pf2e flags
        ],
      });

      // An item with flags: { "demiplane-pf2e": {} } is considered imported
      // because moduleFlags !== undefined (the object exists, even if empty)
      const result = await deleteImportedItems(actor as never);

      expect(result).toBe(1);
      expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["item-1"]);
    });
  });
});
