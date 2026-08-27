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

vi.stubGlobal("game", {
  settings: {
    get: (_moduleId: string, key: string) => {
      if (key === "autoSync") return autoSyncEnabled;
      return undefined;
    },
  },
});

import { HookManager, queueAllItemChanges, queueCombatResourceChanges } from "../../src/hook-manager.js";

const MODULE_ID = "demiplane-pf2e";
let autoSyncEnabled = true;

function createMockExportManager() {
  return {
    queueChange: vi.fn(),
    queueItemChange: vi.fn(),
  };
}

function createMockActor(type: string = "character", characterId: string | null = "char-uuid-1234") {
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
  data: Record<string, unknown> = {}
) {
  return {
    name,
    actor,
    ...data,
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
    autoSyncEnabled = true;
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

  describe("createItem hook", () => {
    it("logs pre-selected granted choices", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const item = createMockItem(createMockActor(), "Bloodline", {
        system: { rules: [{ key: "ChoiceSet", flag: "bloodline", selection: null }] },
        flags: { pf2e: { rulesSelections: { bloodline: "imperial" } } },
      });

      triggerHook("createItem", item);

      expect(logSpy).toHaveBeenCalledWith(
        `${MODULE_ID} | Item created on linked actor: Bloodline; granted choices: bloodline=imperial`
      );
      logSpy.mockRestore();
    });

    it("logs none when no granted choices were selected", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const item = createMockItem(createMockActor(), "Class Feature", {
        system: { rules: [{ key: "ChoiceSet", flag: "choice", selection: null }] },
      });

      triggerHook("createItem", item);

      expect(logSpy).toHaveBeenCalledWith(
        `${MODULE_ID} | Item created on linked actor: Class Feature; granted choices: choice=none`
      );
      logSpy.mockRestore();
    });
  });

  describe("updateActor hook — HP changes", () => {
    it("calls queueChange with character_hit-points_current when HP changes", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = { system: { attributes: { hp: { value: 25 } } } };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_hit-points_current", 25);
    });

    it("calls queueChange with character_hit-points_temp when temp HP changes", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = { system: { attributes: { hp: { temp: 10 } } } };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_hit-points_temp", 10);
    });

    it("reads dotted-path HP updates from Foundry change payloads", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = { "system.attributes.hp.value": 18 };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_hit-points_current", 18);
    });
  });

  describe("updateActor hook — hero points", () => {
    it("calls queueChange with character_hero-points when hero points change", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = { system: { resources: { heroPoints: { value: 3 } } } };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_hero-points", 3);
    });
  });

  describe("updateActor hook — currency changes", () => {
    it("does not queue currency changes via updateActor (currency uses updateItem)", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = {
        system: {
          currency: { gp: 50, sp: 20, cp: 100, pp: 5 },
        },
      };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).not.toHaveBeenCalled();
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
        },
      };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_hit-points_current", 20);
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_hit-points_temp", 5);
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_hero-points", 1);
      expect(exportManager.queueChange).toHaveBeenCalledTimes(3);
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
        },
      };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).not.toHaveBeenCalled();
    });
  });

  describe("updateActor hook — autoSync disabled", () => {
    it("does not queue changes when autoSync is off", () => {
      autoSyncEnabled = false;
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = {
        system: {
          attributes: { hp: { value: 20, temp: 5 } },
          resources: { heroPoints: { value: 1 } },
        },
      };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).not.toHaveBeenCalled();
    });
  });

  describe("updateItem hook — currency via treasure items", () => {
    it("queues gold when a gold-pieces item quantity changes", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const item = createMockItem(actor, "Gold Pieces", {
        system: { slug: "gold-pieces", quantity: 25 },
      });
      const changes = { system: { quantity: 25 } };

      triggerHook("updateItem", item, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_currency_gold", 25);
    });

    it("queues platinum when a platinum-pieces item quantity changes", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const item = createMockItem(actor, "Platinum Pieces", {
        system: { slug: "platinum-pieces", quantity: 10 },
      });
      const changes = { system: { quantity: 10 } };

      triggerHook("updateItem", item, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_currency_platinum", 10);
    });

    it("queues silver and copper from item updates", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();

      const silverItem = createMockItem(actor, "Silver Pieces", {
        system: { slug: "silver-pieces", quantity: 30 },
      });
      triggerHook("updateItem", silverItem, { system: { quantity: 30 } });

      const copperItem = createMockItem(actor, "Copper Pieces", {
        system: { slug: "copper-pieces", quantity: 40 },
      });
      triggerHook("updateItem", copperItem, { system: { quantity: 40 } });

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_currency_silver", 30);
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_currency_copper", 40);
    });

    it("queues non-currency items via queueItemChange", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const item = createMockItem(actor, "Gold Bar", {
        system: { slug: "gold-bar", quantity: 1 },
      });
      const changes = { system: { quantity: 1 } };

      triggerHook("updateItem", item, changes);

      expect(exportManager.queueChange).not.toHaveBeenCalled();
      expect(exportManager.queueItemChange).toHaveBeenCalledWith(actor, "gold-bar", undefined, "quantity", 1);
    });

    it("queues equipped state changes for equipment items", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const item = createMockItem(actor, "Longsword", {
        system: { slug: "longsword", equipped: { carryType: "worn" } },
      });
      const changes = { system: { equipped: { carryType: "worn" } } };

      triggerHook("updateItem", item, changes);

      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "longsword",
        undefined,
        "equipped",
        { carryType: "worn", handsHeld: undefined },
        undefined
      );
    });

    it("queues both quantity and equipped when both change", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const item = createMockItem(actor, "Longsword", {
        system: { slug: "longsword" },
      });
      const changes = { system: { quantity: 2, equipped: { carryType: "held" } } };

      triggerHook("updateItem", item, changes);

      expect(exportManager.queueItemChange).toHaveBeenCalledWith(actor, "longsword", undefined, "quantity", 2);
      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "longsword",
        undefined,
        "equipped",
        { carryType: "held", handsHeld: undefined },
        undefined
      );
    });

    it("queues armor equipped state from live item when change lacks carryType", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const item = createMockItem(actor, "Armored Coat", {
        type: "armor",
        system: {
          slug: "armored-coat",
          equipped: { carryType: "worn", handsHeld: 0, inSlot: true },
        },
      });
      const changes = { system: { equipped: { inSlot: false } } };

      triggerHook("updateItem", item, changes);

      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "armored-coat",
        undefined,
        "equipped",
        { carryType: "worn", handsHeld: 0, inSlot: true },
        "armor"
      );
    });

    it("does not queue when autoSync is disabled", () => {
      autoSyncEnabled = false;
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const item = createMockItem(actor, "Gold Pieces", {
        system: { slug: "gold-pieces", quantity: 15 },
      });
      const changes = { system: { quantity: 15 } };

      triggerHook("updateItem", item, changes);

      expect(exportManager.queueChange).not.toHaveBeenCalled();
    });

    it("does not queue for unlinked actors", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor("character", null);
      const item = createMockItem(actor, "Gold Pieces", {
        system: { slug: "gold-pieces", quantity: 15 },
      });
      const changes = { system: { quantity: 15 } };

      triggerHook("updateItem", item, changes);

      expect(exportManager.queueChange).not.toHaveBeenCalled();
    });
  });

  describe("queueCombatResourceChanges", () => {
    it("queues current HP, temp HP, and hero points from the actor", () => {
      const actor = {
        ...createMockActor(),
        system: {
          attributes: { hp: { value: 22, temp: 4 } },
          resources: { heroPoints: { value: 2 } },
        },
      };

      queueCombatResourceChanges(exportManager as never, actor as never);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_hit-points_current", 22);
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_hit-points_temp", 4);
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_hero-points", 2);
    });
  });

  describe("queueAllItemChanges", () => {
    it("queues quantity and equipped state for syncable items", () => {
      const actor = {
        ...createMockActor(),
        items: [
          {
            type: "weapon",
            name: "Longsword",
            system: { slug: "longsword", quantity: 1, equipped: { carryType: "held", handsHeld: 1 } },
            flags: {},
          },
          {
            type: "armor",
            name: "Breastplate",
            system: { slug: "breastplate", quantity: 1, equipped: { carryType: "worn", handsHeld: 0 } },
            flags: {},
          },
        ],
      };

      queueAllItemChanges(exportManager as never, actor as never);

      expect(exportManager.queueItemChange).toHaveBeenCalledWith(actor, "longsword", undefined, "quantity", 1);
      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "longsword",
        undefined,
        "equipped",
        { carryType: "held", handsHeld: 1 },
        "weapon"
      );
      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "breastplate",
        undefined,
        "equipped",
        { carryType: "worn", handsHeld: 0 },
        "armor"
      );
    });

    it("routes treasure items to currency engines", () => {
      const actor = {
        ...createMockActor(),
        items: [
          {
            type: "treasure",
            name: "Gold Pieces",
            system: { slug: "gold-pieces", quantity: 35, equipped: { carryType: "worn", handsHeld: 0 } },
            flags: {},
          },
        ],
      };

      queueAllItemChanges(exportManager as never, actor as never);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_currency_gold", 35);
    });

    it("uses the stored demiplaneSlug when present", () => {
      const actor = {
        ...createMockActor(),
        items: [
          {
            type: "weapon",
            name: "Longsword",
            system: { slug: "longsword", quantity: 1, equipped: { carryType: "held", handsHeld: 1 } },
            flags: { "demiplane-pf2e": { demiplaneSlug: "longsword-rm" } },
          },
        ],
      };

      queueAllItemChanges(exportManager as never, actor as never);

      expect(exportManager.queueItemChange).toHaveBeenCalledWith(actor, "longsword", "longsword-rm", "quantity", 1);
      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "longsword",
        "longsword-rm",
        "equipped",
        { carryType: "held", handsHeld: 1 },
        "weapon"
      );
    });
  });

  describe("unregister removes hooks", () => {
    it("calls Hooks.off for all registered hook IDs", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();
      manager.unregister();

      expect(Hooks.off).toHaveBeenCalledTimes(4);
      expect(Hooks.off).toHaveBeenCalledWith("updateActor", expect.any(Number));
      expect(Hooks.off).toHaveBeenCalledWith("updateItem", expect.any(Number));
      expect(Hooks.off).toHaveBeenCalledWith("createItem", expect.any(Number));
      expect(Hooks.off).toHaveBeenCalledWith("deleteItem", expect.any(Number));
    });
  });
});
