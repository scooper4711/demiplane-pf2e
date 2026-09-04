import { describe, it, expect, beforeEach, vi } from "vitest";
import { installFoundryMocks, createMockActor } from "./foundry-mocks.js";
import { registerModuleApi } from "../../src/module-api.js";
import { MODULE_ID } from "../../src/import/types.js";

const CHARACTER_ID = "char-123";
const TOKEN = "token-abc";

function linkedActor() {
  const actor = createMockActor({ name: "Valeros" });
  actor.flags[MODULE_ID] = { characterId: CHARACTER_ID };
  return actor;
}

describe("module-api", () => {
  let moduleObject;
  let importCharacter;
  let exportCharacter;

  beforeEach(() => {
    installFoundryMocks();
    moduleObject = {};
    globalThis.game.modules.get = () => moduleObject;
    importCharacter = vi.fn().mockResolvedValue({ itemsImported: 1 });
    exportCharacter = vi.fn().mockResolvedValue({ success: true });
    registerModuleApi(importCharacter, exportCharacter);
  });

  it("attaches importCharacter and exportNow to the module", () => {
    expect(typeof moduleObject.api.importCharacter).toBe("function");
    expect(typeof moduleObject.api.exportNow).toBe("function");
  });

  it("does nothing when the module entry is missing", () => {
    globalThis.game.modules.get = () => undefined;
    expect(() => registerModuleApi(importCharacter, exportCharacter)).not.toThrow();
  });

  it("rejects importCharacter for unlinked actors", async () => {
    const result = await moduleObject.api.importCharacter(createMockActor());

    expect(result).toBeNull();
    expect(globalThis.ui.notifications.error).toHaveBeenCalledWith("No Demiplane character linked to this actor.");
    expect(importCharacter).not.toHaveBeenCalled();
  });

  it("rejects importCharacter without a token", async () => {
    const result = await moduleObject.api.importCharacter(linkedActor(), {});

    expect(result).toBeNull();
    expect(globalThis.ui.notifications.error).toHaveBeenCalledWith(
      "No Demiplane token configured. Set it in module settings."
    );
    expect(importCharacter).not.toHaveBeenCalled();
  });

  it("delegates importCharacter with the stored token", async () => {
    const actor = linkedActor();
    await globalThis.game.settings.set(MODULE_ID, "demiplaneToken", TOKEN);

    await moduleObject.api.importCharacter(actor, {});

    expect(importCharacter).toHaveBeenCalledWith(actor, CHARACTER_ID, TOKEN);
  });

  it("prefers an explicitly passed token", async () => {
    const actor = linkedActor();

    await moduleObject.api.importCharacter(actor, { token: "explicit" });

    expect(importCharacter).toHaveBeenCalledWith(actor, CHARACTER_ID, "explicit");
  });

  it("delegates exportNow to the export flow", async () => {
    const actor = linkedActor();

    const result = await moduleObject.api.exportNow(actor);

    expect(exportCharacter).toHaveBeenCalledWith(actor);
    expect(result).toEqual({ success: true });
  });
});
