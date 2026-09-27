# `import` package (driver)

Demiplane → Foundry character import. The driver layer
(`orchestrator.ts`, `phases.ts`, `reconcile.ts`, `variant-check.ts`) lives
at this root; domain logic lives in the sub-packages below, each with its
own `DESIGN.md`. The driver is the only part that fans out to all of them
(enforced by the `import-driver-depends-inward` and per-sub-package rules).

Sub-packages and their layering:

| Sub-package  | Responsibility                                             | May depend on                       |
| ------------ | ---------------------------------------------------------- | ----------------------------------- |
| `shared/`    | Compendium resolution, engine-stream reading, rank helpers | `core`, `mapping`                   |
| `character/` | Biography, attributes, skills, languages                   | `core`, `shared`, `mapping`         |
| `choices/`   | ChoiceSet auto-resolution + per-actor overrides            | `core`, `shared`                    |
| `spells/`    | Spellcasting entries, slots, feature-granted spells        | `core`, `shared`                    |
| `equipment/` | Inventory, runes, containers, crafting formulas            | `core`, `shared`, `mapping`, `sync` |

## Responsibility

Fetch a character's engines, run them through the ordered phase pipeline,
and leave a fully-built actor plus an `ImportSummary` — while the
`ChoiceSetHandler` auto-resolves PF2e's interactive choices without user
input. See [ARCHITECTURE](../../../docs/ARCHITECTURE.md#import-subsystem-detail)
and [DESIGN §6–§12](../../../docs/DESIGN.md#6-sequential-createembeddeddocuments-for-core-items).

## Public surface

`index.ts` is authoritative (2 names). Everything else in this package is
reached through the sub-package barrels (`shared/`, `character/`,
`choices/`, `equipment/`, `spells/`), never through this one.

| From              | Role                                                            | Names                 |
| ----------------- | --------------------------------------------------------------- | --------------------- |
| `orchestrator.ts` | Fetch engines, install ChoiceSet handling, build + run pipeline | `ImportOrchestrator`  |
| `reconcile.ts`    | Actor-wipe step consumed by `flows/` before re-import           | `deleteImportedItems` |

Internal (not exported): `phases.ts` (`ImportPhase`, `ImportContext`,
and the seven phase implementations), `variant-check.ts` (orchestrator-only
helper).

## How it works

- `ImportOrchestrator.importCharacter` fetches engines, stamps the
  `lastUpdated`/`engineSig` baseline, installs the `ChoiceSetHandler`
  monkey-patch, and drives the phases in order inside `try/finally`:
  lore → equipment prep → sequential ABC/class → grant resolution → batch
  feats/equipment → post-processing (identity, profile, spells, session
  state) → duplicate removal — then uninstalls the patch and stamps
  `lastImportTimestamp`. Journals import last, needing no patch.
- Grant-chain ordering is the reason for sequential phases: class features
  must exist before ancestry/feat evaluation (see ARCHITECTURE "Grant
  Chain Sequencing").
- `deleteImportedItems` (used by `flows/` pre-import) removes only items
  stamped `imported`, preserving user-added homebrew (DESIGN §15).

## Constraints

- The driver may import domain sub-package barrels, `core`, `sync`, and
  `mapping`. Domain sub-packages may never import the driver or each other
  (except through `shared/`) — the phase pipeline is the only fan-out point.
- New importers go in the fitting sub-package and are called from
  `phases.ts`, not from the orchestrator directly.

## Interactions

The driver fans out to the domain sub-packages; domains reach sideways
only through `shared/`:

```mermaid
graph TD
    ORCH["orchestrator<br/>fetch + drive phases"]
    PH["phases<br/>7 ImportPhases"]
    CSH["choices/<br/>ChoiceSetHandler"]
    STE["shared/<br/>stream-engines"]
    ISSUES["sync/<br/>choice overrides"]
    CHAR["character/"]
    EQUIP["equipment/"]
    SPELL["spells/"]
    REC["reconcile<br/>wipe step"]
    FLOWS["flows/<br/>importLinkedCharacter"]
    FLOWS --> ORCH
    FLOWS --> REC
    ORCH --> PH
    ORCH --> CSH
    ORCH --> STE
    ORCH --> ISSUES
    PH --> CSH
    PH --> CHAR
    PH --> EQUIP
    PH --> SPELL
```

### Driver-to-domain interactions

File-level graph behind the driver view above — which resolver serves
which domain:

```mermaid
graph TD
    ORCH2[orchestrator<br/>fetch + drive phases]
    PH2[phases<br/>7 ImportPhases]
    CSH2[choices/<br/>ChoiceSetHandler]
    CR[shared/<br/>compendium-resolver]
    SU[core/<br/>slug-utils]
    COMP[Compendium Packs]
    SE[Stream-Engines API]
    SI[spells/<br/>spell-importer]
    SG[spells/<br/>spell-grouping]
    SCF[spells/<br/>spellcasting-features]
    SCE[spells/<br/>spellcasting-entry]
    PS[spells/<br/>prepared-spells]
    DF[spells/<br/>divine-font]
    SL[spells/<br/>spell-slots]
    SSR[spells/<br/>slot-resolver]
    STE2[shared/<br/>stream-engines]
    FSR[spells/<br/>feature-spell-resolver]
    EI[equipment/<br/>equipment-importer]
    ALI[character/<br/>attribute-language]
    BI[character/<br/>biography]

    ORCH2 --> PH2
    ORCH2 --> CSH2
    ORCH2 --> STE2
    PH2 --> SU
    PH2 --> CR
    PH2 --> CSH2
    PH2 --> SI
    PH2 --> FSR
    PH2 --> EI
    PH2 --> ALI
    PH2 --> BI
    CR --> SU
    CR --> COMP
    SI --> SG
    SG --> SCF
    SI --> SCE
    SI --> PS
    SI --> DF
    SI --> SL
    SL --> SSR
    SSR --> SCF
    SSR --> STE2
    STE2 --> SE
    SCE --> CR
    FSR --> STE2
    FSR --> SCF
    FSR --> CR
    EI --> CR
```

### Grant-chain ordering

Why ABC/class creation is sequential while everything else batches:

```mermaid
graph LR
    A[Ancestry] --> B[Heritage]
    B --> C[Background]
    C --> D[Class]
    D --> E[Pending Grant Resolution]
    E --> F[Lore Items]
    F --> G[Feats - Batch]
    G --> H[Post-Import Phases]
```

### Import data flow detail

Phase-by-phase sequence behind the package-level flow in
[ARCHITECTURE](../../../docs/ARCHITECTURE.md#import-data-flow):

```mermaid
sequenceDiagram
    participant User
    participant Module as module.ts
    participant IO as ImportOrchestrator
    participant CSH as ChoiceSetHandler
    participant GQL as Demiplane GraphQL
    participant SE as Stream-Engines API
    participant Comp as Compendium Packs
    participant Act as Actor Document

    User->>Module: Click "Import Demiplane Character"
    Module->>IO: importCharacter(actor, characterId, options)

    IO->>GQL: fetchCharacterData(characterId)
    GQL-->>IO: { engines: DemiplaneEngineEntry[] }

    IO->>CSH: setEngines(engines)
    IO->>CSH: enable()
    Note over CSH: Monkey-patches ChoiceSet.preCreate

    IO->>IO: categorizeEngines(engines)
    Note over IO: → ancestry, heritage, background, class, feats[], equipment[]

    IO->>IO: buildSelectionData(engines)
    Note over IO: Identifies feat grants via ChoiceSet to avoid duplication

    rect rgb(235, 245, 255)
        Note over IO,Act: LoreItemsPhase (before sequential — feats may reference lore)
        IO->>Comp: resolve background lore + collectLoreNames
        IO->>Act: createEmbeddedDocuments([lore items])
    end

    rect rgb(230, 245, 255)
        Note over IO,Act: SequentialItemsPhase (Grant Chain)
        IO->>Comp: resolveCompendiumItem(ancestrySlug)
        Comp-->>IO: Item data
        IO->>Act: createEmbeddedDocuments([ancestry])

        IO->>Comp: resolveCompendiumItem(heritageSlug)
        Comp-->>IO: Item data
        IO->>Act: createEmbeddedDocuments([heritage])

        IO->>Comp: resolveCompendiumItem(backgroundSlug)
        Comp-->>IO: Item data
        IO->>Act: createEmbeddedDocuments([background])

        IO->>Comp: resolveCompendiumItem(classSlug)
        Comp-->>IO: Item data
        IO->>Act: createEmbeddedDocuments([class])
    end

    IO->>IO: ResolveGrantsPhase → resolvePendingGrants(actor, engines)
    Note over IO: Adds resolved slugs to selectionData.grantedFeatSlugs

    rect rgb(255, 245, 230)
        Note over IO,Act: BatchItemsPhase
        IO->>Comp: resolve all feat + equipment slugs (skip granted)
        IO->>Act: createEmbeddedDocuments(allFeatsAndEquipment)
    end

    rect rgb(240, 255, 240)
        Note over IO,Act: PostProcessingPhase
        IO->>Act: setActorIdentity (name, level, avatar)
        IO->>Act: applyAttributeBoosts
        IO->>Act: applyLanguages
        IO->>Act: applyBiography
        IO->>Act: applySkillProficiencies
        IO->>Act: applyEquipment + applyCurrency
        IO->>SE: applySpells (fetches slot data)
        IO->>SE: applyFeatureGrantedSpells
        IO->>Act: syncSessionState (HP, hero points)
    end

    IO->>IO: RemoveDuplicatesPhase → removeDuplicateItems(actor)

    IO->>CSH: disable()
    IO->>Act: setFlag("lastUpdated", updated)
    IO->>Act: setFlag("engineSig", computeEngineSig(engines))
    IO->>Act: setFlag("lastImportTimestamp", now)
    IO-->>Module: ImportSummary
```
