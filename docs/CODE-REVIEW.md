# Code Review — `demiplane-pf2e`

> **Status (last worked):** P0-1/P0-2/P0-3, P1-1..P1-6, the second-push re-import bug,
> the cross-client infinite-loop fix, P1-3, P1-4, and P2-2/P2-3/P2-4/P2-5/P2-6 are
> **done and committed**. P2-1 is **partial** (3 unnecessary `as never` on `getIndex`
> removed; the remaining ~27 `as never` on `createEmbeddedDocuments` args are deferred
> pending proper `ItemSource` typing across the importers). All work is on `main` in
> small behavior-preserving commits; `docs/CODE-REVIEW.md` is intentionally left untracked.

**Scope.** Holistic design review of the TypeScript source under `src/` against Clean
Code, general software-engineering best practices, and common design patterns. The
module's own `docs/DESIGN.md` and `docs/ARCHITECTURE.md` were used as the reference
for _intended_ design; where the code has diverged from those documents it is called
out explicitly. No code was changed.

**Method.** Read the entry point (`module.ts`), the export path (`export-manager.ts`,
`hook-manager.ts`), the import subsystem (`import/*`), the UI layer
(`demiplane-info-button.ts`, `character-link-dialog.ts`, `titlebar-dot.ts`,
`settings.ts`, `sync-issues.ts`), and the two design docs. Dead-code and duplication
claims below were verified with `grep`, not inferred.

---

## 1. What is working well

- **Clear high-level separation of concerns.** Import (`ImportOrchestrator` + dedicated
  resolvers) is cleanly separated from export (`ExportManager` + `HookManager`), and
  UI is isolated behind small registration functions. This matches the architecture
  diagram and is a genuine strength.
