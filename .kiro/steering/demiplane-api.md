---
inclusion: manual
---

# Demiplane API Reference

## Overview

The Demiplane API uses GraphQL at `https://apiv4.demiplane.com/v1/graphql`. Authentication is via a JWT bearer token. The `@scooper4711/demiplane-api` package (at `../demiplane-api`) wraps this API.

## Authentication

The token is stored in Foundry module settings as `demiplaneToken`. For development/testing, it lives in `.env` as `DEMIPLANE_TOKEN`. The old `/api/auth/login` endpoint no longer works — use `DemiplaneClient.setToken()` with a JWT obtained from browser dev tools.

## Fetching a Character

```typescript
import { DemiplaneClient } from "@scooper4711/demiplane-api";

const client = new DemiplaneClient();
client.setToken(token);
const data = await client.fetchCharacterData("uuid-here");
// data.engines is the full character state
```

Or directly via fetch:

```typescript
const response = await fetch("https://apiv4.demiplane.com/v1/graphql", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    query: `query($id: uuid!) {
      demiplane_user_character(where: {uuid: {_eq: $id}, deleted_at: {_is_null: true}, enabled: {_eq: true}}) {
        data
      }
    }`,
    variables: { id: characterId },
  }),
});
const json = await response.json();
const engines = json.data.demiplane_user_character[0].data.engines;
```

## Character Data Structure

The character payload has two top-level keys:

- `engines` — array of all engine entries (the character's full state)
- `engineCacheIdsBySource` — index mapping (not used during import)

### Engine Types

**DemiplaneEngine** — built-in selections (ancestry, class, feats, spells, items):

- `name`: qualified path like `tabula/feat/power-attack-rm.eng`
- `type`: `"DemiplaneEngine"`
- `args.slug`: the content slug (e.g. `power-attack-rm`)
- `args.sourceRow`: where this was selected (e.g. `fighter-feat-level-2-rm`)
- `args.selectionRank`: spell rank for spells
- `args.parentSpellFeature`: spellcasting source for spells
- `demiplaneEngineId`: unique ID for this engine instance

**CustomDemiplaneEngine** — user overrides and session state:

- `name`: attribute key (e.g. `character_hit-points_current`)
- `type`: `"CustomDemiplaneEngine"`
- `value`: the stored value (string, number, or boolean)

### Key Engine Names (CustomDemiplaneEngine)

| Name                                 | Purpose                                                    |
| ------------------------------------ | ---------------------------------------------------------- |
| `character_name`                     | Character name                                             |
| `character_level`                    | Character level                                            |
| `character_avatar`                   | Avatar image URL                                           |
| `character_hit-points_current`       | Current HP                                                 |
| `character_hit-points_temp`          | Temp HP                                                    |
| `character_hero-points`              | Hero points                                                |
| `character_currency_gold`            | Gold pieces                                                |
| `character_currency_silver`          | Silver pieces                                              |
| `character_currency_copper`          | Copper pieces                                              |
| `character_currency_platinum`        | Platinum pieces                                            |
| `character_organizedplayid`          | Org play ID (format: "123456-2001")                        |
| `character_personality_beliefs`      | Deity name                                                 |
| `character-languages-user`           | Additional languages (comma or newline separated)          |
| `character_hand_primary_equipped-id` | Primary hand item's demiplaneEngineId                      |
| `character_hand_offhand_equipped-id` | Off-hand item's demiplaneEngineId                          |
| `character_hand_both_equipped-id`    | Two-handed item's demiplaneEngineId                        |
| `{demiplaneEngineId}-is-equipped`    | Item is worn/invested (value=1)                            |
| `{demiplaneEngineId}-container`      | Item is in container (value=container's demiplaneEngineId) |
| `{demiplaneEngineId}--quantity`      | Item quantity override                                     |
| `{id}-spell-is-signature`            | Signature spell marker                                     |
| `character_{skill}_prof`             | Skill rank override value                                  |
| `character_{skill}_prof--overridden` | Override is active (value=1)                               |

### Engine Path Patterns (DemiplaneEngine)

| Pattern                                       | Category                             |
| --------------------------------------------- | ------------------------------------ |
| `tabula/ancestry/*.eng`                       | Ancestry                             |
| `tabula/heritage/*.eng`                       | Heritage                             |
| `tabula/background/*.eng`                     | Background                           |
| `tabula/class/*.eng`                          | Class                                |
| `tabula/feat/*.eng`                           | Feat                                 |
| `tabula/class-feature/*.eng`                  | Class feature (ChoiceSet child)      |
| `tabula/spell/*.eng`                          | Spell                                |
| `tabula/item/*.eng`                           | Equipment item                       |
| `tabula/generic-feature/*.eng`                | Generic feature (weapon group, etc.) |
| `core/selection/attribute/boost.eng`          | Attribute boost                      |
| `core/selection/skill/increase/index.eng`     | Skill proficiency                    |
| `core/selection/skill/custom-skill/index.eng` | Lore skill                           |

### Slug Convention

Demiplane slugs end with `-rm` (remaster suffix). Strip this to get the Foundry PF2e compendium slug: `power-attack-rm` → `power-attack`.

## Downloading Character Data to a File

The `tmp/` directory in the demiplane-pf2e project root is available for temporary files (gitignored). To download character data for inspection or debugging:

```typescript
import { writeFile } from "fs/promises";
import { DemiplaneClient } from "@scooper4711/demiplane-api";

const client = new DemiplaneClient();
client.setToken(process.env.DEMIPLANE_TOKEN);
const data = await client.fetchCharacterData(characterId);
await writeFile(`tmp/${characterId}.json`, JSON.stringify(data, null, 2));
```

Or from the Foundry browser console:

```javascript
const token = game.settings.get("foundry-demiplane-pf2e", "demiplaneToken");
const r = await fetch("https://apiv4.demiplane.com/v1/graphql", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    query: `query($id: uuid!) { demiplane_user_character(where: {uuid: {_eq: $id}, deleted_at: {_is_null: true}}) { data } }`,
    variables: { id: "CHARACTER-UUID-HERE" },
  }),
});
const json = await r.json();
console.log(JSON.stringify(json.data.demiplane_user_character[0].data, null, 2));
```

## CORS

- `apiv4.demiplane.com` (GraphQL) — **allows CORS** from browser
- `auth.demiplane.com` — **blocks CORS** from browser (use server-side or token injection)

## Test Characters

| Character         | UUID                                   | Class    | Notes                          |
| ----------------- | -------------------------------------- | -------- | ------------------------------ |
| Valeros (Level 5) | `a5884413-857f-444c-a5d6-24d819632c8a` | Fighter  | Integration test reference     |
| Seoni (player)    | `ef0d28f5-9488-48fd-8798-ecbeb9c636d2` | Sorcerer | Spontaneous caster             |
| Ezren (player)    | `200a5cf1-3fe9-4302-94a0-6988d2a73e99` | Wizard   | Prepared caster with spellbook |
| Bard (player)     | `56635d93-fd96-43ab-a1da-0e20060d189a` | Bard     | Occult spontaneous             |
