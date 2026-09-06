#!/usr/bin/env bash
set -euo pipefail

# Foundry lifecycle manager: start/stop one dev and/or test server side by
# side, or run the full integration suite against a version.
#
# Usage:
#   ./scripts/foundry.sh dev start [--version VER] [--port PORT] [--world ID]
#   ./scripts/foundry.sh dev stop
#   ./scripts/foundry.sh dev status
#   ./scripts/foundry.sh test start [--version VER|--version URL] [--port PORT] [--world ID]
#   ./scripts/foundry.sh test stop
#   ./scripts/foundry.sh test status
#   ./scripts/foundry.sh test run [--version VER|--version URL] [...] [--keep] [--clean]
#
# Flags: --port PORT, --world ID, --world-title TITLE, --version VER,
#   --keep (leave the server up after `run`), --clean (delete the world
#   and server logs first so the next boot re-seeds from scratch),
#   --headed (run Playwright with a visible browser; needs a display).
#
# Modes differ only in defaults (override everything with flags or env):
#   dev:  port 30000, data playwright/Data, world demiplane-test
#   test: port 30001, data playwright/Data-<version>, world integration-test
#
# Versions resolve like before: a bare number reuses playwright/cache, a URL
# is downloaded there first. Each version gets its own data directory with
# the module symlinked in. Server identity (pid/version/port/world) lives in
# <data-dir>/foundry.pid so start/stop/status never hunt processes.
#
# NOTE: Foundry never auto-updates packages on boot (and --noupdate below
# skips even the check), so each Data-<version> keeps the PF2e build from
# its seed time. To refresh the system, delete the world with --clean (or
# remove Data/<version>/Data/systems/pf2e) and let seeding reinstall it.
#
# Env (all optional): FOUNDRY_VERSION, FOUNDRY_PORT, FOUNDRY_WORLD,
# FOUNDRY_WORLD_TITLE, FOUNDRY_LICENSE_KEY, FOUNDRY_ADMIN_PASSWORD,
# FOUNDRY_PATH, FOUNDRY_DATA_PATH.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="$PROJECT_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # Path is computed at runtime by design.
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

PLAYWRIGHT_DIR="$PROJECT_ROOT/playwright"
CACHE_DIR="$PLAYWRIGHT_DIR/cache"
VERSIONS_DIR="$PLAYWRIGHT_DIR/versions"
MODULE_ID="demiplane-pf2e"
DEFAULT_VERSION="14.367"

MODE="${1:-}"
ACTION="${2:-}"
shift 2 2>/dev/null || true

VERSION=""
URL=""
PORT=""
WORLD_ID=""
WORLD_TITLE=""
KEEP=0
CLEAN=0
HEADED=0

usage() {
  grep '^#' "$0" | sed 's/^# \?//' | head -n 30
  exit "${1:-0}"
}

if [ "$MODE" != "dev" ] && [ "$MODE" != "test" ]; then
  echo "ERROR: first arg must be 'dev' or 'test'." >&2
  usage 1
fi
if [ "$ACTION" != "start" ] && [ "$ACTION" != "stop" ] && [ "$ACTION" != "status" ] && [ "$ACTION" != "run" ]; then
  echo "ERROR: second arg must be start, stop, status, or run." >&2
  usage 1
fi
if [ "$ACTION" = "run" ] && [ "$MODE" != "test" ]; then
  echo "ERROR: 'run' is only meaningful for the test environment." >&2
  exit 1
fi

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --port) PORT="$2"; shift 2 ;;
    --world) WORLD_ID="$2"; shift 2 ;;
    --world-title) WORLD_TITLE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --clean) CLEAN=1; shift ;;
    --headed) HEADED=1; shift ;;
    http://*|https://*) URL="$1"; shift ;;
    *)
      if [ -n "$VERSION" ]; then
        echo "ERROR: unexpected arg: $1" >&2
        exit 1
      fi
      VERSION="$1"
      shift
      ;;
  esac
done

# --- Per-mode defaults (flags and env win) ---
if [ "$MODE" = "dev" ]; then
  PORT="${PORT:-${FOUNDRY_PORT:-30000}}"
  # Dev boots into its world by default (and seeds it when missing); pass
  # --world "" for the bare setup screen.
  WORLD_ID="${WORLD_ID:-${FOUNDRY_WORLD:-demiplane-test}}"
  WORLD_TITLE="${WORLD_TITLE:-Demiplane Test}"
  WORLD_DIR_NAME="$WORLD_ID"
else
  PORT="${PORT:-${FOUNDRY_TEST_PORT:-30001}}"
  WORLD_ID="${WORLD_ID:-${FOUNDRY_WORLD:-integration-test}}"
  WORLD_TITLE="${WORLD_TITLE:-Integration Test}"
  WORLD_DIR_NAME="$WORLD_ID"
fi
VERSION="${VERSION:-${FOUNDRY_VERSION:-$DEFAULT_VERSION}}"

# Headed browser for Playwright runs below (seed spec and suite inherit it).
if [ "$HEADED" -eq 1 ]; then
  export PLAYWRIGHT_HEADED=true
fi

