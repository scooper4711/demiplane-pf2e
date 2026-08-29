import { describe, it, expect } from "vitest";
import { computeEngineSig } from "../../src/engine-sig.js";

describe("computeEngineSig", () => {
  it("includes each engine's name and value", () => {
    const sig = computeEngineSig([
      { name: "character_hit-points_current", value: 30 },
      { name: "character_hero-points", value: 1 },
    ]);
    expect(sig).toContain("character_hit-points_current=30");
    expect(sig).toContain("character_hero-points=1");
  });

  it("is order-independent", () => {
    const a = computeEngineSig([
      { name: "b", value: 1 },
      { name: "a", value: 2 },
    ]);
    const b = computeEngineSig([
      { name: "a", value: 2 },
      { name: "b", value: 1 },
    ]);
    expect(a).toBe(b);
  });

  it("serializes object values with sorted keys", () => {
    const sig = computeEngineSig([{ name: "x", value: { b: 1, a: 2 } }]);
    expect(sig).toBe(`x=${JSON.stringify({ a: 2, b: 1 })}`);
  });

  it("treats null and undefined values identically", () => {
    expect(computeEngineSig([{ name: "n", value: null }])).toBe("n=null");
    expect(computeEngineSig([{ name: "u", value: undefined }])).toBe("u=null");
  });
});
