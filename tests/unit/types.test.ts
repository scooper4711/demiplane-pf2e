import { describe, it, expect } from "vitest";
import { stampImported, formatUnmapped } from "../../src/import/types.js";

describe("formatUnmapped", () => {
  it("formats a plain unmapped record", () => {
    expect(formatUnmapped({ slug: "religious-symbol-rm", kind: "equipment" })).toBe(
      'Could not import equipment "religious-symbol-rm": not found in compendium'
    );
  });

  it("appends the feat slot label when present", () => {
    expect(formatUnmapped({ slug: "inspirational-performance", kind: "feat", slot: "Skill feat (level 2)" })).toBe(
      'Could not import feat "inspirational-performance" (Skill feat (level 2)): not found in compendium'
    );
  });
});

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