# --- Resolve the server version (download when given a URL) ---
if [ -n "$URL" ]; then
  command -v curl >/dev/null || { echo "ERROR: curl is required to download $URL" >&2; exit 1; }
  ZIP_NAME="$(basename "$URL")"
  ZIP_PATH="$CACHE_DIR/$ZIP_NAME"
  mkdir -p "$CACHE_DIR"
  if [ -f "$ZIP_PATH" ]; then
    echo "Using cached $ZIP_PATH"
  else
    echo "Downloading $URL ..."
    curl -fSL --retry 3 -o "$ZIP_PATH" "$URL"
  fi
  if [[ "$ZIP_NAME" =~ FoundryVTT-Node-([0-9.]+)\.zip ]]; then
    VERSION="${BASH_REMATCH[1]}"
  fi
else
  ZIP_PATH="$CACHE_DIR/FoundryVTT-Node-$VERSION.zip"
  if [ ! -f "$ZIP_PATH" ]; then
    echo "ERROR: $ZIP_PATH not in cache. Provide the download URL instead:" >&2
    echo "  $0 $MODE $ACTION https://.../FoundryVTT-Node-$VERSION.zip" >&2
    exit 1
  fi
fi

SERVER_DIR="$VERSIONS_DIR/$VERSION/FoundryVTT-Node-$VERSION"
if [ -n "${FOUNDRY_PATH:-}" ]; then
  SERVER_DIR="$FOUNDRY_PATH"
fi
DATA_DIR="${FOUNDRY_DATA_PATH:-$PLAYWRIGHT_DIR/Data-$VERSION}"
if [ "$MODE" = "dev" ] && [ -z "${FOUNDRY_DATA_PATH:-}" ]; then
  DATA_DIR="$PLAYWRIGHT_DIR/Data"
fi
PID_FILE="$DATA_DIR/foundry.pid"
LOG_FILE="/tmp/foundry-$MODE-$VERSION.log"

echo "=== Foundry $MODE env: version $VERSION ==="
echo "Server: $SERVER_DIR"
echo "Data:   $DATA_DIR"
echo "Port:   $PORT"

pid_alive() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

read_pidfile() {
  if [ -f "$PID_FILE" ]; then
    head -n 1 "$PID_FILE" 2>/dev/null || true
  fi
  return 0
}

do_status() {
  local pid
  pid="$(read_pidfile)"
  if pid_alive "$pid"; then
    echo "Running: $MODE env (pid $pid, version $VERSION, port $PORT, data $DATA_DIR)."
    if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
      exec 3<&-; exec 3>&-
      echo "Port $PORT is accepting connections."
    else
      echo "WARNING: pid $pid is alive but port $PORT is not accepting connections."
    fi
  else
    if [ -n "$pid" ]; then rm -f "$PID_FILE"; fi
    echo "Stopped: no $MODE server running (data $DATA_DIR)."
  fi
}

do_stop() {
  local pid
  pid="$(read_pidfile)"
  if ! pid_alive "$pid"; then
    if [ -n "$pid" ]; then rm -f "$PID_FILE"; fi
    echo "No $MODE server running."
    return 0
  fi
  echo "Stopping $MODE server (pid $pid)..."
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    pid_alive "$pid" || break
    sleep 1
  done
  if pid_alive "$pid"; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "Stopped."
}

ensure_server_unpacked() {
  if [ -f "$SERVER_DIR/main.mjs" ]; then return 0; fi
  command -v unzip >/dev/null || { echo "ERROR: unzip is required" >&2; exit 1; }
  echo "Unpacking $ZIP_PATH ..."
  mkdir -p "$SERVER_DIR"
  unzip -q -o "$ZIP_PATH" -d "$SERVER_DIR"
  if [ ! -f "$SERVER_DIR/main.mjs" ]; then
    echo "ERROR: unpacked server has no main.mjs ($SERVER_DIR). Is $ZIP_PATH a Node build?" >&2
    exit 1
  fi
}

ensure_data_dir() {
  mkdir -p "$DATA_DIR/Data/modules" "$DATA_DIR/Data/systems" "$DATA_DIR/Data/worlds" "$DATA_DIR/Config"
  if [ ! -d "$PROJECT_ROOT/dist" ]; then
    echo "ERROR: dist/ missing. Run 'npm run build' first." >&2
    exit 1
  fi
  local link="$DATA_DIR/Data/modules/$MODULE_ID"
  if [ -L "$link" ]; then
    rm "$link"
  elif [ -d "$link" ]; then
    rm -rf "$link"
  fi
  ln -s "$PROJECT_ROOT" "$link"
}

