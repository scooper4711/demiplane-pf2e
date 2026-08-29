import { MODULE_ID } from "../import/types.js";
import { debugLog } from "../import/debug-log.js";
import { computeEngineSig } from "../engine-sig.js";
import type { DemiplaneClient } from "@scooper4711/demiplane-api";

export type ConflictCheckResult = { status: "ok" } | { status: "conflict"; error: string };

/**
 * Encapsulates the optimistic-concurrency check performed before a push.
 *
 * Demiplane bumps the character's `updated` timestamp on every save (including
 * benign autosaves), so a mismatched `updated` alone is not proof of a real
 * conflict. This resolver verifies the character's actual *engine content*
 * (via a signature of engine name/value pairs) changed before declaring a
 * conflict, so benign bumps fall through and genuine remote edits abort the
 * push for re-import.
 */
export class ConflictResolver {
  private readonly client: DemiplaneClient;

  constructor(client: DemiplaneClient) {
    this.client = client;
  }

  /**
   * Decides whether the buffered push may proceed.
   *
   * @returns `{ status: "conflict" }` when the remote character's engine
   *   content changed since our last sync (the caller should abort + re-import);
   *   `{ status: "ok" }` when the push may go ahead. On a benign `updated` bump
   *   the stored `lastUpdated` baseline is refreshed as a side effect so the
   *   next push matches.
   */
  async checkConflict(characterId: string, actor: Actor): Promise<ConflictCheckResult> {
    const storedUpdated = actor.getFlag(MODULE_ID, "lastUpdated") as string | undefined;
    if (!storedUpdated) {
      debugLog(`[push] no stored lastUpdated flag — skipping optimistic concurrency check`);
      return { status: "ok" };
    }

    debugLog(`[push] conflict check: stored lastUpdated=${storedUpdated}`);
    try {
      const startedAt = Date.now();
      const serverUpdated = await this.client.fetchCharacterUpdated(characterId);
      const matched = serverUpdated === storedUpdated;
      debugLog(
        `[push] conflict check: server updated=${serverUpdated} (took ${Date.now() - startedAt}ms) ` +
          `${matched ? "MATCH" : "MISMATCH"}`
      );
      if (matched) return { status: "ok" };

      // `updated` advanced, but that alone isn't proof of a conflicting edit: the
      // Demiplane sheet (or an autosave) can bump `updated` without changing any
      // content. Verify the character's actual engine content changed before we
      // abort the push and trigger a re-import.
      const contentChanged = await this.isRemoteContentChanged(characterId, actor);
      if (!contentChanged) {
        debugLog(
          `[push] updated mismatch but engine content unchanged — benign bump; ` +
            `proceeding with push and refreshing lastUpdated`
        );
        await actor.setFlag(MODULE_ID, "lastUpdated", serverUpdated);
        return { status: "ok" };
      }

      const error = "Conflict: Demiplane character was updated elsewhere. Re-importing.";
      debugLog(
        `[push] conflict detected stored=${storedUpdated} server=${serverUpdated} — aborting push, will re-import`
      );
      return { status: "conflict", error };
    } catch (error) {
      debugLog(`[push] failed to fetch updated for conflict check: ${String(error)}`);
      // If we can't fetch updated, proceed with push but log
      return { status: "ok" };
    }
  }

  /**
   * Determines whether the character's engine content on Demiplane differs from
   * the content we last synced. Used to tell a genuine remote edit apart from a
   * benign `updated` bump so we don't needlessly abort pushes / re-import.
   * Returns `true` (conflict) when content can't be compared, to stay safe.
   */
  private async isRemoteContentChanged(characterId: string, actor: Actor): Promise<boolean> {
    try {
      const data = await this.client.fetchCharacterData(characterId);
      const currentSig = computeEngineSig((data.engines as Array<{ name?: string; value?: unknown }>) ?? []);
      const storedSig = actor.getFlag(MODULE_ID, "engineSig") as string | undefined;
      if (!storedSig) return true; // no baseline — be conservative
      const changed = currentSig !== storedSig;
      debugLog(
        `[push] content compare: ${changed ? "CONTENT CHANGED (real conflict)" : "content unchanged (benign bump)"}`
      );
      return changed;
    } catch (error) {
      debugLog(`[push] failed to compare remote content: ${String(error)} — assuming conflict`);
      return true;
    }
  }
}
