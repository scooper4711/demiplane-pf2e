import { stampImported } from "./types.js";
import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";

/**
 * Maps a Demiplane engine name to the Foundry actor path it populates.
 */
const BIO_FIELD_MAP: ReadonlyArray<readonly [string, string]> = [
  ["character_appearance_gender", "system.details.gender.value"],
  ["character_appearance_age", "system.details.age.value"],
  ["character_appearance_ethnicity", "system.details.ethnicity.value"],
  ["character_appearance_nationality", "system.details.nationality.value"],
  ["character_appearance_height", "system.details.height.value"],
  ["character_appearance_weight", "system.details.weight.value"],
  ["character_appearance_birthplace", "system.details.biography.birthPlace"],
  ["character_appearance_appearance", "system.details.biography.appearance"],
  ["character_personality_catchphrases", "system.details.biography.catchphrases"],
  ["character_personality_attitude", "system.details.biography.attitude"],
  ["character_personality_likes", "system.details.biography.likes"],
  ["character_personality_dislikes", "system.details.biography.dislikes"],
  ["character_campaign_allies", "system.details.biography.allies"],
  ["character_campaign_enemies", "system.details.biography.enemies"],
  ["character_campaign_organizations", "system.details.biography.organizations"],
];

/**
 * Imports biography, deity, and organized play ID from Demiplane.
 */
export async function applyBiography(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary
): Promise<void> {
  const getValue = (name: string): string | undefined => {
    const eng = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === name);
    return eng?.value != null ? String(eng.value) : undefined;
  };

  const updates: Record<string, unknown> = {};

  for (const [engineName, path] of BIO_FIELD_MAP) {
    const value = getValue(engineName);
    if (value) updates[path] = value;
  }

  applyBackstory(updates, getValue("character_campaign_other"));
  applyListField(updates, getValue("character_personality_edicts"), "system.details.biography.edicts");
  applyListField(updates, getValue("character_personality_anathema"), "system.details.biography.anathema");
  applyOrganizedPlayId(updates, getValue("character_organizedplayid"));
  await applyDeity(actor, getValue("character_personality_beliefs"), updates, summary);

  if (Object.keys(updates).length > 0) {
    await actor.update(updates);
    summary.log.push(`+ biography: ${Object.keys(updates).length} fields`);
  }
}

function applyBackstory(updates: Record<string, unknown>, backstory: string | undefined): void {
  if (backstory)
    updates["system.details.biography.backstory"] =
      `<p>${backstory.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

function applyListField(updates: Record<string, unknown>, value: string | undefined, path: string): void {
  if (!value) return;
  updates[path] = value
    .split(/[,\n\r]+/)
    .map((s: string) => s.trim())
    .filter(Boolean);
}

function applyOrganizedPlayId(updates: Record<string, unknown>, orgPlayId: string | undefined): void {
  if (!orgPlayId) return;
  const lastDash = orgPlayId.lastIndexOf("-");
  if (lastDash > 0) {
    updates["system.pfs.playerNumber"] = parseInt(orgPlayId.slice(0, lastDash), 10) || null;
    updates["system.pfs.characterNumber"] = parseInt(orgPlayId.slice(lastDash + 1), 10) || null;
  }
}

async function applyDeity(
  actor: Actor,
  deityName: string | undefined,
  updates: Record<string, unknown>,
  summary: ImportSummary
): Promise<void> {
  // Deity — add as item from pf2e.deities compendium
  if (!deityName) return;
  const deityPack = game.packs.get("pf2e.deities");
  if (!deityPack) return;
  const index = await deityPack.getIndex();
  const match = index.find((e) => e.name?.toLowerCase() === deityName.toLowerCase());
  if (!match) {
    updates["system.details.deity.value"] = deityName;
    summary.log.push(`! deity "${deityName}" not found in compendium, set as text only`);
    return;
  }
  const deityDoc = await deityPack.getDocument(match._id);
  if (deityDoc) {
    await actor.createEmbeddedDocuments("Item", [stampImported(deityDoc.toObject())] as never);
    summary.log.push(`+ deity: ${deityName}`);
  }
}
