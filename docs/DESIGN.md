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
- [ChoiceSet Monkey-Patching](#7-choiceset-monkey-patching)
- [Spell Import Architecture](#8-three-resolver-spell-architecture)
- [Stream-Engines NDJSON Parsing](#9-stream-engines-ndjson-double-parse)
- [Equipment Container Hierarchy](#10-equipment-container-hierarchy)
- [Attribute Boost Placement](#11-attribute-boost-placement-on-source-items)
- [Slug Candidate Generation](#12-slug-candidate-generation)
- [Game-System-Agnostic Library](#13-game-system-agnostic-npm-library)
- [Exponential Backoff Retry](#14-exponential-backoff-retry-strategy)
- [Imported Item Flag Tracking](#15-imported-item-flag-tracking)
- [Cross-Client Sync Pause](#16-cross-client-sync-pause)

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

## 2. Populate Existing Actors Instead of Creating New Ones

**Decision:** Import writes character data into a pre-existing Foundry actor rather than creating a new one.

**Rationale:** Players configure actors with map tokens, vision settings, permission grants, journal links, and combat tracker entries before or during a campaign. Creating a new actor on every import would break all of those associations. Populating an existing actor preserves the established game world context.

**Tradeoffs considered:**

| Approach                | Pros                                                   | Cons                                                          |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| Create new actor        | Simpler code, no reconciliation needed                 | Destroys tokens, permissions, journal links; confuses players |
| Populate existing actor | Preserves all Foundry-side state; seamless for players | Requires item reconciliation logic to avoid duplicates        |
| Clone + merge           | Could keep a "clean" copy                              | Double the actor count; still breaks token links              |

The reconciliation overhead (removing stale imported items before re-adding) is manageable and far less disruptive than recreating actors.

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

**Rationale:** Demiplane's API does not publish official rate limits. Testing showed that sustained bursts beyond this threshold produce intermittent failures. With the 2-second debounce, normal play rarely approaches this limit — a debounced call every 2 seconds would be 30 per minute only if changes are truly continuous.

**Tradeoffs considered:**

| Threshold | Pros                                                 | Cons                                                   |
| --------- | ---------------------------------------------------- | ------------------------------------------------------ |
| 10/60s    | Very conservative                                    | Pending changes queue up during combat-heavy sessions  |
| 30/60s    | Handles combat-heavy sessions without hitting limits | Could still be exceeded in extreme edge cases          |
| 60/60s    | Almost never reached                                 | Risk of triggering undocumented server-side throttling |

Validated against 4-hour sessions with 6 players. Even in the most combat-heavy sessions, individual characters rarely exceed 15–20 sync calls per minute.

---

## 5. Delete-and-Reimport Sync Strategy

**Decision:** "Update from Demiplane" deletes all items flagged as imported and runs a full re-import, rather than attempting incremental merge or version-based conflict detection.

**Rationale:** Demiplane's character `version` field does not reliably increment when a character is saved via the character builder. This was discovered during development — the field exists in the API response but its value remains static across saves. Without a reliable remote version signal, traditional conflict detection (compare local version vs. remote version) cannot work.

The delete-and-reimport approach sidesteps this entirely:

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
| Timestamp comparison                  | Could detect recent changes                                       | Clock skew; Demiplane doesn't expose reliable timestamps                                          |

The approach is robust because it treats Demiplane as the single source of truth for character build data, while Foundry owns session state (HP, hero points, currency) and any manually added items.

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

## 7. ChoiceSet Monkey-Patching

**Decision:** The module monkey-patches `ChoiceSetRuleElement.prototype.preCreate` to auto-select choices during import, then restores the original after import completes.

**Rationale:** The PF2e system's ChoiceSet rule element presents interactive dialogs when items with choices are added (e.g., "choose a skill to increase", "pick a bloodline"). During automated import, there is no user to answer these prompts. The choices are already recorded in the Demiplane character data as engine entries, so the module can match them programmatically.

**Six matching strategies (priority order):**

1. **Skill slugs** — Direct match of `core/selection/skill/increase` engines against choice options.
2. **All engine slugs** — Broadest match: any DemiplaneEngine's `args.slug` against choice values.
3. **Class feature slugs** — Slugified choice labels matched against class feature engine names.
4. **Generic feature slugs** — Partial match of `generic-feature` engine slug segments.
5. **Feat UUID slugs** — Choice labels matched against feat engines with `select-feat-` sourceRow.
6. **Generic choice keywords** — Last path segment of `generic-choice` engines against choice values/labels.

**Fallback:** `choices[0]` if no strategy matches.

**Why monkey-patching instead of alternatives:**

| Approach                              | Pros                                                  | Cons                                                                                  |
| ------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Monkey-patch preCreate                | Works with any ChoiceSet; no PF2e code changes needed | Fragile if PF2e internals change; must install/uninstall carefully                    |
| Override via subclass                 | Cleaner separation                                    | ChoiceSet is instantiated internally by PF2e; can't inject subclass                   |
| Pre-fill rule selections in item data | No runtime patching                                   | ChoiceSet evaluates choices dynamically; pre-fill doesn't work for UUID-based choices |
| Disable ChoiceSet entirely            | Simplest                                              | Character would be missing critical selections                                        |

The patch is scoped to the import duration only — normal interactive behavior is fully restored after `disable()`.

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
