#!/usr/bin/env node
/**
 * Re-populates a Demiplane character from a dump file.
 *
 * Writes ONLY to the target UUID given on the command line (never a default),
 * so restoring takes explicit intent. Pairs with
 * scripts/demiplane-dump-character.mjs; use it to reset FVTT fixture
 * characters after someone touches them on Demiplane.
 *
 * Usage:
 *   node scripts/demiplane-restore-character.mjs <dump-file> <target-uuid> [--name override]
 *
 * The character name restores from the dump unless --name overrides it. Reads
 * DEMIPLANE_TOKEN from the environment / .env. Verifies by re-fetching the
 * target and comparing engine counts.
 */
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import { DemiplaneClient } from "@scooper4711/demiplane-api";

config();

const positional = [];
let nameOverride = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--name" && i + 1 < process.argv.length) {
    nameOverride = process.argv[++i];
  } else if (!process.argv[i].startsWith("--")) {
    positional.push(process.argv[i]);
  }
}

const [dumpPath, targetId] = positional;
if (!dumpPath || !targetId) {
  console.error("usage: node scripts/demiplane-restore-character.mjs <dump-file> <target-uuid> [--name override]");
  process.exit(1);
}

const token = process.env.DEMIPLANE_TOKEN ?? "";
if (!token) {
  console.error("DEMIPLANE_TOKEN env var required");
  process.exit(1);
}

const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
if (!Array.isArray(dump.engines)) {
  console.error(`invalid dump file (no engines array): ${dumpPath}`);
  process.exit(1);
}
console.log(`dump: ${dump.name} (level ${dump.level}, ${dump.engines.length} engines, dumped ${dump.dumpedAt})`);

const client = new DemiplaneClient();
client.setToken(token);

const result = await client.updateCharacter({
  id: targetId,
  data: { engines: dump.engines, engineCacheIdsBySource: dump.engineCacheIdsBySource ?? {} },
  name: nameOverride ?? dump.name,
  level: dump.level,
  avatarUrl: dump.avatarUrl,
  viewPermission: dump.viewPermission,
  editPermission: dump.editPermission,
  // Builder-maintained overview blob ("Lvl X Class" subtitle) — present in
  // dumps taken after this field was added; older dumps restore without it.
  formatedData: dump.formatedData,
});
if (!result.success) {
  console.error(`restore failed: ${result.message}`);
  process.exit(1);
}

const target = await client.fetchCharacterData(targetId);
console.log(`target: ${target.name} (level ${target.level}), engines: ${target.engines.length}`);
if (target.engines.length !== dump.engines.length) {
  console.error("MISMATCH: engine counts differ");
  process.exit(1);
}
console.log("restore verified");
