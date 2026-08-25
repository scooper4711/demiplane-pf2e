# Spell Slot Progression - Tasks

## Tasks

- [ ] 1. Create `src/import/spell-slot-resolver.ts` with `resolveSpellSlots()` function
- [ ] 2. Implement stream-engines fetch: call endpoint with class engine ID, parse NDJSON response
- [ ] 3. Parse `StringObject` node to extract `engineModifiers` → find `v2-add-spell-slots` entry
- [ ] 4. Implement slot computation: sum counts per rank where `levelPrereq <= characterLevel`
- [ ] 5. Implement user override detection: scan for `CustomDemiplaneEngine` entries matching `character_spell-feature_{feature}_spell-slots_{slotType}_max` pattern
- [ ] 6. Merge logic: overrides take priority over stream-engines computed values
- [ ] 7. Investigate curriculum slot source in stream-engines (check school feature engine for its own `v2-add-spell-slots`)
- [ ] 8. Modify `spell-importer.ts` to call `resolveSpellSlots()` and set `system.slots.slotN.max` on the spellcasting entry
- [ ] 9. ~~Test CORS for `character.demiplane.com/stream-engines` from Foundry context~~ — Confirmed working, no CORS issues
- [ ] 10. ~~Add minimal hardcoded fallback table~~ — Removed. Stream-engines is the sole source.
- [ ] 11. Unit tests for slot computation logic (given slot entries + level → expected counts)
- [ ] 12. Unit tests for override detection
- [ ] 13. Integration test with FVTT-Wizard character (verify 5 cantrips + 2 rank-1 at level 1)

## Key Findings

- The class engine ID is in the character data: `tabula/class/wizard-rm.eng` → `id: "96eb308d-84b7-4494-884b-188b3ce2f7e6"`
- The spellcasting feature engine (`279a0698-17ea-4a56-ae85-a1f070c1fad4`) is returned as a dependency when fetching the class engine
- The slot table is in a `StringObject` node, which contains a JSON string with `engineModifiers[]`
- User overrides only appear in character data when manually set; they disappear on reset
- The `--overridden` companion flag (`value: 1`) confirms the override is active

## Notes

- FVTT-Wizard test character UUID: `67536b78-49c6-44a3-a456-4852410f8604`
- Currently has curriculum overrides set to 4712 (for testing) — reset before production testing
- The `versionMap` parameter is optional for stream-engines requests — omit it
- CORS confirmed working from Foundry's `localhost:30000`
- Spell Blending thesis: does NOT add its own `v2-add-spell-slots` entries. Players manually override their slot counts via the Demiplane UI (which creates `CustomDemiplaneEngine` override entries). Supporting override engines is sufficient for Spell Blending.
