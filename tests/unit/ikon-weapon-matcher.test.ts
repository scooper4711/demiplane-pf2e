import { describe, it, expect } from "vitest";
import { resolveIkonWeapons, type IkonToAssign } from "../../src/import/ikon-weapon-matcher.js";

describe("resolveIkonWeapons", () => {
  const ikon = (ikonId: string, candidateWeaponIds: string[]): IkonToAssign => ({ ikonId, candidateWeaponIds });

  it("assigns nothing when there are no ikons", () => {
    expect(resolveIkonWeapons([]).size).toBe(0);
  });

  it("assigns an ikon its single candidate", () => {
    const result = resolveIkonWeapons([ikon("mortal-harvest", ["fauchard"])]);
    expect(result.get("mortal-harvest")).toBe("fauchard");
  });

  it("leaves an ikon unassigned when it has no candidates", () => {
    const result = resolveIkonWeapons([ikon("barrows-edge", [])]);
    expect(result.get("barrows-edge")).toBeNull();
  });

  it("resolves Zatash by elimination: a forced assignment frees the tie", () => {
    // Mortal Harvest accepts only the fauchard (polearm); Barrow's Edge accepts
    // both slashing weapons. Forcing Mortal Harvest -> fauchard leaves Barrow's
    // Edge with only the falchion, so both resolve without a real guess.
    const result = resolveIkonWeapons([
      ikon("barrows-edge", ["falchion", "fauchard"]),
      ikon("mortal-harvest", ["fauchard"]),
    ]);
    expect(result.get("mortal-harvest")).toBe("fauchard");
    expect(result.get("barrows-edge")).toBe("falchion");
  });

  it("never assigns one weapon to two ikons", () => {
    const result = resolveIkonWeapons([
      ikon("first", ["sword"]),
      ikon("second", ["sword"]), // only candidate already claimed by "first"
    ]);
    expect(result.get("first")).toBe("sword");
    expect(result.get("second")).toBeNull();
  });

  it("breaks a genuine tie in favor of the equipped weapon", () => {
    const result = resolveIkonWeapons([ikon("barrows-edge", ["falchion", "fauchard"])], {
      equippedWeaponId: "fauchard",
    });
    expect(result.get("barrows-edge")).toBe("fauchard");
  });

  it("breaks a tie deterministically when nothing is equipped", () => {
    // With no equipped weapon, the winner is the first candidate in sorted order,
    // so a character always imports identically regardless of candidate ordering.
    const forward = resolveIkonWeapons([ikon("barrows-edge", ["falchion", "fauchard"])]);
    const reversed = resolveIkonWeapons([ikon("barrows-edge", ["fauchard", "falchion"])]);
    expect(forward.get("barrows-edge")).toBe("falchion");
    expect(reversed.get("barrows-edge")).toBe("falchion");
  });

  it("does not let an equipped weapon override a forced assignment", () => {
    // The equipped weapon is only a tie-break hint; a forced single-candidate
    // assignment still wins and claims its weapon before ties are broken.
    const result = resolveIkonWeapons(
      [ikon("mortal-harvest", ["fauchard"]), ikon("barrows-edge", ["falchion", "fauchard"])],
      { equippedWeaponId: "fauchard" }
    );
    expect(result.get("mortal-harvest")).toBe("fauchard");
    expect(result.get("barrows-edge")).toBe("falchion");
  });

  it("cascades: breaking one tie forces the remaining ikons", () => {
    // No ikon starts with a single candidate, so propagation makes no progress
    // until a tie is broken; that assignment then forces the rest in turn.
    const result = resolveIkonWeapons([ikon("a", ["x", "y", "z"]), ikon("b", ["x", "y"]), ikon("c", ["x"])], {});
    // c is forced to x; b then has only y; a then has only z.
    expect(result.get("c")).toBe("x");
    expect(result.get("b")).toBe("y");
    expect(result.get("a")).toBe("z");
  });

  it("leaves surplus ikons unassigned when weapons run out", () => {
    const result = resolveIkonWeapons([ikon("first", ["only"]), ikon("second", ["only"]), ikon("third", ["only"])]);
    const assigned = [...result.values()].filter((v) => v !== null);
    expect(assigned).toEqual(["only"]);
    expect([...result.values()].filter((v) => v === null)).toHaveLength(2);
  });
});
