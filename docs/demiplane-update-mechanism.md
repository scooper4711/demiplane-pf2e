# Demiplane Update Mechanism — Findings

**Investigation goal:** Determine whether Hit Points, Temp HP, and Hero Points can be
updated on Demiplane _without_ sending the entire character document.

**Method:** Drove the live Kyra sheet (`cde1fb99-18bd-4f1f-a882-d034e9267b28`) in a
browser, edited Current HP / Temp HP / Hero Points (and used Heal/Damage), and captured
the outgoing network requests + request bodies.

## TL;DR

**No.** There is no granular/delta update endpoint. The official Demiplane web app sends
the **complete character `engines` array** on every save — the same "whole-character
payload" our Foundry module already does. Sending the whole character is **mandated by the
platform**, not a quirk of our code.

## Where the save actually goes

The browser does _not_ call the GraphQL `updateCharacterV2` mutation directly. It POSTs to a
Next.js API route that proxies to it server-side:

```
POST https://app.demiplane.com/api/magic-missile
Authorization: Bearer <session-jwt>
```

(`magic-missile` is an internal codename for the character-save endpoint. Every HP / Temp HP
/ Hero Point / Heal / Damage action generated a burst of these POSTs, returning `200`/`202`.)

### Authentication — re-tested from the Foundry (localhost:30000) browser tab

Two separate questions: (a) does a bearer token alone authenticate? (b) can our Foundry module
reach the endpoint at all?

**Bearer-only authenticates fine from a browser, same-origin.** Running from the
`app.demiplane.com` character sheet tab, `POST /api/magic-missile` with `credentials: "omit"`
(no cookie) + `Authorization: Bearer <accessToken>` returned `400` ("engines array must include
at least one engine") — i.e. **auth passed**, it only failed on payload validation. The earlier
Node-side `401 {"error":"Authenticated user was not found on the access token."}` was a
_non-browser_ artifact (no `Origin`/browser context), **not** evidence that the cookie is
required.

**But the endpoint is same-origin-only (CORS).** Running the identical fetch from the Foundry
tab at `http://localhost:30000` (cross-origin to `app.demiplane.com`) failed with
`TypeError: Failed to fetch` for every variant — the preflight is blocked because
`magic-missile` does not return `Access-Control-Allow-Origin` for non-Demiplane origins. So our
Foundry module (which runs in the browser at `localhost:30000`) **cannot reach `magic-missile`
at all**, regardless of token or cookie.

Verified end-to-end in a _same-origin browser_ (cookie + bearer): it returned
`200 {"ok":true,"message":"Character updated successfully.","actorUserId":"40753",
"permissionPath":"owner","persisted":true}`, with `expectedUpdated` required (see above;
omitting → `400`, stale → `409`).

**Consequence:** `magic-missile` cannot replace our current push path. Our module must continue
calling `updateCharacterV2` GraphQL directly (`DemiplaneClient.updateCharacter` →
`apiv4.demiplane.com/v1/graphql`), which works cross-origin from the Foundry browser with the
Hasura token and needs no cookie. `magic-missile` is only usable by Demiplane's own
same-origin web app.

### Request body shape

```json
{
  "functionName": "UPDATE_CHARACTER_LAMBDA_NAME",
  "payload": {
    "id": "cde1fb99-18bd-4f1f-a882-d034e9267b28",
    "data": {
      "engines": [/* THE ENTIRE ENGINE ARRAY — ~51 KB for a single HP edit */]
    },
    "expectedUpdated": "2026-08-29T11:20:30.620Z"
  }
}
```

`expectedUpdated` is **required** — it is an optimistic-concurrency guard. The route
rejects the update with `409` ("Character has a newer updated timestamp than expectedUpdated")
if the character was modified after that timestamp. It must be the character's current
`updated` value (top-level field on the character record, surfaced as `data.updated` by
`fetchCharacterData`). After a successful save the route returns a new `characterUpdated`
timestamp that must be used as `expectedUpdated` on the _next_ save.

This maps to the mutation defined in `@scooper4711/demiplane-api`
(`client.js` → `updateCharacterV2`):

```graphql
mutation updateCharacterV2(
  $id: String!, $data: json!, $name: String, $level: Int, $classSlug: String,
  $avatarUrl: String, $viewPermission: Int, $editPermission: Int,
  $formatedData: json, $adminView: Boolean, $characterBrowserInstanceUuid: String
) {
  updateCharacterV2(...) { message result success }
}
```

`$data` is a single `json!` blob = the whole character document. There is **no**
`$hitPoints`, `$tempHp`, or `$heroPoints` argument, and no field-level or sub-section
mutation exists in the API surface.

## The three fields are just engines

Within the full `data.engines` array, the three target values are stored as individual
engines (observed in the captured payload for the edit "Current HP → 9, 3 hero points"):

| Field       | Engine `name`                  | Storage              | Observed value        |
| ----------- | ------------------------------ | -------------------- | --------------------- |
| Current HP  | `character_hit-points_current` | `{ "value": <int> }` | `9` (matches edit)    |
| Temp HP     | `character_hit-points_temp`    | `{ "value": <int> }` | (set to 5 earlier)    |
| Hero Points | `character_hero-points`        | `{ "value": <int> }` | `3` (matches 3 ticks) |

Each is a `CustomDemiplaneEngine` with `storeType: "override"`, e.g.:

```json
{
  "id": "eng-hp",
  "name": "character_hit-points_current",
  "value": 9,
  "type": "CustomDemiplaneEngine",
  "saveType": "CharacterSheet",
  "storeType": "override",
  "demiplaneEngineId": "de-hp",
  "args": { "id": null }
}
```

Because the save always transmits the **whole** `engines` list, changing one of these three
still uploads every other engine (ancestry, feats, equipment, spells, …).

## About `updateLastAccess` (red herring)

The only other mutation seen on every interaction is:

```graphql
mutation updateLastAccess {
  slsUpdateUserLastAccessed {
    success
    __typename
  }
}
```

with empty `variables: {}`. It is a **user-activity heartbeat** (records "last accessed"
time) and carries **no character data**. It cannot be leveraged for syncing HP / Temp HP /
Hero Points — doing so would just be a telemetry write, not a data update.

## Conclusion / recommendation

- The "send the whole character on every push" behavior is **correct and unavoidable** given
  Demiplane's API. It should remain as designed.
- Any future optimization would have to come from Demiplane adding a partial-update
  mutation (e.g. `updateCharacterV2` accepting a partial `data`); it does not exist today.
- If we ever wanted to _read back_ just these three values, they are reliably locatable in
  `data.engines` by the engine `name`s above (useful for the Foundry → Demiplane HP sync /
  conflict detection).

## How this was captured (repro)

1. Log into app.demiplane.com, open the Kyra sheet.
2. Edit Current HP (spinbutton), Temp HP (spinbutton), tick Hero Point checkboxes,
   and use Heal/Damage.
3. Capture network; the character save appears as `POST /api/magic-missile`
   (status 200/202), not as a direct `apiv4` GraphQL call (the GraphQL call happens
   server-side behind the route).
4. Read the request body of one such POST → full `data.engines` payload.