- **External-API boundary is respected (DESIGN #13).** All Demiplane/GraphQL/PF2e-agnostic
  communication lives in `@scooper4711/demiplane-api`; the Foundry module owns all
  game-system knowledge. Good layering.
- **Deliberate avoidance of a spell monolith (DESIGN #8).** Three focused resolvers
  instead of one 500-line function is the right call.
- **Excellent design documentation.** `DESIGN.md` records decisions _with rationale and
  tradeoffs_, and `ARCHITECTURE.md` has accurate mermaid diagrams. This is well above
  average and should be preserved.
- **Test discipline is real.** A shared `foundry-mocks.ts` harness exists and coverage
  of `src/import/**` is now ~88% statements/lines. Unit tests for the trickiest logic
  (ChoiceSet matching, NDJSON parsing) exist.

The recommendations below are about _consolidation and risk reduction_ on top of a
fundamentally sound design — not a rewrite.

---

## 2. Prioritized findings

### P0 — Correctness & risk (do first; cheap relative to the danger they remove)

**P0-1. `ChoiceSetHandler` monkey-patch is not crash-safe or idempotent.**
`enable()` (`src/import/choice-set-handler.ts:46`) overwrites
`game.pf2e.RuleElements.builtin.ChoiceSet.prototype.preCreate` and _throws_ if that
prototype is missing. Two problems:

- If `importCharacter` throws after `enable()` but before `disable()`, the patch leaks
  and silently breaks _manual_ character editing for the rest of the session. There is
  no `try/finally` guaranteeing `disable()` in the orchestrator's import sequence.
- Calling `enable()` twice loses the original `preCreate` (no "already installed" guard).
  **Recommendation:** make `enable()` idempotent (guard if `originalPreCreate` is already
  set), and wrap the import body in `try/finally { handler.disable() }`. Consider a
  module-level "patched" boolean as a backstop.

**P0-2. Concurrent imports can prematurely resume pushes.**
`importLinkedCharacter` (`module.ts:164`) calls `exportManager.suspend()` /
`resume()` on a single boolean. If two actors are imported at once, or an import races a
manual push, the second `resume()` can un-suspend while the first import is still mid-
flight, pushing stale data. **Recommendation:** make suspend ref-counted, or key it per
`characterId`.

**P0-3. The "delete imported items before re-import" routine is duplicated 3–4 times,
with drift risk.**
The identical pattern — _filter actor items by the module flag, then
`deleteEmbeddedDocuments`_ — appears in:

- `reimportActorOnConflict` (`module.ts:205`)
- the `getActorContextOptions` onClick handler (`module.ts:253`)
- `performUpdate` (`demiplane-info-button.ts:154`)
- (conceptually) the info-dialog update path.

Each copy re-implements the flag filter. If one copy misses a nuance (e.g., what counts
as "imported"), re-import behavior diverges silently. **Recommendation:** extract a
single `deleteImportedItems(actor): Promise<number>` in `sync-issues.ts` or a small
`import/reconcile.ts` and call it from all sites.

### P1 — Maintainability & duplication (the bulk of the win)

**P1-1. Verified dead code — delete it.**
Grepped, not assumed:

- `src/slug-mapper.ts` (`SlugMapper` + `transformSlug`) — **never imported anywhere.**
  Live code uses `compendium-resolver.ts` + `import/slug-utils.ts`.
- `src/attribute-skill-importer.ts` (`extractAttributeBoosts`, `applyAttributeBoosts`,
  `extractSkillIncreases`, `applySkillIncreases`) — **never imported.** Live equivalents
  live in `import/attribute-language-importer.ts`.
- `src/hooks.ts` — re-exports `HookManager` "for backward compatibility" with a stray
  reference to "task 13.1"; **nothing imports it.**

Worse than dead weight: there are now **two `applyAttributeBoosts` functions with
different signatures** (one per file). That is a latent trap — an import could silently
bind to the wrong one after any refactor. **Recommendation:** delete the three files.
Before deleting `attribute-skill-importer.ts`, harvest anything genuinely distinct
(its `VALID_ATTRIBUTES`/`VALID_SKILLS` validation is worth keeping — see P1-5).

**P1-2. Stream-Engines fetch + NDJSON parsing is copied, not shared (DESIGN #9 claims it
is "encapsulated in a shared pattern" — it isn't).**
`STREAM_ENGINES_URL`, the fetch→split→find-`StringObject`-node→parse-inner-JSON→
extract-`engineModifiers` pattern, and the `getPacks`/`PackIndex`/`resolveSpellFromCompendium`
helpers are repeated in `feature-spell-resolver.ts`, `item-spell-resolver.ts`, and
`spell-importer.ts` (and `spell-slot-resolver.ts` hits the same endpoint).
**Recommendation:** one `streamEngines.fetchModifiers(engineIds)` returning a typed
discriminated union (`AddSpellModifier | AddFocusPointModifier | AddStaffSpellsModifier
| ...`), plus a single `resolveSpellFromCompendium(slug)` in `compendium-resolver.ts`.
Removes ~100+ lines and makes the NDJSON parser a single maintenance surface.

**P1-3. `ExportManager` is a god object (~755 lines).**
It owns: debounce timers, rate limiting, queue storage, optimistic-concurrency conflict
check, `engineSig` content comparison, payload building (`buildUpdatedCharacterData` +
`applyFieldChanges` + `createOverrideEngine`), retry/backoff, and flush orchestration.
Several single-responsibility violations. **Recommendation:** split into collaborators:

- `ChangeBuffer` — queue + debounce + rate limit.
- `PushPayloadBuilder` — `buildUpdatedCharacterData` / `applyFieldChanges` /
  `createOverrideEngine` / `computeEngineSig`.
- `ConflictResolver` — `fetchCharacterUpdated` + content compare.
- `ExportManager` keeps only orchestration + retry.

**P1-4. `ImportOrchestrator` is the central coordinator god object (~562 lines).**
Fetch, categorize, sequence, and invocation of every sub-importer live here. The phase
list (ARCHITECTURE §Import Phase Order, 15 phases) is sound but implemented as one long
method. **Recommendation:** model each phase as a small object (`ImportPhase` interface:
`run(actor, ctx)`) composed into an ordered pipeline. At minimum, extract the
sequential-create block and the post-import block into collaborators so the orchestrator
reads as a table of phases.

**P1-5. Two competing slug modules / attribute modules.**
`slug-utils.ts` vs `slug-mapper.ts` (see P1-1) and `attribute-language-importer.ts` vs
`attribute-skill-importer.ts` overlap conceptually. **Recommendation:** one `slug.ts`
(merge `toFoundrySlug`/`generateSlugCandidates`/`transformSlug`), one attribute/language
importer that _keeps_ the validation tables from the deleted file.

**P1-6. Scattered magic strings & duplicated config.**
Store names (`character_hit-points_current`), pack keys, the stream-engines URL, the
Demiplane URL prefix, and even the Ko-fi URL are inline. `ACTOR_FIELD_MAPPINGS` /
`TREASURE_ITEM_MAP` in `hook-manager.ts` are a good start but the API URL is still
duplicated (P1-2). **Recommendation:** a single `config.ts` (or co-located constants per
owner) and a typed `StoreName` union to make the field map self-documenting.

### P2 — Robustness, typing & hygiene

**P2-1. Pervasive unsafe casts erode type safety.**
`actor.createEmbeddedDocuments("Item", [...] as never)`, `actor.getFlag(...) as string`
for the new `engineSig`, and `DemiplaneEngineEntry.args` being `Record<string, unknown>`
force casts everywhere. `spell-engines.ts` already shows the right pattern
(`Pf2eSpellEngineArgs`). **Recommendation:** extend typed arg interfaces per engine
family and add a local `ItemSource` type so `as never` disappears; this makes refactors
safe instead of silently runtime-broken.

**P2-2. Inconsistent diagnostic channels.**
`console.warn` (attribute-skill-importer, spell-importer, slug-mapper), `debugLog`
(import/*), and raw `console` are used for similar conditions. DESIGN implies a
`debugLog` convention gated by the `debugImport` setting. **Recommendation:** route all
expected-skip/diagnostic output through `debugLog`; reserve `console.error` for genuine
unexpected failures. Remove `console.warn` for "skipped" items (they are expected).

**P2-3. Design docs have drifted from the code — reconcile.**

- ARCHITECTURE.md still lists `slug-mapper.ts` and `attribute-skill-importer.ts` as
  "(Legacy) standalone" while they are in fact unused dead code (P1-1).
- DESIGN #7 / ARCHITECTURE class diagram name `ChoiceSetHandler.install()/uninstall()`
  and strategies `matchBySkillSlug` etc., but the code uses `enable()/disable()` and
  `matchSkillSlugs`.
- ARCHITECTURE's hook table says `updateItem`/`createItem`/`deleteItem` only _log_
  changes ("future: equipment sync"), but the current `HookManager` actually **queues**
  item changes and deletes. Docs understate current behavior.
  **Recommendation:** treat the docs as living artifacts; after the P1 cleanups, update
  the class diagram, the file-structure list, and the hook table. (Dead files should be
  removed from the diagram entirely.)

**P2-4. Conflict/concurrency heuristic has documented blind spots.**
The content-aware check (`engineSig`, `src/engine-sig.ts`) compares a signature of
engine `name`+`value`. Edge cases worth a one-line doc comment: (a) a remote edit that
reorders equal-value entries would reproduce the same signature and be missed; (b) a
benign bump where the remote content changed in a way not captured by name/value could
be treated as a conflict. Low likelihood, but the heuristic should be documented as such
so future maintainers don't over-trust it. Also verify `engineSig` is set on _every_
import path (the `api.importCharacter` path sets it; confirm the context-menu/update
paths do too).

**P2-5. Module API exposes raw internals.**
`module.ts:57` puts `getClient()` / `getOrchestrator()` on `game.modules…api`. Fine for a
small module, but prefer exposing only intent (`importCharacter`, `exportNow`) to keep
the surface stable.

**P2-6. Test coverage gaps remain.**
`orchestrator.ts` (69.9%) and `spell-slot-resolver.ts` (73%) are the main gaps; branch
coverage overall is ~75%. **Recommendation:** add orchestrator-level integration tests
(using `foundry-mocks` + a fake `DemiplaneClient`) covering phase sequencing and the
conflict→reimport path, so the highest-risk coordinator is exercised end-to-end.

---

## 3. Suggested sequencing

1. **P0-1 / P0-2 / P0-3** — guarded monkey-patch + `try/finally`, ref-counted suspend,
   shared `deleteImportedItems`. Small, high-safety-impact diffs.
2. **P1-1** — delete the three dead files (harvest validation tables first).
3. **P1-2 / P1-6** — extract `streamEngines.fetchModifiers` + shared spell resolution +
   centralize config constants.
4. **P1-3 / P1-4** — decompose `ExportManager` and `ImportOrchestrator` behind small
   collaborators/interfaces (no behavior change, just structure).
5. **P2** — typing hardening, logging consistency, doc reconciliation, extra tests.

Steps 1–3 are low-risk and high-value; 4 is the larger refactor and should be done
behind the existing tests (which already pass) to avoid regressions.

---

## Appendix A — Verified dead code

| File                              | Evidence                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/slug-mapper.ts`              | `grep` for `slug-mapper`/`SlugMapper` outside the file → no matches                                       |
| `src/attribute-skill-importer.ts` | `grep` for its exports → only self-references; orchestrator imports from `attribute-language-importer.ts` |
| `src/hooks.ts`                    | `grep "from \"./hooks"` → no matches                                                                      |

## Appendix B — Largest files (candidates for decomposition)

| File                               | Lines | Note                                                              |
| ---------------------------------- | ----- | ----------------------------------------------------------------- |
| `src/import/spell-importer.ts`     | 646   | cohesive but large; split grouping vs placement vs entry creation |
| `src/export-manager.ts`            | ~755  | god object (P1-3)                                                 |
| `src/import/orchestrator.ts`       | 562   | coordinator god object (P1-4)                                     |
| `src/import/choice-set-handler.ts` | 497   | cohesive; only risk is the patch (P0-1)                           |

## Appendix C — Duplicated logic to consolidate

- Stream-Engines fetch + NDJSON parse: `feature-spell-resolver.ts`, `item-spell-resolver.ts`,
  `spell-importer.ts`, `spell-slot-resolver.ts`.
- `resolveSpellFromCompendium` / `getPacks` / `PackIndex`: `feature-spell-resolver.ts`,
  `item-spell-resolver.ts`, `spell-importer.ts`.
- "Delete imported items before re-import": `module.ts` (×2), `demiplane-info-button.ts`.
- `applyAttributeBoosts` defined twice with different signatures (latent trap).
