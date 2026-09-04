import { describe, it, expect, beforeEach, vi } from "vitest";
import { installFoundryMocks, createMockActor } from "./foundry-mocks.js";
import { buildUpdateFromDemiplaneOption, canOpenSyncDialog } from "../../src/actor-context-menu.js";
import { MODULE_ID } from "../../src/import/types.js";

const CHARACTER_ID = "char-123";
const TOKEN = "token-abc";

function summary(overrides = {}) {
  return { itemsImported: 4, itemsSkipped: 0, unmapped: [], errors: [], log: [], ...overrides };
}

function linkedActor(id: string) {
  const actor = createMockActor({ name: `Actor ${id}` });
  actor.id = id;
  actor.flags[MODULE_ID] = { characterId: CHARACTER_ID };
  actor.testUserPermission = () => false;
  return actor;
}

function entryElement(entryId: string) {
  return { dataset: { entryId } };
}

describe("actor-context-menu", () => {
  beforeEach(() => {
    installFoundryMocks();
    globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } };
    globalThis.foundry.applications.api.DialogV2 = { confirm: vi.fn() };
    globalThis.game.user = { isGM: true };
    globalThis.game.actors.contents = [];
    globalThis.game.actors.get = (id) => globalThis.game.actors.contents.find((a) => a.id === id);
  });

  describe("canOpenSyncDialog", () => {
    it("denies unlinked actors", () => {
      expect(canOpenSyncDialog(createMockActor(), { isGM: true })).toBe(false);
    });

    it("denies when there is no user", () => {
      expect(canOpenSyncDialog(linkedActor("a"), null)).toBe(false);
      expect(canOpenSyncDialog(linkedActor("a"), undefined)).toBe(false);
    });

    it("allows GMs", () => {
      expect(canOpenSyncDialog(linkedActor("a"), { isGM: true })).toBe(true);
    });

    it("allows owners without GM status", () => {
      const actor = linkedActor("a");
      actor.testUserPermission = () => true;
      expect(canOpenSyncDialog(actor, { isGM: false })).toBe(true);
    });

    it("denies non-owners without GM status", () => {
      expect(canOpenSyncDialog(linkedActor("a"), { isGM: false })).toBe(false);
    });
  });

  describe("update option", () => {
    it("builds the labelled option", () => {
      const option = buildUpdateFromDemiplaneOption(vi.fn());
      expect(option.label).toBe("Update from Demiplane");
      expect(option.icon).toContain("fa-sync");
    });

    it("hides the option for unknown actors", () => {
      const option = buildUpdateFromDemiplaneOption(vi.fn());
      expect(option.visible(entryElement("missing"))).toBe(false);
    });

    it("hides the option for unlinked actors", () => {
      globalThis.game.actors.contents = [createMockActor({ name: "Orphan" })];
      globalThis.game.actors.contents[0].id = "orphan";
      const option = buildUpdateFromDemiplaneOption(vi.fn());
      expect(option.visible(entryElement("orphan"))).toBe(false);
    });

    it("shows the option to the GM for linked actors", () => {
      globalThis.game.actors.contents = [linkedActor("a1")];
      const option = buildUpdateFromDemiplaneOption(vi.fn());
      expect(option.visible(entryElement("a1"))).toBe(true);
    });

    it("returns early on click when the actor is gone", async () => {
      const importCharacter = vi.fn();
      const option = buildUpdateFromDemiplaneOption(importCharacter);

      await option.onClick({}, entryElement("missing"));

      expect(importCharacter).not.toHaveBeenCalled();
      expect(globalThis.foundry.applications.api.DialogV2.confirm).not.toHaveBeenCalled();
    });

    it("reports a missing token on click", async () => {
      const importCharacter = vi.fn();
      globalThis.game.actors.contents = [linkedActor("a1")];
      const option = buildUpdateFromDemiplaneOption(importCharacter);

      await option.onClick({}, entryElement("a1"));

      expect(globalThis.ui.notifications.error).toHaveBeenCalledWith("No Demiplane token configured.");
      expect(importCharacter).not.toHaveBeenCalled();
    });

    it("returns early when the update is not confirmed", async () => {
      const importCharacter = vi.fn();
      globalThis.game.actors.contents = [linkedActor("a1")];
      await globalThis.game.settings.set(MODULE_ID, "demiplaneToken", TOKEN);
      globalThis.foundry.applications.api.DialogV2.confirm.mockResolvedValue(false);
      const option = buildUpdateFromDemiplaneOption(importCharacter);

      await option.onClick({}, entryElement("a1"));

      expect(importCharacter).not.toHaveBeenCalled();
    });

    it("re-imports with wipe and reports errors on confirm", async () => {
      const importCharacter = vi.fn().mockResolvedValue(summary({ errors: ["bad"] }));
      const actor = linkedActor("a1");
      globalThis.game.actors.contents = [actor];
      await globalThis.game.settings.set(MODULE_ID, "demiplaneToken", TOKEN);
      globalThis.foundry.applications.api.DialogV2.confirm.mockResolvedValue(true);
      const option = buildUpdateFromDemiplaneOption(importCharacter);

      await option.onClick({}, entryElement("a1"));

      expect(importCharacter).toHaveBeenCalledWith(actor, CHARACTER_ID, TOKEN, { wipe: true });
      expect(globalThis.ui.notifications.error).toHaveBeenCalledWith("Update errors: bad");
    });

    it("reports the item count on a clean update", async () => {
      const importCharacter = vi.fn().mockResolvedValue(summary({ itemsImported: 7 }));
      globalThis.game.actors.contents = [linkedActor("a1")];
      await globalThis.game.settings.set(MODULE_ID, "demiplaneToken", TOKEN);
      globalThis.foundry.applications.api.DialogV2.confirm.mockResolvedValue(true);
      const option = buildUpdateFromDemiplaneOption(importCharacter);

      await option.onClick({}, entryElement("a1"));

      expect(globalThis.ui.notifications.info).toHaveBeenCalledWith(expect.stringContaining("7 items"));
    });
  });
});
