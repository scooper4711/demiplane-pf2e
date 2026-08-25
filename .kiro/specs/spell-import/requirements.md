# Spell Import - Requirements

## Overview

Import all spells from a Demiplane PF2e character into Foundry VTT, correctly modeling:

- Spellcasting entries (one per tradition/source)
- Spellbook / spell repertoire (known spells)
- Prepared spell slots (for prepared casters)
- Signature spells (for spontaneous casters)
- Innate spells (from feats/ancestry)
- Focus spells (from class features/feats)
- Cantrips (always-prepared for all casters)

## Caster Types

### Prepared Casters

- **Wizard** (arcane) — spellbook + prepared slots + curriculum slots (separate entry)
- **Cleric** (divine) — full spell list access + prepared slots
- **Druid** (primal) — full spell list access + prepared slots
- **Witch** (tradition from patron) — familiar-granted spellbook + prepared slots + patron-granted spells + hex spells

### Spontaneous Casters

- **Sorcerer** (tradition varies by bloodline) — repertoire + slots per day
- **Bard** (occult) — repertoire + slots per day + signature spells
- **Oracle** (divine) — repertoire + slots per day + signature spells
- **Psychic** (occult) — repertoire + slots per day (unique amp system)

### Wave Casters (bounded, if applicable)

- **Magus** (arcane) — limited slots, studious spells
- **Summoner** (tradition varies) — limited slots

## Requirements

### REQ-1: Create Spellcasting Entry

For each `parentSpellFeature` group found in the character's engines, create a Foundry `spellcastingEntry` item with:

- `system.tradition.value` — arcane, divine, occult, primal
- `system.prepared.value` — "prepared", "spontaneous", "innate", or "focus"
- `system.prepared.flexible` — true for flexible preparation (e.g., Cleric with Flexible Preparation feat)
- `system.ability.value` — key ability (int, wis, cha)
- `system.proficiency.value` — proficiency rank (0-4)

### REQ-2: Import Spellbook / Repertoire

Add all spells marked with `addSpellData.baseSpellbookSpell === true` as spell items on the actor, linked to the spellcasting entry via `system.location.value = entryId`.

For each spell, resolve from the `pf2e.spells-srd` compendium by slug (strip `-rm` suffix).

### REQ-3: Prepared Spell Placement (Prepared Casters)

For prepared casters, place spells marked with `isPrepare === true` into the spellcasting entry's slot structure:

- `system.slots.slot0.prepared[]` — cantrips
- `system.slots.slot1.prepared[]` — rank 1
- `system.slots.slotN.prepared[]` — rank N

Each prepared entry is `{ id: spellItemId, expended: false }`.

### REQ-4: Spell Slot Maximums

Set `system.slots.slotN.max` for each rank. Slot counts are resolved from:

1. **User override engines** in character data (if manually set)
2. **Stream-engines class feature** with `v2-add-spell-slots` modifier (the authoritative source)
3. **Hardcoded fallback** (last resort)

See the `spell-slot-progression` spec for full details on how to fetch and compute these values.

### REQ-5: Cantrip Handling

Cantrips are always prepared (never expended). For both prepared and spontaneous casters:

- Add all known cantrips to the spellbook
- For prepared casters: place prepared cantrips in `slot0.prepared[]`
- `slot0.max` = number of cantrip slots for the class/level

### REQ-6: Curriculum / School Spells (Wizard)

Wizard curriculum spells (identified by `spellSlot` containing `"wizard-school-spellbook-slot"`) get a SEPARATE spellcasting entry:

1. **Curriculum spellcasting entry** — Named after the arcane school chosen (e.g., "Ars Grammatica Curriculum Spells", "Battle Magic Curriculum Spells"). Contains only curriculum spells in its spellbook. Curriculum prepared spells (`isPrepare` with curriculum `spellSlot`) go into this entry's slots.
2. **Regular spellcasting entry** — Contains ALL wizard spells (including curriculum spells) in its spellbook. Regular prepared spells go into this entry's slots.

