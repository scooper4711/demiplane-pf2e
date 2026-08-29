import { describe, it, expect, beforeEach } from "vitest";
import { isClientElectedWriter } from "../../src/sync-election.js";

interface TestUser {
  id: string;
  name: string;
  role: number;
  isGM: boolean;
  active: boolean;
}

function setupGame(me: TestUser, users: TestUser[]): void {
  (globalThis as unknown as { game: { user: TestUser; users: TestUser[] } }).game = { user: me, users };
  (globalThis as unknown as { CONST: unknown }).CONST = {
    USER_ROLES: { NONE: 0, PLAYER: 1, TRUSTED: 2, ASSISTANT: 3, GAMEMASTER: 4 },
    DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
  };
}

function actorWithOwners(...ownerIds: string[]): Actor {
  return {
    testUserPermission: (u: TestUser) => ownerIds.includes(u.id),
  } as unknown as Actor;
}

describe("isClientElectedWriter", () => {
  beforeEach(() => {
    // Reset so a prior test's game doesn't leak in.
    (globalThis as unknown as { game?: unknown }).game = undefined;
  });

  it("elects a GM over a non-GM owner", () => {
    const users: TestUser[] = [
      { id: "gm", name: "Gm", role: 4, isGM: true, active: true },
      { id: "me", name: "Me", role: 1, isGM: false, active: true },
    ];
    setupGame({ id: "me", name: "Me", role: 1, isGM: false, active: true }, users);
    expect(isClientElectedWriter(actorWithOwners("me"))).toBe(false);
  });

  it("elects the owner when no GM or assistant GM is online", () => {
    const users: TestUser[] = [{ id: "me", name: "Me", role: 1, isGM: false, active: true }];
    setupGame({ id: "me", name: "Me", role: 1, isGM: false, active: true }, users);
    expect(isClientElectedWriter(actorWithOwners("me"))).toBe(true);
  });

  it("elects an assistant GM over a non-GM owner", () => {
    const users: TestUser[] = [
      { id: "asst", name: "Asst", role: 3, isGM: true, active: true },
      { id: "owner", name: "Owner", role: 1, isGM: false, active: true },
    ];
    setupGame({ id: "asst", name: "Asst", role: 3, isGM: true, active: true }, users);
    expect(isClientElectedWriter(actorWithOwners("owner"))).toBe(true);
    setupGame({ id: "owner", name: "Owner", role: 1, isGM: false, active: true }, users);
    expect(isClientElectedWriter(actorWithOwners("owner"))).toBe(false);
  });

  it("breaks GM ties alphabetically by name (deterministic)", () => {
    const users: TestUser[] = [
      { id: "z", name: "Zgm", role: 4, isGM: true, active: true },
      { id: "a", name: "Agm", role: 4, isGM: true, active: true },
    ];
    setupGame({ id: "z", name: "Zgm", role: 4, isGM: true, active: true }, users);
    expect(isClientElectedWriter(actorWithOwners())).toBe(false);
    setupGame({ id: "a", name: "Agm", role: 4, isGM: true, active: true }, users);
    expect(isClientElectedWriter(actorWithOwners())).toBe(true);
  });

  it("pushes nothing when no eligible user is connected", () => {
    const users: TestUser[] = [{ id: "me", name: "Me", role: 1, isGM: false, active: true }];
    setupGame({ id: "me", name: "Me", role: 1, isGM: false, active: true }, users);
    // me is not an owner, and no GM/assistant online
    expect(isClientElectedWriter(actorWithOwners())).toBe(false);
  });
});
