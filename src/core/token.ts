/**
 * Demiplane token helpers: user-facing error text.
 *
 * Raw GraphQL auth failures ("GraphQL errors: could not verify: Jwt expired")
 * mean nothing to a non-technical GM, so they are translated to plain language
 * here, in one place, so every entry point reports the same way. Token
 * normalization (trimming, stripping a pasted `Bearer ` prefix) lives in the
 * demiplane-api client (`normalizeBearerToken` / `setToken`), the single owner
 * of what a clean credential is.
 */

/** Link to the README section explaining how to obtain a token. */
export const TOKEN_HELP_URL = "https://github.com/scooper4711/demiplane-pf2e#getting-the-demiplane-token";

/** Hasura/GraphQL phrasings meaning the token expired. */
const TOKEN_EXPIRED_RE = /jwt[^a-z]*expir|expir[^a-z]*jwt|jwt[^a-z]*could not verify|could not verify[^a-z]*jwt/i;

/** Hasura/GraphQL phrasings meaning the token was rejected outright. */
const TOKEN_REJECTED_RE =
  /invalid[^a-z]*jwt|jwt[^a-z]*invalid|unauthorized|forbidden|invalid signature|bad jwt|missing authorization/i;

/**
 * Translates a raw API/GraphQL auth failure into plain language, or null when
 * the error is not token-related (callers then fall back to the raw text).
 */
export function toUserFacingTokenError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (TOKEN_EXPIRED_RE.test(message)) {
    return (
      "Your Demiplane token has expired. Ask your GM to paste a new one into " +
      "Settings > Module Settings > Demiplane PF2e Sync (Demiplane Authorization Token)."
    );
  }
  if (TOKEN_REJECTED_RE.test(message)) {
    return (
      "Demiplane rejected the token. Ask your GM to check it in " +
      "Settings > Module Settings > Demiplane PF2e Sync (Demiplane Authorization Token)."
    );
  }
  return null;
}

/**
 * Always returns displayable text: the plain-language translation for
 * token-related failures, otherwise the raw message untouched.
 */
export function toUserFacingSyncError(error: unknown): string {
  return toUserFacingTokenError(error) ?? (error instanceof Error ? error.message : String(error ?? "Unknown error"));
}
