# `core` package

Foundation: shared constants, pure utilities, and Foundry access seams.
Every other package may depend on `core`; `core` depends on nothing inside
`src/` (enforced by the `core-is-foundation` dependency-cruiser rule).

## Responsibility

Own the facts the whole module agrees on — module identity, Demiplane
endpoints and pack keys, slug math, engine-content signatures, PF2e
`system`-shape access, the optional libWrapper bridge, and the token
credential flow — so no two packages can disagree about them. See
[DESIGN §23](../../../docs/DESIGN.md#23-foundry-type-strategy-and-access-seams)
for the access-seam strategy: `pf2e-types.ts` and `pack-index.ts` (in
`mapping/`) centralize every Foundry/PF2e type assertion behind a named
boundary instead of scattering casts across call sites.

## Public surface

`index.ts` is authoritative (64 names). Consume this package only through
the barrel — enforced by eleven `no-deep-imports-into-*` rules.

| From              | Role                                                         | Names                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`        | Module identity + shared domain model                        | `MODULE_ID`, `INVENTORY_ITEM_TYPES`, `PACKS`, `EXPECTED_TYPES`, `ImportOptions`, `ImportSummary`, `DemiplaneEngineEntry`, `ItemCategory`, `SlugKind`, `UnmappedSlug`, `UnresolvedChoice`, `ChoiceKey`, `ChoiceOverrides`, `formatUnmapped`, `stampImported`                                                     |
| `config.ts`       | Static endpoints, assets, pack keys                          | `DEMIPLANE_SHEET_BASE`, `IMPORT_PLACEHOLDER_NAME`, `DEMIPLANE_ICON_SRC`, `DEMIPLANE_ERROR_ICON_SRC`, `KOFI_URL`, `PF2E_ENGINE_SOURCE`, `SPELLS_PACK`, `EQUIPMENT_PACK`, `DEITIES_PACK`                                                                                                                          |
| `slug-utils.ts`   | Pure slug derivation/normalization shared by import and push | `toFoundrySlug`, `getSlug`, `rawEquipmentSlug`, `categorizeEngine`, `parseFeatSlot`, `describeFeatSlot`, `generateSlugCandidates`, `normalizeEquipmentSlug`, `parseRankedConsumable`, `genericConsumableSlug`, `isGrantedByElement`, `isFormulaEngine`, `slugifyFreeText`, `stripHtmlTags`, `stripTrailingWord` |
| `pf2e-types.ts`   | PF2e `system`-shape seams (single cast boundary)             | `characterSystem`, `itemSystem`, `documentSystem`, `toPlainData`, `sourceRules`, `itemSourceId`, `compendiumSource`, `pf2eLanguages`, `pf2ePredicate`, `builtinRuleElement`, `localizeLanguage`, `actorNaturalSize`, `Pf2eItemSystem`, `Pf2eSize`, `Pf2eSpellSlotRank` (+ `Pf2e*` shape interfaces)             |
| `engine-sig.ts`   | Stable engine-content signature for conflict checks          | `computeEngineSig`                                                                                                                                                                                                                                                                                              |
| `debug-log.ts`    | Gated debug logging for import/export lifecycle              | `debugLog`                                                                                                                                                                                                                                                                                                      |
| `token.ts`        | Raw API/JWT errors → user-facing messages                    | `toUserFacingSyncError`, `TOKEN_HELP_URL`                                                                                                                                                                                                                                                                       |
| `token-source.ts` | Credential flow: read setting, reconcile client just-in-time | `readConfiguredToken`, `syncClientToken`                                                                                                                                                                                                                                                                        |
| `libwrapper.ts`   | Optional libWrapper adapter isolating the untyped global     | `getLibWrapper`, `registerWrapper`, `unregisterWrapper`, `WrappedFn`                                                                                                                                                                                                                                            |

## How it works

This package has no internal call graph to describe — its files are
independent leaves by design. The two files with behavior worth noting:

- `pf2e-types.ts` is the _only_ place that narrows PF2e's untyped
  `system` payloads. Callers read intent (`characterSystem(actor).skills`)
  and never cast. If a new system shape is needed, the accessor is added
  here, not at the call site.
- `token-source.ts` reconciles the API client's token just-in-time from
  the `demiplaneToken` setting, so import and push never depend on
  `module.ts` having seeded the client first.

## Constraints

- No imports from any other `src/` package. New shared code belongs here
  only if _every_ consumer direction needs it; otherwise it belongs in the
  lowest package that covers its consumers.
- Pure where possible: `slug-utils.ts`, `engine-sig.ts`, and `token.ts`
  have no Foundry dependencies and are unit-tested without mocks.
