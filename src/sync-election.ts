/**
 * Cross-client single-writer election for pushing changes to Demiplane.
 *
 * When several clients are connected, every client receives the same actor
 * updates and would each attempt to push — duplicating writes. Instead we elect
 * exactly one writer deterministically from the set of connected, eligible users
 * so all clients agree on who pushes:
 *
 *   1. Game Masters        (role GAMEMASTER) — highest priority
 *   2. Assistant GMs       (role ASSISTANT)  — next
 *   3. Users with OWNER permission on the actor — lowest
 *
 * Ties within a tier are broken alphabetically by user name.
 *
 * IMPORTANT: `User#isGM` is `true` for BOTH GMs and Assistant GMs in this
 * Foundry version, so `role` must be inspected directly to keep the two tiers
 * distinct (confirmed via the live "Assistant GM" test user: role 3, isGM true).
 */
export function isClientElectedWriter(actor: Actor): boolean {
  // No `game` context (e.g. headless tests) — behave as the sole writer so the
  // prior single-client push behavior is preserved.
  if (typeof game === "undefined" || !game.user || !game.users) return true;

  const me = game.user;
  const eligible = game.users.filter((u) => u.active && isEligible(u, actor));
  if (eligible.length === 0) return false;

  eligible.sort((a, b) => writerTier(a) - writerTier(b) || a.name.localeCompare(b.name));
  const elected = eligible[0];
  if (!elected) return false;
  return elected.id === me.id;
}

function isEligible(user: User, actor: Actor): boolean {
  if (user.role === CONST.USER_ROLES.GAMEMASTER) return true;
  if (user.role === CONST.USER_ROLES.ASSISTANT) return true;
  return actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
}

function writerTier(user: User): number {
  if (user.role === CONST.USER_ROLES.GAMEMASTER) return 0;
  if (user.role === CONST.USER_ROLES.ASSISTANT) return 1;
  return 2;
}
