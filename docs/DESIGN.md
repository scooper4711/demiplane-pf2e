# Design Decisions

This document records the key design decisions made in `foundry-demiplane-pf2e`, the rationale behind each, and the tradeoffs that were considered.

## 1. Populate Existing Actors Instead of Creating New Ones

**Decision:** Import writes character data into a pre-existing Foundry actor rather than creating a new one.

**Rationale:** Players configure actors with map tokens, vision settings, permission grants, journal links, and combat tracker entries before or during a campaign. Creating a new actor on every import would break all of those associations and force the GM to re-link everything. Populating an existing actor preserves the established game world context.

**Tradeoffs considered:**

| Approach | Pros | Cons |
|----------|------|------|
| Create new actor | Simpler code, no reconciliation needed | Destroys tokens, permissions, journal links; confuses players |
| Populate existing actor | Preserves all Foundry-side state; seamless for players | Requires item reconciliation logic to avoid duplicates |
| Clone + merge | Could keep a "clean" copy | Double the actor count; still breaks token links |

The reconciliation overhead (removing stale imported items before re-adding) is manageable and far less disruptive than recreating actors.

## 2. Two-Second Debounce Window for Export

**Decision:** Session state changes are batched within a 2-second debounce window before pushing to Demiplane.

**Rationale:** During combat, HP changes happen in rapid bursts (damage, healing, temp HP). A 2-second window collapses those rapid changes into a single API call containing only the final values. This prevents flooding the Demiplane API while still feeling responsive to users: changes sync within a few seconds of the last modification.

**Tradeoffs considered:**

| Window | Pros | Cons |
|--------|------|------|
| 0s (immediate) | Instant sync | Excessive API calls during combat; quickly hits rate limit |
| 500ms | Fast feedback | Still too many calls during multi-target damage rolls |
| 2s | Good balance: collapses combat bursts, syncs before next turn | Slightly delayed visual confirmation on Demiplane |
| 5s+ | Very few API calls | Users may close the browser before sync completes |

Two seconds was chosen because a typical PF2e combat round involves 2-4 HP changes in quick succession (attack, shield block, persistent damage). Two seconds is long enough to capture the full burst but short enough that the result appears on Demiplane before the next player's turn begins.

## 3. Rate Limit: 30 API Calls per 60 Seconds

**Decision:** The module caps Demiplane API calls to 30 per 60-second rolling window per character.

**Rationale:** Demiplane's API does not publish official rate limits, but testing showed that sustained bursts beyond this threshold produce intermittent failures. The 30/60s limit provides a generous margin for normal gameplay while preventing accidental flooding. With the 2-second debounce, normal play rarely approaches this limit (a debounced call every 2 seconds would be 30 per minute only if changes are truly continuous).

**Tradeoffs considered:**

| Threshold | Pros | Cons |
|-----------|------|------|
| 10/60s | Very conservative, unlikely to trigger throttling | Pending changes queue up; stale data on Demiplane |
| 30/60s | Handles combat-heavy sessions without hitting limits | Could still be exceeded in extreme edge cases |
| 60/60s | Almost never reached | Risk of triggering undocumented server-side rate limiting |

The 30/60s threshold was validated against a typical 4-hour session with 6 players. Even in the most combat-heavy sessions, individual characters rarely exceed 15-20 sync calls per minute.

## 4. Version-Based Conflict Detection

**Decision:** Conflicts are detected by comparing the locally stored version integer against the remote version fetched before each push.

**Rationale:** Demiplane assigns each character a monotonically increasing `version` integer that increments on every save. This provides a reliable, race-free conflict signal: if `remote > stored`, someone else modified the character since our last sync. Unlike timestamp-based approaches, integer comparison is deterministic and immune to clock skew between Foundry client and Demiplane server.

**Tradeoffs considered:**

| Approach | Pros | Cons |
|----------|------|------|
| Version integer comparison | Deterministic, no clock skew issues, simple comparison | Requires extra API call to check version before push |
| Last-modified timestamp | No extra fetch needed if returned in headers | Clock skew between client and server; unreliable |
| Content hash (ETag) | Detects any change, not just version bumps | Demiplane doesn't expose content hashes |
| Optimistic locking (send version with update) | Server rejects stale writes | Demiplane's mutation API doesn't support conditional writes |

The extra `fetchCharacterVersion` call is lightweight (small GraphQL query returning a single integer) and runs only when an export flush is triggered, which happens at most every 2 seconds due to the debounce.

## 5. Email/Password Authentication

**Decision:** Users authenticate with their Demiplane email and password rather than extracting a session cookie from the browser.

**Rationale:** Session cookies require users to either install a browser extension, manually copy cookies from DevTools, or run a proxy. This creates friction for non-technical users and breaks whenever Demiplane rotates cookie names or adds SameSite restrictions. Email and password can be entered directly in Foundry's module settings, making the setup self-contained and accessible.

**Tradeoffs considered:**

