# Design Decisions

This document records the key design decisions made in `demiplane-pf2e`, the rationale behind each, and the tradeoffs that were considered.

---

## Table of Contents

- [Authentication](#1-token-based-authentication)
- [Actor Population Strategy](#2-populate-existing-actors-instead-of-creating-new-ones)
- [Export Debounce](#3-two-second-debounce-window-for-export)
- [Rate Limiting](#4-rate-limit-30-api-calls-per-60-seconds)
- [Conflict Detection](#5-version-based-conflict-detection)
- [Grant Chain Sequencing](#6-sequential-createembeddeddocuments-for-core-items)
- [ChoiceSet Wrapping (libWrapper When Available)](#7-choiceset-wrapping-libwrapper-when-available)
- [Spell Import Architecture](#8-three-resolver-spell-architecture)
- [Stream-Engines NDJSON Parsing](#9-stream-engines-ndjson-double-parse)
- [Equipment Container Hierarchy](#10-equipment-container-hierarchy)
- [Attribute Boost Placement](#11-attribute-boost-placement-on-source-items)
- [Slug Candidate Generation](#12-slug-candidate-generation)
- [Game-System-Agnostic Library](#13-game-system-agnostic-npm-library)
- [Exponential Backoff Retry](#14-exponential-backoff-retry-strategy)
- [Imported Item Flag Tracking](#15-imported-item-flag-tracking)
- [Cross-Client Sync Pause](#16-cross-client-sync-pause)
- [Conflict Resolution Heuristic](#17-conflict-resolution-heuristic)
- [Unmapped Slugs as Structured Records](#18-unmapped-slugs-as-structured-records)
- [Slug Mapping Storage](#19-slug-mapping-storage--one-setting-per-kind)
- [Mapping Precedence](#20-mapping-precedence--mappings-win)
- [Mapping Screen Interaction Model](#21-mapping-screen-interaction-model)
- [Recorded Resolutions and the Full Mapping List](#22-recorded-resolutions-and-the-full-mapping-list)

---

## 1. Token-Based Authentication

**Decision:** Users provide a pre-obtained GraphQL JWT via module settings. The module does not handle credential-based login.

**Rationale:** Demiplane's login endpoint (`app.demiplane.com/api/auth/login`) rejects cross-origin requests from `localhost` due to CORS restrictions. Since Foundry VTT runs on `localhost:30000`, email/password authentication cannot work from the browser context. The token-based approach avoids this entirely — users extract a JWT from an authenticated browser session on `app.demiplane.com` and paste it into the module settings.

**Tradeoffs considered:**

| Approach             | Pros                                            | Cons                                                   |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| Direct token entry   | Works regardless of CORS; simple implementation | Users must manually obtain token from browser DevTools |
| Email/password login | Better UX for non-technical users               | Blocked by CORS; would require a proxy server          |
| OAuth2 redirect      | Industry standard                               | Demiplane doesn't expose a public OAuth2 flow          |
| Browser extension    | Could intercept cookies                         | External dependency; fragile; platform-specific        |

The token is stored with `scope: "client"` so each user stores their own token locally. A "Validate Token" button in settings verifies the token is accepted before import.

---

## 2. Populate Existing Actors vs Creating New Ones

**Decision:** Import creates a new, blank actor and imports into that.

**Rationale:** Allowing the module to populate an existing actor would require reconciliation logic to avoid duplicating items. This is complicated by the fact that the Demiplane UUID is not known for existing items, and the module cannot rely on item names alone (users may rename items). Creating a new actor avoids this complexity and ensures a clean import.

**Tradeoffs considered:**

| Approach                | Pros                                                   | Cons                                                         |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| Create new actor        | Simpler code, no reconciliation needed                 | Existing links and setup must be replicated to the new actor |
| Populate existing actor | Preserves all Foundry-side state; seamless for players | Requires item reconciliation logic to avoid duplicates       |
| Clone + merge           | Could keep a "clean" copy                              | Double the actor count; still breaks token links             |

Creating a new actor was chosen because it avoids the complexity of item reconciliation and ensures that the imported character state is consistent with Demiplane. Players can then manually link tokens to the new actor as needed.

---

## 3. Two-Second Debounce Window for Export

**Decision:** Session state changes are batched within a 2-second debounce window before pushing to Demiplane.

**Rationale:** During combat, HP changes happen in rapid bursts (damage, healing, temp HP). A 2-second window collapses those rapid changes into a single API call containing only the final values. This prevents flooding the Demiplane API while still feeling responsive: changes sync within a few seconds of the last modification.

**Tradeoffs considered:**

| Window         | Pros                                                          | Cons                                                       |
| -------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| 0s (immediate) | Instant sync                                                  | Excessive API calls during combat; quickly hits rate limit |
| 500ms          | Fast feedback                                                 | Still too many calls during multi-target damage rolls      |
| 2s             | Good balance: collapses combat bursts, syncs before next turn | Slightly delayed visual confirmation on Demiplane          |
| 5s+            | Very few API calls                                            | Users may close the browser before sync completes          |

Two seconds was chosen because a typical PF2e combat round involves 2–4 HP changes in quick succession (attack, shield block, persistent damage). Two seconds captures the full burst but syncs before the next player's turn begins.

**Implementation:** The debounce timer and pending-change queue are owned by `ChangeBuffer` (`src/export/change-buffer.ts`); `ExportManager.flush` is triggered when the timer fires.

---

## 4. Rate Limit: 30 API Calls per 60 Seconds

**Decision:** The module caps Demiplane API calls to 30 per 60-second rolling window per character.

**Implementation:** The rolling-window tracking is implemented in `ChangeBuffer.isWithinRateLimit` / `recordApiCall`; `ExportManager` consults it before each flush.

**Rationale:** Demiplane's API does not publish official rate limits. This limit is deemed conservative enough to avoid hitting undocumented server-side throttling while still allowing normal gameplay. The module tracks the number of API calls made in the last 60 seconds and blocks further calls if the limit is reached, queuing them for later.

**Tradeoffs considered:**

| Threshold | Pros                                                 | Cons                                                   |
| --------- | ---------------------------------------------------- | ------------------------------------------------------ |
| 10/60s    | Very conservative                                    | Pending changes queue up during combat-heavy sessions  |
| 30/60s    | Handles combat-heavy sessions without hitting limits | Could still be exceeded in extreme edge cases          |
| 60/60s    | Almost never reached                                 | Risk of triggering undocumented server-side throttling |

---

## 5. Delete-and-Reimport Sync Strategy

**Decision:** "Update from Demiplane" deletes all items flagged as imported and runs a full re-import, rather than attempting incremental merge or version-based conflict detection.

**Rationale:** Demiplane's character engine appears to deal only with the entire character. There are no API endpoints that provide a diff of changes since the last sync, nor does Demiplane increment a version number on engine changes. This makes incremental merge or version-based conflict detection unreliable.

The delete-and-reimport is the most robust in this circumstance:

1. Only actors that were initially imported from Demiplane can be re-updated (they have a linked UUID).
2. On update: delete all items flagged `demiplane-pf2e.imported = true` from the actor.
3. Run the full import pipeline against the current Demiplane data.
4. Items added manually by the user (unflagged) are preserved.

**Tradeoffs considered:**

| Approach                              | Pros                                                              | Cons                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Delete flagged items + full re-import | Always produces correct state; no stale data; simple mental model | Slower than incremental; loses item-specific Foundry state (e.g., custom notes on imported items) |
| Incremental merge (diff engines)      | Faster; preserves local item state                                | Requires reliable version/diff signal that Demiplane doesn't provide                              |
| Version-based conflict detection      | Industry standard for optimistic concurrency                      | Demiplane's version field doesn't increment — non-functional                                      |
| Timestamp comparison                  | Could detect recent changes                                       | Clock skew; Demiplane doesn't expose item-level timestamps                                        |

The approach is robust because it treats Demiplane as the single source of truth for character build data, while Foundry owns session state (HP, hero points, currency, item quantity) and any manually added items.

**User-facing behavior:**

- A confirmation dialog warns that imported items will be replaced.
- The dialog explicitly states manually added items will be preserved.
- After re-import, the actor reflects the current state of the Demiplane character.

---

## 6. Sequential `createEmbeddedDocuments` for Core Items

**Decision:** Ancestry, heritage, background, and class are added to the actor one category at a time, waiting for each call to resolve before issuing the next.

**Rationale:** The PF2e system's Grant Chain fires `GrantItem` rules when items are added. A class item grants class features; an ancestry grants ancestry features. If added simultaneously, the Grant Chain cannot resolve dependencies correctly because prerequisite items may not yet exist on the actor.

**Tradeoffs considered:**

| Approach                   | Pros                                                 | Cons                                                |
| -------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| Sequential per category    | Grant Chain fires correctly; prerequisites satisfied | Slower import (4 sequential async calls)            |
| Single batch (all at once) | Fastest possible import                              | Grant Chain misses prerequisites; broken character  |
| Topological sort + batch   | Theoretically optimal                                | Grant Chain evaluates in insertion order regardless |

After the four sequential core items, feats and equipment are safe to batch because their Grant Chain entries only reference the already-present core items.

---

## 7. ChoiceSet Wrapping (libWrapper When Available)

**Decision:** The module wraps `ChoiceSetRuleElement.prototype.preCreate` to auto-select choices during import, then removes the wrap after import completes. When the community **libWrapper** module is active the wrap is registered through it; otherwise the module falls back to a direct prototype patch. libWrapper is declared as a `recommended` relationship in `module.json`, never a requirement.

**Rationale:** The PF2e system's ChoiceSet rule element presents interactive dialogs when items with choices are added (e.g., "choose a skill to increase", "pick a bloodline"). During automated import, there is no user to answer these prompts. The choices are already recorded in the Demiplane character data as engine entries, so the module can match them programmatically.

**Seven matching strategies (priority order):**

1. **Skill slugs** — Direct match of `core/selection/skill/increase` engines against choice options.
2. **Custom-selection lore** — `core/selection/skill/custom-selection` engine name (e.g. "Forest Lore") slugified against choice options, scoped to the originating feat.
3. **All engine slugs** — Broadest match: any DemiplaneEngine's `args.slug` against choice values.
4. **Class feature slugs** — Slugified choice labels matched against class feature engine names.
5. **Generic feature slugs** — Partial match of `generic-feature` engine slug segments.
6. **Feat UUID slugs** — Choice labels matched against feat engines with `select-feat-` sourceRow.
7. **Generic choice keywords** — Last path segment of `generic-choice` engines against choice values/labels.

**Fallback:** `choices[0]` if no strategy matches.

**Module layout:** `ChoiceSetHandler` (`src/import/choice-set-handler.ts`) owns the monkey-patch lifecycle, the `preCreate` interception, and pre-setting selections on item data. The seven strategies are pure functions in `src/import/choice-matchers.ts`, composed in priority order by `findMatchInChoices`, so they can be understood and tested independently of the patching machinery.

**Why wrapping `preCreate` instead of alternatives:**

| Approach                              | Pros                                                  | Cons                                                                                  |
| ------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Wrap preCreate                        | Works with any ChoiceSet; no PF2e code changes needed | Fragile if PF2e internals change; must install/uninstall carefully                    |
| Override via subclass                 | Cleaner separation                                    | ChoiceSet is instantiated internally by PF2e; can't inject subclass                   |
| Pre-fill rule selections in item data | No runtime patching                                   | ChoiceSet evaluates choices dynamically; pre-fill doesn't work for UUID-based choices |
| Disable ChoiceSet entirely            | Simplest                                              | Character would be missing critical selections                                        |

The wrap is scoped to the import duration only — normal interactive behavior is fully restored after `disable()`.

**Why libWrapper-when-available rather than always-manual or hard-dependency:**

The module will not be the only one active in a given world, and other modules may wrap the same PF2e method. A raw prototype assignment risks two cross-module failures: another module's wrapper being silently discarded when we restore, and no diagnostic when two modules fight over the method.

| Approach                             | Pros                                                                      | Cons                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| libWrapper when present **(chosen)** | Chains politely with other wrappers; libWrapper reports conflicts by name | Two code paths to maintain and test                                            |
| Always manual prototype patch        | No external surface; one code path                                        | Can clobber another module's wrapper; no conflict reporting                    |
| Hard-require libWrapper              | Single, well-behaved path                                                 | Forces users to install a second module for one short-lived, import-only patch |

The wrap is only live during a user-initiated import, so a hard dependency is disproportionate; the fallback keeps the module fully functional when libWrapper is absent. Both paths are gated by the same `importMode` flag and share the auto-selection logic in `handlePreCreate`.

**Defensive fallback restore:** On the manual path, `disable()` restores the original `preCreate` only when our patch is still the live method. If another module wrapped `preCreate` after us, we leave the newer wrapper in place rather than overwriting it — so we never silently delete another module's wrapper. libWrapper handles this ordering itself when it owns the wrap.

**Module layout:** `src/libwrapper.ts` isolates the untyped libWrapper global behind `getLibWrapper()` / `registerWrapper()` / `unregisterWrapper()`. `ChoiceSetHandler` (`src/import/choice-set-handler.ts`) chooses the path in `enable()` and owns both the libWrapper registration and the defensive prototype restore.

---

## 8. Three-Resolver Spell Architecture

**Decision:** Spell import is split into three independent resolvers, each handling a different spell source:

1. **`spell-importer`** — Class spellcasting (prepared, spontaneous, spellbook).
2. **`feature-spell-resolver`** — Focus and innate spells granted by class features/heritage.
3. **`item-spell-resolver`** — Spells provided by magical items (staves, wands).

**Rationale:** Each spell source has fundamentally different data shapes, resolution logic, and output requirements:

| Resolver               | Data Source                                                      | Output                                           |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| spell-importer         | Character engines (spell entries) + stream-engines (slot counts) | Spellcasting entry + spells with slot placement  |
| feature-spell-resolver | Stream-engines (feature modifiers with `add-spell`)              | Separate "Focus Spells" or "Innate Spells" entry |
| item-spell-resolver    | Stream-engines (item modifiers with `add-staff-spells`)          | Per-item "Charges" type spellcasting entry       |

Combining these into a single function would create a 500+ line monolith with deeply nested conditionals. Splitting allows each to be tested, understood, and modified independently.

**Spell-importer sub-decisions:**

- **Prepared casters** get spells placed into rank-specific slots via `placePreparedSpells()`.
- **Spontaneous casters** get signature spells marked via `markSignatureSpells()`.
- **Wizard curriculum** gets a separate spellcasting entry for school-specific spells (filtered by `isCurriculumSpell()` which checks for `wizard-school-spellbook-slot` in the `spellSlot` arg).
- **Slot maximums** are set by calling the stream-engines API to compute the progression at the character's level.

**Class-spellcasting module layout:** the `spell-importer` resolver is itself split into focused modules so the top-level file stays an orchestrator:

| Module                  | Responsibility                                                                  |
| ----------------------- | ------------------------------------------------------------------------------- |
| `spell-importer.ts`     | Orchestration: group → per-group/curriculum/innate import, entry naming         |
| `spell-grouping.ts`     | Sorts spell engines into main / innate / divine-font groups; class config table |
| `spellcasting-entry.ts` | Creates spellcasting entries and a shared resolve-and-stamp spell-item helper   |
| `prepared-spells.ts`    | Prepared-slot placement, missing-item backfill, signature marking               |
| `divine-font.ts`        | Cleric Divine Font entry and its slot placement                                 |
| `spell-slots.ts`        | Slot-maximum resolution (via `spell-slot-resolver`) and character-level lookup  |

The shared resolve-and-stamp helper in `spellcasting-entry.ts` (`resolveSpellItems`) consolidates the previously-duplicated "resolve slug → stamp imported → set location" pattern used by the regular, prepared, and divine-font paths. `getCharacterLevel` lives in `spell-slots.ts` and is reused by `feature-spell-resolver` rather than duplicated.

---

## 9. Stream-Engines NDJSON Double-Parse

**Decision:** Accept and parse the stream-engines API's non-standard response format (NDJSON with double-encoded JSON payloads) rather than transforming it server-side.

**Rationale:** The stream-engines endpoint returns Newline-Delimited JSON where the actual payload is inside a `StringObject` node as an escaped JSON string. This requires:

1. Split by newlines → parse each line as JSON (outer envelope).
2. Find `StringObject` nodes → parse `data.string` as JSON again (inner payload).

There is no alternative endpoint that returns standard JSON. A proxy server could normalize the format, but that adds infrastructure complexity and a single point of failure.

**Parsing is encapsulated** in a shared pattern across all three resolvers. Each resolver only differs in which `engineModifiers[].type` values it extracts from the inner payload.

---

## 10. Equipment Container Hierarchy

**Decision:** Equipment import creates backpack/container items first, then assigns `containerId` on items stored inside them.

**Rationale:** Foundry PF2e uses a `containerId` field on items to establish parent-child relationships for inventory containers (backpacks, belt pouches, etc.). The container must exist on the actor before items can reference its ID.

**Import sequence:**

```
1. Identify container engines (items with args indicating container type)
2. Create container items on actor → get their Foundry IDs
3. Create contained items with containerId pointing to the container
4. Set carry state (held/worn/stowed) and quantity on all items
```

**Carry state mapping:**

| Demiplane State | Foundry `carryType` | `handsHeld` |
| --------------- | ------------------- | ----------- |
| Held (1 hand)   | `held`              | 1           |
| Held (2 hands)  | `held`              | 2           |
| Worn            | `worn`              | 0           |
| Stowed          | `stowed`            | 0           |
| Dropped         | `dropped`           | 0           |

---

## 11. Attribute Boost Placement on Source Items

**Decision:** Attribute boosts are placed directly on their source items (ancestry item, background item) and in the actor's level-up build data, rather than as standalone items.

**Rationale:** PF2e stores attribute boosts in three locations depending on their source:

| Source                      | Storage Location                               |
| --------------------------- | ---------------------------------------------- |
| Ancestry                    | `ancestryItem.system.boosts` (keyed by slot)   |
| Background                  | `backgroundItem.system.boosts` (keyed by slot) |
| Level-up (1, 5, 10, 15, 20) | `actor.system.build.attributes.boosts`         |

The module reads `core/selection/attribute/boost` engines, determines the source by the engine's `sourceRow` or context, and places the boost in the correct location. This matches how the PF2e character sheet manages boosts natively — a human editing the character sheet would see the boosts in the expected places.

**Override detection:** If Demiplane's computed ability scores differ from what PF2e calculates (indicating a manual override on Demiplane), the module logs a warning but does not attempt to force-override PF2e's computed values.

---

## 12. Slug Candidate Generation

**Decision:** When a simple slug lookup fails, generate candidate slugs by applying known transformation rules before giving up.

**Rationale:** Demiplane and PF2e use slightly different slug conventions in several cases:

| Mismatch Type            | Example                                                   | Resolution                          |
| ------------------------ | --------------------------------------------------------- | ----------------------------------- |
| `-rm` suffix             | `fireball-rm` → `fireball`                                | Strip suffix (always applied first) |
| Class-qualified features | `weapon-specialization-fighter` → `weapon-specialization` | Strip class suffix                  |
| Bloodline features       | `draconic` → `bloodline-draconic`                         | Add `bloodline-` prefix             |
| Pluralization            | `arrow` → `arrows`                                        | Normalization lookup table          |

Generating candidates in a priority order allows the module to find the correct compendium item without maintaining a full slug-to-slug mapping table. The transformation rules are based on observed patterns across all PF2e content.

**When all candidates fail:** The item is skipped, the slug is logged for debugging, and `ImportSummary.itemsSkipped` is incremented. The import continues — a missing item does not abort the entire import.

---

## 13. Game-System-Agnostic NPM Library

**Decision:** The `@scooper4711/demiplane-api` package contains zero PF2e-specific logic. All game-system knowledge lives in the Foundry module.

**Rationale:** Demiplane supports multiple game systems (Pathfinder 2e, D&D 5e, Marvel Multiverse, etc.). The API client, engine parsing, and update mutations are identical across all systems. Separating the library allows other developers to build integrations for other systems without duplicating the communication layer.

**Boundary:**

| `@scooper4711/demiplane-api` provides     | This module provides           |
| ----------------------------------------- | ------------------------------ |
| `DemiplaneClient` (GraphQL communication) | Token acquisition UX           |
| Engine type guards and query utilities    | Slug mapping for PF2e          |
| Immutable engine value updates            | Actor population logic         |
| Character version checking                | Conflict resolution UI         |
| Attribute mapping retrieval               | PF2e-specific engine arg types |

The library can be tested in plain Node without Foundry mocks. The module tests focus on Foundry-specific integration.

---

## 14. Exponential Backoff Retry Strategy

**Decision:** Failed exports retry up to 3 times with exponential backoff (1s, 2s, 4s delays).

**Rationale:** Transient network failures and brief Demiplane API outages should not cause permanent data loss. Exponential backoff prevents hammering the server during an outage while giving transient issues time to resolve.

| Strategy                        | Pros                                | Cons                                                              |
| ------------------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| No retry                        | Simplest code                       | Single network hiccup loses data until next change                |
| Fixed interval                  | Predictable timing                  | May hammer server during sustained outage                         |
| Exponential backoff (3 retries) | Progressive backoff; total wait ~7s | Slightly delayed failure notification                             |
| Unlimited retries               | Never gives up                      | Memory leak potential; user never knows about persistent failures |

After 4 total attempts (initial + 3 retries), the module notifies the user via `ui.notifications.error` and retains the pending changes for the next sync attempt.

**Implementation:** `ExportManager` keeps the retry/backoff orchestration. The pre-push optimistic-concurrency check (`fetchCharacterUpdated` + `engineSig` content compare) lives in `ConflictResolver` (`src/export/conflict-resolver.ts`), and the payload assembly in `PushPayloadBuilder` (`src/export/push-payload-builder.ts`); `ChangeBuffer` supplies the per-character pending changes.

---

## 15. Imported Item Flag Tracking

**Decision:** Every item created during import is stamped with `flags.demiplane-pf2e.imported = true`.

**Rationale:** On re-import (updating an existing character), the module must delete previously imported items to avoid duplicates. The flag distinguishes module-created items from items the user added manually (homebrew, GM-granted items, etc.). Only flagged items are deleted during reconciliation — manually added items are preserved.

**Stamp utility:** `stampImported(itemData)` in `import/types.ts` adds the flag to item source data before `createEmbeddedDocuments` is called.

**Re-import flow:**

```
1. Query actor items where flags.demiplane-pf2e.imported === true
2. Delete all matched items (single batch deleteEmbeddedDocuments call)
3. Run full import pipeline (items get fresh flags)
```

This means re-import is always a clean slate for module-managed items while preserving the user's custom additions.

---

## 16. Cross-Client Sync Pause

**Decision:** While a character is being imported or pushed on _any_ connected client, every other client pauses its pushes (and imports) for that character, coordinated through a replicated actor flag.

**Rationale:** In a multiplayer Foundry game, an import on the GM's client rewrites the linked actor. Those actor/embedded-item updates are replicated to every player client. On a player client the normal `updateActor` / `updateItem` / `createItem` / `deleteItem` hooks would then queue a push back to Demiplane. That push updates the server, which can trigger another import on the GM's client — an **infinite update loop** that thrashes both Foundry and Demiplane.

The loop is broken by marking the character as "syncing" on the actor document itself. Actor flags replicate to all clients, so any client that observes the mark suppresses its own export-queueing until the sync ends.

**Mechanism (`src/sync-pause.ts`):**

- `beginSyncPause(actor)` / `endSyncPause(actor)` wrap an import or push. They add/remove a **token** to a `demiplane-pf2e.syncActiveTokens` array stored on the actor flag.
- `isSyncActive(actor)` (used by `HookManager`) blocks hook-driven queueing on _every_ client — including the one that started the sync.
- `isRemoteSyncActive(actor)` (checked by `ExportManager.flush`) blocks pushing only when a _different_ client is syncing, so a client never blocks its own in-flight push. The optimistic-concurrency `engineSig`/`lastUpdated` checks that follow are owned by `ConflictResolver` (`src/export/conflict-resolver.ts`).
- A per-character **array of tokens** (one per in-flight sync) is used rather than a single boolean so two clients syncing the same character concurrently do not clear each other's mark.

**Tradeoffs considered:**

| Approach                          | Pros                                                                                        | Cons                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| World-scoped setting (boolean)    | Simple cross-client flag                                                                    | GM-only writable; boolean clobbers concurrent syncs; global   |
| Socket-based mutex                | Authoritative cross-client lock                                                             | More machinery; Foundry sockets add complexity                |
| Per-character actor flag (chosen) | Replicated to all clients; writable by any owner; per-character; token-array avoids clobber | Slight extra actor writes; relies on flag replication latency |

**Safety nets:** A stale mark left by a crashed session would otherwise block pushes forever, so `module.ts` clears any non-empty `syncActiveTokens` on `ready` via `clearSyncPause`. `endSyncPause` is always reached through `try/finally`, so a thrown import/push still releases the mark.

**Known limitation:** The mark is per-character, so two _different_ characters importing simultaneously do not block each other (by design). A genuinely concurrent import of the _same_ character on two clients is rare and is additionally guarded by the optimistic-concurrency `engineSig`/`lastUpdated` checks in the export path.

## 17. Conflict Resolution Heuristic

**Decision:** A push is aborted and a re-import is triggered **only** when the remote character's _engine content_ actually changed since our last sync — not merely because Demiplane bumped the `updated` timestamp.

**Rationale:** Demiplane writes a fresh `updated` timestamp on every save, including benign autosaves and sheet interactions that change no engine content. A naive "timestamp changed ⇒ conflict" rule would abort nearly every push and force a re-import on trivial noise, thrashing both Foundry and Demiplane. We therefore treat `updated` as a _screening_ signal and confirm with a _content_ comparison before declaring a real conflict.

**Mechanism (`src/export/conflict-resolver.ts`, run inside `ExportManager.flush`):**

1. Read the actor's stored `lastUpdated` baseline (set on import and after every successful push). If absent, skip the check and push.
2. Fetch the server's current `updated`. If it **matches**, push proceeds.
3. If `updated` **mismatches**, fetch the server's engines and compute a content signature (`engineSig`) over `name`/`value` pairs. Compare against the actor's stored `engineSig`:
   - **Content unchanged** → benign bump. Refresh `lastUpdated` to the new server value and proceed with the push (no re-import).
   - **Content changed** → genuine conflict. Abort the push (`{ status: "conflict" }`) and invoke the registered `onConflictHandler`, which re-imports the character from Demiplane (overwriting local state).
4. Any fetch/compare failure defaults to **`ok`** (proceed with push) rather than blocking — except the content-comparison step, which defaults to **conflict** (conservative) when the remote content cannot be compared.

**Re-baselining:** After a _successful_ push, `flush` re-fetches the authoritative server `updated` (and recomputes `engineSig` from the returned engines) so the next push starts from a correct baseline. After a _re-import_, the same baseline is refreshed by the import path.

**Decision table:**

| Server `updated` vs baseline | Engine content vs baseline | Outcome                                             |
| ---------------------------- | -------------------------- | --------------------------------------------------- |
| match                        | (not checked)              | Push proceeds                                       |
| mismatch                     | unchanged                  | Refresh `lastUpdated`; push proceeds (no re-import) |
| mismatch                     | changed                    | Abort push; trigger re-import                       |
| compare error                | —                          | Push proceeds (or conflict if content incomparable) |

---

## 18. Unmapped Slugs as Structured Records

**Decision:** An unresolved slug is recorded as a structured `UnmappedSlug { slug, kind }`, and its human-readable text is **derived** at display time via `formatUnmapped`. There is no stored message.

**Rationale:** Two representations of the same event can drift, and a pre-rendered string can't drive a UI without being parsed back apart. The module is unreleased, so there is no persisted data to migrate — the cost of a correct model is the rework, not a migration, and that rework is bounded (the sync dialog, the titlebar dot, and their tests). Carrying a legacy string field forward would leave a second source of truth in the codebase permanently.

**Mechanism:** `ImportSummary.unmapped` replaces the old `unresolved: string[]`; `sync-issues.ts` stores the records under an `unmappedSlugs` actor flag and the dialog renders `[...unmapped.map(formatUnmapped), ...importIssues]`, so the visible wording is unchanged. Non-slug failures (e.g. unknown languages) move to `summary.errors` rather than being forced into the shape.

Full requirements and design: [REQUIREMENTS-slug-mapping.md](./REQUIREMENTS-slug-mapping.md), [DESIGN-slug-mapping.md](./DESIGN-slug-mapping.md).

---

## 19. Slug Mapping Storage — One Setting Per Kind

**Decision:** Mappings live in one world-scoped setting per kind (`slugMappingsEquipment`, `slugMappingsFeat`, `slugMappingsSpell`, `slugMappingsAncestry`, `slugMappingsHeritage`, `slugMappingsBackground`, `slugMappingsClass`), each a `slug → { uuid, name }` map, all `config: false`.

**Rationale:** A mapping points at a particular kind of compendium entry, so scoping by kind prevents two kinds sharing a slug from colliding and means the kind need not be repeated inside every entry. Keeping them out of the standard settings list avoids clutter, since the mapping screen is the UI.

**Tradeoffs:**

| Option                            | Pros                                   | Cons                                   |
| --------------------------------- | -------------------------------------- | -------------------------------------- |
| One setting per kind **(chosen)** | No cross-kind collisions; kind implied | More settings to register              |
| Single monolithic setting         | One read                               | Key must encode kind; one large object |

---

## 20. Mapping Precedence — Mappings Win

**Decision:** A GM mapping is consulted **before** the compendium lookup and wins, even when the slug would have resolved on its own.

**Rationale:** This lets a GM override both a missed match and a _wrong-but-successful_ one, including built-in normalizations such as `magic-scroll-*-rank` → `scroll-of-2nd-rank-spell`. Equipment is checked before normalization so the key matches the raw Demiplane slug the GM mapped. A mapping whose target has since disappeared returns `null`, so the import falls back to the normal lookup and re-records the slug as unmapped rather than breaking.

**Tradeoff:** A bad mapping can override good content. Accepted deliberately — the GM has the final say. The automatic mappings this anticipated are now surfaced too: every successful resolution is recorded as a mapping the GM can see and correct (see [§22](#22-recorded-resolutions-and-the-full-mapping-list)).

---

## 21. Mapping Screen Interaction Model

**Decision:** The magnifying glass lives on the **section header**, not on each row; it is opened once per kind and left open. Rows are drop targets, and the app stays **non-modal** so it remains usable beside the open Compendium Browser.

**Rationale:** Opening a browser per slug would be tedious and would wrongly imply a fresh browser is needed for every row. The browser is only a way to find things — **dropping** is the action that creates a mapping. This mirrors the PF2e inventory, where one browse button serves a whole section.

**Consequences:** No search seeding is needed (one browser serves many rows, and the browser clears its own search text on close). A dropped item whose type doesn't match the slug's kind is blocked with an explanatory dialog. Ancestry, heritage, background and class have no Compendium Browser tab, so those sections fall back to the Compendium sidebar — acceptable because the glass is a convenience, not a required control.

**Aggregation:** The list is built on open from two sources: the unmapped slugs still reported by linked actors, and the recorded mappings ([§22](#22-recorded-resolutions-and-the-full-mapping-list)). A resolved slug therefore stays visible as a mapped row the GM can review or correct, rather than disappearing. The "Show only unmapped items" filter collapses the list back to just the rows that still need attention, and defaults on whenever anything is unmapped.
---

## 22. Recorded Resolutions and the Full Mapping List

**Decision:** Every successful slug resolution is recorded into the same per-kind mapping store the GM edits, so subsequent lookups consult the recorded mapping first and the mapping screen can show _all_ mappings, not just unresolved slugs. The list is filterable down to only the unmapped rows.

**Rationale:** Previously only two things were persistent: GM overrides and still-unmapped slugs. Auto-resolutions (a plain compendium slug match) were invisible — a wrong-but-successful match could only be discovered by inspecting the imported actor. Recording each resolution makes mappings first-class: the GM sees what every Demiplane name resolved to and can correct a bad automatic match the same way they fix an unmapped one (drag a replacement, or clear it). This is the "surface automatic mappings" phase anticipated in [§20](#20-mapping-precedence--mappings-win).

A useful side effect: the store doubles as a resolution cache. Because a mapping is checked before the compendium scan ([§20](#20-mapping-precedence--mappings-win)), a recorded slug skips the multi-pack index search on the next import.

**Mechanism:**

- `recordResolvedMapping(kind, slug, mapping)` in `slug-mapping.ts` writes an entry only when none exists for that slug/kind. It is called on the compendium-fallback success path of both resolvers in `import/compendium-resolver.ts` (`resolveCompendiumItem` and the shared spell `findSpellDocument`), _after_ `resolveMappedItem` has already returned null — so recording never overwrites a deliberate GM override, and never re-records within a run.
- The slug key is the raw Demiplane slug (the same key `resolveMappedItem` looks up), and the target is the compendium UUID that matched.
- Self-healing is unchanged: a recorded mapping whose target later disappears resolves to null, so the import falls back to a fresh lookup and the row is flagged as missing in the editor.

**Non-clobbering, so precedence is preserved:**

| State before resolution | After recording                                                              |
| ----------------------- | ---------------------------------------------------------------------------- |
| No entry                | Auto-resolution recorded                                                     |
| GM override present     | Untouched (override wins, as in [§20](#20-mapping-precedence--mappings-win)) |
| Prior auto-resolution   | Untouched (idempotent)                                                       |

**UI consequences (mapping screen):**

- Rows now include resolved mappings, so the list grows to the full set of imported names. Section headers are sticky and an always-visible toolbar holds the intro text and the filter, so the list stays navigable when long.
- **Show only unmapped items** filters every section to the rows without a mapping. It defaults **on** when anything is unmapped (the actionable case) and **off** when everything resolved; the GM can toggle it freely, and the choice persists for the life of the open window.

**Tradeoffs considered:**

| Approach                                      | Pros                                                                | Cons                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Record on resolution **(chosen)**             | Mappings are first-class and correctable; doubles as a lookup cache | Store grows to all imported slugs; a stale cached UUID can serve until its target is missing         |
| Derive the full list from imported item flags | No new persistence                                                  | Only some import paths stamp the source slug; spells/grants omit it, so the list would be incomplete |
| Keep showing only unresolved slugs            | Smallest list                                                       | A wrong automatic match stays invisible and uncorrectable                                            |

**Live across clients:** mappings are world settings, so a change made on one client (e.g. an assistant GM's editor) replicates and fires Foundry's `updateSetting` on every client. `registerMappingSyncHook` listens for changes to any `slugMappings*` key and refreshes an open editor, so a second GM sees the update immediately instead of stale data. The client that made the change still refreshes inline; the hook covers the other clients.

**Responsive open:** with the store holding every resolved slug, building the list requires a `fromUuid` per mapping to check the target and read its icon. Doing that before the first paint made the window feel slow to open. Instead the window paints a loading shell immediately (`_prepareContext` returns `{ loading: true }` when its section cache is empty), computes the sections off the render path, and re-renders when ready. The lookups run in parallel and are collapsed to one `fromUuid` per mapping rather than two (target-exists and icon share the resolved document). A change invalidates the cache via `reload`, so a drop, clear, or cross-client update recomputes rather than repainting stale data.

**Boy-scout note:** the store is now a superset — GM overrides plus recorded auto-resolutions — rather than overrides only ([§19](#19-slug-mapping-storage--one-setting-per-kind) still describes the storage shape, which is unchanged).
