import { describe, it, expect } from "vitest";
import { parseCharacterLinkInput } from "../../src/character-link-input.js";

describe("parseCharacterLinkInput", () => {
  it.each([
    ["a bare UUID", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"],
    ["uppercase UUID", "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"],
    [
      "a full Demiplane URL",
      "https://app.demiplane.com/nexus/pathfinder2e/character-sheet/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    ],
    ["whitespace-padded input", "  a1b2c3d4-e5f6-7890-abcd-ef1234567890  "],
  ])("accepts %s", (_label, input) => {
    const result = parseCharacterLinkInput(input);
    expect(result).toEqual({
      valid: true,
      uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
  });

  it.each([
    ["empty input", ""],
    ["whitespace-only input", "   "],
    ["invalid UUID format", "not-a-uuid"],
    [
      "a URL with wrong domain",
      "https://wrong.com/nexus/pathfinder2e/character-sheet/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    ],
  ])("rejects %s", (_label, input) => {
    const result = parseCharacterLinkInput(input);
    expect(result.valid).toBe(false);
  });

  it("rejects UUID with wrong segment lengths", () => {
    const result = parseCharacterLinkInput("a1b2c3d4-e5f6-7890-abcd-ef12345678");
    expect(result.valid).toBe(false);
  });

  it("rejects URL with trailing path segments after UUID", () => {
    const result = parseCharacterLinkInput(
      "https://app.demiplane.com/nexus/pathfinder2e/character-sheet/a1b2c3d4-e5f6-7890-abcd-ef1234567890/extra"
    );
    expect(result.valid).toBe(false);
  });

  it("returns error message describing expected formats on invalid input", () => {
    const result = parseCharacterLinkInput("garbage");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("xxxx");
      expect(result.error).toContain("https://app.demiplane.com/nexus/pathfinder2e/character-sheet/");
    }
  });
});
