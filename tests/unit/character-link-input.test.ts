import { describe, it, expect } from "vitest";
import { parseCharacterLinkInput } from "../../src/character-link-input.js";

describe("parseCharacterLinkInput", () => {
  it("accepts a valid bare UUID", () => {
    const result = parseCharacterLinkInput(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    expect(result).toEqual({
      valid: true,
      uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
  });

  it("accepts uppercase UUID and lowercases it", () => {
    const result = parseCharacterLinkInput(
      "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
    );
    expect(result).toEqual({
      valid: true,
      uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
  });

  it("accepts a full Demiplane URL", () => {
    const result = parseCharacterLinkInput(
      "https://app.demiplane.com/nexus/pathfinder2e/character-sheet/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    expect(result).toEqual({
      valid: true,
      uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
  });

  it("trims whitespace", () => {
    const result = parseCharacterLinkInput(
      "  a1b2c3d4-e5f6-7890-abcd-ef1234567890  ",
    );
    expect(result).toEqual({
      valid: true,
      uuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
  });

  it("rejects empty input", () => {
    const result = parseCharacterLinkInput("");
    expect(result.valid).toBe(false);
  });

  it("rejects whitespace-only input", () => {
    const result = parseCharacterLinkInput("   ");
    expect(result.valid).toBe(false);
  });

  it("rejects invalid UUID format", () => {
    const result = parseCharacterLinkInput("not-a-uuid");
    expect(result.valid).toBe(false);
  });

  it("rejects URL with wrong domain", () => {
    const result = parseCharacterLinkInput(
      "https://wrong.com/nexus/pathfinder2e/character-sheet/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    );
    expect(result.valid).toBe(false);
  });

  it("rejects UUID with wrong segment lengths", () => {
    const result = parseCharacterLinkInput("a1b2c3d4-e5f6-7890-abcd-ef12345678");
    expect(result.valid).toBe(false);
  });

  it("rejects URL with trailing path segments after UUID", () => {
    const result = parseCharacterLinkInput(
      "https://app.demiplane.com/nexus/pathfinder2e/character-sheet/a1b2c3d4-e5f6-7890-abcd-ef1234567890/extra",
    );
    expect(result.valid).toBe(false);
  });

  it("returns error message describing expected formats on invalid input", () => {
    const result = parseCharacterLinkInput("garbage");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("xxxx");
      expect(result.error).toContain(
        "https://app.demiplane.com/nexus/pathfinder2e/character-sheet/",
      );
    }
  });
});
