#!/usr/bin/env node
/**
 * Demiplane MCP Server
 *
 * Provides tools for agents to query the Demiplane character API.
 *
 * Tools:
 *   dump_character           – raw character data (engines + metadata)
 *   fetch_engine_definitions – resolve engine IDs to display names + modifiers
 *   fetch_attribute_mapping  – store-name-to-description mapping per game system
 *   dump_character_readable  – human-readable character summary
 *
 * Usage:
 *   node scripts/demiplane-mcp.mjs
 *
 * Configure in opencode.json:
 *   "mcpServers": {
 *     "demiplane": {
 *       "command": "node",
 *       "args": ["scripts/demiplane-mcp.mjs"]
 *     }
 *   }
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  loadToken,
  fetchCharacter,
  fetchEngineDefinitions,
  fetchAttributeMapping,
  buildReadableCharacter,
  fetchCharacterJournals,
} from "./demiplane-api.mjs";

// ── MCP Server ───────────────────────────────────────────────────────────────

const token = loadToken();

const server = new McpServer({
  name: "demiplane",
  version: "1.0.0",
});

// Tool 1: Raw character data
server.registerTool("dump_character", {
  title: "Dump Demiplane Character",
  description:
    "Downloads the raw Demiplane character sheet by UUID. Returns all engine entries (selections, overrides) and metadata. Use fetch_engine_definitions to resolve engine IDs to display names.",
  inputSchema: {
    character_id: z.string().describe("The UUID of the Demiplane character"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ character_id }) => {
  try {
    const character = await fetchCharacter(character_id, token);
    return { content: [{ type: "text", text: JSON.stringify(character, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

// Tool 2: Engine definitions
server.registerTool("fetch_engine_definitions", {
  title: "Fetch Engine Definitions",
  description:
    "Resolves Demiplane engine instance IDs to their display names and modifiers (spells granted, proficiency changes, etc.). Pass the engine IDs from a character's engines[].id array.",
  inputSchema: {
    engine_ids: z.array(z.string()).describe("Array of engine instance IDs (engines[].id from character data)"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ engine_ids }) => {
  try {
    const defs = await fetchEngineDefinitions(engine_ids, token);
    return { content: [{ type: "text", text: JSON.stringify(defs, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

// Tool 3: Attribute mapping
server.registerTool("fetch_attribute_mapping", {
  title: "Fetch Attribute Mapping",
  description:
    "Returns the attribute mapping for a game system (nexus). Maps internal store names (e.g. 'character_name', 'hit_points') to human-readable descriptions. Nexus 1 = Pathfinder 2e.",
  inputSchema: {
    nexus_id: z.number().int().positive().describe("The nexus (game system) ID. 1 = Pathfinder 2e"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ nexus_id }) => {
  try {
    const mapping = await fetchAttributeMapping(nexus_id, token);
    return { content: [{ type: "text", text: JSON.stringify(mapping, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

// Tool 4: Human-readable character dump
server.registerTool("dump_character_readable", {
  title: "Dump Character (Readable)",
  description:
    "Downloads a Demiplane character and produces a human-readable JSON summary with display names, categorized feats/equipment, and custom overrides.",
  inputSchema: {
    character_id: z.string().describe("The UUID of the Demiplane character"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ character_id }) => {
  try {
    const character = await fetchCharacter(character_id, token);
    const engineIds = (character.engines ?? []).map((e) => e.id);
    const engineDefs = await fetchEngineDefinitions(engineIds, token);
    const readable = buildReadableCharacter(character, engineDefs);
    return { content: [{ type: "text", text: JSON.stringify(readable, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

// Tool 5: Character journal entries
server.registerTool("dump_character_journals", {
  title: "Dump Character Journals",
  description:
    "Fetches all journal entries (notes) for a Demiplane character. Each entry has a title, description, and objectID.",
  inputSchema: {
    character_id: z.string().describe("The UUID of the Demiplane character"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ character_id }) => {
  try {
    const journals = await fetchCharacterJournals(character_id, token);
    return { content: [{ type: "text", text: JSON.stringify(journals, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
