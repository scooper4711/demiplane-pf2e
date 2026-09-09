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

// Mirrors PF2e: CONFIG.PF2E.languages maps a slug to an i18n *key*, which
// game.i18n.localize resolves to the display name.
const LANGUAGE_LABELS: Record<string, string> = {
  common: "Common",
  draconic: "Draconic",
  dwarven: "Dwarven",
  halfling: "Halfling",
  undercommon: "Undercommon",
  sakvroth: "Sakvroth",
  varisian: "Varisian",
};

vi.stubGlobal("game", {
  settings: {
    get: (_moduleId: string, key: string) => {
      // `autoSyncEnabled` true = full write (delete tier); false = no writing.
      // Tests that need an intermediate tier set `writeLevel` directly.
      if (key === "syncWriteLevel") return writeLevel ?? (autoSyncEnabled ? "text-quantity-delete" : "none");
      if (key === "syncSoftDelete") return softDeleteEnabled;
      if (key === "debugImport") return debugEnabled;
      return undefined;
    },
  },
  i18n: {
    localize: (key: string) => {
      const slug = key.replace("PF2E.Actor.Creature.Language.", "");
      return LANGUAGE_LABELS[slug] ?? key;
    },
  },
});

vi.stubGlobal("CONFIG", {
  PF2E: {
    languages: Object.fromEntries(
      Object.keys(LANGUAGE_LABELS).map((slug) => [slug, `PF2E.Actor.Creature.Language.${slug}`])
    ),
  },
});

// The delete handler prompts before propagating; `confirmDelete` controls the answer.
let confirmDelete = true;
const dialogConfirm = vi.fn(() => Promise.resolve(confirmDelete ? "delete" : "keep"));
vi.stubGlobal("foundry", { applications: { api: { DialogV2: { wait: dialogConfirm } } } });

import {
  HookManager,
  queueAllItemChanges,
  queueAllDetailChanges,
  queueCombatResourceChanges,
} from "../../src/hook-manager.js";

const MODULE_ID = "demiplane-pf2e";
let autoSyncEnabled = true;
/** When set, overrides the autoSyncEnabled→tier mapping for intermediate-tier tests. */
let writeLevel: string | undefined;
let softDeleteEnabled = false;
let debugEnabled = true;

function createMockExportManager() {
  return {
    queueChange: vi.fn(),
    queueItemChange: vi.fn(),
    queueItemDelete: vi.fn(),
    exportCampaignNotes: vi.fn(),
  };
}

