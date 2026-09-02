import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFoundryMocks } from "./foundry-mocks.js";
import { registerDirectoryIcon } from "../../src/directory-icon.js";
import { showDemiplaneInfoDialog } from "../../src/demiplane-info-button.js";

// The click handler delegates to the shared info dialog; mock it so tests can
// assert the delegation without exercising the real DialogV2 machinery.
vi.mock("../../src/demiplane-info-button.js", () => ({
  showDemiplaneInfoDialog: vi.fn().mockResolvedValue(undefined),
}));

const importCharacter = vi.fn();
const exportCharacter = vi.fn();

function register(): void {
  registerDirectoryIcon(importCharacter, exportCharacter);
}

/** Returns the callback registered for a given Foundry hook, if any. */
function hookCallback(event: string): ((...args: unknown[]) => void) | undefined {
  const calls = (globalThis as unknown as { Hooks: { on: ReturnType<typeof vi.fn> } }).Hooks.on.mock.calls as Array<
    [string, (...args: unknown[]) => void]
  >;
  return calls.find((c) => c[0] === event)?.[1];
}

interface FakeIcon {
  className: string;
  src: string;
  alt: string;
  title: string;
  loading: string;
  classList: { add: (c: string) => void; has: (c: string) => boolean };
  listeners: Record<string, (event: FakeEvent) => void>;
  addEventListener: (type: string, handler: (event: FakeEvent) => void) => void;
}

interface FakeEvent {
  preventDefault: () => void;
  stopPropagation: () => void;
}

function makeIcon(): FakeIcon {
  const classes = new Set<string>();
  const icon: FakeIcon = {
    className: "",
    src: "",
    alt: "",
    title: "",
    loading: "",
    classList: { add: (c: string) => void classes.add(c), has: (c: string) => classes.has(c) },
    listeners: {},
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
  };
  return icon;
}

/** Minimal fake of a sidebar entry `<li>` collecting appended icons. */
interface FakeEntry {
  dataset: { entryId?: string };
  children: FakeIcon[];
  appended: FakeIcon[];
  querySelector: (selector: string) => unknown;
  append: (child: FakeIcon) => void;
}

function makeEntry(entryId: string | undefined): FakeEntry {
  return {
    dataset: entryId === undefined ? {} : { entryId },
    children: [],
    appended: [],
    querySelector(selector: string) {
      if (selector.includes("demiplane-directory-icon")) {
        return this.children.find((c) => c.className.includes("demiplane-directory-icon")) ?? null;
      }
      return null;
    },
    append(child: FakeIcon) {
      this.children.push(child);
      this.appended.push(child);
    },
  };
}

/**
 * Stand-in for the DOM `HTMLElement` constructor. The Node test environment has
 * no DOM, but the production code guards element resolution with
 * `instanceof HTMLElement`, so a class the fakes can extend is enough.
 */
class FakeHTMLElement {}

/** A fake directory root whose `querySelectorAll` returns the given entries. */
function makeRoot(entries: FakeEntry[]): HTMLElement {
  const root = new FakeHTMLElement() as unknown as { querySelectorAll: () => FakeEntry[] };
  root.querySelectorAll = () => entries;
  return root as unknown as HTMLElement;
}

/** Registers a synced/unsynced actor whose owner permission is configurable. */
function stubActor(id: string, characterId: string | undefined, isOwner = true): void {
  const actors = (globalThis as unknown as { game: { actors: { get: ReturnType<typeof vi.fn> } } }).game.actors;
  actors.get.mockImplementation((wanted: string) =>
    wanted === id
      ? {
          getFlag: (_m: string, key: string) => (key === "characterId" ? characterId : undefined),
          testUserPermission: () => isOwner,
        }
      : null
  );
}

/** Sets the current user's GM status for the permission gate. */
function stubUser(isGM: boolean): void {
  (globalThis as unknown as { game: { user: unknown } }).game.user = { isGM };
}