This means curriculum spells are duplicated across both entries' spellbooks, which is correct — a curriculum spell can fill either a curriculum slot or a regular slot.

Slot counts for each entry are separate:

- Regular entry: `character_spell-feature_wizard-spellcasting-rm_spell-slots_cantrip_max`, `rank-1_max`, etc.
- Curriculum entry: `character_spell-feature_wizard-spellcasting-rm_spell-slots_cantrip-wizard-school-spellbook-slot_max`, `rank-1-wizard-school-spellbook-slot_max`, etc.

### REQ-7: Signature Spells (Spontaneous Casters)

For spontaneous casters, spells can be marked as signature (heightenable to any available rank). Detect via `CustomDemiplaneEngine` with name pattern `{demiplaneEngineId}-spell-is-signature` and `value: 1`.

In Foundry, signature spells are flagged on the spell collection entry. Signature spells should only be imported ONCE at their base rank — Foundry handles displaying them at higher ranks automatically.

Do NOT duplicate signature spells at multiple ranks. If the Demiplane data lists the same spell slug at multiple `selectionRank` values, only create one Foundry spell item at its lowest rank and mark it as signature.

### REQ-8: Innate Spells

Innate spells come from two sources:

**Source A: Player-selected innate spells** (in character data)
Spells with `args.sourceType === "select-spell"` and no `parentSpellFeature` (from feats like Adapted Cantrip, Adaptive Adept). Already in the character's spell engines.

**Source B: Auto-granted innate spells** (in stream-engines feature definitions)
Heritage/ancestry/feat features that grant spells automatically. Identified by `type: "add-spell"` with `isInnate: true` in the feature's `engineModifiers`.

Example from Seer Elf heritage:

```json
{
  "type": "add-spell",
  "level": 1,
  "addSpell": "detect-magic-rm",
  "isInnate": true,
  "tradition": "arcane",
  "spellLevel": 0
}
```

**Import process for auto-granted innate spells:**

1. For each heritage (`tabula/heritage/*.eng`) and ancestry feat (`tabula/feat/*.eng` with `builderSection: "ancestry"`), fetch from stream-engines
2. Parse `engineModifiers` for entries with `type: "add-spell"` AND `isInnate: true`
3. Filter by `level <= characterLevel`
4. Add to the actor's "Innate Spells" spellcasting entry

**Distinguishing innate vs focus:**

- `isInnate: true` → innate spellcasting entry
- No `isInnate` flag → focus spellcasting entry (class feature grants like wizard school spells, hex spells)

Both Source A and Source B innate spells go into the same "Innate Spells" entry on the actor.

### REQ-9: Focus Spells

Focus spells are NOT stored in the character's spell engines. They are granted by class feature engine definitions (fetched from stream-engines), identified by `engineModifiers` entries with `type: "add-spell"`.

Example from School of Ars Grammatica:

```json
{
  "type": "add-spell",
  "level": 1,
  "addSpell": "protective-wards-rm",
  "tradition": "arcane",
  "autoScaleSpellLevel": true
}
```

The `level` field indicates the character level at which the focus spell becomes available.

**Import process:**

1. For each class feature engine in the character data (`tabula/class-feature/*.eng`), fetch its definition from stream-engines
2. Parse `engineModifiers` for entries with `type: "add-spell"` — these are focus spells
3. Filter by `level <= characterLevel` to get currently available focus spells
4. Resolve each spell slug from `pf2e.spells-srd` compendium
5. Add to the actor's Focus Spells spellcasting entry (or create one if it doesn't exist)

**Focus pool:**
Class features also grant focus points via `type: "add-focus-point"` with `addFocus: N`. Sum all focus point grants from class features to determine `system.resources.focus.max`.

**Key difference from other spells:** Focus spells come from stream-engines class feature data, not from the character's saved `tabula/spell/` engines.

### REQ-9a: Witch Patron Spells and Hex Spells

The Witch has unique spell handling compared to other prepared casters:

**Tradition:** Determined by the patron feature via `type: "add-spell-list"` in the patron's stream-engines data. Example: Mosquito Witch sets `"addSpellList": "Primal"`.

