/**
 * Assigns each Exemplar weapon ikon to one of the character's owned weapons.
 *
 * An Exemplar picks several ikons; a *weapon* ikon can be attached to a weapon
 * the character already owns ("existing"), but Demiplane records neither the
 * grant-vs-existing choice nor which weapon each ikon claims. Each ikon does,
 * however, restrict which weapons it accepts (Mortal Harvest → polearm/axe/…,
 * Barrow's Edge → any slashing/piercing melee weapon), and a given weapon can
 * back only one ikon. The valid weapons per ikon are computed by the caller
 * (by testing each weapon against the ikon's own PF2e predicate); this module
 * only solves the assignment.
 *
 * The solver is a small constraint propagation: an ikon with exactly one
 * remaining candidate is forced to take it, which removes that weapon from every
 * other ikon and can force further assignments. Once no forced assignment
 * remains, any ikon still holding several candidates is broken by picking the
 * equipped weapon if present, else the first candidate in the caller's order,
 * after which propagation resumes. This deliberately mirrors how a player would
 * disambiguate and keeps imports reproducible.
 *
 * This module has no Foundry or PF2e dependencies so the matching logic can be
 * unit-tested with plain data; adapting owned weapons and ikon predicates into
 * candidate sets, and writing the result back onto the ChoiceSet, is the
 * caller's job.
 */

/** A weapon ikon awaiting assignment, with the weapons it may attach to. */
export interface IkonToAssign {
  /** Stable identifier for the ikon (e.g. its slug). */
  ikonId: string;
  /** Ids of owned weapons this ikon's filter accepts. */
  candidateWeaponIds: readonly string[];
}

/** The owned-weapon context the solver needs to break ties. */
export interface WeaponContext {
  /** The id of the weapon the character has equipped, if any. */
  equippedWeaponId?: string;
}

/** The resolved weapon for each ikon (`null` when none could be assigned). */
export type IkonAssignments = Map<string, string | null>;

/**
 * Solves the ikon → owned-weapon assignment.
 *
 * @param ikons - the weapon ikons to place, each with its accepted weapon ids
 * @param context - owned-weapon context used only for tie-breaking
 * @returns a map from ikon id to the assigned weapon id, or `null` when the ikon
 *   has no assignable weapon (the caller should leave it to the default flow)
 */
export function resolveIkonWeapons(ikons: readonly IkonToAssign[], context: WeaponContext = {}): IkonAssignments {
  const assignments: IkonAssignments = new Map(ikons.map((ikon) => [ikon.ikonId, null]));
  const claimedWeaponIds = new Set<string>();
  const candidatesByIkon = new Map<string, Set<string>>(
    ikons.map((ikon) => [ikon.ikonId, new Set(ikon.candidateWeaponIds)])
  );

  let progressed = true;
  while (progressed) {
    progressed = propagateForcedAssignments(assignments, candidatesByIkon, claimedWeaponIds);
    if (!progressed) {
      progressed = breakOneTie(ikons, assignments, candidatesByIkon, claimedWeaponIds, context);
    }
  }

  return assignments;
}

/**
 * Assigns every ikon that has exactly one unclaimed candidate, repeating until
 * no more such forced assignments exist. Returns whether any assignment was made
 * so the caller knows a fixed point was reached.
 */
function propagateForcedAssignments(
  assignments: IkonAssignments,
  candidatesByIkon: Map<string, Set<string>>,
  claimedWeaponIds: Set<string>
): boolean {
  let madeAnyAssignment = false;
  let madeAssignmentThisPass = true;

  while (madeAssignmentThisPass) {
    madeAssignmentThisPass = false;
    for (const [ikonId, candidates] of candidatesByIkon) {
      if (assignments.get(ikonId) !== null) continue;
      pruneClaimed(candidates, claimedWeaponIds);
      if (candidates.size !== 1) continue;

      const [onlyWeaponId] = candidates;
      assignWeapon(ikonId, onlyWeaponId!, assignments, claimedWeaponIds);
      madeAssignmentThisPass = true;
      madeAnyAssignment = true;
    }
  }

  return madeAnyAssignment;
}

/**
 * Breaks the tie for the first still-ambiguous ikon (in the caller's order) by
 * choosing the equipped weapon when it is a candidate, else the first candidate
 * in a stable order. Assigns exactly one ikon so the caller can re-run
 * propagation, which may cascade into further forced assignments.
 *
 * @returns whether an ambiguous ikon was resolved this call
 */
function breakOneTie(
  ikons: readonly IkonToAssign[],
  assignments: IkonAssignments,
  candidatesByIkon: Map<string, Set<string>>,
  claimedWeaponIds: Set<string>,
  context: WeaponContext
): boolean {
  for (const { ikonId } of ikons) {
    if (assignments.get(ikonId) !== null) continue;
    const candidates = candidatesByIkon.get(ikonId)!;
    pruneClaimed(candidates, claimedWeaponIds);
    if (candidates.size === 0) continue;

    assignWeapon(ikonId, chooseTieBreakWinner(candidates, context), assignments, claimedWeaponIds);
    return true;
  }
  return false;
}

/**
 * Picks the winning weapon among several candidates: the equipped weapon when it
 * qualifies, otherwise the first candidate in a stable (sorted) order so a given
 * character always imports the same way.
 */
function chooseTieBreakWinner(candidates: Set<string>, context: WeaponContext): string {
  const { equippedWeaponId } = context;
  if (equippedWeaponId !== undefined && candidates.has(equippedWeaponId)) {
    return equippedWeaponId;
  }
  return [...candidates].sort()[0]!;
}

/** Removes weapons already taken by another ikon from a candidate set. */
function pruneClaimed(candidates: Set<string>, claimedWeaponIds: Set<string>): void {
  for (const weaponId of claimedWeaponIds) {
    candidates.delete(weaponId);
  }
}

/** Records an ikon's assignment and marks its weapon claimed. */
function assignWeapon(
  ikonId: string,
  weaponId: string,
  assignments: IkonAssignments,
  claimedWeaponIds: Set<string>
): void {
  assignments.set(ikonId, weaponId);
  claimedWeaponIds.add(weaponId);
}
