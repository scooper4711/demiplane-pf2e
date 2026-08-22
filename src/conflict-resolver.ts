import { MODULE_ID } from "./import/types.js";
import type {
  DemiplaneClient,
  CharacterEngine,
} from "@scooper4711/demiplane-api";
import { updateCustomEngineValue } from "@scooper4711/demiplane-api";


export type ConflictStatus =
  | { conflicted: false }
  | { conflicted: true; localVersion: number; remoteVersion: number };

export type ConflictResolution = "reimport" | "force-push" | "cancel";

export interface ConflictResolutionResult {
  success: boolean;
  error?: string;
}

/**
 * Detects version conflicts between local and remote character state
 * and provides resolution strategies.
 *
 * A conflict exists when the remote character version is greater than
 * the locally stored version, indicating someone else modified the
 * character on Demiplane since the last sync.
 */
export class ConflictResolver {
  private readonly client: DemiplaneClient;

  constructor(client: DemiplaneClient) {
    this.client = client;
  }

  async checkForConflict(actor: Actor): Promise<ConflictStatus> {
    const characterId = actor.getFlag(MODULE_ID, "characterId") as
      | string
      | undefined;
    if (!characterId) {
      return { conflicted: false };
    }

    const storedVersion = actor.getFlag(MODULE_ID, "lastKnownVersion") as
      | number
      | undefined;
    if (storedVersion === undefined) {
      return { conflicted: false };
    }

    try {
      const remote = await this.client.fetchCharacterVersion(characterId);
      if (remote.version > storedVersion) {
        return {
          conflicted: true,
          localVersion: storedVersion,
          remoteVersion: remote.version,
        };
      }
      return { conflicted: false };
    } catch {
      return { conflicted: false };
    }
  }

  async resolveConflict(
    actor: Actor,
    resolution: ConflictResolution,
    localEngines: CharacterEngine[],
    localSessionState: Map<string, number>,
  ): Promise<ConflictResolutionResult> {
    const characterId = actor.getFlag(MODULE_ID, "characterId") as
      | string
      | undefined;
    if (!characterId) {
      return { success: false, error: "Actor has no linked character ID" };
    }

    switch (resolution) {
      case "reimport":
        return this.handleReimport(actor, characterId, localSessionState);
      case "force-push":
        return this.handleForcePush(characterId, localEngines);
      case "cancel":
        return { success: true };
    }
  }

  private async handleReimport(
    actor: Actor,
    characterId: string,
    localSessionState: Map<string, number>,
  ): Promise<ConflictResolutionResult> {
    try {
      const freshData = await this.client.fetchCharacterData(characterId);
      let mergedEngines = freshData.engines;

      for (const [field, value] of localSessionState) {
        mergedEngines = updateCustomEngineValue(mergedEngines, field, value);
      }

      const pushSuccess = await this.client.updateCharacter({
        id: characterId,
        data: {
          engines: mergedEngines,
          engineCacheIdsBySource: freshData.engineCacheIdsBySource,
        },
      });

      if (!pushSuccess) {
        return { success: false, error: "Merge push failed" };
      }

      const version = await this.client.fetchCharacterVersion(characterId);
      await actor.setFlag(MODULE_ID, "lastKnownVersion", version.version);
      await actor.setFlag(MODULE_ID, "lastSyncTimestamp", Date.now());
      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Re-import failed: ${message}` };
    }
  }

  private async handleForcePush(
    characterId: string,
    localEngines: CharacterEngine[],
  ): Promise<ConflictResolutionResult> {
    try {
      const pushSuccess = await this.client.updateCharacter({
        id: characterId,
        data: {
          engines: localEngines,
          engineCacheIdsBySource: {},
        },
      });

      if (!pushSuccess) {
        return { success: false, error: "Force push mutation failed" };
      }

      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Force push failed: ${message}` };
    }
  }
}
