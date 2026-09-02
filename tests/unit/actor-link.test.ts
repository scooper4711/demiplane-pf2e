import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getLinkedCharacterId, findActorLinkedTo, reconcileDuplicateLink } from "../../src/actor-link.js";

const MODULE_ID = "demiplane-pf2e";

/** Minimal actor stub whose characterId flag is backed by a plain field. */
function makeActor(id: string, characterId?: string) {
  const flags: Record<string, Record<string, unknown>> = {};
  if (characterId !== undefined) flags[MODULE_ID] = { characterId };
  return {
    id,
    name: `Actor ${id}`,
    getFlag: vi.fn((_scope: string, key: string) => flags[MODULE_ID]?.[key]),
    unsetFlag: vi.fn(async (_scope: string, key: string) => {
      if (flags[MODULE_ID]) delete flags[MODULE_ID][key];
    }),
  };
}

describe("actor-link", () => {
  let actors: ReturnType<typeof makeActor>[];

  beforeEach(() => {
    actors = [];
    vi.stubGlobal("ui", { notifications: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } });
    vi.stubGlobal("game", { actors: { contents: actors } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getLinkedCharacterId returns the flag value or undefined", () => {
    expect(getLinkedCharacterId(makeActor("a", "uuid-1") as never)).toBe("uuid-1");
    expect(getLinkedCharacterId(makeActor("b") as never)).toBeUndefined();
  });

  it("findActorLinkedTo finds another actor with the same characterId", () => {
    const a = makeActor("a", "uuid-1");
    const b = makeActor("b", "uuid-2");
    actors.push(a, b);
    expect(findActorLinkedTo("uuid-2", "a")?.id).toBe("b");
  });

  it("findActorLinkedTo excludes the actor being linked", () => {
    const a = makeActor("a", "uuid-1");
    actors.push(a);
    expect(findActorLinkedTo("uuid-1", "a")).toBeUndefined();
  });

  it("findActorLinkedTo returns undefined when no other actor holds the link", () => {
    actors.push(makeActor("a", "uuid-1"));
    expect(findActorLinkedTo("uuid-9", "a")).toBeUndefined();
  });

  it("reconcileDuplicateLink unlinks the arriving copy when a duplicate exists", async () => {
    const original = makeActor("a", "uuid-1");
    const copy = makeActor("b", "uuid-1");
    actors.push(original, copy);

    await reconcileDuplicateLink(copy as never);

    expect(copy.unsetFlag).toHaveBeenCalledWith(MODULE_ID, "characterId");
    expect(original.unsetFlag).not.toHaveBeenCalled();
    expect(ui.notifications.warn).toHaveBeenCalled();
  });

  it("reconcileDuplicateLink does nothing when the link is unique", async () => {
    const only = makeActor("a", "uuid-1");
    actors.push(only);

    await reconcileDuplicateLink(only as never);

    expect(only.unsetFlag).not.toHaveBeenCalled();
  });

  it("reconcileDuplicateLink does nothing for an unlinked actor", async () => {
    const unlinked = makeActor("a");
    actors.push(unlinked);

    await reconcileDuplicateLink(unlinked as never);

    expect(unlinked.unsetFlag).not.toHaveBeenCalled();
  });
});
