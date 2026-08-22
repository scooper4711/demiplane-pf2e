import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { parseCharacterLinkInput } from "../../src/character-link-input.js";

/**
 * Generates a hex string of a fixed length using characters 0-9 and a-f.
 */
function hexSegment(length: number): fc.Arbitrary<string> {
  const hexChar = fc.constantFrom(
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
  );
  return fc
    .array(hexChar, { minLength: length, maxLength: length })
    .map((chars) => chars.join(""));
}

/**
 * Arbitrary that generates valid UUID strings in the format 8-4-4-4-12 hex.
 */
const uuidArbitrary = fc
  .tuple(
    hexSegment(8),
    hexSegment(4),
    hexSegment(4),
    hexSegment(4),
    hexSegment(12),
  )
  .map(([a, b, c, d, e]) => `${a}-${b}-${c}-${d}-${e}`);

const DEMIPLANE_URL_PREFIX =
  "https://app.demiplane.com/nexus/pathfinder2e/character-sheet/";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates: Requirements 12.3, 12.6
 */
describe("Feature: demiplane-foundry-sync, Property 11: Character link input round-trip for bare UUIDs", () => {
  it("returns valid with the UUID lowercased for any valid UUID", () => {
    fc.assert(
      fc.property(uuidArbitrary, (uuid) => {
        const result = parseCharacterLinkInput(uuid);
        expect(result).toEqual({ valid: true, uuid: uuid.toLowerCase() });
      }),
      { numRuns: 100 },
    );
  });

  it("returns valid with UUID unchanged when input has surrounding whitespace", () => {
    fc.assert(
      fc.property(
        uuidArbitrary,
        fc.nat({ max: 5 }),
        fc.nat({ max: 5 }),
        (uuid, leadSpaces, trailSpaces) => {
          const padded =
            " ".repeat(leadSpaces) + uuid + " ".repeat(trailSpaces);
          const result = parseCharacterLinkInput(padded);
          expect(result).toEqual({ valid: true, uuid: uuid.toLowerCase() });
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Validates: Requirements 12.3, 12.4
 */
describe("Feature: demiplane-foundry-sync, Property 12: Character link input extracts UUID from valid URL", () => {
  it("extracts the same UUID from a Demiplane URL as from a bare UUID", () => {
    fc.assert(
      fc.property(uuidArbitrary, (uuid) => {
        const url = `${DEMIPLANE_URL_PREFIX}${uuid}`;
        const fromUrl = parseCharacterLinkInput(url);
        const fromBare = parseCharacterLinkInput(uuid);

        expect(fromUrl.valid).toBe(true);
        expect(fromBare.valid).toBe(true);
        if (fromUrl.valid && fromBare.valid) {
          expect(fromUrl.uuid).toBe(fromBare.uuid);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("extracts the UUID segment unchanged (lowercased) from a valid URL", () => {
    fc.assert(
      fc.property(uuidArbitrary, (uuid) => {
        const url = `${DEMIPLANE_URL_PREFIX}${uuid}`;
        const result = parseCharacterLinkInput(url);

        expect(result).toEqual({ valid: true, uuid: uuid.toLowerCase() });
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Validates: Requirements 12.7
 */
describe("Feature: demiplane-foundry-sync, Property 13: Character link input rejects invalid formats", () => {
  it("rejects strings that are neither valid UUIDs nor Demiplane URLs", () => {
    const invalidArbitrary = fc.string().filter((s) => {
      const trimmed = s.trim();
      if (!trimmed) return false;
      if (UUID_REGEX.test(trimmed)) return false;
      if (
        trimmed.toLowerCase().startsWith(DEMIPLANE_URL_PREFIX.toLowerCase())
      ) {
        const candidate = trimmed.slice(DEMIPLANE_URL_PREFIX.length);
        if (UUID_REGEX.test(candidate)) return false;
      }
      return true;
    });

    fc.assert(
      fc.property(invalidArbitrary, (input) => {
        const result = parseCharacterLinkInput(input);
        expect(result.valid).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects UUIDs with non-hex characters", () => {
    const nonHexChar = fc.constantFrom("g", "h", "z", "G", "Z", "!", "@", " ");
    const corruptedUuidArbitrary = fc
      .tuple(uuidArbitrary, fc.nat({ max: 35 }), nonHexChar)
      .map(([uuid, pos, char]) => {
        const noDashes = uuid.replace(/-/g, "");
        const corrupted =
          noDashes.slice(0, pos) + char + noDashes.slice(pos + 1);
        return `${corrupted.slice(0, 8)}-${corrupted.slice(8, 12)}-${corrupted.slice(12, 16)}-${corrupted.slice(16, 20)}-${corrupted.slice(20, 32)}`;
      })
      .filter((s) => !UUID_REGEX.test(s));

    fc.assert(
      fc.property(corruptedUuidArbitrary, (input) => {
        const result = parseCharacterLinkInput(input);
        expect(result.valid).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
