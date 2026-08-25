# Spell Import - Design

## Current State

The existing `spell-importer.ts` handles:

- Grouping spells by `parentSpellFeature`
- Creating spellcasting entries with tradition/type/ability
- Resolving spells from `pf2e.spells-srd` compendium
- Deduplicating by Foundry slug
- Separating innate spells (`sourceType === "select-spell"`)

What it does NOT handle:

- Setting `system.slots.slotN.max` (slot counts)
- Placing prepared spells into slot positions
- Curriculum/school spell separation
- Signature spell marking
- Focus spells
- Heightened spell placement
- Flexible preparation

## Architecture

### Module Structure

```
src/import/
  spell-importer.ts         — orchestrates spell import (refactor existing)
  spell-engines.ts          — engine filtering/classification (exists, extend)
  spell-slot-resolver.ts    — resolves slot counts from stream-engines + user overrides (new)
  spell-prepared-placer.ts  — places isPrepare spells into slot positions (new)
```

### Import Flow

```
applySpells(actor, engines, summary)
  │
  ├─ 1. groupSpells(engines)
  │     → { main: SpellGroup[], innate: [], focus: [] }
  │
  ├─ 2. For each main group:
  │     ├─ createSpellcastingEntry(actor, config)
  │     ├─ addSpellbookSpells(actor, entryId, spellbookEngines)
  │     ├─ resolveSpellSlots(classEngineId, level, engines, parentFeature)
  │     ├─ setSlotMaximums(actor, entryId, slotCounts)
  │     ├─ placePreparedSpells(actor, entryId, preparedEngines, slugToId)
  │     └─ markSignatureSpells(actor, entryId, signatureEngineIds)
  │
  ├─ 3. For innate group:
  │     ├─ createSpellcastingEntry(actor, "innate")
  │     └─ addSpellbookSpells(actor, entryId, innateEngines)
  │
  └─ 4. For focus group:
        ├─ findOrCreateFocusEntry(actor)
        └─ addFocusSpells(actor, entryId, focusEngines)
```

### Spellcasting Entry Configuration

Extend the existing `CLASS_SPELLCASTING` lookup:

```typescript
interface SpellcastingConfig {
  tradition: MagicTradition;
  preparedType: "prepared" | "spontaneous";
  ability: AttributeString;
  hasCurriculum?: boolean; // wizard
  hasPatronSlots?: boolean; // witch
  hasSignatureSpells?: boolean; // bard, oracle, sorcerer
}
```

### Prepared Spell Placement

For prepared casters, after adding all spellbook spells:

1. Build a map: `slug → foundryItemId` from created spell items
2. For each `isPrepare` engine:
   - Determine target slot rank from `selectionRank`
   - Determine if curriculum from `spellSlot` field
   - Find the spell's Foundry item ID via slug lookup
   - Add `{ id: itemId, expended: false }` to `slots.slot{rank}.prepared[]`
3. Fill remaining slots with `{ id: null, expended: false }` up to `max`

### Curriculum Slot Handling

**Decision: Separate spellcasting entry.**

For wizards, create TWO spellcasting entries:

1. "Arcane Prepared Spells" — all wizard spells in spellbook, regular slot counts, regular prepared spells
2. "{School Name} Curriculum Spells" (e.g., "Ars Grammatica Curriculum Spells") — curriculum spells ONLY in spellbook, curriculum slot counts, curriculum prepared spells

The school name comes from the `tabula/class-feature/school-of-*.eng` entry's `args.name` field (e.g., "School of Ars Grammatica" → "Ars Grammatica Curriculum Spells").

Curriculum spells (detected via `isCurriculumSpell()` — `spellSlot` contains `"wizard-school-spellbook-slot"`) are added to BOTH entries' spellbooks. This reflects the rule that curriculum spells can fill either slot type.

Prepared spell placement:

- `isPrepare` engines with regular `spellSlot` (e.g., `"cantrip"`, `"rank-1"`) → regular entry slots
- `isPrepare` engines with curriculum `spellSlot` (e.g., `"cantrip-wizard-school-spellbook-slot"`) → curriculum entry slots

### Signature Spells (Spontaneous)

1. Collect all `CustomDemiplaneEngine` entries matching `{id}-spell-is-signature`
2. Map the `{id}` portion back to a spellbook engine's `demiplaneEngineId`
3. Find the corresponding Foundry spell item
4. Update the spell: `system.location.signature = true`

### Focus Spells

Focus spells are a special case. In Foundry PF2e, they're auto-granted by class features via the rules system. During import:

- If the class item was imported correctly, focus spells should already be on the actor
- Only add focus spells manually if they're missing after class import
- Set `system.resources.focus.max` and `system.resources.focus.value` based on focus pool engines

### Spontaneous Caster Slots

Spontaneous casters don't place specific spells into specific slots. They have:

- A repertoire (spell items linked to the entry)
- A number of slots per rank (how many times they can cast per day)

For import: just set `slots.slotN.max` and `slots.slotN.value` (remaining casts). Don't populate `prepared[]` — Foundry handles spontaneous casting differently.

## Error Handling

| Scenario                                    | Action                                                  |
| ------------------------------------------- | ------------------------------------------------------- |
| Spell not found in compendium               | Log warning, skip spell, continue                       |
| Unknown `parentSpellFeature`                | Log warning with engine count, skip group               |
| Unknown class for slot lookup               | Log warning, skip slot setup (user configures manually) |
| `isPrepare` engine references unknown spell | Log warning, leave slot empty                           |

## Foundry PF2e Slot System Details

From the PF2e source (`data.ts`):

```typescript
interface SpellSlotData {
  prepared: SpellPrepData[];  // array of { id: string | null, expended: boolean }
  value: number;              // remaining unused slots (spontaneous)
  max: number;                // total slots available
}

type SpellcastingEntrySlots = Record<`slot${0-10}`, SpellSlotData>;
```

- `slot0` = cantrips (max = cantrips known/prepared, value not tracked)
- `slot1` through `slot10` = ranked spells
- For prepared casters: `prepared[]` contains the actual prepared spells
- For spontaneous casters: `prepared[]` is not used; `value`/`max` track daily usage

## Testing Strategy

Use the known test characters:

- **FVTT-Wizard** (67536b78-...) — prepared caster with curriculum, spell blending
- **Ezren** (200a5cf1-...) — wizard reference character
- **Seoni** (ef0d28f5-...) — sorcerer, spontaneous caster
- **Bard** (56635d93-...) — spontaneous with occult tradition

Verify:

1. Correct number of spell items created (no duplicates)
2. Correct spellcasting entry configuration
3. Prepared spells in correct slots (for prepared casters)
4. Slot maximums set correctly
5. Signature spells flagged (for spontaneous casters)
