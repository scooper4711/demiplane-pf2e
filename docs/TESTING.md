# Testing Guide

How to run the module for dev testing and how to run the integration
tests. All Foundry lifecycle management goes through one script,
`scripts/foundry.sh`, which can keep a dev and a test server up side by
side (ports 30000 / 30001, separate data dirs, pidfiles under each data
dir so you never hunt PIDs).

> All local Foundry state lives under `playwright/` (gitignored): `cache/`
> (version zips), `versions/<ver>/` (unpacked servers), `Data/` (dev) and
> `Data-<ver>/` (per-version test data).

## Prerequisites

Copy `.env.example` to `.env` and fill in:

| Var                      | Used for                                     |
| ------------------------ | -------------------------------------------- |
| `FOUNDRY_LICENSE_KEY`    | First-time seeding (license screen)          |
| `FOUNDRY_ADMIN_PASSWORD` | Server admin (default `test-admin`)          |
| `DEMIPLANE_TOKEN`        | Import tests (skipped without it)            |
| `*_UUID`                 | Reference character IDs for the import specs |

Build once before anything touches Foundry:

```bash
npm run build
```

## Dev testing

```bash
./scripts/foundry.sh dev start [--version 14.367]   # boots playwright/Data on :30000
./scripts/foundry.sh dev status
./scripts/foundry.sh dev stop
```

- First start seeds a fresh data dir automatically (license → PF2e →
  `demiplane-test` world → module link → token from `.env`).
- The module is symlinked in, so `npm run build` (or `build:watch`)
  takes effect on next page reload — no reinstall.
- `./scripts/foundry.sh dev start --clean` wipes the dev world and
  server logs, then re-seeds from scratch.
- `./scripts/foundry.sh dev start --world ""` boots to the setup screen
  instead of a world.

Then open http://localhost:30000 and join as Gamemaster.

## Integration tests

One command does everything (boot → seed if needed → suite → failure
summary → stop):

```bash
./scripts/foundry.sh test run [14.367|<zip-URL>] [--keep] [--headed]
```

- A bare version reuses `playwright/cache`; a URL is downloaded there
  first. Each version gets its own server and `Data-<version>/`.
- `--keep` leaves the server up afterwards; `--headed` shows the browser.
- Results end with a `=== Smoke summary ===` table; details in
  `test-results/`. Rerun failures only with
  `npx playwright test --last-failed`.

For a manual loop (server already up via `test start`), run the suite
directly:

```bash
npx playwright test                                  # all integration specs
npx playwright test tests/integration/valeros-import.spec.ts   # one file
```

Live Demiplane API + `DEMIPLANE_TOKEN` are required; suites skip
themselves without it. The specs import each reference character once
per file and clean up their actors afterwards.

## Coverage

- Unit: `npm run test:coverage` (vitest, 80% lines/branches gate).
- E2E (what the browser actually executed, as a **guide for which
  characters to add next** — never a gate, since error paths can't be
  simulated live):

```bash
npx playwright test          # records raw chunks to coverage/e2e-raw/
npm run coverage:e2e         # converts via sourcemaps, writes coverage/e2e/
```

View it in the terminal table, open `coverage/e2e/index.html`, or point
the VS Code Coverage Gutters extension at `coverage/e2e/lcov.info`. Only
statements/functions are meaningful (browser coverage is function-level;
ignore its branch column).

## Test fixtures

`scripts/reset-test-characters.mjs` resets the dedicated Demiplane test
characters to their documented states (e.g. language lists) via the API:

```bash
node scripts/reset-test-characters.mjs
```

Specs that depend on fixture state say so at the top; if you rebuild a
reference character on Demiplane, update its pinned assertions.
