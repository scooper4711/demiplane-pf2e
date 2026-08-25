# Spell Slot Progression Import

## Problem Statement

Demiplane does NOT expose spell slot counts via its GraphQL character data endpoint. However, the slot progression table IS available from the `stream-engines` endpoint — it's embedded in the class feature engine definition as structured JSON data.

Additionally, if a user has manually overridden their slot counts (e.g., for Spell Blending), those overrides ARE stored in the character data as `CustomDemiplaneEngine` entries.

## Data Sources (in priority order)

1. **User overrides** (character GraphQL data) — `CustomDemiplaneEngine` with name pattern `character_spell-feature_{parentSpellFeature}_spell-slots_{slotType}_max` and `storeType: "override"`. Only present if the user manually changed slot counts.

2. **Class feature engine definition** (stream-engines endpoint) — The class engine contains a `StringObject` node with the full slot progression table in `engineModifiers[].slots[]`. Available for any class by fetching its engine ID from `stream-engines`.

3. ~~Hardcoded fallback~~ — Removed. Stream-engines is the authoritative source.

## Requirements

### REQ-1: Read Slot Progression from Stream-Engines

Fetch the class engine definition from `character.demiplane.com/stream-engines` using the class engine ID from the character data. Parse the `engineModifiers` array for the entry with `type: "v2-add-spell-slots"` and extract the `slots[]` array.

Each slot entry has:

- `rank` — 0 for cantrips, 1-10 for ranked spells
- `count` — number of slots granted
- `levelPrereq` — character level at which these slots become available
- `slug` — empty for regular slots, potentially populated for special slot types

To get total slots at a given level: sum all `count` values where `levelPrereq <= characterLevel` for each `rank`.

### REQ-2: Respect User Override Engines

Check for `CustomDemiplaneEngine` entries matching:

- Name pattern: `character_spell-feature_{feature}_spell-slots_{slotType}_max`
- `storeType: "override"`
- Companion flag: `{name}--overridden` with `value: 1`

If present, use the override `value` instead of the computed total from REQ-1.

### REQ-3: Cantrip Slot Counts

Cantrips are rank 0 in the slot table. The same `v2-add-spell-slots` data covers cantrips. Apply the same level-prerequisite logic.

### REQ-4: Wizard Curriculum Slots

Wizard curriculum/school slots are a SEPARATE spellcasting entry on the character, distinct from the regular wizard spellcasting entry.

Rules:

- Curriculum slots can ONLY be filled by curriculum spells
- Curriculum spells CAN also be placed in regular spell slots
- Therefore curriculum spells appear in BOTH spellbooks (the curriculum entry AND the regular entry)

Implementation:

- Create a second spellcasting entry named after the arcane school (e.g., "Ars Grammatica Curriculum Spells", "Battle Magic Curriculum Spells") for curriculum slots
- The curriculum entry's spellbook contains ONLY curriculum spells (identified by `spellSlot` containing `"wizard-school-spellbook-slot"`)
- The regular entry's spellbook contains ALL spells including curriculum spells
- Slot counts for each entry come from their respective slot types in stream-engines / overrides

The curriculum slot progression may appear as a separate `v2-add-spell-slots` entry in the school class feature engine, or as additional entries in the wizard spellcasting feature with a distinct slug.

### REQ-5: Thesis and Feature Modifications

Features like Spell Blending modify the slot distribution. If the user has adjusted their slots, this is captured as override engines (REQ-2). The stream-engines slot table represents the base progression before modifications.

### REQ-6: Derive Slots During Import

During character import, use:

1. The character's class engine ID (from `tabula/class/*.eng` → its `id` field)
2. The character's level (from `character_level` CustomDemiplaneEngine)
3. Fetch the class engine from `stream-engines` to get the slot table
4. Check for user override engines
5. Compute final slot counts and configure Foundry's spellcasting entry

### REQ-7: Apply Prepared Spells to Slots

Using the `isPrepare: true` engines from the character data:

1. Match each prepared spell to its correct slot category (regular vs curriculum) via the `spellSlot` field
2. Place it in the appropriate slot in Foundry's prepared spell system

## Data Model (from Demiplane API)

### Source 1: Stream-Engines Slot Table

Fetch via `POST https://character.demiplane.com/stream-engines` with the class engine ID.

The class engine (e.g., `wizard-rm.eng`, ID `96eb308d-84b7-4494-884b-188b3ce2f7e6`) returns dependent engines. One of them (the spellcasting class feature) contains a `StringObject` node with a JSON payload:

