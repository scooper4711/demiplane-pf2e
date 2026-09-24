# `flows` package

Cross-direction sync orchestration: guarded import, manual export, and
push-conflict recovery. This is the single bridge allowed to reach into
`import/` and `export/` — always via their barrels (enforced by
`flows-bridge-scope` plus the deep-import rules). Sits above `core`,
`sync`, `import`, and `export`; nothing else may depend on it except the
`module.ts` composition root and `ui/` (for the flow function types).

## Responsibility

Own the operations that touch _both_ directions — wipe-then-import with
pause/election guards, suspend-aware export, and what happens when a push
loses a conflict — so neither `import/` nor `export/` knows about the
other. Collaborators arrive as `SyncFlowDeps { exportManager,
importOrchestrator }` (built by `module.ts` at call time), never as module
globals. See [DESIGN §24](../../../docs/DESIGN.md#24-module-entrypoint-decomposition).

## Public surface

`index.ts` is authoritative (7 names). `pushCharacterEngines`,
`notifyConflict`, and `reimportActorOnConflict` are deliberately _not_
exported: they are internal steps of the flows below, exercised directly
by tests.

| From            | Role                                                        | Names                                                                                                                                                      |
| --------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync-flows.ts` | Guarded import, manual export, conflict recovery + DI types | `importLinkedCharacter`, `exportLinkedCharacter`, `handlePushConflict`, `recoverStaleSyncPauses`, `ImportCharacterFn`, `ExportCharacterFn`, `SyncFlowDeps` |

## How it works

- `importLinkedCharacter` suspends the export pipeline, takes a sync
  pause, wipes previously imported items (`deleteImportedItems`), runs the
  `ImportOrchestrator`, then re-queues and toasts. Every step is guarded by
  pause state, election, and write level.
- `exportLinkedCharacter` flushes through `ExportManager` with the same
  guards; `handlePushConflict` recovers based on write level (re-import
  when session state already lives on Demiplane, warn-only at story mode
  where a silent re-import would clobber unsynced local state).
- `recoverStaleSyncPauses` clears marks left by a crashed session on
  `ready`, so a dead client can't block pushes forever.

## Constraints

- May import `core`, `sync`, `import/`, and `export/` barrels only — never
  `mapping/` or `ui/`, never deep files.
- Flows take collaborators as parameters; they never read `module.ts`
  singletons. `module.ts` binds the real collaborators through
  `importFn`/`exportFn` closures evaluated at call time, because hook
  registration happens before `ready` assigns the singletons.
