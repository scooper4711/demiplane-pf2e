# `import/shared` sub-package

Shared import infrastructure: compendium resolution, Demiplane
engine-stream reading, and rank helpers. Consumed by the domain
sub-packages via this barrel; depends on `core` and `mapping` only, and
is the lowest layer inside `import/` (enforced by
`import-shared-is-lowest`).

## Responsibility

Give every domain importer the same two seams: "turn this Demiplane
reference into a Foundry document" and "read this engine-stream
definition". One implementation each, so slug matching and stream parsing
can't drift between spells, equipment, and choices. See
[ARCHITECTURE "Compendium Resolution"](../../../docs/ARCHITECTURE.md#compendium-resolution).

## Public surface

`index.ts` is authoritative (22 names).

| From                     | Role                                                     | Names                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compendium-resolver.ts` | Slug → compendium UUID (mapping first, then pack scan)   | `resolveCompendiumItem`, `resolveSlugToUuid`, `resolveSpellFromCompendium`, `resolveSpellSourceFromCompendium`                                                                                                                                                                                                                                                              |
| `stream-engines.ts`      | NDJSON fetch/parse, modifier types, feat-grant expansion | `fetchStreamEngineLines`, `parseEngineLines`, `expandFeatGrantLines`, `fetchDomainEngineData`, `mapSpellEngineIds`, `mapClassFeatureEngineIds`, `resolveClassFeatureEngineIdsBySlug`, `resolveGrantBuilderSelections`, `resolveGrantedFeatsBySlug`, `AddSpellModifier`, `EngineModifier`, `RawEngineLine`, `DemiplaneSlotEntry`, `DomainEngineData`, `RepertoireCountEntry` |
| `pf2e-ranks.ts`          | Rank/proficiency constants                               | `MAX_HERO_POINTS`, `PROFICIENCY_TRAINED`, `PROFICIENCY_LEGENDARY`                                                                                                                                                                                                                                                                                                           |

## How it works

- `resolveCompendiumItem` implements the mapping-first algorithm
  (recorded/GM mapping → `-rm` strip → class-suffix strip → bloodline
  prefix → pack search) and records successes non-clobberingly, so the
  mapping store doubles as a lookup cache (DESIGN §20, §22).
- `stream-engines.ts` parses the NDJSON stream definitions both spell
  resolvers need (slot progressions, feat-grant lines, repertoire counts);
  the modifier union types keep the two consumers reading the same shapes.
- `pf2e-ranks.ts` holds the small constants both profile and spell code
  need (proficiency rungs, hero-point cap).

## Constraints

- Lowest layer in `import/`: may not import sibling sub-packages, the
  driver, `sync`, `export`, or `ui`. Needs from higher layers are a sign
  the code belongs higher.
