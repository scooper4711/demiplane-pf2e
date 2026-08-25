# Spell Import - Tasks

## Phase 1: Refactor Existing Spell Importer

- [ ] 1. Refactor `groupSpells()` to also separate focus spells from main/innate groups
- [ ] 2. Extend `SpellcastingConfig` with `hasCurriculum`, `hasSignatureSpells` flags
- [ ] 3. Add Magus and Summoner to `CLASS_SPELLCASTING` lookup table
- [ ] 4. Return `slugToId` map from `addSpells()` for use by prepared placement (already done, verify)

## Phase 2: Spell Slot Setup

- [ ] 5. Implement `spell-slot-resolver.ts` (see `spell-slot-progression` spec): fetch stream-engines, parse slot table, check user overrides
- [ ] 6. After creating spellcasting entry, call resolver and set `system.slots.slotN.max` via `actor.updateEmbeddedDocuments`
- [ ] 7. For spontaneous casters, also set `system.slots.slotN.value = max` (full slots on import)

## Phase 3: Prepared Spell Placement

- [ ] 8. Create `placePreparedSpells()` function that:
  - Filters engines with `isPrepare === true`
  - Groups by `selectionRank` (determines which slot group)
  - Maps each to its Foundry item ID via slug
  - Builds the `prepared[]` array for each slot rank
- [ ] 9. Handle wizard curriculum: create separate spellcasting entry for curriculum spells, add curriculum spells to BOTH entries' spellbooks, place curriculum prepared spells in curriculum entry slots only
- [ ] 10. Fill unpopulated slot positions with `{ id: null, expended: false }`
- [ ] 11. Update spellcasting entry with populated `system.slots` via `actor.updateEmbeddedDocuments`

## Phase 4: Signature Spells (Spontaneous Casters)

- [ ] 12. Scan `CustomDemiplaneEngine` entries for `{id}-spell-is-signature` pattern
- [ ] 13. Map signature markers back to spell items via `demiplaneEngineId` → slug → Foundry item ID
- [ ] 14. Set `system.location.signature = true` on signature spell items

## Phase 5: Focus Spells

- [ ] 15. For each `tabula/class-feature/*.eng` in character data, fetch its engine definition from stream-engines
- [ ] 16. Parse `engineModifiers` for `type: "add-spell"` entries — these are focus spells
- [ ] 17. Filter focus spells by `level <= characterLevel`
- [ ] 18. Create or find the Focus Spells spellcasting entry on the actor
- [ ] 19. Resolve focus spell slugs from compendium and add to the entry
- [ ] 20. Sum all `type: "add-focus-point"` modifiers across class features to set `system.resources.focus.max` and `.value`

## Phase 6: Cantrip Handling

- [ ] 18. Ensure cantrips (selectionRank 0) go into `slot0` for prepared casters
- [ ] 19. For prepared casters: prepared cantrips → `slot0.prepared[]`; max = cantrip slot count
- [ ] 20. For spontaneous casters: all repertoire cantrips are "always known" — just link to entry

## Phase 7: Staff and Wand Spellcasting Entries

- [ ] 21. During equipment import, identify items with "staff" or "wand" traits (from stream-engines item data)
- [ ] 22. For each staff/wand, fetch its engine definition from stream-engines and parse `engineModifiers` for `add-staff-spells` or `add-special-item-spell`
- [ ] 23. Create a Foundry spellcasting entry per staff/wand (named after the item, `validItems: "scroll"`)
- [ ] 24. Resolve spell slugs from compendium and add to the entry with correct ranks
- [ ] 25. Set tradition from the character's main spellcasting entry

## Phase 8: Edge Cases

- [ ] 26. Handle heightened preparation: when `selectionRank` on an `isPrepare` engine is higher than the spell's base rank, place it in the higher slot group
- [ ] 27. Handle Spell Blending thesis: infer actual slot distribution from `isPrepare` counts per rank
- [ ] 28. Handle flexible preparation (Cleric feat): set `system.prepared.flexible = true`
- [ ] 29. Handle scrolls: skip engines where `parentFeature === "scroll"` (already done, verify)

## Phase 9: Testing

- [ ] 30. Unit tests for `placePreparedSpells()` with mock engine data
- [ ] 31. Unit tests for signature spell detection
- [ ] 32. Integration test with FVTT-Wizard character (prepared + curriculum)
- [ ] 33. Integration test with Seoni (spontaneous + signature spells + staff/wand)
- [ ] 34. Integration test with FVTT Witch (patron tradition, patron-granted spells, hex focus spells)
- [ ] 35. Add FVTT-Wizard UUID to the steering doc test characters table

## Dependencies

- Task 5 depends on the `spell-slot-progression` spec (stream-engines fetch + override detection)
- Task 15 needs investigation of focus spell representation in Demiplane data (may need a test character with a focus spell)

## Open Questions

1. Does Demiplane's `selectionRank` always match the slot rank for prepared spells, or can it differ for heightened preparation?
