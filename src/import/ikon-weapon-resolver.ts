import { pf2ePredicate } from "../pf2e-types.js";
import { debugLog } from "./debug-log.js";
import { resolveIkonWeapons, type IkonToAssign } from "./ikon-weapon-matcher.js";

/**
 * Bridges the pure {@link resolveIkonWeapons} solver to a live PF2e actor.
 *
 * An Exemplar weapon ikon can attach to a weapon the character already owns, but
 * Demiplane records neither that decision nor which weapon each ikon claims (see
 * {@link resolveIkonWeapons} for the full context). PF2e does encode each ikon's
 * accepted weapons — as the predicate on its `existingIkon` ChoiceSet rule — so
 * this resolver reads that predicate straight off the ikon items and tests the
 * actor's owned weapons against it, delegating "which weapons qualify" wholly to
 * the system. That keeps every ikon-specific rule (and every future ikon) in
 * PF2e's data instead of a table here.
 *
 * The assignment is computed once and memoized: the ChoiceSet handler resolves
 * the ikons' choices one at a time (the origin `granted`/`existing` choice fires
 * before the `existingIkon` weapon choice), but the solver needs every ikon's
 * candidates together, so the answer must be ready at the first query.
 */

/** The `existingIkon` ChoiceSet flag that marks a weapon ikon and holds its filter. */
const EXISTING_IKON_FLAG = "existingIkon";

/** Weapons in this category are excluded from ikon assignment, matching PF2e's ChoiceSet. */
const UNARMED_CATEGORY = "unarmed";

/** A ChoiceSet rule as authored on an ikon item's source data. */
interface ChoiceSetRule {
  key?: unknown;
  flag?: unknown;
  choices?: { ownedItems?: unknown; predicate?: unknown } | unknown;
}

/** The minimal weapon-item surface the resolver reads. */
export interface WeaponItem {
  id: string;
  category?: string;
  getRollOptions: (prefix: string) => string[];
}

/** The minimal ikon-item surface the resolver reads (a sibling being created). */
export interface IkonItem {
  /** The ikon's identifier (its slug); used as the solver key and the query key. */
  slug: string | null;
  system: { rules: Array<Record<string, unknown>> };
}

/**
 * Computes and answers the ikon → owned-weapon assignment for one import.
 *
 * Construct once (after the actor's weapons are embedded and prepared, and once
 * the sibling ikon items exist), then query {@link assignsExistingWeapon} for
 * the origin `granted`/`existing` choice and {@link assignedWeaponId} for the
 * weapon choice.
 *
 * @param weapons - the actor's owned weapons (unarmed already excluded is fine;
 *   the resolver also excludes them defensively)
 * @param actorRollOptions - the actor's roll options, unioned into each predicate
 *   test to match how PF2e's ChoiceSet evaluates owned-item filters
 * @param ikons - the weapon ikons being created (each with its source rules)
 * @param equippedWeaponId - the equipped weapon, used only to break genuine ties
 */
export class IkonWeaponResolver {
  private readonly assignments: Map<string, string | null>;

  constructor(weapons: WeaponItem[], actorRollOptions: string[], ikons: IkonItem[], equippedWeaponId?: string) {
    this.assignments = this.solve(weapons, actorRollOptions, ikons, equippedWeaponId);
  }

  /** Whether the given ikon should take the "existing weapon" branch. */
  assignsExistingWeapon(ikonSlug: string): boolean {
    return this.assignments.get(ikonSlug) != null;
  }

  /** The owned-weapon id assigned to the ikon, or `undefined` when none. */
  assignedWeaponId(ikonSlug: string): string | undefined {
    return this.assignments.get(ikonSlug) ?? undefined;
  }

  private solve(
    weapons: WeaponItem[],
    actorRollOptions: string[],
    ikons: IkonItem[],
    equippedWeaponId?: string
  ): Map<string, string | null> {
    const eligibleWeapons = weapons.filter((w) => w.category !== UNARMED_CATEGORY);

    const toAssign: IkonToAssign[] = [];
    for (const ikon of ikons) {
      const slug = ikon.slug;
      if (!slug) continue;
      const predicate = existingIkonPredicate(ikon);
      if (!predicate) continue;
      toAssign.push({
        ikonId: slug,
        candidateWeaponIds: candidateWeapons(eligibleWeapons, predicate, actorRollOptions),
      });
    }

    if (toAssign.length === 0) return new Map();

    const assignments = resolveIkonWeapons(toAssign, equippedWeaponId !== undefined ? { equippedWeaponId } : {});
    debugLog(`[ikon] assignments: ${[...assignments].map(([k, v]) => `${k}->${v ?? "none"}`).join(", ")}`);
    return assignments;
  }
}

/** Whether an item is a weapon ikon: it carries an `existingIkon` ChoiceSet rule. */
export function isWeaponIkon(ikon: IkonItem): boolean {
  return existingIkonPredicate(ikon) !== undefined;
}

/** The raw `ownedItems` predicate from an ikon's `existingIkon` ChoiceSet, if any. */
function existingIkonPredicate(ikon: IkonItem): unknown[] | undefined {
  const rule = ikon.system.rules.find((r) => r.key === "ChoiceSet" && r.flag === EXISTING_IKON_FLAG) as
    ChoiceSetRule | undefined;
  const choices = rule?.choices as { ownedItems?: unknown; predicate?: unknown } | undefined;
  if (!choices?.ownedItems || !Array.isArray(choices.predicate)) return undefined;
  return choices.predicate;
}

/** The ids of owned weapons that satisfy the ikon's PF2e weapon filter. */
function candidateWeapons(weapons: WeaponItem[], rawPredicate: unknown[], actorRollOptions: string[]): string[] {
  const predicate = pf2ePredicate(rawPredicate);
  if (!predicate) return [];
  return weapons
    .filter((weapon) => predicate.test([...actorRollOptions, ...weapon.getRollOptions("item")]))
    .map((weapon) => weapon.id);
}
