# `import/spells` sub-package

Spell import: spell grouping, compendium matching, spellcasting entries,
slot resolution, and feature-granted spells. Depends only on `core` and
`shared` (enforced by `import-spells-depends-inward`). See
[DESIGN §8](../../../docs/DESIGN.md#8-three-resolver-spell-architecture).

## Responsibility

Turn a character's spell engines into Foundry spellcasting entries with
correct slots — class repertoires (prepared/spontaneous), innate/hex/font
groups, focus spells, and spells granted by features and feats — resolving
every spell against the compendium through `shared/`.

## Public surface

`index.ts` is authoritative (2 names). The driver (`phases.ts`) needs only
the two apply-steps; everything else is internal choreography:

| From                        | Role                             | Names                       |
| --------------------------- | -------------------------------- | --------------------------- |
| `spell-importer.ts`         | Class spellcasting orchestration | `applySpells`               |
| `feature-spell-resolver.ts` | Feature/feat-granted spells      | `applyFeatureGrantedSpells` |

Internal (not exported): `spell-grouping.ts` (main/innate/hex/font/ritual
sort + group config), `spell-engines.ts` (engine identification),
`spellcasting-features.ts` (class config table, special slugs, eidolon
traditions), `spellcasting-entry.ts` (entry creation + shared
resolve-and-stamp helper), `prepared-spells.ts` (prepared placement +
signature marking), `divine-font.ts` (cleric entry), `spell-slots.ts`
(slot maximums) + `spell-slot-resolver.ts` (progression from stream defs +
per-character overrides).

## How it works

- `applySpells` groups engines, creates one spellcasting entry per group,
  places prepared/signature spells, resolves the divine font, and writes
  slot maximums from the resolver's progression (stream-engine defs
  adjusted by per-character overrides).
- `applyFeatureGrantedSpells` handles everything not on a repertoire:
  focus, innate, hex, apparition, and repertoire-granted spells from
  features and feats, expanding feat grants through `shared/stream-engines`
  and matching through the compendium seam.
- `spellcasting-entry.ts` holds the single resolve-and-stamp path both
  flows share, so a spell is matched and flagged identically wherever it
  comes from.

## Constraints

- All compendium and stream access goes through `shared/` — no direct
  pack reads, no duplicated slug logic.
- Depends only on `core` and `shared`. Needs from siblings or the driver
  belong in `shared/` or in the phase pipeline, not here.