**Patron-granted spells** (from patron class feature stream-engines):

- Identified by `type: "add-spell"` entries in the patron's `engineModifiers`
- These include the patron's granted spell (e.g., Pest Form) and hex focus spells (e.g., Buzzing Bites)
- Hex spells have `parentFeature: "hex-spells"` — these are focus spells
- Non-hex patron spells (e.g., Pest Form with `parentFeature: ""`) go into the regular spellbook — they're available for preparation even though they don't appear as `baseSpellbookSpell` entries in character data

**Hex cantrip from character data:**

- Player-selected hex cantrips (e.g., Patron's Puppet) appear in the character spell engines with NO `parentSpellFeature`, NO `spellSlot`, NO `addSpellData`
- Their `sourceRow` references `hex-spells-rm`
- These are focus spells and should go into the Focus Spells entry

**Important:** Patron-granted spells like Pest Form appear in the character data ONLY as `isPrepare` engines (when prepared). They are NOT listed as `baseSpellbookSpell` entries. The importer must add them to the spellbook by reading the patron feature from stream-engines.

**No curriculum separation:** Witch has NO equivalent to the wizard's curriculum slots. All `spellSlot` values are plain `"cantrip"` or `"rank-N"`.

### REQ-10: Staff and Wand Spellcasting Entries

Staves and wands that provide spells must be created as separate spellcasting entries in Foundry. The spell lists are available from the stream-engines item definitions.

**Staff spells** — Identified by `engineModifiers` entry with `type: "add-staff-spells"`:

```json
{
  "type": "add-staff-spells",
  "spells": [
    { "rank": 0, "spell": "spout-rm" },
    { "rank": 1, "spell": "create-water-rm" },
    { "rank": 1, "spell": "hydraulic-push-rm" }
  ]
}
```

**Wand spells** — Identified by `engineModifiers` entry with `type: "add-special-item-spell"`:

```json
{
  "rank": "1",
  "type": "add-special-item-spell",
  "spell": "heal-rm",
  "itemType": "wand",
  "freeSpell": false
}
```

**Import process:**

1. Identify staff/wand items from `tabula/item/` engines (traits include "staff" or "wand", or slugs containing those terms)
2. Fetch each item's engine definition from `stream-engines` using the item's `id` field
3. Parse `engineModifiers` for `add-staff-spells` or `add-special-item-spell` entries
4. Create a Foundry spellcasting entry named after the item (e.g., "Staff of Water") with `system.prepared.validItems = "scroll"`
5. Resolve each spell slug from the `pf2e.spells-srd` compendium and add to the entry
6. Tradition comes from the character's main spellcasting tradition (staves use the wielder's tradition)

**Data available per item from stream-engines:**

- Item name, slug, traits
- Full spell list with ranks
- Item type (staff vs wand)

### REQ-11: Deduplication and Signature Spell Handling

The same spell can appear multiple times in the engines. Rules:

- For prepared casters: once as spellbook entry + once per preparation slot. Only one Foundry spell item per unique slug.
- For spontaneous casters: a signature spell may appear at multiple `selectionRank` values (e.g., Thunderstrike at rank 1, 2, and 3). Only create ONE Foundry spell item at the spell's BASE rank. Mark it as signature. Foundry handles auto-heightening display.

Deduplication key: Foundry slug (after stripping `-rm`). Always use the lowest `selectionRank` for the base spell.

### REQ-12: Heightened Spells (Prepared Casters Only)

When a prepared caster prepares a spell at a higher rank than its base, the `selectionRank` on the `isPrepare` engine indicates the rank it's prepared at. The spell item in Foundry stays at its base rank, but the prepared slot entry places it in the higher rank's slot group.

### REQ-13: Spell Proficiency

Set the spellcasting entry's proficiency rank based on the character's class level:

- Trained (1) at class grant
- Expert (2), Master (3), Legendary (4) at class-defined levels

This could be derived from class rules or from the character's existing proficiency engines if present.

## Demiplane Data Reference

### Engine Identification

All spell engines: `name.startsWith("tabula/spell/")`

