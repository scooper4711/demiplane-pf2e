import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFoundryMocks, createMockActor, createMockPack } from "./foundry-mocks.js";
import { DemiplaneClient } from "@scooper4711/demiplane-api";
import { ImportOrchestrator } from "../../src/import/orchestrator.js";
import { ExportManager } from "../../src/export-manager.js";
import { syncClientToken } from "../../src/token-source.js";
import { MODULE_ID } from "../../src/import/types.js";

/**
 * Integration coverage for bearer-token (mis)management across the seam this
 * work converged: import and push share ONE real {@link DemiplaneClient} whose
 * credential is sourced from the `demiplaneToken` setting. Only the network is
 * stubbed — the real client, token normalization, orchestrator, and export
 * manager run — so these tests catch the actual failure the beta tester hit
 * (import works, push reports "no token") and the mistakes around it: an empty
 * setting at startup, a token added later, a cleared token, a pasted `Bearer `
 * prefix, and a scheme-only paste.
 */

const CHARACTER_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const JWT = "header.payload.signature";
const UPDATED = "2026-01-01T00:00:00.000Z";

/**
 * An actor linked to CHARACTER_ID. setFlag on the mock is a no-op, so the
 * characterId flag (which the push flow reads) is written to `flags` directly,
 * plus the lastUpdated baseline so a push doesn't trip the conflict check.
 */
function linkedActor() {
  const actor = createMockActor();
  actor.flags[MODULE_ID] = { characterId: CHARACTER_ID, lastUpdated: UPDATED };
  return actor;
}

/** The `demiplaneToken` setting value for the current test; mutated per scenario. */
let tokenSetting = "";

/**
 * A GraphQL fetch stub that dispatches on the operation in the request body and
 * records the `Authorization` header each call carried, so a test can assert
 * exactly what credential the real client put on the wire.
 */
function installGraphqlStub(): { authHeaders: Array<string | undefined> } {
  const authHeaders: Array<string | undefined> = [];

  const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    authHeaders.push(headers.Authorization);
    const body = String(init.body);

    const data = resolveGraphqlResponse(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data }),
      text: async () => JSON.stringify({ data }),
    } as unknown as Response;
  });

  (globalThis as unknown as Record<string, unknown>).fetch = fetchStub;
  return { authHeaders };
}

/**
 * Minimal happy-path payloads keyed on the GraphQL *operation name*. Matching
 * on the operation (not incidental words like "engines", which also appear in a
 * mutation's serialized variables) keeps the dispatch unambiguous.
 */
function resolveGraphqlResponse(body: string): Record<string, unknown> {
  const operation = readOperationName(body);
  switch (operation) {
    case "character_data":
      return { demiplane_user_character: [{ data: { engines: [], engineCacheIdsBySource: {} }, updated: UPDATED }] };
    case "character_updated":
      return { demiplane_user_character: [{ updated: UPDATED }] };
    case "updateLastAccess":
      return { slsUpdateUserLastAccessed: { success: true } };
    case "updateCharacterV2":
      return { updateCharacterV2: { message: null, result: null, success: true } };
    default:
      return {};
  }
}

/** Extracts the leading operation name from a GraphQL request body. */
function readOperationName(body: string): string {
  const query = (JSON.parse(body) as { query: string }).query;
  return /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "";
}