| Approach | Pros | Cons |
|----------|------|------|
| Email/password in settings | Simple UX; no external tooling; works for all users | Credentials stored in Foundry's client settings (per-user, not world) |
| Session cookie extraction | No credential storage | Requires browser extension or manual DevTools copy; fragile; poor UX |
| OAuth2 redirect flow | Industry standard; no password storage | Demiplane doesn't expose a public OAuth2 flow for third parties |
| API key | Stateless, simple | Demiplane doesn't offer API keys |

Credentials are stored with `scope: "client"` so each user stores their own credentials locally. They are never shared with the GM or other players. The password field uses Foundry's password input type to avoid displaying it in plain text.

## 6. Sequential `createEmbeddedDocuments` for Core Items

**Decision:** Ancestry, heritage, background, and class are added to the actor one category at a time, waiting for each `createEmbeddedDocuments` call to resolve before issuing the next.

**Rationale:** The PF2e system's Grant Chain engine fires `GrantItem` rules when items are added. A class item grants class features; an ancestry grants ancestry features and heritage options. If these items are added simultaneously in a single batch, the Grant Chain cannot resolve dependencies correctly because prerequisite items may not yet exist on the actor when the chain evaluates.

**Tradeoffs considered:**

| Approach | Pros | Cons |
|----------|------|------|
| Sequential per category | Grant Chain fires correctly; prerequisites satisfied | Slower import (4 sequential async calls) |
| Single batch (all items at once) | Fastest possible import | Grant Chain misses prerequisites; broken character |
| Topological sort + single batch | Theoretically optimal | Grant Chain evaluates items in insertion order regardless of array position |

After the four sequential core items are established, feats, class features, equipment, and spells are safe to add in a single batch because their Grant Chain entries only reference the core items that are already present.

## 7. Game-System-Agnostic NPM Library

**Decision:** The `@scooper4711/demiplane-api` package contains zero PF2e-specific logic. All game-system knowledge lives in the Foundry module.

**Rationale:** Demiplane supports multiple game systems (Pathfinder 2e, D&D 5e, Marvel Multiverse, etc.). The API client, authentication, engine parsing, and update mutations are identical across all systems. By keeping the library generic, other developers can build Foundry modules (or non-Foundry integrations) for other systems without duplicating the API communication layer.

**Tradeoffs considered:**

| Approach | Pros | Cons |
|----------|------|------|
| Agnostic library + system-specific module | Reusable; clear separation of concerns; community can extend | Two packages to maintain; slightly more complex dependency chain |
| Single monolithic Foundry module | Simpler project structure; one repo | Cannot be reused for other systems; mixes concerns |
| Library with system plugins | Single install | Over-engineered for current needs; plugin API design burden |

The two-package split also aligns with testing boundaries: the library can be tested in a plain Node environment without Foundry mocks, while the module tests focus on Foundry-specific integration.

## 8. World-Scoped Dry Run Setting

**Decision:** The `dryRun` module setting uses `scope: "world"` rather than `scope: "client"`.

**Rationale:** Dry run mode is a safety mechanism: when enabled, no mutations are sent to Demiplane and no actor state is modified. This is a GM-controlled safeguard. If it were client-scoped, individual players could accidentally disable it and push changes during a session where the GM intended preview-only operation. World scope means the GM controls it for all users, providing a consistent and predictable environment.

**Tradeoffs considered:**

| Scope | Pros | Cons |
|-------|------|------|
| World (GM-controlled) | Consistent for all users; GM can safely demo the module; prevents accidental writes | Players cannot individually preview without affecting others |
| Client (per-user) | Each player controls their own preview mode | GM cannot guarantee no writes happen; inconsistent sync state |

In practice, dry run mode is used during initial setup (verifying the import looks correct before committing) or when demonstrating the module to a new group. In both cases, world-wide enforcement is the desired behavior.

## 9. Exponential Backoff Retry Strategy

**Decision:** Failed exports retry up to 3 times with exponential backoff (1s, 2s, 4s delays).

**Rationale:** Transient network failures and brief Demiplane API outages should not cause permanent data loss. Exponential backoff prevents hammering the server during an outage while giving transient issues time to resolve. After 4 total attempts (initial + 3 retries), the module gives up, notifies the user, and retains the pending changes for the next manual or automatic sync attempt.

**Tradeoffs considered:**

| Strategy | Pros | Cons |
|----------|------|------|
| No retry | Simplest code | Single network hiccup loses data until next change |
| Fixed interval retry | Predictable timing | May hammer server repeatedly during sustained outage |
| Exponential backoff (3 retries) | Progressive backoff; reasonable total wait (~7s) | Slightly delayed final failure notification |
| Unlimited retries | Never gives up | Could queue indefinitely; memory leak potential; user never knows about persistent failures |

The total worst-case delay is 7 seconds (1 + 2 + 4), which is acceptable in a tabletop gaming context where a few seconds of delay is imperceptible during play.