### Key `args` Fields

| Field                             | Purpose                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `slug`                            | Spell identifier (strip `-rm` for Foundry lookup)                                    |
| `name`                            | Display name (empty for prepared entries)                                            |
| `addSpellData.baseSpellbookSpell` | `true` = spellbook/repertoire entry                                                  |
| `isPrepare`                       | `true` = prepared in a slot                                                          |
| `spellSlot`                       | Slot category (see table below)                                                      |
| `selectionRank`                   | Spell rank (0 = cantrip, 1-10 = ranked)                                              |
| `parentSpellFeature`              | Spellcasting source (e.g., `"wizard-spellcasting-rm"`)                               |
| `sourceRow`                       | Origin: `"builder-spell-section--*"` (builder) or `"manual-sheet-drawer"` (prepared) |
| `sourceType`                      | `"select-spell"` for innate spells                                                   |
| `parentFeature`                   | `"scroll"` for scroll spells (skip these)                                            |

### `spellSlot` Values

| Pattern                                   | Meaning                 |
| ----------------------------------------- | ----------------------- |
| `"cantrip"`                               | Regular cantrip         |
| `"cantrip-wizard-school-spellbook-slot"`  | Curriculum cantrip      |
| `"rank-{N}"`                              | Regular rank N spell    |
| `"rank-{N}-wizard-school-spellbook-slot"` | Curriculum rank N spell |

### `parentSpellFeature` Values

| Value                        | Class                 |
| ---------------------------- | --------------------- |
| `"wizard-spellcasting-rm"`   | Wizard                |
| `"cleric-spellcasting-rm"`   | Cleric                |
| `"druid-spellcasting-rm"`    | Druid                 |
| `"witch-spellcasting-rm"`    | Witch                 |
| `"sorcerer-spellcasting-rm"` | Sorcerer              |
| `"bard-spellcasting-rm"`     | Bard                  |
| `"oracle-spellcasting-rm"`   | Oracle                |
| `"psychic-spellcasting-rm"`  | Psychic               |
| `"magus-spellcasting-rm"`    | Magus (if present)    |
| `"summoner-spellcasting-rm"` | Summoner (if present) |

### Signature Spell Detection

`CustomDemiplaneEngine` with `name = "{demiplaneEngineId}-spell-is-signature"` and `value = 1`.

## Foundry PF2e Data Model

### Spellcasting Entry Item

```typescript
{
  type: "spellcastingEntry",
  name: "Arcane Prepared Spells",
  system: {
    tradition: { value: "arcane" },
    prepared: { value: "prepared", flexible: false },
    ability: { value: "int" },
    proficiency: { slug: "", value: 1 },  // 0-4
    slots: {
      slot0: { max: 5, prepared: [{ id: "itemId", expended: false }] },
      slot1: { max: 2, prepared: [{ id: "itemId", expended: false }] },
      // ... slot2 through slot10
    }
  }
}
```

### Spell Item (linked to entry)

```typescript
{
  type: "spell",
  name: "Fireball",
  system: {
    location: { value: "spellcastingEntryId" },
    // ... rest of spell data from compendium
  }
}
```

### Prepared Slot Entry

```typescript
{ id: string | null, expended: boolean }
```

- `id` = the Foundry item ID of the spell on the actor
- `expended` = whether it's been cast today (import as `false`)
- `null` id = empty slot

## Acceptance Criteria

1. A Wizard character imports with: correct spellbook, correct prepared slots, correct curriculum separation (separate entry)
2. A Sorcerer character imports with: correct repertoire, signature spells marked, correct slot counts
3. A Cleric character imports with: full divine list access noted, prepared slots filled
4. A Witch character imports with: correct spellbook (including patron-granted spell), hex cantrips as focus spells, correct tradition from patron
5. Innate spells from feats appear in a separate "Innate Spells" entry
6. No duplicate spell items on the actor (except curriculum spells in both entries)
7. Spells that can't be resolved from the compendium are logged as warnings, not errors
8. Staff/wand spellcasting entries created with correct spell lists