beforeEach(() => {
  installFoundryMocks({
    "pf2e.classes": createMockPack([]),
    "pf2e.ancestries": createMockPack([]),
    "pf2e.heritages": createMockPack([]),
    "pf2e.backgrounds": createMockPack([]),
    "pf2e.feats-srd": createMockPack([]),
    "pf2e.classfeatures": createMockPack([]),
    "pf2e.spells-srd": createMockPack([]),
    "pf2e.equipment-srd": createMockPack([]),
  });
  // Override the settings store so demiplaneToken and syncWriteLevel are driven
  // per scenario; everything else falls through to the installed mock.
  const realGet = globalThis.game.settings.get as (m: string, k: string) => unknown;
  globalThis.game.settings.get = vi.fn((moduleId: string, key: string) => {
    if (key === "demiplaneToken") return tokenSetting;
    if (key === "syncWriteLevel") return "session";
    return realGet(moduleId, key);
  });
  // The ChoiceSet patch target the import pipeline expects.
  (globalThis as unknown as { game: Record<string, unknown> }).game.pf2e = {
    RuleElements: { builtin: { ChoiceSet: { prototype: { preCreate: async () => {} } } } },
  };
  tokenSetting = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bearer token management — push auth gate (syncClientToken + real client)", () => {
  it("leaves a client unauthenticated when the setting is empty", () => {
    const client = new DemiplaneClient();
    expect(syncClientToken(client)).toBe(false);
    expect(client.isAuthenticated()).toBe(false);
  });

  it("authenticates a client that started empty once the token is set later", () => {
    // The exact beta-tester timing: startup with no token, GM pastes it after.
    const client = new DemiplaneClient();
    expect(syncClientToken(client)).toBe(false);

    tokenSetting = JWT;
    expect(syncClientToken(client)).toBe(true);
    expect(client.isAuthenticated()).toBe(true);
  });

  it("clears a previously-authenticated client when the token is removed", () => {
    tokenSetting = JWT;
    const client = new DemiplaneClient();
    expect(syncClientToken(client)).toBe(true);

    tokenSetting = "";
    expect(syncClientToken(client)).toBe(false);
    expect(client.isAuthenticated()).toBe(false);
  });

  it("strips a pasted Bearer prefix before storing the credential", async () => {
    const { authHeaders } = installGraphqlStub();
    tokenSetting = `Bearer ${JWT}`;
    const client = new DemiplaneClient();

    expect(syncClientToken(client)).toBe(true);
    await client.fetchCharacterUpdated(CHARACTER_ID);

    // The wire header carries the bare JWT, not the doubled "Bearer Bearer ...".
    expect(authHeaders.at(-1)).toBe(`Bearer ${JWT}`);
  });

  it("treats a scheme-only paste ('Bearer ') as no token", () => {
    tokenSetting = "Bearer ";
    const client = new DemiplaneClient();
    expect(syncClientToken(client)).toBe(false);
    expect(client.isAuthenticated()).toBe(false);
  });
});

describe("bearer token management — import and push share one client", () => {
  it("import fails cleanly when no token is passed and none is configured", async () => {
    installGraphqlStub();
    const client = new DemiplaneClient();
    const orchestrator = new ImportOrchestrator(client);
    const actor = createMockActor();

    const summary = await orchestrator.importCharacter(actor as never, CHARACTER_ID, {});

    expect(summary.errors).toContain("No authentication token provided");
    expect(client.isAuthenticated()).toBe(false);
  });

  it("import falls back to the configured token and authenticates the shared client", async () => {
    const { authHeaders } = installGraphqlStub();
    tokenSetting = `Bearer ${JWT}`;
    const client = new DemiplaneClient();
    const orchestrator = new ImportOrchestrator(client);
    const actor = createMockActor();

    const summary = await orchestrator.importCharacter(actor as never, CHARACTER_ID, {});

    expect(summary.errors).toHaveLength(0);
    // Import authenticated via the shared client with the normalized token.
    expect(client.isAuthenticated()).toBe(true);
    expect(authHeaders).toContain(`Bearer ${JWT}`);
  });

  it("a client import authenticated then pushes through the same credential — the divergence is gone", async () => {
    const { authHeaders } = installGraphqlStub();
    tokenSetting = JWT;
    const client = new DemiplaneClient();
    const orchestrator = new ImportOrchestrator(client);
    const exportManager = new ExportManager(client);
    const actor = linkedActor();

    // Import first (as a user would) through the shared client, then push a
    // change through the SAME client — the scenario that used to fail: import
    // authenticated its own request while push saw an unconfigured client.
    await orchestrator.importCharacter(actor as never, CHARACTER_ID, { token: JWT });
    expect(client.isAuthenticated()).toBe(true);

    exportManager.queueChange(actor as never, "character_hit-points_current", 25);
    const result = await exportManager.flush(actor as never);

    // Push reached the network and succeeded — crucially, it did NOT stop at the
    // token gate the way it did before import and push shared one client.
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    // Every request the shared client sent carried the same bare JWT.
    expect(authHeaders.length).toBeGreaterThan(0);
    expect(authHeaders.every((header) => header === `Bearer ${JWT}`)).toBe(true);
  });

  it("push reports the token error (not a silent success) when the setting is empty", async () => {
    installGraphqlStub();
    tokenSetting = "";
    const client = new DemiplaneClient();
    const exportManager = new ExportManager(client);
    const actor = linkedActor();

    exportManager.queueChange(actor as never, "character_hit-points_current", 25);
    const result = await exportManager.flush(actor as never);

    expect(result.success).toBe(false);
    expect(result.error).toContain("No Demiplane token");
  });
});
