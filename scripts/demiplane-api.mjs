/**
 * Shared Demiplane API functions used by both the MCP server and CLI tools.
 *
 * Exports: loadToken, fetchCharacter, fetchEngineDefinitions,
 *          fetchAttributeMapping, buildReadableCharacter
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Constants ────────────────────────────────────────────────────────────────

const GRAPHQL_ENDPOINT = "https://apiv4.demiplane.com/v1/graphql";
const STREAM_ENGINES_URL = "https://character.demiplane.com/stream-engines";
const ENGINE_SOURCE = "pathfinder2e-v2";
const NEXUS_SLUG = "pathfinder2e";

// ── Load token from .env ─────────────────────────────────────────────────────

export function loadToken() {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "..", ".env");
  const env = readFileSync(envPath, "utf-8");
  const match = env.match(/^DEMIPLANE_TOKEN=(.+)$/m);
  if (!match) throw new Error("DEMIPLANE_TOKEN not found in .env");
  return match[1].trim();
}

// ── GraphQL queries ──────────────────────────────────────────────────────────

const CHARACTER_QUERY = `query character_data($id: uuid!) {
  demiplane_user_character(
    where: {uuid: {_eq: $id}, deleted_at: {_is_null: true}, enabled: {_eq: true}}
  ) {
    data
    name
    level
    avatar_url
    view_permission
    edit_permission
    updated
  }
}`;

const ATTRIBUTE_MAPPING_QUERY = `query getCharacterAttributeMapping($nexusId: Int!) {
  demiplane_character_attribute_mapping(where: {nexus_id: {_eq: $nexusId}}) {
    nexus_id
    id
    attribute_mapping
  }
}`;

// ── Fetch character from GraphQL ─────────────────────────────────────────────

export async function fetchCharacter(characterId, token) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: CHARACTER_QUERY,
      variables: { id: characterId },
    }),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  const row = json.data?.demiplane_user_character?.[0];
  if (!row || !row.data) throw new Error(`Character not found: ${characterId}`);

  return {
    ...row.data,
    ...(row.name ? { name: row.name } : {}),
    ...(row.level !== null ? { level: row.level } : {}),
    ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
    ...(row.view_permission !== null ? { viewPermission: row.view_permission } : {}),
    ...(row.edit_permission !== null ? { editPermission: row.edit_permission } : {}),
    ...(row.updated ? { updated: row.updated } : {}),
  };
}

// ── Stream-engines: fetch engine definitions ─────────────────────────────────

function splitNdjson(text) {
  return text.split("\n").filter((line) => line.trim());
}

function parseStringObjects(nodes) {
  const results = [];
  for (const node of nodes) {
    if (node.name !== "StringObject" || !node.data?.string) continue;
    try {
      results.push(JSON.parse(node.data.string));
    } catch {
      // skip malformed
    }
  }
  return results;
}

function parseEngineLine(line) {
  try {
    const parsed = JSON.parse(line);
    const objects = parseStringObjects(Object.values(parsed.data?.nodes ?? {}));
    for (const obj of objects) {
      const modifiers = (obj.engineModifiers ?? []).filter(
        (m) => m && typeof m === "object" && typeof m.type === "string"
      );
      if (modifiers.length > 0) {
        return { id: parsed.id, name: obj.name ?? undefined, modifiers };
      }
    }
    return { id: parsed.id, name: undefined, modifiers: [] };
  } catch {
    return { id: undefined, name: undefined, modifiers: [] };
  }
}

async function postStreamEngines(engineIds, token) {
  const response = await fetch(STREAM_ENGINES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      engineIdsBySource: { [ENGINE_SOURCE]: engineIds },
      isSheet: true,
      nexusSlug: NEXUS_SLUG,
    }),
  });
  if (!response.ok) throw new Error(`stream-engines HTTP ${response.status}`);
  return response.text();
}

export async function fetchEngineDefinitions(engineIds, token) {
  if (engineIds.length === 0) return [];
  const text = await postStreamEngines(engineIds, token);
  return splitNdjson(text).map(parseEngineLine);
}

// ── Attribute mapping ────────────────────────────────────────────────────────

export async function fetchAttributeMapping(nexusId, token) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: ATTRIBUTE_MAPPING_QUERY,
      variables: { nexusId },
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  const mapping = json.data?.demiplane_character_attribute_mapping?.[0];
  if (!mapping) throw new Error(`No attribute mapping found for nexus: ${nexusId}`);
  return {
    nexusId: mapping.nexus_id,
    id: mapping.id,
    attributeMapping: mapping.attribute_mapping,
  };
}

// ── Human-readable character builder ─────────────────────────────────────────

function slugToTitle(slug) {
  if (!slug) return "";
  return slug
    .replace(/-rm$/, "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function categorizeEngine(name) {
  if (!name) return "other";
  if (name.startsWith("tabula/feat/")) return "feat";
  if (name.startsWith("tabula/item/")) return "equipment";
  if (name.startsWith("tabula/class/")) return "class";
  if (name.startsWith("tabula/ancestry/")) return "ancestry";
  if (name.startsWith("tabula/heritage/")) return "heritage";
  if (name.startsWith("tabula/background/")) return "background";
  if (name.startsWith("tabula/generic-feature/")) return "feature";
  if (name.startsWith("core/selection/attribute/")) return "abilityBoost";
  if (name.startsWith("core/selection/skill/")) return "skillChoice";
  if (name.startsWith("core/")) return "core";
  if (name === "custom_character_name") return "identity";
  if (name === "custom_character_level") return "identity";
  if (name === "custom_character_avatar") return "identity";
  if (name.startsWith("custom_character_appearance_")) return "appearance";
  if (name.startsWith("custom_character_personality_")) return "personality";
  if (name.startsWith("custom_character_campaign_")) return "campaign";
  if (name.startsWith("custom_character_hit-points")) return "health";
  if (name.startsWith("custom_character_hero-points")) return "health";
  if (name.startsWith("custom_character_currency_")) return "currency";
  if (name.startsWith("custom_character_hand_")) return "equipment";
  if (name.startsWith("custom_character_organizedplayid")) return "identity";
  if (name.startsWith("custom_") && name.endsWith("--quantity")) return "equipment";
  if (name.startsWith("custom_") && name.endsWith("-container")) return "equipment";
  if (name.startsWith("custom_") && name.endsWith("-is-equipped")) return "equipment";
  if (name.startsWith("custom_") && name.endsWith("--overridden")) return "skillChoice";
  if (name.startsWith("custom_") && name.includes("_prof")) return "skillChoice";
  if (name.startsWith("custom_") && name.includes("-rune")) return "equipment";
  if (name === "character-languages-user") return "language";
  if (name === "getting-started-current" || name === "tab-spells--display" || name.includes("is-selected")) return "uiState";
  if (name === "selected-pregen-id" || name === "view-permission" || name === "edit-permission") return "meta";
  if (name.endsWith("--quantity") || name.endsWith("-container") || name.endsWith("-is-equipped")) return "equipment";
  if (name.endsWith("-rune")) return "equipment";
  if (name.startsWith("custom_")) return "customOverride";
  if (name.startsWith("character_")) return "customOverride";
  return "customOverride";
}

export function buildReadableCharacter(character, engineDefs) {
  const defMap = new Map();
  for (const def of engineDefs) {
    if (def.id) defMap.set(def.id, def);
  }

  const engines = character.engines ?? [];
  const categories = {};

  for (const eng of engines) {
    const cat = categorizeEngine(eng.name);
    if (!categories[cat]) categories[cat] = [];

    const def = defMap.get(eng.id);
    const entry = {
      id: eng.id,
      name: eng.name,
      displayName: def?.name ?? slugToTitle(eng.name?.split("/").pop()?.replace(/\.eng$/, "")),
    };

    if (eng.type === "CustomDemiplaneEngine" && eng.value !== undefined) {
      entry.value = eng.value;
    }
    if (eng.args?.slug) entry.slug = eng.args.slug;
    if (eng.args?.level !== undefined) entry.level = eng.args.level;
    if (eng.args?.sourceRow) entry.sourceRow = eng.args.sourceRow;

    if (def?.modifiers?.length) {
      entry.modifiers = def.modifiers.map((m) => {
        const mod = { type: m.type };
        if (m.addSpell) mod.spell = m.addSpell;
        if (m.tradition) mod.tradition = m.tradition;
        if (m.level !== undefined) mod.level = m.level;
        if (m.spells) mod.spells = m.spells;
        if (m.slug) mod.slug = m.slug;
        if (m.slots) mod.slots = m.slots;
        return mod;
      });
    }

    categories[cat].push(entry);
  }

  const summary = {
    name: character.name,
    level: character.level,
  };

  const identity = categories.identity ?? [];
  for (const e of identity) {
    if (e.name === "custom_character_name") summary.name = e.value;
    if (e.name === "custom_character_level") summary.level = e.value;
  }

  const classEngines = categories.class ?? [];
  const ancestryEngines = categories.ancestry ?? [];
  const heritageEngines = categories.heritage ?? [];
  const backgroundEngines = categories.background ?? [];

  if (classEngines.length) summary.class = classEngines.map((e) => e.displayName).join(", ");
  if (ancestryEngines.length) summary.ancestry = ancestryEngines.map((e) => e.displayName).join(", ");
  if (heritageEngines.length) summary.heritage = heritageEngines.map((e) => e.displayName).join(", ");
  if (backgroundEngines.length) summary.background = backgroundEngines.map((e) => e.displayName).join(", ");

  summary.featCount = (categories.feat ?? []).length;
  summary.equipmentCount = (categories.equipment ?? []).length;
  summary.featureCount = (categories.feature ?? []).length;

  const health = categories.health ?? [];
  for (const e of health) {
    if (e.name === "custom_character_hit-points_current") summary.hitPoints = e.value;
    if (e.name === "custom_character_hit-points_temp") summary.temporaryHP = e.value;
    if (e.name === "custom_character_hero-points") summary.heroPoints = e.value;
  }

  const currency = categories.currency ?? [];
  if (currency.length) {
    summary.currency = {};
    for (const e of currency) {
      const metal = e.name.replace("custom_character_currency_", "");
      summary.currency[metal] = e.value;
    }
  }

  const appearance = categories.appearance ?? [];
  if (appearance.length) {
    summary.appearance = {};
    for (const e of appearance) {
      const field = e.name.replace("custom_character_appearance_", "");
      summary.appearance[field] = e.value;
    }
  }

  const personality = categories.personality ?? [];
  if (personality.length) {
    summary.personality = {};
    for (const e of personality) {
      const field = e.name.replace("custom_character_personality_", "");
      summary.personality[field] = e.value;
    }
  }

  const campaign = categories.campaign ?? [];
  if (campaign.length) {
    summary.campaign = {};
    for (const e of campaign) {
      const field = e.name.replace("custom_character_campaign_", "");
      summary.campaign[field] = e.value;
    }
  }

  const feats = categories.feat ?? [];
  if (feats.length) {
    summary.feats = feats.map((e) => ({
      name: e.displayName,
      slug: e.slug,
      level: e.level,
    }));
  }

  const equipment = categories.equipment ?? [];
  if (equipment.length) {
    summary.equipment = equipment.map((e) => ({
      name: e.displayName,
      ...(e.value !== undefined ? { value: e.value } : {}),
    }));
  }

  const features = categories.feature ?? [];
  if (features.length) {
    summary.features = features.map((e) => e.displayName);
  }

  const abilityBoosts = categories.abilityBoost ?? [];
  if (abilityBoosts.length) {
    summary.abilityBoosts = abilityBoosts.map((e) => ({
      name: e.displayName,
      slug: e.slug,
      level: e.level,
    }));
  }

  const skillChoices = categories.skillChoice ?? [];
  if (skillChoices.length) {
    summary.skillChoices = skillChoices.map((e) => ({
      name: e.displayName,
      ...(e.value !== undefined ? { value: e.value } : {}),
    }));
  }

  return {
    summary,
    categories,
    engineCount: engines.length,
    engineDefCount: engineDefs.length,
  };
}
