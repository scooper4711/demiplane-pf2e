# Architecture

This document describes the internal architecture of `demiplane-pf2e`: component responsibilities, class relationships, data flow through the system, and lifecycle hooks.

---

## Table of Contents

- [Component Overview](#component-overview)
- [Class Diagram](#class-diagram)
- [Module Initialization](#module-initialization)
- [Import Data Flow](#import-data-flow)
- [Export Data Flow](#export-data-flow)
- [Conflict Detection Flow](#conflict-detection-flow)
- [File Structure](#file-structure)
- [Import Subsystem Detail](#import-subsystem-detail)
- [Hook Lifecycle](#hook-lifecycle)
- [Compendium Resolution](#compendium-resolution)
- [ChoiceSet Auto-Resolution](#choiceset-auto-resolution)
- [Grant Chain Sequencing](#grant-chain-sequencing)

---

## Component Overview

```mermaid
graph TD
    subgraph "Foundry VTT Browser"
        Module[module.ts<br/>Bootstrap + Hook Registration]
        Settings[settings.ts<br/>Module Settings]
        ST[titlebar-dot.ts<br/>Sync Issue Indicator]
        SI[sync-issues.ts<br/>Import/Export Issue Sets]
        IBTN[demiplane-info-button.ts<br/>Demiplane Dialog]
        CLD[CharacterLinkDialog<br/>UUID Linking]
        HM[HookManager<br/>Actor Change Detection]
        IO[ImportOrchestrator<br/>Import Pipeline]
        EM[ExportManager<br/>Debounced Push]
    end

    subgraph "Import Subsystem"
        CSH[ChoiceSetHandler<br/>Auto-Select Choices]
        CompRes[compendium-resolver<br/>Slug → UUID]
        SlugUtils[slug-utils<br/>Slug Transformation]
        SpellImp[spell-importer<br/>Spellcasting Entries]
        SpellSlot[spell-slot-resolver<br/>Slot Progression]
        FeatSpell[feature-spell-resolver<br/>Focus/Innate Spells]
        ItemSpell[item-spell-resolver<br/>Staff/Wand Spells]
        EquipImp[equipment-importer<br/>Items + Containers]
        AttrImp[attribute-language-importer<br/>Boosts + Skills + Languages]
        BioImp[biography-importer<br/>Bio Fields + Deity]
    end

    subgraph "@scooper4711/demiplane-api"
        DC[DemiplaneClient]
        EU[Engine Utilities]
    end

    subgraph "External APIs"
        GQL[Demiplane GraphQL<br/>apiv4.demiplane.com]
        SE[Stream-Engines<br/>character.demiplane.com]
    end

    subgraph "Foundry Core"
        ACTOR[Actor Document]
        COMP[Compendium Packs]
        HOOKS[Foundry Hook System]
    end

    Module --> Settings
    Module --> HM
    Module --> IO
    Module --> EM
    Module --> ST
    Module --> CLD

    HM --> EM
    EM --> DC
    DC --> GQL

    IO --> CSH
    IO --> CompRes
    IO --> SlugUtils
    IO --> SpellImp
    IO --> EquipImp
    IO --> AttrImp
    IO --> BioImp
    IO --> ACTOR

    SpellImp --> SpellSlot
    SpellImp --> CompRes
    SpellSlot --> SE
    FeatSpell --> SE
    FeatSpell --> CompRes
    ItemSpell --> SE
    ItemSpell --> CompRes
    CompRes --> SlugUtils
    CompRes --> COMP

    IO --> FeatSpell
    IO --> ItemSpell

    ST --> ACTOR
    CLD --> ACTOR
    HOOKS --> HM
    HOOKS --> Module
```

---

## Class Diagram

```mermaid
classDiagram
    class DemiplaneClient {
        -graphqlToken: string|null
        +setToken(token: string): void
        +isAuthenticated(): boolean
        +validateToken(): Promise~void~
        +fetchCharacterData(id: string): Promise~CharacterData~
        +fetchCharacterVersion(id: string): Promise~CharacterVersion~
        +fetchAttributeMapping(nexusId: number): Promise~AttributeMapping~
        +updateCharacter(options: UpdateCharacterOptions): Promise~boolean~
    }

    class ImportOrchestrator {
        -client: DemiplaneClient
        -choiceSetHandler: ChoiceSetHandler
        +importCharacter(actor, characterId, options): Promise~ImportSummary~
        -fetchCharacterEngines(characterId): Promise~DemiplaneEngineEntry[]~
        -categorizeEngines(engines): CategorizedEngines
        -buildSelectionData(engines): SelectionData
        -addItemToActor(actor, slug, pack, options): Promise~Item|null~
        -importBatchItems(actor, engines): Promise~void~
        -resolvePendingGrants(actor, engines): Promise~void~
        -createLoreItems(actor, background, engines): Promise~void~
        -setActorIdentity(actor, engines): Promise~void~
        -syncSessionState(actor, engines): Promise~void~
    }

    class ExportManager {
        -client: DemiplaneClient
        -pendingChanges: Map~string, PendingChange[]~
        -debounceTimers: Map~string, number~
        -callCounts: Map~string, number[]~
        +queueChange(actor, storeName, value): void
        +flush(actor, options): Promise~ExportResult~
        +hasPendingChanges(characterId): boolean
        -checkRateLimit(characterId): boolean
        -retryWithBackoff(fn, retries): Promise~boolean~
    }

    class HookManager {
        -exportManager: ExportManager
        +register(): void
        -onActorUpdate(actor, changes): void
        -onItemUpdate(item, changes): void
        -onItemCreate(item): void
        -onItemDelete(item): void
        -mapFieldToStoreName(path): string|undefined
    }

    class TitlebarDot {
        +register(importCharacter, exportCharacter): void
        -applyDot(dot, actor): void
        -getOpenSheetsFor(actor): ActorSheet[]
    }

    class SyncIssues {
        +getImportIssues(actor): Set
        +getExportIssues(actor): Set
        +hasActiveIssues(actor): boolean
        +resetImportIssues(actor): void
        +clearExportIssues(actor): void
        +clearAllIssues(actor): void
        +addImportIssue(actor, msg): void
        +addExportIssue(actor, msg): void
    }

    class DemiplaneInfoDialog {
        +showDemiplaneInfoDialog(actor, id, import, export): Promise
        -buildIssuesSection(importIssues, exportIssues): string
        -buildManualItemsSection(items): string
        -performUpdate(actor, id, import): Promise
    }

    class CharacterLinkDialog {
        -client: DemiplaneClient
        +show(actor): void
        -linkCharacter(actor, input): Promise~void~
        -unlinkCharacter(actor): Promise~void~
    }

    class ChoiceSetHandler {
        -engines: DemiplaneEngineEntry[]
        +setEngines(engines): void
        +presetChoiceSelections(itemData): void
        +install(): void
        +uninstall(): void
        -matchBySkillSlug(choices): string|undefined
        -matchByEngineSlug(choices): string|undefined
        -matchByClassFeatureSlug(choices): string|undefined
        -matchByGenericFeatureSlug(choices): string|undefined
        -matchByFeatUuidSlug(choices): string|undefined
        -matchByGenericChoiceKeyword(choices): string|undefined
    }

    class SpellSlotResolver {
        +resolveSpellSlots(engineId, level, slotSlug): Promise~SpellSlotProgression~
    }

    class FeatureSpellResolver {
        +applyFeatureGrantedSpells(actor, engines, level): Promise~void~
    }

    class ItemSpellResolver {
        +applyItemSpells(actor, engines): Promise~void~
    }

    ImportOrchestrator --> DemiplaneClient : fetches data
    ImportOrchestrator --> ChoiceSetHandler : auto-resolves choices
    ImportOrchestrator --> SpellSlotResolver : spell slots
    ImportOrchestrator --> FeatureSpellResolver : focus/innate
    ImportOrchestrator --> ItemSpellResolver : staff/wand

    ExportManager --> DemiplaneClient : pushes changes
    HookManager --> ExportManager : queues changes

    SyncIssues ..> ExportManager : export issues
    SyncIssues ..> ImportOrchestrator : import issues
    DemiplaneInfoDialog --> SyncIssues : lists/dismisses
    TitlebarDot --> SyncIssues : reads active issues
    TitlebarDot --> DemiplaneInfoDialog : opens on click
    CharacterLinkDialog --> DemiplaneClient : validates UUID
```

---

## Module Initialization

```mermaid
sequenceDiagram
    participant Foundry
    participant Module as module.ts
    participant Settings as settings.ts

    Foundry->>Module: Hooks.once("init")
    Module->>Settings: registerSettings()
    Note over Settings: Registers: autoSync, demiplaneToken, debugImport

    Foundry->>Module: Hooks.once("ready")
    Module->>Module: Create DemiplaneClient
    Module->>Module: Read token from settings
    Module->>Module: client.setToken(token) if configured

    Module->>Module: Create ImportOrchestrator(client)
    Module->>Module: Create ExportManager(client)
    Module->>Module: Create HookManager(exportManager)
    Module->>Module: Create CharacterLinkDialog(client)

    Module->>Module: hookManager.register()
    Note over Module: Registers updateActor, updateItem,<br/>createItem, deleteItem hooks

    Module->>Module: registerDemiplaneInfoButton(import, export)
    Module->>Module: registerTitlebarDot(import, export)
    Note over Module: Renders sync-issue dot on linked sheet titlebars;<br/>click opens the Demiplane dialog

    Module->>Module: Expose module API on game.modules

    Foundry->>Module: Hooks.on("renderActorDirectory")
    Module->>Module: Add "Import Demiplane Character" button

    Foundry->>Module: Hooks.on("getActorContextOptions")
    Module->>Module: Add "Update from Demiplane" context menu
```

**Module API** (exposed on `game.modules.get("demiplane-pf2e").api`):

| Method                            | Description                 |
| --------------------------------- | --------------------------- |
| `importCharacter(actor, options)` | Trigger a full import       |
| `exportNow(actor)`                | Force-flush pending changes |

---

## Import Data Flow

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
    IO->>CSH: install()
    Note over CSH: Monkey-patches ChoiceSet.preCreate

    IO->>IO: categorizeEngines(engines)
    Note over IO: → ancestry, heritage, background, class,<br/>feats[], equipment[]

    IO->>IO: buildSelectionData(engines)
    Note over IO: Identifies feat grants via ChoiceSet<br/>to avoid duplication

    rect rgb(230, 245, 255)
        Note over IO,Act: Sequential Phase (Grant Chain)
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

    IO->>IO: resolvePendingGrants(actor, engines)
    IO->>IO: createLoreItems(actor, background, engines)

    rect rgb(255, 245, 230)
        Note over IO,Act: Batch Phase
        IO->>Comp: resolve all feat slugs
        IO->>Act: createEmbeddedDocuments(allFeats)
    end

    rect rgb(240, 255, 240)
        Note over IO,Act: Post-Import Phases
        IO->>Act: setActorIdentity (name, level, avatar)
        IO->>Act: applyAttributeBoosts
        IO->>Act: applyLanguages
        IO->>Act: applyBiography
        IO->>Act: applySkillProficiencies
        IO->>Act: applyEquipment + applyCurrency
        IO->>SE: applySpells (fetches slot data)
        IO->>SE: applyFeatureGrantedSpells
        IO->>SE: applyItemSpells
        IO->>Act: syncSessionState (HP, hero points)
    end

    IO->>CSH: uninstall()
    IO->>Act: setFlag("lastKnownVersion", version)
    IO->>Act: setFlag("lastSyncTimestamp", now)
    IO-->>Module: ImportSummary
```

---

## Export Data Flow

```mermaid
sequenceDiagram
    participant Foundry as Foundry Core
    participant HM as HookManager
    participant EM as ExportManager
    participant DC as DemiplaneClient
    participant API as Demiplane GraphQL

    Foundry->>HM: Hook: updateActor(actor, changes)
    HM->>HM: Check: is linked character?
    HM->>HM: Map Foundry path → store name

    alt Mapped field changed
        HM->>EM: queueChange(actor, storeName, value)
        EM->>EM: Store in pendingChanges map
        EM->>EM: Reset 2s debounce timer
    end

    Note over EM: 2 seconds of inactivity...

    EM->>EM: Debounce timer fires
    EM->>EM: Check rate limit (30/60s window)

    alt Rate limit OK
        EM->>DC: fetchCharacterData(characterId)
        DC-->>EM: Current engines array

        EM->>EM: Apply pending changes via updateCustomEngineValue
        EM->>DC: updateCharacter({ id, data })
        DC->>API: updateCharacterV2 mutation

        alt Success
            API-->>DC: { success: true }
            EM->>EM: Clear pending changes
            EM->>Foundry: actor.setFlag("lastSyncTimestamp", now)
        else Transient failure
            EM->>EM: Retry with backoff (1s, 2s, 4s)
        end
    else Rate limit exceeded
        EM->>EM: Retain changes, try on next trigger
    end
```

---

## File Structure

```
src/
├── module.ts                      Entry point: hook registration, service wiring, API exposure
├── settings.ts                    Foundry module settings (token, autoSync, debugImport)
├── hook-manager.ts                Listens to actor/item hooks, maps fields, queues exports
├── export-manager.ts              Debounced + rate-limited push to Demiplane
├── sync-issues.ts                Import/export sync-issue sets on linked actors
├── titlebar-dot.ts               Red indicator on actor sheet titlebars for open issues
├── demiplane-info-button.ts      Header button + Demiplane dialog (lists issues, dismissable)
├── character-link-dialog.ts       Dialog for linking/unlinking UUID to actor
├── character-link-input.ts        Parses UUID or Demiplane URL
├── slug-mapper.ts                 (Legacy) standalone slug resolution class
├── attribute-skill-importer.ts    (Legacy) standalone attribute/skill functions
│
├── import/
│   ├── index.ts                   Barrel re-export
│   ├── types.ts                   Core types: DemiplaneEngineEntry, ImportSummary, etc.
│   ├── orchestrator.ts            Central import pipeline coordinator
│   ├── slug-utils.ts              Slug transformation and categorization
│   ├── compendium-resolver.ts     Slug → compendium UUID resolution
│   ├── choice-set-handler.ts      ChoiceSet monkey-patch with 6 strategies
│   ├── debug-log.ts               Conditional debug logging
│   │
│   ├── spell-importer.ts          Class spellcasting entries + spell placement
│   ├── spell-engines.ts           Spell engine identification helpers
│   ├── spell-slot-resolver.ts     Fetches slot progression from stream-engines
│   ├── feature-spell-resolver.ts  Focus/innate spells from class features
│   ├── item-spell-resolver.ts     Staff/wand spells from items
│   │
│   ├── equipment-importer.ts      Equipment + containers + carry state
│   ├── attribute-language-importer.ts  Boosts, skills, languages
│   └── biography-importer.ts      Biography fields, deity, organized play
│
└── pf2e-foundry-config.d.ts       Type augmentations for Foundry/PF2e
```

---

## Import Subsystem Detail

The import subsystem is the most complex part of the module. Here is how its components interact:

```mermaid
graph TD
    IO[ImportOrchestrator] --> |"1. categorize"| SU[slug-utils]
    IO --> |"2. setup"| CSH[ChoiceSetHandler]
    IO --> |"3. resolve items"| CR[compendium-resolver]
    CR --> SU
    CR --> |"search packs"| COMP[Compendium Packs]

    IO --> |"4a. spells"| SI[spell-importer]
    SI --> |"slot counts"| SSR[spell-slot-resolver]
    SI --> CR
    SSR --> |"POST"| SE[Stream-Engines API]

    IO --> |"4b. feature spells"| FSR[feature-spell-resolver]
    FSR --> |"POST"| SE
    FSR --> CR

    IO --> |"4c. item spells"| ISR[item-spell-resolver]
    ISR --> |"POST"| SE
    ISR --> CR

    IO --> |"4d. equipment"| EI[equipment-importer]
    EI --> CR

    IO --> |"4e. attributes"| ALI[attribute-language-importer]
    IO --> |"4f. biography"| BI[biography-importer]
```

### Import Phase Order

| Phase | Component                     | What It Does                                         |
| ----- | ----------------------------- | ---------------------------------------------------- |
| 1     | `orchestrator`                | Fetch engines, categorize by type                    |
| 2     | `ChoiceSetHandler`            | Install monkey-patch for auto-selection              |
| 3     | `orchestrator`                | Sequential: ancestry → heritage → background → class |
| 4     | `orchestrator`                | Resolve pending grants from sequential items         |
| 5     | `orchestrator`                | Create lore items from background                    |
| 6     | `orchestrator`                | Batch: all feats                                     |
| 7     | `equipment-importer`          | Equipment with containers and carry state            |
| 8     | `attribute-language-importer` | Attribute boosts, skill proficiencies, languages     |
| 9     | `biography-importer`          | Biography text fields, deity                         |
| 10    | `spell-importer`              | Class spellcasting entries with slot placement       |
| 11    | `feature-spell-resolver`      | Focus and innate spells from features                |
| 12    | `item-spell-resolver`         | Staff and wand spell lists                           |
| 13    | `orchestrator`                | Session state (HP, hero points, etc.)                |
| 14    | `ChoiceSetHandler`            | Uninstall monkey-patch                               |
| 15    | `orchestrator`                | Stamp version + timestamp flags                      |

---

## Hook Lifecycle

`HookManager` registers four Foundry hooks during initialization:

| Hook          | Trigger                        | Action                                                |
| ------------- | ------------------------------ | ----------------------------------------------------- |
| `updateActor` | Actor data changes             | Maps field path → Demiplane store name, queues export |
| `updateItem`  | Item on linked actor changes   | Logs change (future: consumable sync)                 |
| `createItem`  | Item added to linked actor     | Logs creation (future: equipment sync)                |
| `deleteItem`  | Item removed from linked actor | Logs deletion (future: equipment sync)                |

All hooks filter for: `actor.type === "character"` AND actor has `demiplane-pf2e.characterId` flag set.

### Actor Field → Store Name Mapping

| Foundry Actor Path                  | Demiplane Store Name           |
| ----------------------------------- | ------------------------------ |
| `system.attributes.hp.value`        | `character_hit-points_current` |
| `system.attributes.hp.temp`         | `character_hit-points_temp`    |
| `system.resources.heroPoints.value` | `character_hero-points`        |
| `system.resources.focus.value`      | `character_focus_current`      |
| `system.currency.gp`                | `character_currency_gold`      |
| `system.currency.sp`                | `character_currency_silver`    |
| `system.currency.cp`                | `character_currency_copper`    |
| `system.currency.pp`                | `character_currency_platinum`  |

---

## Compendium Resolution

The `compendium-resolver` module searches PF2e compendium packs by `system.slug` to find the Foundry item UUID for a given Demiplane slug.

### Resolution Algorithm

```
Input: Demiplane slug (e.g., "weapon-specialization-fighter-rm")

1. Transform: toFoundrySlug() strips "-rm" suffix → "weapon-specialization-fighter"
2. Generate candidates:
   a. Exact: "weapon-specialization-fighter"
   b. Strip class suffix: "weapon-specialization"
   c. Bloodline prefix: "bloodline-weapon-specialization-fighter" (if applicable)
3. For each candidate, search target pack(s) by system.slug
4. Return first match, or undefined if none found
```

### Pack Search Order

| Pack                 | Contents                  |
| -------------------- | ------------------------- |
| `pf2e.ancestries`    | Ancestries                |
| `pf2e.heritages`     | Heritages                 |
| `pf2e.backgrounds`   | Backgrounds               |
| `pf2e.classes`       | Classes                   |
| `pf2e.classfeatures` | Class features            |
| `pf2e.feats-srd`     | Feats                     |
| `pf2e.spells-srd`    | Spells                    |
| `pf2e.equipment-srd` | Equipment, armor, weapons |

The resolver accepts a target pack parameter to search a specific pack, or searches all packs in order.

---

## ChoiceSet Auto-Resolution

When items are added to a PF2e actor, the system's `ChoiceSetRuleElement` normally presents an interactive dialog for player choices (e.g., "choose a skill to increase"). During automated import, these must be resolved without user interaction.

The `ChoiceSetHandler` monkey-patches `ChoiceSet.preCreate` to intercept choice prompts and auto-select the correct option using 6 strategies (tried in priority order):

| Priority | Strategy                | Matches Against                                                    |
| -------- | ----------------------- | ------------------------------------------------------------------ |
| 1        | Skill slugs             | `core/selection/skill/increase` engine slugs                       |
| 2        | All engine slugs        | Any DemiplaneEngine `args.slug`                                    |
| 3        | Class feature slugs     | Choice labels slugified against class feature engines              |
| 4        | Generic feature slugs   | Partial match of `generic-feature` engine slugs                    |
| 5        | Feat UUID slugs         | Choice labels against feat engines with `select-feat-` sourceRow   |
| 6        | Generic choice keywords | Last segment of `generic-choice` engine slug against choice values |

**Fallback:** If no strategy matches, selects `choices[0]`.

The monkey-patch is installed before import begins and uninstalled after import completes, so normal interactive behavior is restored for manual character editing.

---

## Grant Chain Sequencing

The PF2e system uses a **Grant Chain** — when items are added, `GrantItem` rule elements automatically create sub-items. This requires careful ordering during import.

### Why Sequential

```
Class (wizard)
  └── GrantItem → "Arcane Spellcasting" (class feature)
  └── GrantItem → "Arcane School" (class feature)
       └── ChoiceSet → pick a school
            └── GrantItem → school-specific feature
```

If class features aren't present when ancestry is evaluated, or if the class isn't present when feats are added, the Grant Chain cannot resolve prerequisite checks.

### Ordering Constraint

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

**Sequential (one at a time, await each):** Ancestry → Heritage → Background → Class

**Batch (single `createEmbeddedDocuments` call):** All feats together

**Independent (any order):** Equipment, spells, attributes, biography — these don't trigger Grant Chains that depend on ordering.

### Engine Categorization Rules

The orchestrator categorizes engines by inspecting the `name` path:

| Path Contains                         | Category   | Notes                          |
| ------------------------------------- | ---------- | ------------------------------ |
| `/classfeature/` or `/class-feature/` | (skipped)  | Granted automatically by class |
| `/ancestry/`                          | ancestry   |                                |
| `/heritage/`                          | heritage   |                                |
| `/background/`                        | background |                                |
| `/class/`                             | class      | Checked after classfeature     |
| `/feat/`                              | feat       |                                |
| `/spell/`                             | spell      | Handled by spell-importer      |
| `/item/`                              | equipment  |                                |

Class features are explicitly excluded from direct import because the PF2e Grant Chain creates them automatically when the class item is added.
