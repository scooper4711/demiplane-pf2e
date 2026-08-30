/**
 * Foundry VTT global mocks for unit testing.
 * Provides minimal implementations of game, Actor, fromUuid, etc.
 */
import { vi } from "vitest";

// Mock compendium pack
export function createMockPack(
  items: Array<{
    _id: string;
    name: string;
    system: { slug: string; level?: { value: number }; [key: string]: unknown };
    [key: string]: unknown;
  }> = []
) {
  return {
    getIndex: vi.fn().mockResolvedValue(items),
    getDocument: vi.fn().mockImplementation(async (id: string) => {
      const item = items.find((i) => i._id === id);
      return item ? { toObject: () => ({ ...item }) } : null;
    }),
  };
}

// Mock game.packs collection
export function createMockPacks(packMap: Record<string, ReturnType<typeof createMockPack>> = {}) {
  return {
    get: vi.fn().mockImplementation((key: string) => packMap[key] ?? null),
    filter: vi.fn().mockReturnValue(Object.values(packMap)),
  };
}

// Mock actor
export function createMockActor(initialData: { name?: string; items?: Array<Record<string, unknown>> } = {}) {
  const items: Array<Record<string, unknown>> = initialData.items ?? [];

  const actor = {
    name: initialData.name ?? "Test Actor",
    items: {
      filter: (fn: (i: Record<string, unknown>) => boolean) => items.filter(fn),
      find: (fn: (i: Record<string, unknown>) => boolean) => items.find(fn),
      get: (id: string) => items.find((i) => i.id === id),
      map: (fn: (i: Record<string, unknown>) => unknown) => items.map(fn),
      size: items.length,
      [Symbol.iterator]: () => items[Symbol.iterator](),
      get itemTypes() {
        const ofType = (type: string) => items.filter((i) => i.type === type);
        return { spellcastingEntry: ofType("spellcastingEntry"), spell: ofType("spell") };
      },
    },
    system: {
      details: {
        level: { value: 5 },
        languages: { value: ["common"] },
        gender: {},
        ethnicity: {},
        nationality: {},
        deity: {},
      },
      attributes: { hp: { value: 50, max: 50, temp: 0 } },
      resources: { heroPoints: { value: 1, max: 3 } },
      skills: {} as Record<string, { rank: number }>,
      abilities: {
        str: { mod: 0 },
        dex: { mod: 0 },
        con: { mod: 0 },
        int: { mod: 0 },
        wis: { mod: 0 },
        cha: { mod: 0 },
      },
      pfs: { playerNumber: null, characterNumber: null },
      build: { attributes: { boosts: {} } },
    },
    flags: {} as Record<string, Record<string, unknown>>,
    img: "",
    prototypeToken: { texture: { src: "" } },
    update: vi.fn().mockResolvedValue(undefined),
    setFlag: vi.fn().mockResolvedValue(undefined),
    getFlag: vi.fn().mockImplementation((_scope: string, key: string) => actor.flags[_scope]?.[key]),
    createEmbeddedDocuments: vi.fn().mockImplementation(async (_type: string, data: Array<Record<string, unknown>>) => {
      const created = data.map((d, i) => {
        const item: Record<string, unknown> = {
          ...d,
          id: `mock-id-${items.length + i}`,
          _id: `mock-id-${items.length + i}`,
          flags: d.flags ?? {},
          system: {
            ...(d.system as Record<string, unknown>),
            slug: (d.system as Record<string, unknown>)?.slug ?? d.name?.toString().toLowerCase().replace(/\s+/g, "-"),
          },
        };
        item.update = async (updateData: Record<string, unknown>) => {
          if (updateData.system) {
            item.system = {
              ...(item.system as Record<string, unknown>),
              ...(updateData.system as Record<string, unknown>),
            };
            const { system: _system, ...rest } = updateData;
            Object.assign(item, rest);
          } else {
            Object.assign(item, updateData);
          }
          return item;
        };
        return item;
      });
      items.push(...created);
      return created;
    }),
    deleteEmbeddedDocuments: vi.fn().mockImplementation(async (_type: string, ids: string[]) => {
      for (const id of ids) {
        const idx = items.findIndex((i) => i.id === id || i._id === id);
        if (idx >= 0) items.splice(idx, 1);
      }
    }),
  };

  return actor;
}

// Install globals
export function installFoundryMocks(packMap: Record<string, ReturnType<typeof createMockPack>> = {}) {
  const packs = createMockPacks(packMap);

  // A real (if simple) settings store so round-tripping persisted values can be
  // tested, rather than every read returning undefined.
  const settingStore = new Map<string, unknown>();

  (globalThis as unknown as Record<string, unknown>).game = {
    packs,
    actors: { get: vi.fn(), getName: vi.fn() },
    modules: { get: vi.fn() },
    settings: {
      get: vi.fn((_module: string, key: string) => settingStore.get(key)),
      set: vi.fn((_module: string, key: string, value: unknown) => {
        settingStore.set(key, value);
        return Promise.resolve(value);
      }),
      register: vi.fn(),
    },
  };

  (globalThis as unknown as Record<string, unknown>).fromUuid = vi.fn().mockImplementation(async (uuid: string) => {
    // Parse "Compendium.{packKey}.Item.{id}"
    const parts = uuid.split(".");
    if (parts.length >= 5) {
      const packKey = `${parts[1]}.${parts[2]}`;
      const id = parts[4];
      const pack = packs.get(packKey);
      if (pack) return pack.getDocument(id);
    }
    return null;
  });

  (globalThis as unknown as Record<string, unknown>).foundry = {
    utils: {
      /** Foundry IDs are 16-character alphanumeric strings. */
      randomID: () =>
        Array.from({ length: 16 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join(
          ""
        ),
    },
  };

  (globalThis as unknown as Record<string, unknown>).CONFIG = {
    PF2E: { languages: {} },
  };
  (globalThis as unknown as Record<string, unknown>).ui = {
    notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  (globalThis as unknown as Record<string, unknown>).Actor = {
    create: vi.fn(),
  };
  (globalThis as unknown as Record<string, unknown>).Dialog = {
    prompt: vi.fn(),
    confirm: vi.fn(),
  };
  (globalThis as unknown as Record<string, unknown>).Hooks = {
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  };

  return { packs };
}
