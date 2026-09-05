#!/usr/bin/env node
/**
 * Resets dedicated Demiplane test characters to their defined states.
 *
 * The integration specs treat these characters as fixtures: each has a
 * documented setup below, applied with plain CustomDemiplaneEngine overrides
 * (same shape PushPayloadBuilder emits). Run this after touching the
 * characters on Demiplane, or whenever a spec fails on stale fixture data.
 *
 * Usage:
 *   node scripts/reset-test-characters.mjs
 *
 * Reads DEMIPLANE_TOKEN (and the *_UUID vars, with the same fallbacks as the
 * specs) from the environment / .env. Prints a before/after diff per engine.
 */
import { randomUUID } from "crypto";
import { config } from "dotenv";
import { DemiplaneClient } from "@scooper4711/demiplane-api";

config();

const token = process.env.DEMIPLANE_TOKEN ?? "";
if (!token) {
  console.error("DEMIPLANE_TOKEN env var required");
  process.exit(1);
}

/** Desired `character-languages-user` values per test character. */
const LANGUAGE_SETUP = [
  {
    env: "BARD_UUID",
    fallback: "e3aced0a-2614-47ba-bbeb-82b871a7b9b4",
    // Comma-separated, all valid PF2e languages.
    languages: "elven, gnomish, ekujae",
  },
  {
    env: "WIZARD_CURRICULUM_UUID",
    fallback: "67536b78-49c6-44a3-a456-4852410f8604",
    // Semicolon-separated with one bogus entry to exercise the
    // unmatched-language path.
    languages: "osiriani;zz-invalid-test-language;diabolic",
  },
];

const LANGUAGES_ENGINE = "character-languages-user";

const client = new DemiplaneClient();
client.setToken(token);

function overrideEngine(name, value) {
  return {
    id: `custom_${name}`,
    name,
    value,
    type: "CustomDemiplaneEngine",
    saveType: "CharacterSheet",
    storeType: "override",
    demiplaneEngineId: randomUUID(),
    args: { id: null },
  };
}

let failed = false;
for (const { env, fallback, languages } of LANGUAGE_SETUP) {
  const characterId = process.env[env] ?? fallback;
  const data = await client.fetchCharacterData(characterId);
  const existing = data.engines.find(
    (e) => e.type === "CustomDemiplaneEngine" && e.name === LANGUAGES_ENGINE
  );
  console.log(`${env} (${data.name}): ${LANGUAGES_ENGINE} was ${JSON.stringify(existing?.value)}`);

  const engines = data.engines.filter(
    (e) => !(e.type === "CustomDemiplaneEngine" && e.name === LANGUAGES_ENGINE)
  );
  engines.push(overrideEngine(LANGUAGES_ENGINE, languages));

  const result = await client.updateCharacter({
    id: characterId,
    data: { engines, engineCacheIdsBySource: data.engineCacheIdsBySource ?? {} },
    name: data.name,
    level: data.level,
    avatarUrl: data.avatarUrl,
    viewPermission: data.viewPermission,
    editPermission: data.editPermission,
  });
  console.log(`  -> update success=${result.success} ${result.message ?? ""}`);

  const verify = await client.fetchCharacterData(characterId);
  const current = verify.engines.find(
    (e) => e.type === "CustomDemiplaneEngine" && e.name === LANGUAGES_ENGINE
  );
  const ok = current?.value === languages;
  console.log(`  -> now ${JSON.stringify(current?.value)} ${ok ? "OK" : "MISMATCH"}`);
  if (!ok) failed = true;
}

process.exit(failed ? 1 : 0);
