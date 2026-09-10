import { describe, it, expect, beforeEach } from "vitest";
import {
  IkonWeaponResolver,
  isWeaponIkon,
  type IkonItem,
  type WeaponItem,
} from "../../src/import/ikon-weapon-resolver.js";

/**
 * A minimal stand-in for PF2e's Predicate supporting the statement forms the
 * weapon-ikon filters use: bare string membership, `{or:[...]}`, and `{not:x}`.
 * Installed as game.pf2e.Predicate so the resolver evaluates real ikon
 * predicates against a weapon's roll options exactly as the system would.
 */
class FakePredicate {
  constructor(private readonly raw: unknown[]) {}
  test(options: string[] | Set<string>): boolean {
    const set = new Set(options);
    const holds = (stmt: unknown): boolean => {
      if (typeof stmt === "string") return set.has(stmt);
      if (stmt && typeof stmt === "object") {
        const o = stmt as Record<string, unknown>;
        if (Array.isArray(o.or)) return o.or.some(holds);
        if ("not" in o) return !holds(o.not);
      }
      return false;
    };
    return this.raw.every(holds);
  }
}

function installPredicate(): void {
  const g = globalThis as unknown as { game?: Record<string, unknown> };
  g.game = { ...(g.game ?? {}), pf2e: { Predicate: FakePredicate } };
}

/** A weapon whose `item:` roll options carry the given tokens (group, damage type, melee, …). */
function weapon(id: string, options: string[], category = "martial"): WeaponItem {
  return { id, category, getRollOptions: () => options };
}

/** An ikon carrying an `existingIkon` ChoiceSet with the given ownedItems predicate. */
function weaponIkon(slug: string, predicate: unknown[]): IkonItem {
  return {
    slug,
    system: { rules: [{ key: "ChoiceSet", flag: "existingIkon", choices: { ownedItems: true, predicate } }] },
  };
}

const SLASHING_MELEE: unknown[] = ["item:melee", { or: ["item:damage:type:slashing", "item:damage:type:piercing"] }];
const POLEARM: unknown[] = [{ or: ["item:base:sickle", "item:group:axe", "item:group:flail", "item:group:polearm"] }];

describe("IkonWeaponResolver", () => {
  beforeEach(() => installPredicate());

  const falchion = () => weapon("falchion", ["item:melee", "item:group:sword", "item:damage:type:slashing"]);
  const fauchard = () =>
    weapon("fauchard", ["item:melee", "item:group:polearm", "item:damage:type:slashing", "item:damage:type:piercing"]);

  it("identifies a weapon ikon by its existingIkon ChoiceSet", () => {
    expect(isWeaponIkon(weaponIkon("barrows-edge", SLASHING_MELEE))).toBe(true);
    expect(isWeaponIkon({ slug: "skin-hard-as-horn", system: { rules: [] } })).toBe(false);
  });

  it("resolves Zatash: Mortal Harvest -> fauchard forces Barrow's Edge -> falchion", () => {
    const resolver = new IkonWeaponResolver(
      [falchion(), fauchard()],
      [],
      [weaponIkon("barrows-edge", SLASHING_MELEE), weaponIkon("mortal-harvest", POLEARM)]
    );

    expect(resolver.assignsExistingWeapon("mortal-harvest")).toBe(true);
    expect(resolver.assignedWeaponId("mortal-harvest")).toBe("fauchard");
    expect(resolver.assignsExistingWeapon("barrows-edge")).toBe(true);
    expect(resolver.assignedWeaponId("barrows-edge")).toBe("falchion");
  });

  it("does not assign an ikon when no owned weapon matches its filter", () => {
    // Only a bow is owned; neither ikon's melee/polearm filter accepts it.
    const bow = weapon("shortbow", ["item:ranged", "item:group:bow", "item:damage:type:piercing"]);
    const resolver = new IkonWeaponResolver([bow], [], [weaponIkon("mortal-harvest", POLEARM)]);

    expect(resolver.assignsExistingWeapon("mortal-harvest")).toBe(false);
    expect(resolver.assignedWeaponId("mortal-harvest")).toBeUndefined();
  });

  it("excludes unarmed weapons from assignment", () => {
    const fist = weapon("fist", ["item:melee", "item:damage:type:slashing"], "unarmed");
    const resolver = new IkonWeaponResolver([fist], [], [weaponIkon("barrows-edge", SLASHING_MELEE)]);

    expect(resolver.assignsExistingWeapon("barrows-edge")).toBe(false);
  });

  it("breaks a genuine tie toward the equipped weapon", () => {
    const resolver = new IkonWeaponResolver(
      [falchion(), fauchard()],
      [],
      [weaponIkon("barrows-edge", SLASHING_MELEE)],
      "fauchard"
    );

    expect(resolver.assignedWeaponId("barrows-edge")).toBe("fauchard");
  });

  it("ignores ikons without an existingIkon predicate (body/worn ikons)", () => {
    const resolver = new IkonWeaponResolver([falchion()], [], [{ slug: "skin-hard-as-horn", system: { rules: [] } }]);

    expect(resolver.assignsExistingWeapon("skin-hard-as-horn")).toBe(false);
  });

  it("skips an ikon that has no slug", () => {
    const noSlug: IkonItem = {
      slug: null,
      system: {
        rules: [{ key: "ChoiceSet", flag: "existingIkon", choices: { ownedItems: true, predicate: SLASHING_MELEE } }],
      },
    };
    const resolver = new IkonWeaponResolver([falchion()], [], [noSlug]);

    // Nothing to key on, so it neither assigns nor throws.
    expect(resolver.assignedWeaponId("")).toBeUndefined();
  });

  it("returns no assignment when the Predicate class is unavailable", () => {
    (globalThis as unknown as { game: Record<string, unknown> }).game = { pf2e: {} };
    const resolver = new IkonWeaponResolver([falchion()], [], [weaponIkon("barrows-edge", SLASHING_MELEE)]);

    expect(resolver.assignsExistingWeapon("barrows-edge")).toBe(false);
  });
});