```json
{
  "name": "Wizard Spellcasting",
  "slug": "wizard-spellcasting-rm",
  "tradition": "arcane",
  "featureType": "prepared-spellbook",
  "attribute": "intelligence",
  "engineModifiers": [
    {
      "type": "v2-add-spellcasting-feature",
      "slug": "wizard-spellcasting-rm",
      "tradition": "arcane",
      "attribute": "intelligence",
      "featureType": "prepared-spellbook",
      "isMainFeature": true,
      "hasFocusGroup": true,
      "focusName": "School Spells",
      "focusSlug": "school-spells"
    },
    {
      "type": "v2-add-spell-slots",
      "slug": "wizard-spellcasting-rm",
      "slots": [
        { "rank": 0, "count": 5, "levelPrereq": 1, "slug": "" },
        { "rank": 1, "count": 2, "levelPrereq": 1, "slug": "" },
        { "rank": 1, "count": 1, "levelPrereq": 2, "slug": "" },
        { "rank": 2, "count": 2, "levelPrereq": 3, "slug": "" },
        { "rank": 2, "count": 1, "levelPrereq": 4, "slug": "" },
        ...
        { "rank": 10, "count": 1, "levelPrereq": 19, "slug": "" }
      ]
    }
  ],
  "grantedFeatures": [
    [{ "name": "Heightening Spells", "slug": "heightening-spells-wizard-rm", "level": 1 }],
    [{ "name": "Cantrips", "slug": "cantrips-wizard-rm", "level": 1 }],
    [{ "name": "Spellbook", "slug": "spellbook-wizard-rm", "level": 1 }]
  ]
}
```

To compute slots for a given level: `sum(count) WHERE rank == targetRank AND levelPrereq <= characterLevel`

Example for Level 1 Wizard:

- Rank 0 (cantrips): 5 (one entry: count=5, levelPrereq=1)
- Rank 1: 2 (one entry: count=2, levelPrereq=1)

Example for Level 4 Wizard:

- Rank 0: 5
- Rank 1: 3 (count=2 at level 1, count=1 at level 2)
- Rank 2: 3 (count=2 at level 3, count=1 at level 4)

### Source 2: User Override Engines (Character GraphQL Data)

`CustomDemiplaneEngine` entries in the character's `engines[]` array:

```json
{
  "name": "character_spell-feature_wizard-spellcasting-rm_spell-slots_cantrip_max",
  "type": "CustomDemiplaneEngine",
  "value": 5,
  "storeType": "override"
}
```

Companion flag (must have `value: 1` for override to be active):

```json
{
  "name": "character_spell-feature_wizard-spellcasting-rm_spell-slots_cantrip_max--overridden",
  "type": "CustomDemiplaneEngine",
  "value": 1,
  "storeType": "override"
}
```

Name pattern: `character_spell-feature_{parentSpellFeature}_spell-slots_{slotType}_max`

Where `{slotType}` matches the `spellSlot` values from spell engines:

- `cantrip`
- `rank-1`, `rank-2`, ... `rank-10`
- `cantrip-wizard-school-spellbook-slot`
- `rank-1-wizard-school-spellbook-slot`, etc.

### Spellbook Entries

```json
{
  "args": {
    "addSpellData": { "baseSpellbookSpell": true },
    "spellSlot": "cantrip" | "cantrip-wizard-school-spellbook-slot" | "rank-1" | "rank-1-wizard-school-spellbook-slot",
    "selectionRank": 0 | 1 | 2 | ...,
    "parentSpellFeature": "wizard-spellcasting-rm",
    "sourceRow": "builder-spell-section--wizard-spellcasting-rm--{rank}"
  }
}
```

### Prepared Spells

```json
{
  "args": {
    "isPrepare": true,
    "spellSlot": "cantrip" | "cantrip-wizard-school-spellbook-slot" | "rank-1" | "rank-1-wizard-school-spellbook-slot",
    "selectionRank": 0 | 1 | 2 | ...,
    "parentSpellFeature": "wizard-spellcasting-rm",
    "sourceRow": "manual-sheet-drawer"
  }
}
```

### Distinguishing Curriculum vs Regular

| `spellSlot` value                         | Category           |
| ----------------------------------------- | ------------------ |
| `"cantrip"`                               | Regular cantrip    |
| `"cantrip-wizard-school-spellbook-slot"`  | Curriculum cantrip |
| `"rank-{N}"`                              | Regular rank N     |
| `"rank-{N}-wizard-school-spellbook-slot"` | Curriculum rank N  |

### Slot Counts (NOT in API)

Confirmed absent from:

- `demiplane_user_character.data.engines` (GraphQL)
- `character.demiplane.com/stream-engines` (engine definitions, not computed values)

Computed client-side by Demiplane's engine runtime. Must be derived from PF2e rules.

## Out of Scope

- Focus spells / focus pool (separate system, already handled)
- Innate spells (no slot concept)
- Multiclass spellcasting dedications (future consideration)
