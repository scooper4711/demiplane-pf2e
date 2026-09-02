import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFoundryMocks } from "./foundry-mocks.js";
import { registerDirectoryIcon } from "../../src/directory-icon.js";

/** Returns the callback registered for a given Foundry hook, if any. */
function hookCallback(event: string): ((...args: unknown[]) => void) | undefined {
  const calls = (globalThis as unknown as { Hooks: { on: ReturnType<typeof vi.fn> } }).Hooks.on.mock.calls as Array<
    [string, (...args: unknown[]) => void]
  >;
  return calls.find((c) => c[0] === event)?.[1];
}

/**
 * Minimal fake of a sidebar entry `<li>`. `entry-name` is the growing element;
 * `children` collects appended icons so tests can assert on placement.
 */
interface FakeEntry {
  dataset: { entryId?: string };
  children: FakeIcon[];
  appended: FakeIcon[];
  querySelector: (selector: string) => unknown;
  append: (child: FakeIcon) => void;
}

interface FakeIcon {
  className: string;
  src: string;
  alt: string;
  title: string;
  loading: string;
}

function makeEntry(entryId: string | undefined): FakeEntry {
  const entry: FakeEntry = {
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
  return entry;
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

/** Registers a synced/unsynced actor in the mocked `game.actors`. */
function stubActor(id: string, characterId: string | undefined): void {
  const actors = (globalThis as unknown as { game: { actors: { get: ReturnType<typeof vi.fn> } } }).game.actors;
  actors.get.mockImplementation((wanted: string) =>
    wanted === id ? { getFlag: (_m: string, key: string) => (key === "characterId" ? characterId : undefined) } : null
  );
}

describe("directory icon", () => {
  beforeEach(() => {
    installFoundryMocks();
    (globalThis as unknown as { HTMLElement: typeof FakeHTMLElement }).HTMLElement = FakeHTMLElement;
    // A tiny `document` so buildIcon() can create an <img> in the Node env.
    (globalThis as unknown as { document: { createElement: () => FakeIcon } }).document = {
      createElement: () => ({ className: "", src: "", alt: "", title: "", loading: "" }),
    };
    // No live directory at registration time unless a test opts in.
    (globalThis as unknown as { ui: Record<string, unknown> }).ui = { notifications: {} };
  });

  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).document;
    delete (globalThis as unknown as Record<string, unknown>).HTMLElement;
  });

  it("registers render and activate hooks for the actor directory", () => {
    registerDirectoryIcon();
    expect(typeof hookCallback("renderActorDirectory")).toBe("function");
    expect(typeof hookCallback("activateActorDirectory")).toBe("function");
  });

  it("adds the icon to a synced actor's row via the render hook", () => {
    registerDirectoryIcon();
    stubActor("synced", "demiplane-uuid");
    const entry = makeEntry("synced");

    hookCallback("renderActorDirectory")?.(undefined, makeRoot([entry]));

    expect(entry.appended).toHaveLength(1);
    const icon = entry.appended[0];
    expect(icon.className).toBe("demiplane-directory-icon");
    expect(icon.src).toBe("modules/demiplane-pf2e/assets/demiplane.ico");
  });

  it("does not add the icon to an actor without a characterId flag", () => {
    registerDirectoryIcon();
    stubActor("plain", undefined);
    const entry = makeEntry("plain");

    hookCallback("renderActorDirectory")?.(undefined, makeRoot([entry]));

    expect(entry.appended).toHaveLength(0);
  });

  it("skips entries with no entry id", () => {
    registerDirectoryIcon();
    stubActor("synced", "demiplane-uuid");
    const entry = makeEntry(undefined);

    hookCallback("renderActorDirectory")?.(undefined, makeRoot([entry]));

    expect(entry.appended).toHaveLength(0);
  });

  it("skips actors that are not in the world collection", () => {
    registerDirectoryIcon();
    const actors = (globalThis as unknown as { game: { actors: { get: ReturnType<typeof vi.fn> } } }).game.actors;
    actors.get.mockReturnValue(null);
    const entry = makeEntry("missing");

    hookCallback("renderActorDirectory")?.(undefined, makeRoot([entry]));

    expect(entry.appended).toHaveLength(0);
  });

  it("does not add a second icon when the row is already decorated", () => {
    registerDirectoryIcon();
    stubActor("synced", "demiplane-uuid");
    const entry = makeEntry("synced");

    const render = hookCallback("renderActorDirectory");
    render?.(undefined, makeRoot([entry]));
    render?.(undefined, makeRoot([entry]));

    expect(entry.appended).toHaveLength(1);
  });

  it("ignores a render payload that is not an element", () => {
    registerDirectoryIcon();
    stubActor("synced", "demiplane-uuid");

    // Should neither throw nor decorate anything.
    expect(() => hookCallback("renderActorDirectory")?.(undefined, "not-an-element")).not.toThrow();
  });

  it("decorates the live directory through the activate hook", () => {
    stubActor("synced", "demiplane-uuid");
    const entry = makeEntry("synced");
    const app = { element: makeRoot([entry]) };

    registerDirectoryIcon();
    hookCallback("activateActorDirectory")?.(app);

    expect(entry.appended).toHaveLength(1);
  });

  it("decorates the already-rendered directory at registration time", () => {
    stubActor("synced", "demiplane-uuid");
    const entry = makeEntry("synced");
    (globalThis as unknown as { ui: { actors: { element: HTMLElement } } }).ui = {
      actors: { element: makeRoot([entry]) },
    };

    registerDirectoryIcon();

    expect(entry.appended).toHaveLength(1);
  });
});
