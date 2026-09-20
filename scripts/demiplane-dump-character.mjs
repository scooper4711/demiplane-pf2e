#!/usr/bin/env node
/**
 * Stores a Demiplane character's full payload (engines + meta) to a JSON file.
 *
 * Read-only: never writes to Demiplane. The dump pairs with
 * scripts/demiplane-restore-character.mjs to re-populate FVTT fixture
 * characters after someone touches them on Demiplane.
 *
 * Usage:
 *   node scripts/demiplane-dump-character.mjs <character-uuid> [--output path.json]
 *
 * Default output is tests/fixtures/demiplane-characters/<uuid>.json. Reads
 * DEMIPLANE_TOKEN from the environment / .env.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "dotenv";
import { DemiplaneClient } from "@scooper4711/demiplane-api";

config();

const positional = [];
let output = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--output" && i + 1 < process.argv.length) {
    output = process.argv[++i];
  } else if (!process.argv[i].startsWith("--")) {
    positional.push(process.argv[i]);
  }
}

const characterId = positional[0];
if (!characterId) {
  console.error("usage: node scripts/demiplane-dump-character.mjs <character-uuid> [--output path.json]");
  process.exit(1);
}

const token = process.env.DEMIPLANE_TOKEN ?? "";
if (!token) {
  console.error("DEMIPLANE_TOKEN env var required");
  process.exit(1);
}

const outPath = output ?? resolve("tests/fixtures/demiplane-characters", `${characterId}.json`);

const client = new DemiplaneClient();
client.setToken(token);

const data = await client.fetchCharacterData(characterId);
const dump = {
  characterId,
  dumpedAt: new Date().toISOString(),
  name: data.name,
  level: data.level,
  avatarUrl: data.avatarUrl,
  viewPermission: data.viewPermission,
  editPermission: data.editPermission,
  // Builder-maintained overview blob ("Lvl X Class" subtitle) — restores must
  // pass it back or the subtitle is nulled.
  formatedData: data.formatedData,
  engineCacheIdsBySource: data.engineCacheIdsBySource ?? {},
  engines: data.engines,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(dump, null, 2)}\n`);
console.log(`dumped ${data.name} (level ${data.level}, ${data.engines.length} engines) -> ${outPath}`);
