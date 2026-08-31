#!/usr/bin/env node
/**
 * Demiplane Character CLI
 *
 * Fetches a Demiplane character and outputs a human-readable JSON summary.
 * Reuses the same API functions as the Demiplane MCP server.
 *
 * Usage:
 *   node scripts/demiplane-character.mjs <character-uuid>
 *   node scripts/demiplane-character.mjs <character-uuid> --output char.json
 *   node scripts/demiplane-character.mjs <character-uuid> --raw
 */

import {
  loadToken,
  fetchCharacter,
  fetchEngineDefinitions,
  buildReadableCharacter,
} from "./demiplane-api.mjs";

// ── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const positional = [];
let outputFile = null;
let rawMode = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--raw") {
    rawMode = true;
  } else if (args[i] === "--output" && i + 1 < args.length) {
    outputFile = args[++i];
  } else if (!args[i].startsWith("--")) {
    positional.push(args[i]);
  }
}

const characterId = positional[0];

if (!characterId) {
  process.stderr.write("Usage: demiplane-character <uuid> [--raw] [--output file]\n");
  process.stderr.write("  --raw     Output raw character data instead of readable summary\n");
  process.stderr.write("  --output  Write JSON to file instead of stdout\n");
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const token = loadToken();

  process.stderr.write(`Fetching character ${characterId}...\n`);
  const character = await fetchCharacter(characterId, token);

  let output;
  if (rawMode) {
    output = character;
  } else {
    const engineIds = (character.engines ?? []).map((e) => e.id);
    process.stderr.write(`Resolving ${engineIds.length} engine entries...\n`);
    const engineDefs = await fetchEngineDefinitions(engineIds, token);
    output = buildReadableCharacter(character, engineDefs);
  }

  const json = JSON.stringify(output, null, 2);

  if (outputFile) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outputFile, json + "\n");
    process.stderr.write(`Wrote ${outputFile} (${json.length} bytes)\n`);
  } else {
    process.stdout.write(json + "\n");
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
