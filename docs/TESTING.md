# Testing Guide

How to run the module for dev testing and how to run the integration
tests. All Foundry lifecycle management goes through the `foundry-test`
CLI from [foundry-test-kit](https://github.com/scooper4711/foundry-test-kit),
configured by `foundry-test.config.json`. It can keep a dev and a test
server up side by side (ports 30000 / 30001, separate data dirs, pidfiles
under each data dir so you never hunt PIDs).

> All local Foundry state lives under `.foundry-test/` (gitignored):
> `cache/` (version zips), `versions/<ver>/` (unpacked servers),
> `Data-dev-<ver>/` and `Data-test-<ver>/` (data per server and version),
> and `logs/`.

## Prerequisites

Copy `.env.example` to `.env` and fill in:

| Var                      | Used for                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `FOUNDRY_LICENSE_KEY`    | First-time seeding (license screen)                                                                                |
| `FOUNDRY_ADMIN_PASSWORD` | Server admin (default `test-admin`)                                                                                |
| `FOUNDRY_USERNAME`       | foundryvtt.com account, to download Foundry builds that are not cached                                             |
| `FOUNDRY_PASSWORD`       | foundryvtt.com password (can be [dotenvx](https://dotenvx.com)-encrypted; see the kit's README)                    |
| `DEMIPLANE_TOKEN`        | Import tests (skipped without it)                                                                                  |
| `*_UUID`                 | Reference character IDs for the import specs                                                                       |
| `SKIP_MUTATION_TESTS=1`  | Skip the slow mutation round-trip specs (Kyra mutation files + reimport); run unflagged after touching write logic |

Build once before anything touches Foundry:

```bash
npm run build
```

## Dev testing

```bash
npx foundry-test dev start [--version 14.367|latest]   # boots .foundry-test/Data-dev-<ver> on :30000
npx foundry-test dev status
npx foundry-test dev stop
```

- First start seeds a fresh data dir automatically (license → PF2e →
  `demiplane-test` world → module link → token from `.env` and debug
  logging, per `seed.settings` in `foundry-test.config.json`).
- The module is symlinked in, so `npm run build` (or `build:watch`)
  takes effect on next page reload — no reinstall.
- `npx foundry-test dev start --clean` wipes the dev world and
  server logs, then re-seeds from scratch.
- `npx foundry-test dev start --world ""` boots to the setup screen
  instead of a world.

Then open http://localhost:30000 and join as Gamemaster.

## Integration tests

One command does everything (boot → seed if needed → suite → failure
summary → stop):

```bash
npm run integration     # = npx foundry-test test run --all-worlds
npx foundry-test test run [--version 14.367|latest|<zip-URL>] [--keep] [--headed]
```

- A version reuses `.foundry-test/cache`, downloading it from
  foundryvtt.com (with `FOUNDRY_USERNAME` / `FOUNDRY_PASSWORD`) when
  missing; a URL is downloaded there first. `latest` is the newest stable
  release. Each version gets its own server and `Data-test-<version>/`.
- `--keep` leaves the server up afterwards; `--headed` shows the browser.
- Results end with a `=== Summary ===` table; details in
  `test-results/`. Rerun failures only with
  `npx playwright test --last-failed`.

For a manual loop (server already up via `npx foundry-test test start`), run the suite
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

View it in the terminal table, open `coverage/e2e/lcov-report/index.html`, or point
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
