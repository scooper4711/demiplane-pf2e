# Demiplane API Reference

This document describes the two Demiplane APIs consumed by this module: the **GraphQL API** for character data CRUD and the **Stream-Engines API** for computed character features (spell slots, granted spells, item spells).

---

## Table of Contents

- [GraphQL API](#graphql-api)
  - [Endpoint](#endpoint)
  - [Authentication](#authentication)
  - [Character Data Model](#character-data-model)
  - [Engine Types](#engine-types)
  - [Query: Fetch Character Data](#query-fetch-character-data)
  - [Query: Fetch Character Version](#query-fetch-character-version)
  - [Mutation: Update Character](#mutation-update-character)
  - [Character Journals](#character-journals)
  - [Session State Store Names](#session-state-store-names)
- [Stream-Engines API](#stream-engines-api)
  - [Endpoint](#stream-engines-endpoint)
  - [Request Format](#request-format)
  - [Response Format (NDJSON)](#response-format-ndjson)
  - [Parsing Pattern](#parsing-pattern)
  - [Modifier Types](#modifier-types)
- [Engine Name Conventions](#engine-name-conventions)
- [Slug Conventions](#slug-conventions)
- [API Access Layering (and Known Bypasses)](#api-access-layering-and-known-bypasses)

---

## GraphQL API

### Endpoint

```
POST https://apiv4.demiplane.com/v1/graphql
```

All requests are standard GraphQL POST requests with `Content-Type: application/json`.

### Authentication

The API accepts an optional `Authorization: Bearer <token>` header. The token is a Hasura JWT obtained externally (e.g., from an authenticated browser session on `app.demiplane.com`).

- **Read operations** (fetching public character data) work without authentication.
- **Write operations** (`updateCharacterV2` mutation) require a valid bearer token.

This module stores the token in a Foundry client setting (`demiplaneToken`). The `@scooper4711/demiplane-api` package handles token attachment via `DemiplaneClient.setToken()`.

### Character Data Model

A character in Demiplane is represented as an array of **engines**. Each engine is either a selection from game content (ancestry, class, feat, spell) or a user-editable override value (HP, hero points, currency).

```
Character
└── data
    ├── engines: Engine[]            ← all selections + overrides
    └── engineCacheIdsBySource: {}   ← internal cache metadata
```

### Engine Types

There are two engine discriminators:

#### DemiplaneEngine

Represents a game content selection (class, ancestry, feat, spell, equipment, etc.).

```typescript
{
  id: string;                    // UUID — unique instance ID
  demiplaneEngineId: string;     // UUID — the engine definition ID
  name: string;                  // qualified path, e.g. "tabula/class/wizard-rm.eng"
  type: "DemiplaneEngine";
  saveType: "CharacterBuilder" | "CharacterSheet";
  args: {
    id: string | null;
    slug?: string;               // URL-safe content identifier, e.g. "wizard-rm"
    sourceRow?: string;          // source context, e.g. "select-feat-ancestry-1"
    parentEngine?: string;       // UUID of parent engine
    builderSection?: string;     // UI section in character builder
    name?: string;               // display name
    tableID?: string;            // data table identifier
    selectionGroup?: string;     // mutually exclusive group key
    selectionRank?: number;      // rank within group
    // Spell-specific args:
    spellSlot?: string;          // e.g. "wizard-spellcasting-rm-rank-3"
    parentSpellFeature?: string; // e.g. "wizard-spellcasting-rm"
    isPrepare?: boolean;         // true = prepared in a slot
    addSpellData?: {
      baseSpellbookSpell: boolean;  // true = added to spellbook
    };
    [key: string]: unknown;      // additional game-specific properties
  }
}
```

#### CustomEngine (CustomDemiplaneEngine)

Represents a user-editable override value (session state).

```typescript
{
  id: string;
  demiplaneEngineId: string;
  name: string;                  // store name, e.g. "character_hit-points_current"
  type: "CustomDemiplaneEngine";
  saveType: "CharacterBuilder" | "CharacterSheet";
  storeType: "override";
  value: string | number | boolean;   // the stored value
  args: { id: string | null; [key: string]: unknown }
}
```

### Query: Fetch Character Data

Returns the full engines array for a character.

```graphql
query character_data($id: uuid!) {
  demiplane_user_character(where: { uuid: { _eq: $id }, deleted_at: { _is_null: true }, enabled: { _eq: true } }) {
    data
  }
}
```

**Variables:** `{ "id": "<character-uuid>" }`

**Response shape:**

```json
{
  "data": {
    "demiplane_user_character": [
      {
        "data": {
          "engines": [/* Engine[] */],
          "engineCacheIdsBySource": {/* ... */}
        }
      }
    ]
  }
}
```

### Query: Fetch Character Version

Returns the character's `version` field. This field exists in the API but **does not reliably increment** when a character is saved via the character builder. It is used only for validating that a character UUID is accessible (the `CharacterLinkDialog` calls this as a lightweight existence check).

```graphql
query character_version($id: uuid!) {
  demiplane_user_character(where: { uuid: { _eq: $id }, deleted_at: { _is_null: true }, enabled: { _eq: true } }) {
    uuid
    version
  }
}
```

**Response shape:**

```json
{
  "data": {
    "demiplane_user_character": [{ "uuid": "...", "version": 42 }]
  }
}
```

> **Note:** Do not rely on `version` for conflict detection or change tracking. The value does not increment predictably. This module uses a delete-and-reimport strategy instead.

### Mutation: Update Character

Pushes updated character data back to Demiplane. Requires authentication.

```graphql
mutation updateCharacterV2(
  $id: String!
  $data: json!
  $name: String
  $level: Int
  $classSlug: String
  $avatarUrl: String
  $viewPermission: Int
  $editPermission: Int
) {
  updateCharacterV2(
    id: $id
    data: $data
    name: $name
    level: $level
    classSlug: $classSlug
    avatarUrl: $avatarUrl
    viewPermission: $viewPermission
    editPermission: $editPermission
  ) {
    message
    result
    success
  }
}
```

**Variables:** The `data` field is the full `{ engines, engineCacheIdsBySource }` object.

**Response:** `{ success: boolean, message: string }`

### Character Journals

Journal entries are freeform character notes (a `title` plus a body). They are
separate from the engines array and are addressed by their own `objectID`. By
default a character has no journal entries; they are created on demand.

This module maps the Foundry Campaign **Notes** field
(`system.details.biography.campaignNotes`, the Biography tab → Campaign section)
to a journal entry titled **"Campaign"**: importing copies the Campaign journal
body into Campaign Notes, and editing Campaign Notes creates or updates the
Campaign journal.

> **Do not confuse this with `biography.backstory`.** That is the separate
> Personality-tab backstory, populated from the `character_campaign_other`
> engine value — not from a journal. Mapping the journal to `backstory` causes
> the two importers to fight over the same field.

> **Critical schema gotcha — `data` is a scalar.**
> On all three journal operations the `data` field is a **scalar JSON blob**,
> not a GraphQL object. Requesting a subselection such as `data { items { ... } }`
> or `data { item { ... } }` fails validation with:
>
> ```
> unexpected subselection set for non-object field
> ```
>
> Always select `data` as a bare scalar and read `items` / `item` from the
> parsed JSON in code.

> **Body field gotcha — read `description`, write `content`.**
> The mutations take a `content` variable, and the server mirrors that value
> into **both** the `content` and `description` fields on the stored entry.
> Reads should use `description` (the stored body); older entries created by
> other paths may have an empty `content` but a populated `description`.

#### Query: Fetch Character Journals

```graphql
query slsGetCharacterJournals($characterId: String!, $search: String!, $ranking: String!) {
  slsGetCharacterJournals(characterId: $characterId, search: $search, ranking: $ranking) {
    data # scalar JSON: { items: CharacterJournal[] }
    error
    message
    success
  }
}
```

**Variables:** `{ "characterId": "<uuid>", "search": "", "ranking": "desc(lastModified)" }`

#### Mutation: Create Character Journal

```graphql
mutation slsCreateCharacterJournal($characterId: String!, $title: String!, $content: String!) {
  slsCreateCharacterJournal(characterId: $characterId, title: $title, content: $content) {
    data # scalar JSON: { item: CharacterJournal }
    error
    message
    success
  }
}
```

#### Mutation: Update Character Journal

```graphql
mutation slsUpdateCharacterJournal($objectID: String!, $characterId: String!, $title: String!, $content: String!) {
  slsUpdateCharacterJournal(objectID: $objectID, characterId: $characterId, title: $title, content: $content) {
    data # scalar JSON: { item: CharacterJournal }
    error
    message
    success
  }
}
```

**CharacterJournal shape:**

```typescript
{
  objectID: string; // journal entry UUID
  characterId: string;
  title: string; // e.g. "Campaign"
  content: string; // body (mirror of description)
  description: string; // body — read this
  createdDate: string; // ISO timestamp
  lastModified: string; // ISO timestamp
}
```

These operations are exposed by `@scooper4711/demiplane-api` as
`DemiplaneClient.fetchCharacterJournals`, `createCharacterJournal`, and
`updateCharacterJournal`.

### Session State Store Names

These CustomEngine `name` values represent user-mutable session state tracked by the export system:

| Store Name                     | Type   | Description          |
| ------------------------------ | ------ | -------------------- |
| `character_hit-points_current` | number | Current HP           |
| `character_hit-points_temp`    | number | Temporary HP         |
| `character_hero-points`        | number | Hero points          |
| `character_focus_current`      | number | Current focus points |
| `character_currency_gold`      | number | Gold pieces          |
| `character_currency_silver`    | number | Silver pieces        |
| `character_currency_copper`    | number | Copper pieces        |
| `character_currency_platinum`  | number | Platinum pieces      |
| `character_name`               | string | Character name       |
| `character_level`              | number | Character level      |

Additional CustomEngine values used during import (biography, deity, etc.) follow the pattern `character_<section>_<field>`.

---

## Stream-Engines API

The stream-engines API returns **computed character features** — spell slot progressions, spells granted by class features, and spells provided by magical items. It processes engine definitions and returns their runtime effects.

### Stream-Engines Endpoint

```
POST https://character.demiplane.com/stream-engines
```

**No authentication required.** This endpoint is publicly accessible.

### Request Format

```json
{
  "engineIdsBySource": {
    "pathfinder2e-v2": ["<engine-uuid-1>", "<engine-uuid-2>"]
  },
  "isSheet": true,
  "nexusSlug": "pathfinder2e"
}
```

| Field               | Type                       | Description                                       |
| ------------------- | -------------------------- | ------------------------------------------------- |
| `engineIdsBySource` | `Record<string, string[]>` | Map of source nexus key to engine instance IDs    |
| `isSheet`           | `boolean`                  | Always `true` — indicates character sheet context |
| `nexusSlug`         | `string`                   | Game system identifier: `"pathfinder2e"`          |

The engine IDs are the `id` fields from `DemiplaneEngine` entries in the character data. You send the IDs of the engines whose computed effects you want to retrieve.

### Response Format (NDJSON)

The response is **Newline-Delimited JSON** (not standard JSON). Each line is an independent JSON object representing the computed output for one engine.

```
{"id":"<engine-id-1>","data":{"nodes":{...}}}
{"id":"<engine-id-2>","data":{"nodes":{...}}}
```

**Top-level per-line structure:**

```typescript
{
  id: string; // matches the requested engine ID
  data: {
    nodes: Record<string, EngineNode>;
  }
}
```

**EngineNode structure:**

```typescript
{
  name: string; // node type — we care about "StringObject"
  data: {
    string: string; // double-encoded JSON payload
  }
}
```

The actual feature data is inside `StringObject` nodes as a **double-encoded JSON string**. The `data.string` field must be parsed a second time to access the payload.

### Parsing Pattern

All three resolvers follow the same extraction pattern:

```
Response text
  → split by "\n", filter empty lines
    → parse each line as JSON (outer envelope)
      → iterate Object.values(line.data.nodes)
        → filter nodes where node.name === "StringObject"
          → JSON.parse(node.data.string) → actual payload
            → extract engineModifiers[] by type
```

**Pseudocode:**

```typescript
const lines = responseText.split("\n").filter(Boolean);
for (const line of lines) {
  const envelope = JSON.parse(line);
  for (const node of Object.values(envelope.data.nodes)) {
    if (node.name === "StringObject" && node.data?.string) {
      const payload = JSON.parse(node.data.string);
      // payload.engineModifiers contains the computed effects
    }
  }
}
```

### Modifier Types

The `engineModifiers` array in the parsed payload contains the computed effects. Each modifier has a `type` discriminator.

#### `v2-add-spell-slots` — Spell Slot Progression

Returned when requesting a spellcasting class engine (e.g., the wizard class engine).

```typescript
{
  type: "v2-add-spell-slots";
  slug: string;                  // spellcasting feature slug
  slots: DemiplaneSlotEntry[];
}
```

**DemiplaneSlotEntry:**

```typescript
{
  rank: number; // 0 = cantrips, 1–10 = spell ranks
  count: number; // number of slots granted
  levelPrereq: number; // character level required
  slug: string; // "" for regular slots, non-empty for special (e.g. "wizard-school-spellbook-slot")
}
```

**Example:**

```json
{
  "type": "v2-add-spell-slots",
  "slug": "wizard-spellcasting-rm",
  "slots": [
    { "rank": 0, "count": 5, "levelPrereq": 1, "slug": "" },
    { "rank": 1, "count": 2, "levelPrereq": 1, "slug": "" },
    { "rank": 1, "count": 1, "levelPrereq": 2, "slug": "" },
    { "rank": 2, "count": 2, "levelPrereq": 3, "slug": "" }
  ]
}
```

Slot computation: sum all entries where `levelPrereq <= characterLevel`, grouped by rank. Regular slots have `slug === ""`. Curriculum/school slots have a specific slug (e.g., `"wizard-school-spellbook-slot"`).

#### `v2-add-spellcasting-feature` — Spellcasting Feature Metadata

Describes the spellcasting tradition and type for a class.

```typescript
{
  type: "v2-add-spellcasting-feature";
  slug: string;              // e.g. "wizard-spellcasting-rm"
  tradition: string;         // "arcane", "divine", "primal", "occult"
  attribute: string;         // key ability: "intelligence", "wisdom", "charisma"
  featureType: string;       // "prepared-spellbook", "spontaneous", "prepared"
  isMainFeature: boolean;
  hasFocusGroup?: boolean;
  focusName?: string;        // e.g. "School Spells"
  focusSlug?: string;        // e.g. "school-spells"
}
```

#### `add-spell` — Granted Spell (Focus or Innate)

Returned when requesting class feature or heritage engines that grant spells.

```typescript
{
  type: "add-spell";
  level: number;              // minimum character level for availability
  addSpell: string;           // spell slug, e.g. "shield"
  tradition: string;          // casting tradition
  isInnate?: boolean;         // true = innate, false/undefined = focus
  spellLevel?: number;        // fixed spell level (0 = auto-heighten)
  parentFeature?: string;     // granting feature slug
  autoScaleSpellLevel?: boolean;
}
```

#### `add-focus-point` — Focus Point Grant

```typescript
{
  type: "add-focus-point";
  addFocus: number; // focus points granted (usually 1)
}
```

#### `add-staff-spells` — Staff Spell List

Returned when requesting equipment engines for magical staves.

```typescript
{
  type: "add-staff-spells";
  spells: Array<{
    rank: number; // spell rank
    spell: string; // spell slug
  }>;
}
```

#### `add-special-item-spell` — Wand/Item Spell

Returned when requesting equipment engines for wands or other spell-granting items.

```typescript
{
  type: "add-special-item-spell";
  rank: number | string; // spell rank
  spell: string; // spell slug
  itemType: string; // "wand", etc.
}
```

---

## Engine Name Conventions

The `name` field on DemiplaneEngine entries follows a path-based convention that encodes the content type:

| Path Pattern                         | Content Type    | Example                                             |
| ------------------------------------ | --------------- | --------------------------------------------------- |
| `tabula/ancestry/<slug>.eng`         | Ancestry        | `tabula/ancestry/human-rm.eng`                      |
| `tabula/heritage/<slug>.eng`         | Heritage        | `tabula/heritage/versatile-heritage-rm.eng`         |
| `tabula/background/<slug>.eng`       | Background      | `tabula/background/scholar-rm.eng`                  |
| `tabula/class/<slug>.eng`            | Class           | `tabula/class/wizard-rm.eng`                        |
| `tabula/class-feature/<slug>.eng`    | Class feature   | `tabula/class-feature/weapon-specialization-rm.eng` |
| `tabula/feat/<slug>.eng`             | Feat            | `tabula/feat/toughness-rm.eng`                      |
| `tabula/spell/<slug>.eng`            | Spell           | `tabula/spell/fireball-rm.eng`                      |
| `tabula/item/<slug>.eng`             | Equipment       | `tabula/item/longsword-rm.eng`                      |
| `core/selection/skill/increase`      | Skill increase  | (slug in args)                                      |
| `core/selection/attribute/boost`     | Attribute boost | (slug in args)                                      |
| `core/selection/generic-choice/...`  | Generic choice  | (various)                                           |
| `core/selection/generic-feature/...` | Generic feature | (various)                                           |

The `tabula/` prefix indicates game content. The `core/selection/` prefix indicates player choices during character building.

---

## Slug Conventions

Demiplane uses the `-rm` suffix to indicate **Remastered** content (Pathfinder 2e Remaster). The Foundry PF2e system does not use this suffix — both legacy and remastered items share the same slug.

**Transformation rule:** Strip the trailing `-rm` to get the Foundry compendium slug.

| Demiplane Slug | Foundry Slug          |
| -------------- | --------------------- |
| `wizard-rm`    | `wizard`              |
| `fireball-rm`  | `fireball`            |
| `human-rm`     | `human`               |
| `fighter`      | `fighter` (no change) |

Additional slug normalization for equipment handles known mismatches (e.g., `arrow` → `arrows`).

When a simple strip doesn't match, the module generates candidate slugs:

1. Exact slug (after `-rm` strip)
2. Strip class suffix (e.g., `weapon-specialization-fighter` → `weapon-specialization`)
3. Add `bloodline-` prefix for sorcerer bloodline features

---

## API Access Layering (and Known Bypasses)

The intended architecture is that **all** Demiplane GraphQL access goes through
the `@scooper4711/demiplane-api` `DemiplaneClient`. The client centralizes the
endpoint, auth token, UUID validation, error handling, and the schema quirks
documented above (notably the scalar-`data` journal gotcha). Several call sites
still talk to Demiplane directly with raw `fetch`; these are technical debt to
be migrated onto the client.

### GraphQL bypasses (should move to `DemiplaneClient`)

| Location                                               | What it does                                                                             | Client method to use instead                                                               | Notes                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/import/orchestrator.ts` → `fetchCharacterEngines` | Raw GraphQL query for `demiplane_user_character.data`/`updated` to get the engines array | `DemiplaneClient.fetchCharacterData` (returns `CharacterData` incl. `engines` + `updated`) | Duplicates the fetch-character query and its response typing. The orchestrator now holds a `client`, so this can be swapped directly. |
| `src/import/orchestrator.ts` → `importJournals`        | (migrated) previously a raw journal query                                                | `DemiplaneClient.fetchCharacterJournals`                                                   | Already converted — listed for completeness.                                                                                          |

### Parallel re-implementation in `scripts/`

`scripts/demiplane-api.mjs` is a **second, independent implementation** of the
Demiplane GraphQL + stream-engines calls, used by the MCP server
(`scripts/demiplane-mcp.mjs`) and CLI tooling. It duplicates:

- `fetchCharacter` (≈ `fetchCharacterData`)
- `fetchAttributeMapping` (≈ `fetchAttributeMapping`)
- `fetchCharacterJournals` / `createCharacterJournal` / `updateCharacterJournal`
  (≈ the client's journal methods)
- `fetchEngineDefinitions` (stream-engines — see below)

All three journal operations here now select `data` as a scalar (matching the
schema gotcha above); the earlier `data { item { ... } }` subselection in the
create/update mutations has been corrected.

This `.mjs` layer cannot import the TypeScript client directly today (it is a
standalone ESM script bundle with its own token loading from `.env`). Options
for cleanup: (a) build the client to a form the scripts can import, or (b) at
minimum share the corrected query strings so the two implementations cannot
drift.

### Stream-Engines API — intentionally not on the client (for now)

`src/import/stream-engines.ts` (`postStreamEngines`) POSTs to
`https://character.demiplane.com/stream-engines`, a **different host** and a
**non-GraphQL, NDJSON** protocol. `DemiplaneClient` does not currently model
this endpoint, so this is not a bypass of an existing method — it is a gap. If
the goal is "one client for all Demiplane access," stream-engines support would
need to be added to the client first. Until then this is the sanctioned place
for stream-engines access; the resolvers
(`spell-slot-resolver.ts`, `item-spell-resolver.ts`, `feature-spell-resolver.ts`)
correctly funnel through it rather than calling `fetch` themselves.

### Summary for cleanup

1. Swap `orchestrator.ts` `fetchCharacterEngines` → `client.fetchCharacterData`.
2. Decide on a strategy to de-duplicate `scripts/demiplane-api.mjs` against the
   TypeScript client.
3. (Optional) Add stream-engines support to `DemiplaneClient` and route
   `stream-engines.ts` through it.

## Rate Limits and Error Handling

Demiplane does not publish official rate limits. Empirical testing indicates:

- The GraphQL API tolerates sustained bursts under ~30 requests per minute per character.
- The stream-engines API has no observed throttling for typical import workloads.

The module enforces a self-imposed rate limit of **30 API calls per 60-second rolling window** per character on the export path.

**Error responses** from the GraphQL API follow standard GraphQL error format:

```json
{
  "data": null,
  "errors": [{ "message": "not found" }]
}
```

HTTP-level errors (401, 403, 500) produce non-200 status codes with no useful body.
