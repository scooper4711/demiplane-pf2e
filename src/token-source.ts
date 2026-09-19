/**
 * Sources the Demiplane client's credential from the `demiplaneToken` setting,
 * the single authoritative copy. Callers reconcile just-in-time before each
 * Demiplane operation so import and push always read the same value.
 */

import { normalizeBearerToken, type DemiplaneClient } from "@scooper4711/demiplane-api";
import { MODULE_ID } from "./import/types.js";

/** The configured token, normalized (trim + strip `Bearer`) as the client stores it. */
export function readConfiguredToken(): string {
  return normalizeBearerToken((game.settings.get(MODULE_ID, "demiplaneToken") as string) ?? "");
}

/**
 * Reconciles the client with the current setting and reports whether a token is
 * configured. Always calls `setToken` — an empty value clears the client — so a
 * token added or removed after startup takes effect without a settings-change
 * event on this client.
 */
export function syncClientToken(client: DemiplaneClient): boolean {
  const token = readConfiguredToken();
  client.setToken(token);
  return token.length > 0;
}
