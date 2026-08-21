import { stampImported } from "./types.js";
import type { DemiplaneEngineEntry, ImportSummary } from "./types.js";

/**
 * Imports biography, deity, and organized play ID from Demiplane.
 */
// eslint-disable-next-line complexity -- flat field assignments, cognitively simple
export async function applyBiography(
  actor: Actor,
  engines: DemiplaneEngineEntry[],
  summary: ImportSummary,
): Promise<void> {
  const getValue = (name: string): string | undefined => {
    const eng = engines.find((e) => e.type === "CustomDemiplaneEngine" && e.name === name);
    return eng?.value != null ? String(eng.value) : undefined;
  };

  const updates: Record<string, unknown> = {};

  const gender = getValue("character_appearance_gender");
  if (gender) updates["system.details.gender.value"] = gender;

  const age = getValue("character_appearance_age");
  if (age) updates["system.details.age.value"] = age;

  const ethnicity = getValue("character_appearance_ethnicity");
  if (ethnicity) updates["system.details.ethnicity.value"] = ethnicity;

  const nationality = getValue("character_appearance_nationality");
  if (nationality) updates["system.details.nationality.value"] = nationality;

  const height = getValue("character_appearance_height");
  if (height) updates["system.details.height.value"] = height;

  const weight = getValue("character_appearance_weight");
  if (weight) updates["system.details.weight.value"] = weight;

  const birthplace = getValue("character_appearance_birthplace");
  if (birthplace) updates["system.details.biography.birthPlace"] = birthplace;

  const appearance = getValue("character_appearance_appearance");
  if (appearance) updates["system.details.biography.appearance"] = appearance;

  const catchphrases = getValue("character_personality_catchphrases");
  if (catchphrases) updates["system.details.biography.catchphrases"] = catchphrases;

  const backstory = getValue("character_campaign_other");
  if (backstory) updates["system.details.biography.backstory"] = `<p>${backstory.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;

  // Deity — add as item from pf2e.deities compendium
  const deityName = getValue("character_personality_beliefs");
  if (deityName) {
    const deityPack = game.packs.get("pf2e.deities");
    if (deityPack) {
      const index = await deityPack.getIndex();
      const match = index.find((e: { name: string }) => e.name.toLowerCase() === deityName.toLowerCase());
      if (match) {
        const deityDoc = await deityPack.getDocument(match._id);
        if (deityDoc) {
          await actor.createEmbeddedDocuments("Item", [stampImported(deityDoc.toObject())] as never);
          summary.log.push(`+ deity: ${deityName}`);
        }
      } else {
        updates["system.details.deity.value"] = deityName;
        summary.log.push(`! deity "${deityName}" not found in compendium, set as text only`);
      }
    }
  }

  const attitude = getValue("character_personality_attitude");
  if (attitude) updates["system.details.biography.attitude"] = attitude;

  const likes = getValue("character_personality_likes");
  if (likes) updates["system.details.biography.likes"] = likes;

  const dislikes = getValue("character_personality_dislikes");
  if (dislikes) updates["system.details.biography.dislikes"] = dislikes;

  const allies = getValue("character_campaign_allies");
  if (allies) updates["system.details.biography.allies"] = allies;

  const enemies = getValue("character_campaign_enemies");
  if (enemies) updates["system.details.biography.enemies"] = enemies;

  const organizations = getValue("character_campaign_organizations");
  if (organizations) updates["system.details.biography.organizations"] = organizations;

  const edicts = getValue("character_personality_edicts");
  if (edicts) updates["system.details.biography.edicts"] = edicts.split(/[,\n\r]+/).map((s: string) => s.trim()).filter(Boolean);

  const anathema = getValue("character_personality_anathema");
  if (anathema) updates["system.details.biography.anathema"] = anathema.split(/[,\n\r]+/).map((s: string) => s.trim()).filter(Boolean);

  const orgPlayId = getValue("character_organizedplayid");
  if (orgPlayId) {
    const lastDash = orgPlayId.lastIndexOf("-");
    if (lastDash > 0) {
      updates["system.pfs.playerNumber"] = parseInt(orgPlayId.slice(0, lastDash), 10) || null;
      updates["system.pfs.characterNumber"] = parseInt(orgPlayId.slice(lastDash + 1), 10) || null;
    }
  }

  if (Object.keys(updates).length > 0) {
    await actor.update(updates);
    summary.log.push(`+ biography: ${Object.keys(updates).length} fields`);
  }
}
