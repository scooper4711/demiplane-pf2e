#!/usr/bin/env node
/**
 * Copies a Demiplane character's engine payload into another character slot.
 *
 * The source is only ever read; the target is the only character written, and
 * the script refuses to run when source and target are the same UUID. Useful
 * for cloning a player's character into a disposable FVTT fixture slot.
 *
 * Usage:
 *   node scripts/demiplane-copy-character.mjs <source-uuid> <target-uuid> [new-name]
 *
 * Reads DEMIPLANE_TOKEN from the environment / .env. Verifies the copy by
 * re-fetching the target and comparing engine counts.
 */
import { config } from "dotenv";
import { DemiplaneClient } from "@scooper4711/demiplane-api";

config();

const [sourceId, targetId, newName] = process.argv.slice(2);
if (!sourceId || !targetId) {
  console.error("usage: node scripts/demiplane-copy-character.mjs <source-uuid> <target-uuid> [new-name]");
  process.exit(1);
}
if (sourceId === targetId) {
  console.error("refusing: source and target are the same character");
  process.exit(1);
}

const token = process.env.DEMIPLANE_TOKEN ?? "";
if (!token) {
  console.error("DEMIPLANE_TOKEN env var required");
  process.exit(1);
}

const client = new DemiplaneClient();
client.setToken(token);

// Read-only on the source: fetch its full engine payload.
const source = await client.fetchCharacterData(sourceId);
console.log(`source: ${source.name} (level ${source.level}), engines: ${source.engines.length}`);

// The sheet display name lives in the `character_name` override engine, not
// just the top-level name field — rewrite it so the rename sticks.
const engines =
  newName == null
    ? source.engines
    : source.engines.map((e) => (e.name === "character_name" ? { ...e, value: newName } : e));

// Write-only on the target: persist the source payload under the target id.
// The full meta passthrough (avatar/permissions) mirrors
// scripts/reset-test-characters.mjs — omitting it makes the mutation fail.
const result = await client.updateCharacter({
  id: targetId,
  data: { engines, engineCacheIdsBySource: source.engineCacheIdsBySource ?? {} },
  name: newName ?? source.name,
  level: source.level,
  avatarUrl: source.avatarUrl,
  viewPermission: source.viewPermission,
  editPermission: source.editPermission,
});
if (!result.success) {
  console.error(`copy failed: ${result.message}`);
  process.exit(1);
}

// Verify the target now mirrors the source.
const target = await client.fetchCharacterData(targetId);
console.log(`target: ${target.name} (level ${target.level}), engines: ${target.engines.length}`);
if (target.engines.length !== source.engines.length) {
  console.error("MISMATCH: engine counts differ");
  process.exit(1);
}
console.log("copy verified");