describe("directory icon", () => {
  beforeEach(() => {
    installFoundryMocks();
    vi.mocked(showDemiplaneInfoDialog).mockClear();
    (globalThis as unknown as { HTMLElement: typeof FakeHTMLElement }).HTMLElement = FakeHTMLElement;
    (globalThis as unknown as { CONST: { DOCUMENT_OWNERSHIP_LEVELS: { OWNER: number } } }).CONST = {
      DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
    };
    (globalThis as unknown as { document: { createElement: () => FakeIcon } }).document = {
      createElement: () => makeIcon(),
    };
    (globalThis as unknown as { ui: Record<string, unknown> }).ui = { notifications: {} };
    stubUser(true);
  });

  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).document;
    delete (globalThis as unknown as Record<string, unknown>).HTMLElement;
    delete (globalThis as unknown as Record<string, unknown>).CONST;
  });

  it("registers render and activate hooks for the actor directory", () => {
    register();
    expect(typeof hookCallback("renderActorDirectory")).toBe("function");
    expect(typeof hookCallback("activateActorDirectory")).toBe("function");
  });

  it("adds the icon to a synced actor's row via the render hook", () => {
    register();
    stubActor("synced", "demiplane-uuid");
    const entry = makeEntry("synced");

    hookCallback("renderActorDirectory")?.(undefined, makeRoot([entry]));

    expect(entry.appended).toHaveLength(1);
    const icon = entry.appended[0];
    expect(icon.className).toBe("demiplane-directory-icon");
    expect(icon.src).toBe("modules/demiplane-pf2e/assets/demiplane.ico");
  });

  it("does not add the icon to an actor without a characterId flag", () => {
    register();
    stubActor("plain", undefined);
    const entry = makeEntry("plain");

    hookCallback("renderActorDirectory")?.(undefined, makeRoot([entry]));

    expect(entry.appended).toHaveLength(0);
  });

  it("skips entries with no entry id", () => {
    register();
    stubActor("synced", "demiplane-uuid");
    const entry = makeEntry(undefined);

    hookCallback("renderActorDirectory")?.(undefined, makeRoot([entry]));

    expect(entry.appended).toHaveLength(0);
  });

  it("skips actors that are not in the world collection", () => {
    register();
    const actors = (globalThis as unknown as { game: { actors: { get: ReturnType<typeof vi.fn> } } }).game.actors;
    actors.get.mockReturnValue(null);
    const entry = makeEntry("missing");

    hookCallback("renderActorDirectory")?.(undefined, makeRoot([entry]));

    expect(entry.appended).toHaveLength(0);
  });

  it("does not add a second icon when the row is already decorated", () => {
    register();
    stubActor("synced", "demiplane-uuid");
    const entry = makeEntry("synced");

    const render = hookCallback("renderActorDirectory");
    render?.(undefined, makeRoot([entry]));
    render?.(undefined, makeRoot([entry]));

    expect(entry.appended).toHaveLength(1);
  });

  it("ignores a render payload that is not an element", () => {
    register();
    stubActor("synced", "demiplane-uuid");

    expect(() => hookCallback("renderActorDirectory")?.(undefined, "not-an-element")).not.toThrow();
  });

  it("decorates the live directory through the activate hook", () => {
    stubActor("synced", "demiplane-uuid");
    const entry = makeEntry("synced");
    const app = { element: makeRoot([entry]) };

    register();
    hookCallback("activateActorDirectory")?.(app);

    expect(entry.appended).toHaveLength(1);
  });

  it("decorates the already-rendered directory at registration time", () => {
    stubActor("synced", "demiplane-uuid");
    const entry = makeEntry("synced");
    (globalThis as unknown as { ui: { actors: { element: HTMLElement } } }).ui = {
      actors: { element: makeRoot([entry]) },
    };

    register();

    expect(entry.appended).toHaveLength(1);
  });

  it("opens the Demiplane dialog when a GM clicks the icon", () => {
    register();
    stubUser(true);
    stubActor("synced", "demiplane-uuid");
    const entry = makeEntry("synced");

    hookCallback("renderActorDirectory")?.(undefined, makeRoot([entry]));
    const icon = entry.appended[0];
    expect(icon.classList.has("clickable")).toBe(true);

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    icon.listeners.click?.({ preventDefault, stopPropagation });

    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(showDemiplaneInfoDialog).toHaveBeenCalledWith(
      expect.anything(),
      "demiplane-uuid",
      importCharacter,
      exportCharacter
    );
  });

  it("opens the dialog for a non-GM owner", () => {
    register();
    stubUser(false);
    stubActor("synced", "demiplane-uuid", true);
    const entry = makeEntry("synced");

    hookCallback("renderActorDirectory")?.(undefined, makeRoot([entry]));
    entry.appended[0].listeners.click?.({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

    expect(showDemiplaneInfoDialog).toHaveBeenCalledTimes(1);
  });

  it("leaves the icon passive for a non-GM non-owner", () => {
    register();
    stubUser(false);
    stubActor("synced", "demiplane-uuid", false);
    const entry = makeEntry("synced");

    hookCallback("renderActorDirectory")?.(undefined, makeRoot([entry]));
    const icon = entry.appended[0];

    expect(icon.classList.has("clickable")).toBe(false);
    expect(icon.listeners.click).toBeUndefined();
  });

  it("leaves the icon passive when there is no current user", () => {
    register();
    (globalThis as unknown as { game: { user: unknown } }).game.user = null;
    stubActor("synced", "demiplane-uuid");
    const entry = makeEntry("synced");

    hookCallback("renderActorDirectory")?.(undefined, makeRoot([entry]));
    const icon = entry.appended[0];

    expect(icon.classList.has("clickable")).toBe(false);
    expect(icon.listeners.click).toBeUndefined();
  });
});
