import { describe, it, expect, vi } from "vitest";
import {
  getSanctification,
  recordSanctificationChoice,
  setSanctificationSelection,
  isSanctification,
  type SanctificationState,
} from "../../src/sanctification.js";

/** An actor whose flags actually persist, so the accessors can round-trip. */
function createFlagActor() {
  const flags: Record<string, Record<string, unknown>> = {};
  return {
    name: "Test Cleric",
    flags,
    getFlag: vi.fn((_scope: string, key: string) => flags["demiplane-pf2e"]?.[key]),
    setFlag: vi.fn(async (_scope: string, key: string, value: unknown) => {
      flags["demiplane-pf2e"] = { ...(flags["demiplane-pf2e"] ?? {}), [key]: value };
    }),
  };
}

describe("sanctification accessors", () => {
  it("isSanctification accepts only the three values", () => {
    expect(isSanctification("holy")).toBe(true);
    expect(isSanctification("unholy")).toBe(true);
    expect(isSanctification("none")).toBe(true);
    expect(isSanctification("neutral")).toBe(false);
    expect(isSanctification(undefined)).toBe(false);
  });

  it("returns undefined when no sanctification state is stored", () => {
    const actor = createFlagActor() as unknown as Actor;
    expect(getSanctification(actor)).toBeUndefined();
  });

  it("records an import choice with the default unacknowledged", async () => {
    const actor = createFlagActor() as unknown as Actor;
    await recordSanctificationChoice(actor, ["holy", "none"], "holy");

    const state = getSanctification(actor) as SanctificationState;
    expect(state.options).toEqual(["holy", "none"]);
    expect(state.selected).toBe("holy");
    expect(state.acknowledged).toBe(false);
  });

  it("preserves an acknowledged selection across a later import", async () => {
    const actor = createFlagActor() as unknown as Actor;
    await recordSanctificationChoice(actor, ["holy", "none"], "holy");
    await setSanctificationSelection(actor, "none"); // player chose None

    // A re-import re-runs recordSanctificationChoice with the affirmative default.
    await recordSanctificationChoice(actor, ["holy", "none"], "holy");

    const state = getSanctification(actor) as SanctificationState;
    expect(state.selected).toBe("none"); // player's choice preserved
    expect(state.acknowledged).toBe(true);
  });

  it("setSanctificationSelection marks the choice acknowledged", async () => {
    const actor = createFlagActor() as unknown as Actor;
    await recordSanctificationChoice(actor, ["holy", "unholy", "none"], "holy");
    await setSanctificationSelection(actor, "unholy");

    const state = getSanctification(actor) as SanctificationState;
    expect(state.selected).toBe("unholy");
    expect(state.acknowledged).toBe(true);
  });
});
