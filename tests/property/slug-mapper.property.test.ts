import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { transformSlug } from "../../src/slug-mapper.js";

/**
 * Validates: Requirements 8.2
 */
describe("Feature: demiplane-foundry-sync, Property 3: Slug transformation is idempotent on non-rm slugs", () => {
  it("returns the slug unchanged for any slug not ending with -rm", () => {
    const nonRmSlug = fc
      .string({ minLength: 1 })
      .filter((s) => !s.endsWith("-rm"));

    fc.assert(
      fc.property(nonRmSlug, (slug) => {
        expect(transformSlug(slug)).toBe(slug);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Validates: Requirements 8.1
 */
describe("Feature: demiplane-foundry-sync, Property 4: Slug transformation strips exactly trailing -rm", () => {
  it("strips exactly the last 3 characters for any slug ending with -rm", () => {
    const rmSlug = fc.string({ minLength: 1 }).map((s) => {
      // Ensure the base doesn't itself end with -rm to make the property clearer
      const base = s.endsWith("-rm") ? s + "x" : s;
      return base + "-rm";
    });

    fc.assert(
      fc.property(rmSlug, (slug) => {
        const result = transformSlug(slug);
        expect(result).toBe(slug.slice(0, -3));
        expect(result.endsWith("-rm")).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
