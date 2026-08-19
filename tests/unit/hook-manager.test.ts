import { describe, it, expect, vi, beforeEach } from "vitest";

const hookRegistry: Record<string, ((...args: unknown[]) => void)[]> = {};
let nextHookId = 1;

vi.stubGlobal("Hooks", {
  on: (event: string, callback: (...args: unknown[]) => void) => {
    if (!hookRegistry[event]) {
      hookRegistry[event] = [];
    }
    hookRegistry[event].push(callback);
    return nextHookId++;
  },
  off: vi.fn(),
});

import { HookManager } from "../../src/hook-manager.js";

const MODULE_ID = "foundry-demiplane-pf2e";

function createMockExportManager() {
  return {
    queueChange: vi.fn(),
  };
}

function createMockActor(
  type: string = "character",
  characterId: string | null = "char-uuid-1234",
) {
  return {
    type,
    name: "Test Actor",
    getFlag: (_moduleId: string, key: string) => {
      if (key === "characterId") return characterId ?? undefined;
      return undefined;
    },
  };
}

function createMockItem(
  actor: ReturnType<typeof createMockActor> | null,
  name = "Healing Potion",
) {
  return {
    name,
    actor,
  };
}

function triggerHook(event: string, ...args: unknown[]): void {
  const callbacks = hookRegistry[event] ?? [];
  for (const callback of callbacks) {
    callback(...args);
  }
}

describe("HookManager", () => {
  let exportManager: ReturnType<typeof createMockExportManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(hookRegistry)) {
      delete hookRegistry[key];
    }
    nextHookId = 1;
    exportManager = createMockExportManager();
  });

  describe("register hooks", () => {
    it("registers updateActor, updateItem, createItem, deleteItem hooks", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      expect(hookRegistry["updateActor"]).toHaveLength(1);
      expect(hookRegistry["updateItem"]).toHaveLength(1);
      expect(hookRegistry["createItem"]).toHaveLength(1);
      expect(hookRegistry["deleteItem"]).toHaveLength(1);
    });
  });

  describe("updateActor hook — HP changes", () => {
    it("calls queueChange with character_hit-points_current when HP changes", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = { system: { attributes: { hp: { value: 25 } } } };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_hit-points_current",
        25,
      );
    });

    it("calls queueChange with character_hit-points_temp when temp HP changes", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = { system: { attributes: { hp: { temp: 10 } } } };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_hit-points_temp",
        10,
      );
    });
  });

  describe("updateActor hook — hero points and focus points", () => {
    it("calls queueChange with character_hero-points when hero points change", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = { system: { resources: { heroPoints: { value: 3 } } } };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_hero-points",
        3,
      );
    });

    it("calls queueChange with character_focus_current when focus points change", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = { system: { resources: { focus: { value: 2 } } } };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_focus_current",
        2,
      );
    });
  });

  describe("updateActor hook — currency changes", () => {
    it("calls queueChange with correct store names for currency changes", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = {
        system: {
          currency: { gp: 50, sp: 20, cp: 100, pp: 5 },
        },
      };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_currency_gold",
        50,
      );
      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_currency_silver",
        20,
      );
      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_currency_copper",
        100,
      );
      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_currency_platinum",
        5,
      );
    });
  });

  describe("updateActor hook — filtering non-character actors", () => {
    it("does not call queueChange for non-character actors", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor("npc");
      const changes = { system: { attributes: { hp: { value: 30 } } } };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).not.toHaveBeenCalled();
    });
  });

  describe("updateActor hook — filtering unlinked actors", () => {
    it("does not call queueChange for actors without a linked character UUID", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor("character", null);
      const changes = { system: { attributes: { hp: { value: 30 } } } };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).not.toHaveBeenCalled();
    });
  });

  describe("updateActor hook — multiple simultaneous changes", () => {
    it("handles multiple simultaneous field changes in one updateActor call", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = {
        system: {
          attributes: { hp: { value: 20, temp: 5 } },
          resources: { heroPoints: { value: 1 } },
          currency: { gp: 100 },
        },
      };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_hit-points_current",
        20,
      );
      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_hit-points_temp",
        5,
      );
      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_hero-points",
        1,
      );
      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_currency_gold",
        100,
      );
      expect(exportManager.queueChange).toHaveBeenCalledTimes(4);
    });
  });

  describe("updateActor hook — non-numeric values", () => {
    it("does not call queueChange for non-numeric values", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = {
        system: {
          attributes: { hp: { value: "not-a-number" } },
          currency: { gp: null },
        },
      };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).not.toHaveBeenCalled();
    });
  });

  describe("unregister removes hooks", () => {
    it("calls Hooks.off for all registered hook IDs", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();
      manager.unregister();

      expect(Hooks.off).toHaveBeenCalledTimes(4);
    });
  });
});
