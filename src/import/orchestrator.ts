/**
 * ImportOrchestrator - Coordinates full character import from Demiplane into Foundry PF2e.
 *
 * Key architecture decisions:
 * - Items are resolved from compendium via slug matching (strip -rm suffix)
 * - ChoiceSet prompts are suppressed by monkey-patching preCreate during import
 * - Feats get system.location and system.level.taken set from Demiplane sourceRow
 * - Feats granted by other feats' ChoiceSets are skipped (deduplication)
 * - Feats granted by GrantItem rules (e.g. background → Assurance) are detected and skipped
 * - Class features are created by PF2e's native Granted rules, not imported directly
 * - Import order: ancestry → heritage → background → class (sequential), then feats (batch)
 *
 * This class is a thin driver: it fetches engines, stamps bookkeeping flags,
 * installs the ChoiceSetHandler and preCreateItem hook, then runs an ordered
 * pipeline of `ImportPhase` objects (see ./phases.js) inside the try/finally.
 */

import type { DemiplaneClient } from "@scooper4711/demiplane-api";
import type { DemiplaneEngineEntry, ImportOptions, ImportSummary } from "./types.js";
import { MODULE_ID } from "./types.js";
import { debugLog } from "./debug-log.js";
import { ChoiceSetHandler } from "./choice-set-handler.js";
import { DEMIPLANE_GRAPHQL_URL } from "../config.js";
import { computeEngineSig } from "../engine-sig.js";
import {
  buildSelectionData,
  categorizeEngines,
  LoreItemsPhase,
  SequentialItemsPhase,
  ResolveGrantsPhase,
  BatchItemsPhase,
  PostProcessingPhase,
  RemoveDuplicatesPhase,
  type ImportContext,
  type ImportPhase,
} from "./phases.js";

/** Journal title that maps to the Foundry Campaign Notes biography field. */
const CAMPAIGN_JOURNAL_TITLE = "Campaign";

/**
 * Foundry path for the Campaign "Notes" field (Biography tab → Campaign
 * section). This is distinct from `biography.backstory`, which is the
 * Personality-tab backstory fed by the `character_campaign_other` engine.
 */
const CAMPAIGN_NOTES_PATH = "system.details.biography.campaignNotes";

export { collectLoreNames } from "./phases.js";

export class ImportOrchestrator {
  private readonly choiceSetHandler = new ChoiceSetHandler();
  private readonly client: DemiplaneClient | undefined;

  /**
   * @param client - The Demiplane API client used for journal import. Optional
   *   so tests (and any caller that doesn't need journal sync) can construct an
   *   orchestrator without wiring a client; when absent, journal import is
   *   skipped.
   */
  constructor(client?: DemiplaneClient) {
    this.client = client;
  }

  async importCharacter(actor: Actor, characterId: string, options: ImportOptions = {}): Promise<ImportSummary> {
    const { token } = options;
    const summary: ImportSummary = { itemsImported: 0, itemsSkipped: 0, unmapped: [], errors: [], log: [] };

    const fetched = await this.fetchCharacterEngines(characterId, token, summary);
    if (!fetched) return summary;
    const { engines, updated } = fetched;
    if (updated) {
      await actor.setFlag(MODULE_ID, "lastUpdated", updated);
      debugLog(`[import] stored lastUpdated=${updated}`);
    } else {
      debugLog(`[import] character has no updated timestamp; leaving lastUpdated unchanged`);
    }
    // Snapshot the imported engine content so a later benign `updated` bump
    // (e.g. the Demiplane sheet being open) isn't mistaken for a conflict.
    await actor.setFlag(MODULE_ID, "engineSig", computeEngineSig(engines));
    debugLog(`[import] stored engineSig for ${engines.length} engines`);

    // eslint-disable-next-line no-console -- single always-on log per pull
    console.info(`${MODULE_ID} | Pulled character data from Demiplane (${characterId})`);

    this.choiceSetHandler.setEngines(engines);
    const selectionData = buildSelectionData(engines);
    const categorized = categorizeEngines(engines);
    const ctx: ImportContext = {
      engines,
      summary,
      choiceSetHandler: this.choiceSetHandler,
      categorized,
      selectionData,
      grantResolvedSlugs: new Set(),
    };

    const importHookId = Hooks.on("preCreateItem", ((item: Item) => {
      if (item.parent?.id !== actor.id) return;
      (item as { updateSource: (data: Record<string, unknown>) => void }).updateSource({
        [`flags.${MODULE_ID}.imported`]: true,
      });
    }) as never);

    try {
      this.choiceSetHandler.enable();
      for (const phase of this.buildPipeline()) {
        await phase.run(actor, ctx);
      }
    } finally {
      Hooks.off("preCreateItem", importHookId);
      this.choiceSetHandler.disable();
    }

    await actor.setFlag(MODULE_ID, "lastImportTimestamp", Date.now());
    await this.importJournals(actor, characterId);
    return summary;
  }

  private buildPipeline(): ImportPhase[] {
    return [
      new LoreItemsPhase(),
      new SequentialItemsPhase(),
      new ResolveGrantsPhase(),
      new BatchItemsPhase(),
      new PostProcessingPhase(),
      new RemoveDuplicatesPhase(),
    ];
  }

  private async fetchCharacterEngines(
    characterId: string,
    token: string | undefined,
    summary: ImportSummary
  ): Promise<{ engines: DemiplaneEngineEntry[]; updated: string | null } | null> {
    if (!token) {
      summary.errors.push("No authentication token provided");
      return null;
    }

    try {
      const query = `query($id: uuid!) {
        demiplane_user_character(where: {uuid: {_eq: $id}, deleted_at: {_is_null: true}, enabled: {_eq: true}}) {
          data
          updated
        }
      }`;

      const response = await fetch(DEMIPLANE_GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables: { id: characterId } }),
      });

      const json = (await response.json()) as {
        data?: {
          demiplane_user_character: Array<{
            data: { engines: DemiplaneEngineEntry[] };
            updated: string | null;
          }>;
        };
        errors?: Array<{ message: string }>;
      };

      if (json.errors) {
        summary.errors.push(`GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
        return null;
      }

      const character = json.data?.demiplane_user_character?.[0];
      if (!character?.data?.engines) {
        summary.errors.push(`Character not found: ${characterId}`);
        return null;
      }

      return { engines: character.data.engines, updated: character.updated };
    } catch (error) {
      summary.errors.push(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Imports the "Campaign" journal entry into the actor's Campaign Notes field
   * (`biography.campaignNotes`). Journal sync is best-effort: any failure is
   * logged and swallowed so it never aborts the surrounding character import.
   *
   * The journal body lives in the `description` field (the server mirrors the
   * `content` write into it), so that is what we read into Campaign Notes.
   */
  private async importJournals(actor: Actor, characterId: string): Promise<void> {
    if (!this.client) {
      debugLog(`[import] no API client configured; skipping journal import`);
      return;
    }
    try {
      const journals = await this.client.fetchCharacterJournals(characterId);
      const campaign = journals.find((journal) => journal.title === CAMPAIGN_JOURNAL_TITLE);
      const notes = campaign?.description ?? "";
      if (notes.length === 0) return;

      await actor.update({ [CAMPAIGN_NOTES_PATH]: notes } as Record<string, unknown>);
      debugLog(`[import] imported Campaign journal → ${CAMPAIGN_NOTES_PATH} (${notes.length} chars)`);
    } catch (error) {
      debugLog(`[import] journal import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