function createMockActor(
  type: string = "character",
  characterId: string | null = "char-uuid-1234",
  flags: Record<string, unknown> = {}
) {
  return {
    type,
    name: "Test Actor",
    system: {
      pfs: { playerNumber: null as number | null, characterNumber: null as number | null },
    },
    getFlag: (_moduleId: string, key: string) => {
      if (key === "characterId") return characterId ?? undefined;
      return flags[key];
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
    writeLevel = undefined;
    softDeleteEnabled = false;
    confirmDelete = true;
    debugEnabled = true;
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
        `${MODULE_ID} | [debug] Item created on linked actor: Bloodline; granted choices: bloodline=imperial`
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
        `${MODULE_ID} | [debug] Item created on linked actor: Class Feature; granted choices: choice=none`
      );
      logSpy.mockRestore();
    });
  });

  describe("deleteItem hook", () => {
    /** A Demiplane-controlled inventory item (imported flag set). */
    function importedItem(
      actor: ReturnType<typeof createMockActor>,
      name: string,
      data: { type: string; system: Record<string, unknown>; demiplaneSlug?: string }
    ) {
      const dpFlags: Record<string, unknown> = { imported: true };
      if (data.demiplaneSlug) dpFlags.demiplaneSlug = data.demiplaneSlug;
      return createMockItem(actor, name, {
        type: data.type,
        system: data.system,
        flags: { "demiplane-pf2e": dpFlags },
      });
    }

    /**
     * Let the async confirm-then-queue chain settle. The delete path awaits
     * across a couple of nested async hops (confirmAndQueueDelete →
     * confirmHardDelete → DialogV2.wait), so flush several microtasks.
     */
    const settle = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    it("prompts, then queues deletion using the item's demiplane slug when confirmed", async () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const item = importedItem(actor, "Armored Coat", {
        type: "armor",
        system: { slug: "armored-coat" },
        demiplaneSlug: "armored-coat",
      });

      triggerHook("deleteItem", item);
      await settle();

      expect(dialogConfirm).toHaveBeenCalledTimes(1);
      expect(exportManager.queueItemDelete).toHaveBeenCalledWith(actor, "armored-coat");
    });

    it("soft-deletes by pushing quantity 0 with no prompt when enabled", async () => {
      softDeleteEnabled = true;
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const item = importedItem(actor, "Armored Coat", {
        type: "armor",
        system: { slug: "armored-coat" },
        demiplaneSlug: "armored-coat-rm",
      });

      triggerHook("deleteItem", item);
      await settle();

      // Soft-delete is reversible (no Demiplane data loss), so it must not prompt.
      expect(dialogConfirm).not.toHaveBeenCalled();
      expect(exportManager.queueItemDelete).not.toHaveBeenCalled();
      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "armored-coat",
        "armored-coat-rm",
        "quantity",
        0,
        "armor"
      );
    });

    it("does NOT queue the deletion when the user declines the prompt", async () => {
      confirmDelete = false;
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      triggerHook(
        "deleteItem",
        importedItem(actor, "Armored Coat", { type: "armor", system: { slug: "armored-coat" } })
      );
      await settle();

      expect(dialogConfirm).toHaveBeenCalledTimes(1);
      expect(exportManager.queueItemDelete).not.toHaveBeenCalled();
    });

    it("falls back to the system slug when no demiplane slug is stored", async () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      triggerHook("deleteItem", importedItem(actor, "Longsword", { type: "weapon", system: { slug: "longsword" } }));
      await settle();

      expect(exportManager.queueItemDelete).toHaveBeenCalledWith(actor, "longsword");
    });

    it("queues deletion for equipment, ammunition, and treasure inventory types", async () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      triggerHook("deleteItem", importedItem(actor, "Arrows", { type: "ammo", system: { slug: "arrows" } }));
      triggerHook(
        "deleteItem",
        importedItem(actor, "Healing Potion", { type: "consumable", system: { slug: "healing-potion" } })
      );
      triggerHook("deleteItem", importedItem(actor, "Gold Bar", { type: "treasure", system: { slug: "gold-bar" } }));
      await settle();

      expect(exportManager.queueItemDelete).toHaveBeenCalledTimes(3);
    });

    it("does not prompt or queue for a homemade (non-Demiplane) item", async () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      // Inventory type + resolvable slug, but no imported flag: user's own item.
      triggerHook("deleteItem", createMockItem(actor, "Homebrew Blade", { type: "weapon", system: { slug: "sword" } }));
      await settle();

      expect(dialogConfirm).not.toHaveBeenCalled();
      expect(exportManager.queueItemDelete).not.toHaveBeenCalled();
    });

    it("does not queue deletion for non-inventory items like feats, classes, and backgrounds", async () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      triggerHook(
        "deleteItem",
        importedItem(actor, "Power Attack", { type: "feat", system: { slug: "power-attack" } })
      );
      triggerHook("deleteItem", importedItem(actor, "Fighter", { type: "class", system: { slug: "fighter" } }));
      triggerHook("deleteItem", importedItem(actor, "Farmhand", { type: "background", system: { slug: "farmhand" } }));
      triggerHook("deleteItem", importedItem(actor, "Dwarf", { type: "ancestry", system: { slug: "dwarf" } }));
      triggerHook("deleteItem", importedItem(actor, "Fireball", { type: "spell", system: { slug: "fireball" } }));
      await settle();

      expect(exportManager.queueItemDelete).not.toHaveBeenCalled();
    });

    it("does not queue deletion for an item without a slug", async () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      triggerHook("deleteItem", importedItem(actor, "Mystery Item", { type: "equipment", system: {} }));
      await settle();

      expect(exportManager.queueItemDelete).not.toHaveBeenCalled();
    });

    it("does not queue deletion for unlinked or non-character actors", async () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const unlinked = importedItem(createMockActor("character", null), "Sword", {
        type: "weapon",
        system: { slug: "sword" },
      });
      triggerHook("deleteItem", unlinked);

      const nonCharacter = importedItem(createMockActor("npc"), "Sword", {
        type: "weapon",
        system: { slug: "sword" },
      });
      triggerHook("deleteItem", nonCharacter);
      await settle();

      expect(exportManager.queueItemDelete).not.toHaveBeenCalled();
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

  describe("updateActor hook — focus points", () => {
    it("calls queueChange with character_focus_current when focus changes", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = { system: { resources: { focus: { value: 2 } } } };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_focus_current", 2);
    });
  });

  describe("updateActor hook — biography fields", () => {
    it("queues string biography fields", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = {
        system: {
          details: {
            gender: { value: "He/him" },
            age: { value: "28" },
            height: { value: "5' 8\"" },
            weight: { value: "190 lbs" },
            biography: {
              birthPlace: "Andoran",
              appearance: "Scruffy-looking",
              attitude: "Cocky",
              likes: "Beer",
              dislikes: "Being sober",
              allies: "Ezren, Seoni, Kyra",
              enemies: "Aspis Consortium",
              organizations: "Pathfinder Society",
              catchphrases: "Noble at heart",
              campaignNotes: "Notes about the ongoing campaign",
            },
          },
        },
      };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_appearance_gender", "He/him");
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_appearance_age", "28");
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_appearance_height", "5' 8\"");
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_appearance_weight", "190 lbs");
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_appearance_birthplace", "Andoran");
      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_appearance_appearance",
        "Scruffy-looking"
      );
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_personality_attitude", "Cocky");
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_personality_likes", "Beer");
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_personality_dislikes", "Being sober");
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_campaign_allies", "Ezren, Seoni, Kyra");
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_campaign_enemies", "Aspis Consortium");
      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_campaign_organizations",
        "Pathfinder Society"
      );
      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_personality_catchphrases",
        "Noble at heart"
      );
      expect(exportManager.exportCampaignNotes).toHaveBeenCalledWith(actor, "Notes about the ongoing campaign");
    });

    it("joins array fields with semicolons for edicts and anathema", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = {
        system: {
          details: {
            biography: {
              edicts: ["Be brave", "Help others", "Stay true"],
              anathema: ["leave friends in danger", "break promises"],
            },
          },
        },
      };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_personality_edicts",
        "Be brave; Help others; Stay true"
      );
      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_personality_anathema",
        "leave friends in danger; break promises"
      );
    });
  });

  describe("updateActor hook — organized play ID", () => {
    it("combines playerNumber and characterNumber into organized play ID", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      actor.system.pfs = { playerNumber: 123456, characterNumber: 2001 };
      const changes = {
        system: {
          pfs: { playerNumber: 123456 },
        },
      };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_organizedplayid", "123456-2001");
    });

    it("queues organized play ID when character number changes", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      actor.system.pfs = { playerNumber: 123456, characterNumber: 2001 };
      const changes = {
        system: {
          pfs: { characterNumber: 3002 },
        },
      };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_organizedplayid", "123456-3002");
    });

    it("does not queue when only one field is present in actor", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      actor.system.pfs = { playerNumber: 123456, characterNumber: null };
      const changes = {
        system: {
          pfs: { playerNumber: 123456 },
        },
      };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).not.toHaveBeenCalledWith(actor, "character_organizedplayid", expect.anything());
    });
  });

  describe("updateActor hook — campaign notes journal export", () => {
    it("calls exportCampaignNotes when campaignNotes changes", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = {
        system: {
          details: {
            biography: {
              campaignNotes: "The party rescued the village",
            },
          },
        },
      };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.exportCampaignNotes).toHaveBeenCalledWith(actor, "The party rescued the village");
    });

    it("does not call exportCampaignNotes when campaignNotes is not a string", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = {
        system: {
          details: {
            biography: {
              campaignNotes: 123,
            },
          },
        },
      };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.exportCampaignNotes).not.toHaveBeenCalled();
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
    it("does not call queueChange for null or undefined values", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = {
        system: {
          attributes: { hp: { value: undefined } },
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

    it("logs a calm note that nothing is pushed when autoSync is off", () => {
      autoSyncEnabled = false;
      const manager = new HookManager(exportManager as never);
      manager.register();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      triggerHook("updateActor", createMockActor(), { "system.attributes.hp.value": 20 });

      expect(logSpy).toHaveBeenCalledWith(
        `${MODULE_ID} | [debug] "Test Actor" changed (text), but the write level does not permit it — nothing pushed to Demiplane.`
      );
      logSpy.mockRestore();
    });

    it("does not log the auto-sync note for the actor's own in-flight sync", () => {
      // During an import/push the actor is marked with a sync token. The
      // structural sync-active guard must short-circuit *before* the auto-sync
      // note, so an import does not spam "nothing pushed" for its own writes.
      autoSyncEnabled = false;
      const manager = new HookManager(exportManager as never);
      manager.register();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const importing = createMockActor("character", "char-uuid-1234", { syncActiveTokens: ["local-token"] });
      triggerHook("updateActor", importing, { "system.attributes.hp.value": 20 });

      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("nothing pushed to Demiplane"));
      expect(exportManager.queueChange).not.toHaveBeenCalled();
      logSpy.mockRestore();
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
      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "gold-bar",
        undefined,
        "quantity",
        1,
        undefined,
        true
      );
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

      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "longsword",
        undefined,
        "quantity",
        2,
        undefined,
        true
      );
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

    /**
     * An actor whose `items.get` resolves two backpacks sharing a slug but
     * carrying distinct Demiplane engine ids — the case slug-based matching
     * couldn't tell apart.
     */
    function actorWithContainer() {
      const leftPouch = {
        id: "left-pouch-foundry-id",
        type: "backpack",
        system: { slug: "backpack" },
        flags: { "demiplane-pf2e": { demiplaneSlug: "backpack-rm", demiplaneEngineId: "left-engine-id" } },
      };
      const rightPouch = {
        id: "right-pouch-foundry-id",
        type: "backpack",
        system: { slug: "backpack" },
        flags: { "demiplane-pf2e": { demiplaneSlug: "backpack-rm", demiplaneEngineId: "right-engine-id" } },
      };
      const byId: Record<string, unknown> = {
        [leftPouch.id]: leftPouch,
        [rightPouch.id]: rightPouch,
      };
      return {
        ...createMockActor(),
        items: { get: (id: string) => byId[id] },
      };
    }

    it("queues a container move by the container's unique engine id, distinguishing same-slug containers", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = actorWithContainer();
      const item = createMockItem(actor, "Dagger", { type: "weapon", system: { slug: "dagger" } });

      // Moved into the RIGHT pouch (same slug as the left one).
      triggerHook("updateItem", item, { system: { containerId: "right-pouch-foundry-id" } });

      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "dagger",
        undefined,
        "container",
        { containerEngineId: "right-engine-id" },
        "weapon"
      );
    });

    it("queues a move to the top level as a null container", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = actorWithContainer();
      const item = createMockItem(actor, "Dagger", { type: "weapon", system: { slug: "dagger" } });

      // containerId cleared (moved out of a container).
      triggerHook("updateItem", item, { system: { containerId: null } });

      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "dagger",
        undefined,
        "container",
        { containerEngineId: null },
        "weapon"
      );
    });

    it("does not queue a container change when containerId is untouched", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = actorWithContainer();
      const item = createMockItem(actor, "Dagger", { type: "weapon", system: { slug: "dagger" } });

      triggerHook("updateItem", item, { system: { quantity: 2 } });

      const containerCalls = exportManager.queueItemChange.mock.calls.filter((c: unknown[]) => c[3] === "container");
      expect(containerCalls).toHaveLength(0);
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

  describe("updateItem hook — cast/expended spell slots", () => {
    /**
     * A spellcasting entry item carrying the import-stamped
     * `preparedSlotEngineIds` map plus live slot state, so a slots change can be
     * resolved back to the prepared engine whose `-is-cast` flag to toggle.
     */
    function spellcastingEntry(
      actor: ReturnType<typeof createMockActor>,
      preparedSlotEngineIds: Record<string, string[]>,
      slots: Record<string, { prepared?: Array<{ expended?: boolean }> }>
    ) {
      return createMockItem(actor, "Arcane Prepared Spells", {
        type: "spellcastingEntry",
        system: { slots },
        flags: { "demiplane-pf2e": { preparedSlotEngineIds } },
      });
    }

    it("queues a cast change when a prepared slot is expended", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const entry = spellcastingEntry(
        actor,
        { slot3: ["fireball-engine-id"] },
        { slot3: { prepared: [{ expended: true }] } }
      );
      const changes = { system: { slots: { slot3: { prepared: { 0: { expended: true } } } } } };

      triggerHook("updateItem", entry, changes);

      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "fireball-engine-id",
        "fireball-engine-id",
        "cast",
        { expended: true },
        "spell"
      );
    });

    it("queues a restore (expended false) when a prepared slot is un-cast", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const entry = spellcastingEntry(
        actor,
        { slot3: ["fireball-engine-id"] },
        { slot3: { prepared: [{ expended: false }] } }
      );
      const changes = { system: { slots: { slot3: { prepared: { 0: { expended: false } } } } } };

      triggerHook("updateItem", entry, changes);

      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "fireball-engine-id",
        "fireball-engine-id",
        "cast",
        { expended: false },
        "spell"
      );
    });

    it("resolves the correct engine by slot position when a rank has multiple prepared spells", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const entry = spellcastingEntry(
        actor,
        { slot3: ["engine-a", "engine-b"] },
        { slot3: { prepared: [{ expended: false }, { expended: true }] } }
      );
      const changes = { system: { slots: { slot3: { prepared: { 1: { expended: true } } } } } };

      triggerHook("updateItem", entry, changes);

      expect(exportManager.queueItemChange).toHaveBeenCalledTimes(1);
      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "engine-b",
        "engine-b",
        "cast",
        { expended: true },
        "spell"
      );
    });

    it("does not queue a cast change when the entry has no preparedSlotEngineIds flag", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const entry = createMockItem(actor, "Arcane Prepared Spells", {
        type: "spellcastingEntry",
        system: { slots: { slot3: { prepared: [{ expended: true }] } } },
      });
      const changes = { system: { slots: { slot3: { prepared: { 0: { expended: true } } } } } };

      triggerHook("updateItem", entry, changes);

      expect(exportManager.queueItemChange).not.toHaveBeenCalled();
    });

    it("does not queue a cast change when the update carries no slots change", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const entry = spellcastingEntry(actor, { slot3: ["fireball-engine-id"] }, { slot3: { prepared: [{}] } });
      const changes = { system: { name: "Renamed Entry" } };

      triggerHook("updateItem", entry, changes);

      expect(exportManager.queueItemChange).not.toHaveBeenCalled();
    });

    it("falls back to the live slot's expended state when the change omits it", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const entry = spellcastingEntry(
        actor,
        { slot3: ["fireball-engine-id"] },
        { slot3: { prepared: [{ expended: true }] } }
      );
      // The prepared entry changed (e.g. a sibling field) but `expended` is absent
      // from the diff; the handler should read the live value rather than assume false.
      const changes = { system: { slots: { slot3: { prepared: { 0: { id: "spell-x" } } } } } };

      triggerHook("updateItem", entry, changes);

      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "fireball-engine-id",
        "fireball-engine-id",
        "cast",
        { expended: true },
        "spell"
      );
    });
  });

  describe("updateItem hook — spontaneous spell slots", () => {
    /**
     * A spontaneous spellcasting entry: stamped with the feature slug (so the
     * remaining-slot engine name can be built) and live per-rank slot state.
     */
    function spontaneousEntry(
      actor: ReturnType<typeof createMockActor>,
      feature: string,
      slots: Record<string, { value?: number; max?: number }>
    ) {
      return createMockItem(actor, "Bard Spontaneous Spells", {
        type: "spellcastingEntry",
        system: { slots },
        flags: { "demiplane-pf2e": { spellFeature: feature } },
      });
    }

    it("queues the remaining count as the feature's rank-N current engine", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const entry = spontaneousEntry(actor, "bard-spellcasting-rm", { slot1: { value: 1, max: 2 } });
      const changes = { system: { slots: { slot1: { value: 1 } } } };

      triggerHook("updateItem", entry, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_spell-feature_bard-spellcasting-rm_spell-slots_rank-1_current",
        1
      );
    });

    it("does not queue a rank-0 (cantrip) change — cantrips are at-will", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const entry = spontaneousEntry(actor, "bard-spellcasting-rm", { slot0: { value: 5, max: 5 } });
      const changes = { system: { slots: { slot0: { value: 4 } } } };

      triggerHook("updateItem", entry, changes);

      expect(exportManager.queueChange).not.toHaveBeenCalled();
    });

    it("does not queue when the entry has no spellFeature flag", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const entry = createMockItem(actor, "Unstamped Entry", {
        type: "spellcastingEntry",
        system: { slots: { slot1: { value: 1, max: 2 } } },
      });
      const changes = { system: { slots: { slot1: { value: 1 } } } };

      triggerHook("updateItem", entry, changes);

      expect(exportManager.queueChange).not.toHaveBeenCalled();
    });

    it("falls back to the live slot value when the change omits it", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const entry = spontaneousEntry(actor, "bard-spellcasting-rm", { slot2: { value: 0, max: 3 } });
      // A sibling field of slot2 changed but `value` is absent from the diff.
      const changes = { system: { slots: { slot2: { max: 3 } } } };

      triggerHook("updateItem", entry, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_spell-feature_bard-spellcasting-rm_spell-slots_rank-2_current",
        0
      );
    });

    it("rides the text tier — queues even when quantity writes are off", () => {
      // Spell slots are the lowest (text) tier, unlike prepared cast tracking
      // which needs the quantity tier.
      writeLevel = "text";
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const entry = spontaneousEntry(actor, "bard-spellcasting-rm", { slot1: { value: 1, max: 2 } });
      const changes = { system: { slots: { slot1: { value: 1 } } } };

      triggerHook("updateItem", entry, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_spell-feature_bard-spellcasting-rm_spell-slots_rank-1_current",
        1
      );
    });
  });

  describe("queueCombatResourceChanges", () => {
    it("queues current HP, temp HP, hero points, and focus from the actor", () => {
      const actor = {
        ...createMockActor(),
        system: {
          attributes: { hp: { value: 22, temp: 4 } },
          resources: { heroPoints: { value: 2 }, focus: { value: 1 } },
        },
      };

      queueCombatResourceChanges(exportManager as never, actor as never);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_hit-points_current", 22);
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_hit-points_temp", 4);
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_hero-points", 2);
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_focus_current", 1);
    });

    it("queues nothing below the text tier", () => {
      writeLevel = "none";
      const actor = {
        ...createMockActor(),
        system: {
          attributes: { hp: { value: 22, temp: 4 } },
          resources: { heroPoints: { value: 2 } },
        },
      };

      queueCombatResourceChanges(exportManager as never, actor as never);

      expect(exportManager.queueChange).not.toHaveBeenCalled();
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

    it("queues the container engine id for a stowed item and a null container for a top-level item", () => {
      const backpack = {
        id: "backpack-foundry-id",
        type: "backpack",
        name: "Backpack",
        system: { slug: "backpack" },
        flags: { "demiplane-pf2e": { demiplaneSlug: "backpack-rm", demiplaneEngineId: "backpack-engine-id" } },
      };
      const stowed = {
        type: "weapon",
        name: "Asp Coil",
        system: { slug: "asp-coil", quantity: 1, containerId: "backpack-foundry-id" },
        flags: {},
      };
      const topLevel = {
        type: "weapon",
        name: "Arbalest",
        system: { slug: "arbalest", quantity: 1 },
        flags: {},
      };
      const items = [backpack, stowed, topLevel];
      const actor = {
        ...createMockActor(),
        items: Object.assign(items, {
          get: (id: string) => items.find((i) => (i as { id?: string }).id === id),
        }),
      };

      queueAllItemChanges(exportManager as never, actor as never);

      // Stowed item resolves to its container's unique engine id (not its slug).
      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "asp-coil",
        undefined,
        "container",
        { containerEngineId: "backpack-engine-id" },
        "weapon"
      );
      // Top-level item queues a null container so a re-sync CLEARS a stale
      // container link (an item pulled out of a bag in Foundry). This is the
      // regression: without it, a full push could add links but never remove them.
      expect(exportManager.queueItemChange).toHaveBeenCalledWith(
        actor,
        "arbalest",
        undefined,
        "container",
        { containerEngineId: null },
        "weapon"
      );
    });

    it("does not queue a container change for non-inventory items", () => {
      const items = [
        {
          type: "feat",
          name: "Power Attack",
          system: { slug: "power-attack" },
          flags: {},
        },
      ];
      const actor = {
        ...createMockActor(),
        items: Object.assign(items, { get: () => undefined }),
      };

      queueAllItemChanges(exportManager as never, actor as never);

      const containerCalls = exportManager.queueItemChange.mock.calls.filter((c: unknown[]) => c[3] === "container");
      expect(containerCalls).toHaveLength(0);
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

    it("at the text tier queues currency but not quantity or equipped state", () => {
      writeLevel = "text";
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
            type: "treasure",
            name: "Gold Pieces",
            system: { slug: "gold-pieces", quantity: 35, equipped: { carryType: "worn", handsHeld: 0 } },
            flags: {},
          },
        ],
      };

      queueAllItemChanges(exportManager as never, actor as never);

      // Currency is text-tier and still syncs.
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_currency_gold", 35);
      // Quantity and equipped state require the quantity tier.
      expect(exportManager.queueItemChange).not.toHaveBeenCalled();
    });

    it("queues nothing below the text tier", () => {
      writeLevel = "none";
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

      expect(exportManager.queueChange).not.toHaveBeenCalled();
      expect(exportManager.queueItemChange).not.toHaveBeenCalled();
    });

    it("re-syncs a spontaneous entry's remaining slots by rank (skipping cantrips)", () => {
      const entry = {
        type: "spellcastingEntry",
        name: "Bard Spontaneous Spells",
        system: { slots: { slot0: { value: 5, max: 5 }, slot1: { value: 1, max: 2 }, slot2: { value: 0, max: 1 } } },
        flags: { "demiplane-pf2e": { spellFeature: "bard-spellcasting-rm" } },
      };
      const actor = { ...createMockActor(), items: [entry] };

      queueAllItemChanges(exportManager as never, actor as never);

      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_spell-feature_bard-spellcasting-rm_spell-slots_rank-1_current",
        1
      );
      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character_spell-feature_bard-spellcasting-rm_spell-slots_rank-2_current",
        0
      );
      // Cantrips (rank 0) are at-will and never pushed.
      expect(exportManager.queueChange).not.toHaveBeenCalledWith(
        actor,
        "character_spell-feature_bard-spellcasting-rm_spell-slots_rank-0_current",
        expect.anything()
      );
    });
  });

  describe("queueAllDetailChanges", () => {
    function createDetailActor(overrides: Record<string, unknown> = {}) {
      return {
        ...createMockActor(),
        items: [] as unknown[],
        system: {
          pfs: { playerNumber: 123456, characterNumber: 2001 },
          details: {
            deity: { value: "" },
            languages: { value: ["common", "draconic"] },
            biography: { appearance: "Weathered", campaignNotes: "Session 1 notes" },
          },
          build: { languages: { granted: [{ slug: "common", source: "Human" }] } },
          ...overrides,
        },
      };
    }

    it("queues mapped detail fields, org play ID, and languages", () => {
      const actor = createDetailActor();

      queueAllDetailChanges(exportManager as never, actor as never);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_appearance_appearance", "Weathered");
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_organizedplayid", "123456-2001");
      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character-languages-user", "Draconic");
    });

    it("does not export campaign notes (a separate journal push, not an engine change)", () => {
      const actor = createDetailActor();

      queueAllDetailChanges(exportManager as never, actor as never);

      expect(exportManager.exportCampaignNotes).not.toHaveBeenCalled();
    });

    it("never queues deity: it is build-derived, not a pushable field", () => {
      const actor = createDetailActor();
      actor.items = [{ type: "deity", name: "Sarenrae" }];
      actor.system.details.deity.value = "Sarenrae";

      queueAllDetailChanges(exportManager as never, actor as never);

      expect(exportManager.queueChange).not.toHaveBeenCalledWith(
        actor,
        "character_personality_beliefs",
        expect.anything()
      );
    });

    it("does not queue organized play ID when only one PFS number is set", () => {
      const actor = createDetailActor({ pfs: { playerNumber: 123456, characterNumber: null } });

      queueAllDetailChanges(exportManager as never, actor as never);

      expect(exportManager.queueChange).not.toHaveBeenCalledWith(actor, "character_organizedplayid", expect.anything());
    });

    it("queues nothing below the text tier", () => {
      writeLevel = "none";
      const actor = createDetailActor();

      queueAllDetailChanges(exportManager as never, actor as never);

      expect(exportManager.queueChange).not.toHaveBeenCalled();
    });
  });

  describe("cross-client sync pause", () => {
    it("does not queue an actor push while another client is syncing the character", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();
      const actor = createMockActor("character", "char-uuid-1234", { syncActiveTokens: ["remote-token"] });

      triggerHook("updateActor", actor, { "system.attributes.hp.value": 25 });

      expect(exportManager.queueChange).not.toHaveBeenCalled();
    });

    it("still queues an actor push when no sync is in progress", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();
      const actor = createMockActor("character", "char-uuid-1234");

      triggerHook("updateActor", actor, { "system.attributes.hp.value": 25 });

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character_hit-points_current", 25);
    });

    it("does not queue an item push while another client is syncing the character", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();
      const actor = createMockActor("character", "char-uuid-1234", { syncActiveTokens: ["remote-token"] });
      const item = createMockItem(actor, "Healing Potion", {
        system: { slug: "healing-potion", quantity: 3 },
      });

      triggerHook("updateItem", item, { "system.quantity": 3 });

      expect(exportManager.queueItemChange).not.toHaveBeenCalled();
    });
  });

  describe("deity changes", () => {
    it("does not queue anything when a deity item is added", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const item = createMockItem(actor, "Sarenrae", { type: "deity", system: { slug: "sarenrae" } });

      triggerHook("createItem", item);

      expect(exportManager.queueChange).not.toHaveBeenCalledWith(
        actor,
        "character_personality_beliefs",
        expect.anything()
      );
    });

    it("does not queue anything when a deity item is removed", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const item = createMockItem(actor, "Sarenrae", { type: "deity", system: { slug: "sarenrae" } });

      triggerHook("deleteItem", item);

      expect(exportManager.queueChange).not.toHaveBeenCalledWith(
        actor,
        "character_personality_beliefs",
        expect.anything()
      );
      expect(exportManager.queueItemDelete).not.toHaveBeenCalled();
    });

    it("does not queue anything for a manual text edit to the deity field", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const changes = { system: { details: { deity: { value: "Iomedae" } } } };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).not.toHaveBeenCalledWith(
        actor,
        "character_personality_beliefs",
        expect.anything()
      );
    });

    it("does not queue a deity change for non-deity item creation", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const item = createMockItem(actor, "Longsword", { type: "weapon", system: { slug: "longsword" } });

      triggerHook("createItem", item);

      expect(exportManager.queueChange).not.toHaveBeenCalledWith(
        actor,
        "character_personality_beliefs",
        expect.anything()
      );
    });

    it("does not queue a deity change when autoSync is disabled", () => {
      autoSyncEnabled = false;
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor();
      const created = createMockItem(actor, "Sarenrae", { type: "deity", system: { slug: "sarenrae" } });
      triggerHook("createItem", created);

      const removed = createMockItem(actor, "Sarenrae", { type: "deity", system: { slug: "sarenrae" } });
      triggerHook("deleteItem", removed);

      expect(exportManager.queueChange).not.toHaveBeenCalled();
    });

    it("does not queue a deity change while another client is syncing", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createMockActor("character", "char-uuid-1234", { syncActiveTokens: ["remote-token"] });
      const item = createMockItem(actor, "Sarenrae", { type: "deity", system: { slug: "sarenrae" } });

      triggerHook("createItem", item);

      expect(exportManager.queueChange).not.toHaveBeenCalled();
    });
  });

  describe("updateActor hook — languages", () => {
    function createActorWithLanguages(
      value: string[],
      granted: { slug: string; source: string }[]
    ): ReturnType<typeof createMockActor> {
      const actor = createMockActor();
      actor.system = {
        ...actor.system,
        details: { languages: { value } },
        build: { languages: { granted } },
      } as never;
      return actor;
    }

    it("pushes only user-added languages, excluding ancestry grants, as display names", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      // Common is granted by ancestry; the rest are user-added.
      const actor = createActorWithLanguages(
        ["common", "draconic", "dwarven", "halfling", "undercommon", "varisian"],
        [{ slug: "common", source: "Human" }]
      );
      const changes = { system: { details: { languages: { value: actor.system.details.languages.value } } } };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(
        actor,
        "character-languages-user",
        "Draconic, Dwarven, Halfling, Undercommon, Varisian"
      );
    });

    it("pushes the corrected language after a user edit (Undercommon -> Sakvroth)", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createActorWithLanguages(["common", "sakvroth"], [{ slug: "common", source: "Human" }]);
      const changes = { "system.details.languages.value": ["common", "sakvroth"] };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character-languages-user", "Sakvroth");
    });

    it("pushes an empty string when only granted languages remain", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createActorWithLanguages(["common"], [{ slug: "common", source: "Human" }]);
      const changes = { system: { details: { languages: { value: ["common"] } } } };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character-languages-user", "");
    });

    it("title-cases languages the PF2e config does not know", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createActorWithLanguages(["common", "ancient-osiriani"], [{ slug: "common", source: "Human" }]);
      const changes = { system: { details: { languages: { value: ["common", "ancient-osiriani"] } } } };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).toHaveBeenCalledWith(actor, "character-languages-user", "Ancient Osiriani");
    });

    it("does not queue a language change when languages are not part of the update", () => {
      const manager = new HookManager(exportManager as never);
      manager.register();

      const actor = createActorWithLanguages(["common", "draconic"], [{ slug: "common", source: "Human" }]);
      const changes = { system: { attributes: { hp: { value: 10 } } } };

      triggerHook("updateActor", actor, changes);

      expect(exportManager.queueChange).not.toHaveBeenCalledWith(actor, "character-languages-user", expect.anything());
    });
  });
});
