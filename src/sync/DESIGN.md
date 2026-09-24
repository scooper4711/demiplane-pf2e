# `sync` package

Sync coordination primitives: link integrity, write gating, pause tokens,
writer election, the per-actor issue store, and edge notices. Depends only
on `core` (enforced by the `sync-depends-inward` rule). Cross-direction
orchestration lives one layer up in `flows/`.

## Responsibility

Answer every "may I sync this actor right now?" question from one place:
is the actor linked, is anyone else syncing it, is this client the elected
writer, does the current write level permit this write, and what is
currently wrong with it. See [DESIGN §16](../../../docs/DESIGN.md#16-cross-client-sync-pause)
and [§26](../../../docs/DESIGN.md#26-overlap-safe-sync-tokens).

## Public surface

`index.ts` is authoritative (48 names). Consume this package only through
the barrel.

| From               | Role                                                                              | Names                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actor-link.ts`    | `characterId` flag reads + duplicate-link repair                                  | `findActorLinkedTo`, `reconcileDuplicateLink`                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sync-pause.ts`    | Per-character sync-token array on the actor flag                                  | `beginSyncPause`, `endSyncPause`, `clearSyncPause`, `isSyncActive`, `isRemoteSyncActive`                                                                                                                                                                                                                                                                                                                                                      |
| `sync-election.ts` | Deterministic single-writer election (pure)                                       | `isClientElectedWriter`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `write-level.ts`   | Cumulative `read-only`/`story`/`session`/`full` tiers + per-capability predicates | `WRITE_LEVEL_SETTING`, `DEFAULT_WRITE_LEVEL`, `WRITE_LEVEL_LABELS`, `WRITE_LEVEL_DESCRIPTIONS`, `getWriteLevel`, `canWrite*` (biography, languages, organizedPlayId, campaignNotes, hitPoints, heroPoints, focusPoints, currency, spellSlots, inventory quantity/equipped/container, soft/hard delete), `canWriteSessionState`, `isWritingEnabled`, `shouldSkipZeroQuantityItems` (+ `WriteLevel`, `WriteCapability`, `CAPABILITY_MIN_LEVEL`) |
| `sync-issues.ts`   | Actor-flag diagnostics store + change event                                       | `ISSUES_CHANGED_EVENT`, getters/setters for import/export issues, `getUnmappedSlugs`/`setUnmappedSlugs`, `getUnresolvedChoices`/`setUnresolvedChoices`, `getChoiceOverrides`/`setChoiceOverride`/`removeChoiceOverride`, `acknowledgeIssues`, conflict-notified flags, `shouldShowIndicator`                                                                                                                                                  |
| `sync-notice.ts`   | Hold-off / all-clear toasts for eligible non-writers                              | `registerSyncNotice`                                                                                                                                                                                                                                                                                                                                                                                                                          |

## How it works

- **Pause** (`sync-pause.ts`): `beginSyncPause` mints a token, appends it
  to the actor's `syncActiveTokens` flag (replicated to all clients), and
  returns it; `endSyncPause` removes exactly that token. The array (not a
  boolean) lets concurrent syncs unload independently; `isSyncActive` gates
  hook queueing everywhere, `isRemoteSyncActive` gates pushes from other
  clients only.
- **Election** (`sync-election.ts`): GM > assistant GM > owner, name
  tiebreak — pure and dependency-free, shared by push and notices.
- **Issues** (`sync-issues.ts`): the data behind the directory badge, the
  titlebar dot, the info dialog, and the mapping editor. Unmapped slugs,
  unresolved choices, and choice overrides are replaced wholesale each
  import; acknowledgement and conflict-notified flags are sticky.
- **Write gating** (`write-level.ts`): each capability declares its minimum
  tier; hooks, flows, export, and import-skip all ask `canWrite*` instead
  of reading the setting.

## Constraints

- Depends only on `core`. Anything needing `import/`, `export/`, or `ui/`
  belongs in `flows/` or `ui/`, not here.
- `sync-election.ts` stays pure (no Foundry I/O) so election logic is
  unit-testable without mocks.
