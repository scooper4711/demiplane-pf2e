import { describe, it, expect } from "vitest";
import { stampImported } from "../../src/import/types.js";

describe("stampImported", () => {
  it("adds imported flag to empty item", () => {
    const item = { name: "Test", type: "feat", system: {} };
    const result = stampImported(item);
    expect(result.flags).toEqual({
      "demiplane-pf2e": { imported: true },
    });
  });

  it("preserves existing flags", () => {
    const item = {
      name: "Test",
      type: "feat",
      system: {},
      flags: { pf2e: { rulesSelections: {} } },
    };
    const result = stampImported(item);
    expect((result.flags as Record<string, unknown>).pf2e).toEqual({
      rulesSelections: {},
    });
    expect(
      (result.flags as Record<string, Record<string, unknown>>)[
        "demiplane-pf2e"
      ].imported,
    ).toBe(true);
  });

  it("preserves existing module flags", () => {
    const item = {
      name: "Test",
      type: "feat",
      system: {},
      flags: { "demiplane-pf2e": { other: "value" } },
    };
    const result = stampImported(item);
    const moduleFlags = (
      result.flags as Record<string, Record<string, unknown>>
    )["demiplane-pf2e"];
    expect(moduleFlags.imported).toBe(true);
    expect(moduleFlags.other).toBe("value");
  });

  it("returns the same object reference", () => {
    const item = { name: "Test", type: "feat", system: {} };
    const result = stampImported(item);
    expect(result).toBe(item);
  });
});
