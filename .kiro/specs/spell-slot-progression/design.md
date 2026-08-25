# Spell Slot Progression - Design

## Architecture

### New Module: `src/import/spell-slot-resolver.ts`

Resolves spell slot counts from two sources:

1. **Stream-engines class feature data** — fetches the class engine definition and parses the `v2-add-spell-slots` modifier
2. **User override engines** — checks character data for manual overrides

```typescript
interface SpellSlotProgression {
  cantrips: number;
  curriculumCantrips?: number;
  slots: Record<number, number>; // rank → count
  curriculumSlots?: Record<number, number>;
}

interface SlotEntry {
  rank: number;
  count: number;
  levelPrereq: number;
  slug: string;
}

async function resolveSpellSlots(
  classEngineId: string,
  characterLevel: number,
  engines: DemiplaneEngineEntry[],
  parentSpellFeature: string
): Promise<SpellSlotProgression>;
```

### How It Works

```
resolveSpellSlots(classEngineId, level, engines, parentFeature)
  │
  ├─ 1. Check for user overrides in engines[]
  │     Pattern: character_spell-feature_{parentFeature}_spell-slots_{slotType}_max
  │     If ALL slot types have overrides → return overrides directly
  │
  ├─ 2. Fetch class engine from stream-engines
  │     POST https://character.demiplane.com/stream-engines
  │     Body: { engineIdsBySource: { "pathfinder2e-v2": [classEngineId] }, ... }
  │
  ├─ 3. Parse response NDJSON, find StringObject node containing engineModifiers
  │     Look for entry with type: "v2-add-spell-slots"
  │
  ├─ 4. Compute slot counts per rank
  │     For each rank: sum(count) WHERE levelPrereq <= characterLevel
  │
  └─ 5. Merge: overrides take priority over computed values
```

### Stream-Engines Request

```typescript
const response = await fetch("https://character.demiplane.com/stream-engines", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    engineIdsBySource: {
      "pathfinder2e-v2": [classEngineId],
    },
    isSheet: true,
    nexusSlug: "pathfinder2e",
  }),
});
```

The `versionMap` parameter is optional — the endpoint works without it. It may be used for caching optimization on Demiplane's side but is not required.

**CORS:** Confirmed working from Foundry's `localhost:30000` origin. No CORS issues.

The response is NDJSON (newline-delimited JSON). Parse each line, find the one with a `StringObject` node whose `string` value is a JSON object containing `engineModifiers` with a `v2-add-spell-slots` entry.

### Curriculum Slots

The wizard school feature likely has its own `v2-add-spell-slots` entry. When we fetch the class engine, we'll get all dependent engines including the school. Look for slot entries that would correspond to the `wizard-school-spellbook-slot` pattern.

If not found in stream-engines, fall back to the known rule: 1 curriculum cantrip + 1 curriculum slot per available rank.

### Modifications to `src/import/spell-importer.ts`

After creating the spellcasting entry:

1. Call `resolveSpellSlots()` to get slot counts
2. Set `system.slots.slotN.max` on the spellcasting entry
3. Place prepared spells into slot positions

### User Override Detection

```typescript
function findSlotOverrides(engines: DemiplaneEngineEntry[], parentFeature: string): Map<string, number> {
  const overrides = new Map();
  const prefix = `character_spell-feature_${parentFeature}_spell-slots_`;
  const suffix = "_max";

  for (const eng of engines) {
    if (eng.type !== "CustomDemiplaneEngine") continue;
    if (!eng.name.startsWith(prefix) || !eng.name.endsWith(suffix)) continue;
    if (eng.name.endsWith("--overridden")) continue; // skip the flag

    // Check that the --overridden flag is set
    const flagName = `${eng.name}--overridden`;
    const flag = engines.find((e) => e.name === flagName && e.value === 1);
    if (!flag) continue;

    const slotType = eng.name.slice(prefix.length, -suffix.length);
    overrides.set(slotType, eng.value as number);
  }

  return overrides;
}
```

## Risks and Mitigations

| Risk                                             | Impact                   | Mitigation                                             |
| ------------------------------------------------ | ------------------------ | ------------------------------------------------------ |
| stream-engines endpoint unavailable from Foundry | Can't get slot table     | Skip slot setup with warning; user configures manually |
| Curriculum slot data not in stream-engines       | Missing curriculum slots | Fetch school class feature engine separately           |
| New classes not yet mapped                       | Missing slot info        | Log warning, skip slot setup                           |

## Alternative: Hardcoded Table (Removed)

Previously considered a hardcoded fallback table. This has been removed from the design — stream-engines is the authoritative source and must be available for spell slot import to work. If stream-engines is unavailable, spell slot setup should be skipped with a warning rather than using potentially stale hardcoded data.
