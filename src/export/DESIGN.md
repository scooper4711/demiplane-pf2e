# `export` package

Foundry → Demiplane push pipeline. Depends on `core` and `sync` only
(enforced by `export-depends-inward`). `HookManager` (Foundry document
hooks) feeds `ExportManager` (debounced, retried push); the buffer,
payload builder, and conflict check are internal collaborators owned by
the manager.

## Responsibility

Turn local actor/item edits on linked characters into rate-limited,
conflict-checked Demiplane pushes — and nothing else. Import never flows
through here; the `flows/` bridge calls in from above. See
[DESIGN §3–§5](../../../docs/DESIGN.md#3-two-second-debounce-window-for-export),
[§14](../../../docs/DESIGN.md#14-exponential-backoff-retry-strategy),
[§17](../../../docs/DESIGN.md#17-conflict-resolution-heuristic),
[§27–§28](../../../docs/DESIGN.md#27-journal-writes-without-the-actor-pause).

## Public surface

`index.ts` is authoritative (6 names). Only the manager, the hook
registration, and the queue entry points used by `flows/` are public;
`ChangeBuffer`, `PushPayloadBuilder`, `ConflictResolver`, and the
spellcasting-entry queue helpers are internal details reached through
`ExportManager` / `HookManager`.

| From                | Role                                                | Names                                                                                       |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `export-manager.ts` | Debounced, rate-limited, retried push orchestration | `ExportManager`, `ExportResult`                                                             |
| `hook-manager.ts`   | Foundry hook → buffered-change translation          | `HookManager`, `queueCombatResourceChanges`, `queueAllItemChanges`, `queueAllDetailChanges` |

Internal (not exported): `change-buffer.ts` (2s debounce, 30/min rate
limit, per-character pending maps, suspend counts), `push-payload-builder.ts`
(buffered changes → Demiplane payload with slug→engine resolution),
`conflict-resolver.ts` (`updated` + `engine-sig` optimistic-concurrency
check), `spellcasting-entry-sync.ts` (prepared-expended and spontaneous
slot bookkeeping).

## How it works

- Ingress: `HookManager.register` subscribes to `updateActor`,
  `createItem`, `updateItem`, `deleteItem`. Each hook checks the link flag,
  sync-pause state, writer election, and the per-capability write gate
  before queueing — unlinked actors and mid-sync echoes never reach the
  buffer.
- Pipeline: `ExportManager.flush` enforces election, checks
  `isRemoteSyncActive`, runs the conflict check, builds the payload, and
  pushes with exponential-backoff retry. Journal (campaign-notes) writes
  bypass the actor pause under a local promise lock (§27).
- Every capability question (`canWriteHitPoints`, …) delegates to
  `sync/write-level.ts`; this package never reads the write-level setting
  directly.

## Constraints

- Depends only on `core` and `sync` (via their barrels). No imports from
  `import/`, `mapping/`, or `ui/`.
- `hook-manager.ts` lives here — not in `sync/` — because ingress and
  pipeline are one cohesive unit: the hooks exist only to feed this buffer.

## Interactions

Pipeline classes plus their edges outside the package — hooks and the
manager gate through `sync/`, the bridge flushes through the manager:

```mermaid
classDiagram
    class ExportManager {
        +queueChange(actor, field, value)
        +queueItemChange(actor, change)
        +queueItemDelete(actor, slot)
        +exportCampaignNotes(actor, notes)
        +flush(actor) ExportResult
        +suspend(characterId)
        +resume(characterId)
        +setOnConflictHandler(handler)
    }
    class HookManager {
        +register()
    }
    class ChangeBuffer {
        +queueChange / queueItemChange / queueItemDelete
        +suspend / resume / peek / clear
        +isWithinRateLimit / recordApiCall
    }
    class PushPayloadBuilder {
        +buildUpdatedCharacterData(...) FetchedCharacter
    }
    class ConflictResolver {
        +checkConflict(...) ConflictCheckResult
    }
    class FlowsBridge {
        <<external>>
        +exportLinkedCharacter
        +handlePushConflict
    }
    class SyncGates {
        <<external>>
        +isSyncActive / isRemoteSyncActive
        +isClientElectedWriter
        +canWriteBiography / canWriteSpellSlots / ...
    }
    class DemiplaneClient {
        <<external>>
        +fetchCharacterData / updateCharacter
    }
    HookManager --> ExportManager : queues via
    ExportManager --> ChangeBuffer : buffers in
    ExportManager --> PushPayloadBuilder : builds with
    ExportManager --> ConflictResolver : checks with
    ExportManager --> SyncGates : gates via
    ExportManager --> DemiplaneClient : pushes via
    HookManager --> SyncGates : gates via
    FlowsBridge --> ExportManager : flushes
```

### Export data flow detail

Hook-by-hook sequence behind the package-level flow in
[ARCHITECTURE](../../../docs/ARCHITECTURE.md#export-data-flow):

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

    alt Mapped engine field changed
        HM->>EM: queueChange(actor, storeName, value)
        EM->>EM: Store in pendingChanges map
        EM->>EM: Reset 2s debounce timer
    else Campaign Notes changed
        HM->>EM: exportCampaignNotes(actor, notes)
        Note over EM: No actor pause here, or hook queueing stalls and drops edits. A local lock serializes our own writes. Skips if a remote client is mid-sync
        EM->>DC: fetchCharacterJournals(characterId)
        DC-->>EM: Existing journals
        EM->>DC: create or update the Campaign journal
        DC->>API: slsCreateCharacterJournal or slsUpdateCharacterJournal
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