do_start() {
  local existing
  existing="$(read_pidfile)"
  if pid_alive "$existing"; then
    echo "Already running: $MODE env (pid $existing). Use '$0 $MODE stop' first."
    return 0
  fi
  if [ -n "$existing" ]; then rm -f "$PID_FILE"; fi

  # --clean wipes just this world plus the server logs, so the next boot
  # re-seeds from scratch (license → PF2e → world) with fresh logs. Runs
  # only when no server is up (checked above), and never touches anything
  # outside the world dir and Logs.
  if [ "$CLEAN" -eq 1 ] && [ -n "$WORLD_DIR_NAME" ]; then
    echo "Cleaning world $WORLD_DIR_NAME and server logs ..."
    rm -rf "$DATA_DIR/Data/worlds/$WORLD_DIR_NAME" "$DATA_DIR/Logs"
    mkdir -p "$DATA_DIR/Logs"
  fi

  local node_major
  node_major="$(node --version | sed 's/v//' | cut -d. -f1)"
  if [ "$node_major" -lt 24 ]; then
    echo "ERROR: Foundry v14 requires Node 24+. Current: $(node --version)" >&2
    exit 1
  fi

  ensure_server_unpacked
  ensure_data_dir

  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    exec 3<&-; exec 3>&-
    echo "ERROR: something already listens on port $PORT. Use --port or stop it." >&2
    exit 1
  fi

  # No --world flag at all when empty (dev default): boots to setup.
  # (String, not an array: macOS bash 3.2 crashes expanding empty arrays
  # under `set -u`.)
  world_flag=""
  if [ -n "$WORLD_ID" ]; then
    world_flag="--world=$WORLD_ID"
  fi
  echo "Starting Foundry $VERSION ($MODE) on port $PORT${WORLD_ID:+ world $WORLD_ID}..."
  # Intentional word splitting of the optional flag (empty expands to nothing).
  # shellcheck disable=SC2086
  node "$SERVER_DIR/main.mjs" \
    --dataPath="$DATA_DIR" \
    --port="$PORT" \
    --adminPassword="${FOUNDRY_ADMIN_PASSWORD:-test-admin}" \
    ${world_flag:+$world_flag} \
    --noupdate \
    > "$LOG_FILE" 2>&1 &
  local pid=$!
  printf '%s\n%s\n%s\n%s\n' "$pid" "$VERSION" "$PORT" "$WORLD_ID" > "$PID_FILE"

  echo "Waiting for server..."
  for _ in $(seq 1 180); do
    if grep -q "Server started and listening" "$LOG_FILE" 2>/dev/null; then
      echo "Foundry is ready (pid $pid, log $LOG_FILE)."
      return 0
    fi
    if ! pid_alive "$pid"; then
      echo "ERROR: Foundry died during startup. Tail of $LOG_FILE:" >&2
      tail -n 30 "$LOG_FILE" >&2
      rm -f "$PID_FILE"
      exit 1
    fi
    sleep 1
  done
  echo "ERROR: timed out waiting for Foundry. Tail of $LOG_FILE:" >&2
  tail -n 30 "$LOG_FILE" >&2
  exit 1
}

seed_if_needed() {
  if [ -z "$WORLD_ID" ]; then return 0; fi
  if [ -d "$DATA_DIR/Data/worlds/$WORLD_DIR_NAME" ]; then
    echo "World $WORLD_DIR_NAME already exists — skipping seed."
    return 0
  fi
  if [ -z "${FOUNDRY_LICENSE_KEY:-}" ]; then
    echo "ERROR: fresh data dir needs FOUNDRY_LICENSE_KEY (seeding $WORLD_DIR_NAME)." >&2
    exit 1
  fi
  echo "Seeding fresh data dir (license, PF2e, world)..."
  FOUNDRY_PORT="$PORT" \
  FOUNDRY_ADMIN_PASSWORD="${FOUNDRY_ADMIN_PASSWORD:-test-admin}" \
  SMOKE_WORLD_TITLE="$WORLD_TITLE" \
    npx playwright test scripts/setup-foundry.spec.ts --config=scripts/playwright-setup.config.ts
}

case "$ACTION" in
  status) do_status ;;
  stop) do_stop ;;
  start)
    do_start
    seed_if_needed
    ;;
  run)
    STARTED_BY_ME=0
    if ! pid_alive "$(read_pidfile)"; then
      do_start
      STARTED_BY_ME=1
    else
      echo "Reusing already-running $MODE server."
    fi
    # Always clean up what we started, even if tests or summary fail.
    cleanup_on_exit() {
      if [ "$STARTED_BY_ME" -eq 1 ]; then
        if [ "$KEEP" -eq 1 ]; then
          echo "Keeping server running (--keep)."
        else
          do_stop
        fi
      fi
    }
    trap cleanup_on_exit EXIT INT TERM
    seed_if_needed
    echo "Running integration tests..."
    RESULT_JSON="/tmp/foundry-$MODE-$VERSION-results.json"
    rm -f "$RESULT_JSON"
    set +e
    FOUNDRY_TEST_PORT="$PORT" \
    FOUNDRY_DATA_PATH="$DATA_DIR" \
    FOUNDRY_WORLD="$WORLD_ID" \
    PLAYWRIGHT_JSON_OUTPUT_NAME="$RESULT_JSON" \
      npx playwright test --reporter=json,line
    TEST_EXIT=$?
    set -e
    node "$SCRIPT_DIR/summarize-results.mjs" "$RESULT_JSON" || true
    trap - EXIT INT TERM
    cleanup_on_exit
    exit "$TEST_EXIT"
    ;;
esac
