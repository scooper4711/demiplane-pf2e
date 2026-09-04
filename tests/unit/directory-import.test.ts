import { describe, it, expect, beforeEach, vi } from "vitest";
import { installFoundryMocks, createMockActor } from "./foundry-mocks.js";
import {
  buildImportPromptContent,
  canImportCharacters,
  extractCharacterId,
  onImportButtonClick,
} from "../../src/directory-import.js";
import { DEMIPLANE_SHEET_BASE } from "../../src/config.js";
import { MODULE_ID } from "../../src/import/types.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const TOKEN = "token-abc";

function summary(overrides = {}) {
  return { itemsImported: 2, itemsSkipped: 0, unmapped: [], errors: [], log: [], ...overrides };
}

function linkedActor(id: string, characterId: string) {
  const actor = createMockActor({ name: `Actor ${id}` });
  actor.id = id;
  actor.flags[MODULE_ID] = { characterId };
  return actor;
}

describe("directory-import", () => {
  beforeEach(() => {
    installFoundryMocks();
    globalThis.foundry.applications.api.DialogV2 = { input: vi.fn() };
    globalThis.Actor.create = vi.fn();
  });

  describe("extractCharacterId", () => {
    it("extracts a bare UUID", () => {
      expect(extractCharacterId(UUID)).toBe(UUID);
    });

    it("extracts a UUID embedded in a Demiplane URL", () => {
      expect(extractCharacterId(`${DEMIPLANE_SHEET_BASE}/character/${UUID}?foo=bar`)).toBe(UUID);
    });

    it("is case-insensitive", () => {
      expect(extractCharacterId(UUID.toUpperCase())).toBe(UUID.toUpperCase());
    });

    it.each(["", "not-a-uuid", "123", "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"])("returns null for %j", (input) => {
      expect(extractCharacterId(input)).toBeNull();
    });
  });

  describe("buildImportPromptContent", () => {
    it("names the characterRef field and hints the sheet URL", () => {
      const content = buildImportPromptContent();
      expect(content).toContain('name="characterRef"');
      expect(content).toContain(DEMIPLANE_SHEET_BASE);
    });
  });

  describe("canImportCharacters", () => {
    it("allows GMs", () => {
      expect(canImportCharacters({ isGM: true })).toBe(true);
    });

    it("allows users with actor-create permission", () => {
      expect(canImportCharacters({ isGM: false, can: () => true })).toBe(true);
    });

    it.each([[null], [undefined], [{ isGM: false, can: () => false }]])("denies %j", (user) => {
      expect(canImportCharacters(user)).toBe(false);
    });
  });

  describe("onImportButtonClick", () => {
    function dialogInput(result) {
      globalThis.foundry.applications.api.DialogV2.input.mockResolvedValue(result);
    }

    it("returns silently when the dialog is cancelled", async () => {
      const importCharacter = vi.fn();
      dialogInput(null);

      await onImportButtonClick(importCharacter);

      expect(importCharacter).not.toHaveBeenCalled();
      expect(globalThis.Actor.create).not.toHaveBeenCalled();
    });

    it("reports an invalid character reference", async () => {
      const importCharacter = vi.fn();
      dialogInput({ characterRef: "  garbage  " });

      await onImportButtonClick(importCharacter);

      expect(globalThis.ui.notifications.error).toHaveBeenCalledWith("Invalid Demiplane character UUID or URL.");
      expect(importCharacter).not.toHaveBeenCalled();
    });

    it("refuses a character that is already linked elsewhere", async () => {
      const importCharacter = vi.fn();
      dialogInput({ characterRef: UUID });
      globalThis.game.actors.contents = [linkedActor("a1", UUID)];

      await onImportButtonClick(importCharacter);

      expect(globalThis.ui.notifications.error).toHaveBeenCalledWith(expect.stringContaining("already linked"));
      expect(importCharacter).not.toHaveBeenCalled();
    });

    it("reports a missing token", async () => {
      const importCharacter = vi.fn();
      dialogInput({ characterRef: UUID });
      globalThis.game.actors.contents = [];

      await onImportButtonClick(importCharacter);

      expect(globalThis.ui.notifications.error).toHaveBeenCalledWith(
        "No Demiplane token configured. Set it in module settings."
      );
    });

    it("returns silently when actor creation fails", async () => {
      const importCharacter = vi.fn();
      dialogInput({ characterRef: UUID });
      globalThis.game.actors.contents = [];
      await globalThis.game.settings.set(MODULE_ID, "demiplaneToken", TOKEN);
      globalThis.Actor.create.mockResolvedValue(null);

      await onImportButtonClick(importCharacter);

      expect(importCharacter).not.toHaveBeenCalled();
    });

    it("links the new actor and reports the import", async () => {
      const importCharacter = vi.fn().mockResolvedValue(summary({ itemsImported: 5 }));
      dialogInput({ characterRef: `  ${UUID}  ` });
      globalThis.game.actors.contents = [];
      await globalThis.game.settings.set(MODULE_ID, "demiplaneToken", TOKEN);
      const actor = createMockActor({ name: "Importing..." });
      globalThis.Actor.create.mockResolvedValue(actor);

      await onImportButtonClick(importCharacter);

      expect(globalThis.Actor.create).toHaveBeenCalledWith({ name: "Importing...", type: "character" });
      expect(actor.setFlag).toHaveBeenCalledWith(MODULE_ID, "characterId", UUID);
      expect(importCharacter).toHaveBeenCalledWith(actor, UUID, TOKEN);
      expect(globalThis.ui.notifications.info).toHaveBeenCalledWith(expect.stringContaining('Imported "Importing..."'));
    });

    it("reports import errors from the summary", async () => {
      const importCharacter = vi.fn().mockResolvedValue(summary({ errors: ["bad", "worse"] }));
      dialogInput({ characterRef: UUID });
      globalThis.game.actors.contents = [];
      await globalThis.game.settings.set(MODULE_ID, "demiplaneToken", TOKEN);
      const actor = createMockActor({ name: "Importing..." });
      globalThis.Actor.create.mockResolvedValue(actor);

      await onImportButtonClick(importCharacter);

      expect(globalThis.ui.notifications.error).toHaveBeenCalledWith("Import errors: bad; worse");
    });
  });
});
