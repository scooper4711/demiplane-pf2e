#!/usr/bin/env bash
set -euo pipefail

# Setup script for Foundry VTT integration testing.
#
# This script:
# 1. Creates the Data directory structure if it doesn't exist
# 2. Symlinks the built module (dist/) into Data/modules/
# 3. Starts Foundry VTT
# 4. Runs a Playwright script to handle first-time setup (license, EULA, PF2e install, world creation)
#
# Prerequisites:
#   - Node 24+ available (use `nvm use 24`)
#   - Module built (`npm run build`)
#   - FOUNDRY_LICENSE_KEY env var set
#
# Usage:
#   ./scripts/setup-foundry.sh
#
# Configuration is loaded from .env (gitignored) in the project root.
# Create .env with:
#   FOUNDRY_LICENSE_KEY=XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
#   FOUNDRY_PORT=30000

# Source .env file if it exists (gitignored, contains license key and port)
ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env"
if [ -f "$ENV_FILE" ]; then
  echo "Loading environment from .env..."
  set -a
  source "$ENV_FILE"
  set +a
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

FOUNDRY_DIR="${FOUNDRY_PATH:-$PROJECT_ROOT/foundry-playwright/FoundryVTT-Node-14.367}"
DATA_DIR="${FOUNDRY_DATA_PATH:-$PROJECT_ROOT/foundry-playwright/Data}"
PORT="${FOUNDRY_PORT:-30000}"
ADMIN_PASSWORD="${FOUNDRY_ADMIN_PASSWORD:-test-admin}"
MODULE_ID="foundry-demiplane-pf2e"

echo "=== Foundry VTT Integration Test Setup ==="
echo "Foundry:  $FOUNDRY_DIR"
echo "Data:     $DATA_DIR"
echo "Port:     $PORT"
echo "Module:   $PROJECT_ROOT/dist -> $DATA_DIR/modules/$MODULE_ID"
echo ""

# --- Step 1: Create Data directory structure ---
echo "[1/5] Creating Data directory structure..."
mkdir -p "$DATA_DIR/modules"
mkdir -p "$DATA_DIR/systems"
mkdir -p "$DATA_DIR/worlds"
mkdir -p "$DATA_DIR/Config"

# --- Step 2: Symlink built module into Data/modules ---
echo "[2/5] Symlinking module..."
MODULE_LINK="$DATA_DIR/modules/$MODULE_ID"

if [ -L "$MODULE_LINK" ]; then
  echo "  Symlink already exists, updating..."
  rm "$MODULE_LINK"
elif [ -d "$MODULE_LINK" ]; then
  echo "  Directory exists (not a symlink), removing..."
  rm -rf "$MODULE_LINK"
fi

if [ ! -d "$PROJECT_ROOT/dist" ]; then
  echo "  ERROR: dist/ directory not found. Run 'npm run build' first."
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/dist/module.json" ]; then
  echo "  ERROR: dist/module.json not found. Ensure the build produces a module.json."
  exit 1
fi

ln -s "$PROJECT_ROOT/dist" "$MODULE_LINK"
echo "  Linked: $MODULE_LINK -> $PROJECT_ROOT/dist"

# --- Step 3: Verify Node version ---
echo "[3/5] Checking Node version..."
NODE_VERSION=$(node --version)
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "  ERROR: Foundry v14 requires Node 24+. Current: $NODE_VERSION"
  echo "  Run: nvm use 24"
  exit 1
fi
echo "  Node $NODE_VERSION ✓"

# --- Step 4: Start Foundry VTT ---
echo "[4/5] Starting Foundry VTT on port $PORT..."

node "$FOUNDRY_DIR/main.mjs" \
  --dataPath="$DATA_DIR" \
  --port="$PORT" \
  --adminPassword="$ADMIN_PASSWORD" \
  --noupdate \
  > /tmp/foundry-setup.log 2>&1 &

FOUNDRY_PID=$!
echo "  PID: $FOUNDRY_PID"

# Wait for Foundry to start listening
echo "  Waiting for server..."
for i in $(seq 1 60); do
  if grep -q "Server started and listening" /tmp/foundry-setup.log 2>/dev/null; then
    echo "  Foundry is ready."
    break
  fi
  if ! kill -0 "$FOUNDRY_PID" 2>/dev/null; then
    echo "  ERROR: Foundry process died. Check /tmp/foundry-setup.log"
    cat /tmp/foundry-setup.log
    exit 1
  fi
  sleep 1
done

if ! grep -q "Server started and listening" /tmp/foundry-setup.log 2>/dev/null; then
  echo "  ERROR: Timed out waiting for Foundry to start."
  kill "$FOUNDRY_PID" 2>/dev/null || true
  cat /tmp/foundry-setup.log
  exit 1
fi

# --- Step 5: Run Playwright setup script ---
echo "[5/5] Running Playwright setup (license, EULA, PF2e install, world creation)..."
echo ""

FOUNDRY_PORT="$PORT" \
FOUNDRY_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
npx playwright test scripts/setup-foundry.spec.ts --config=scripts/playwright-setup.config.ts || {
  echo ""
  echo "Setup script failed. Foundry is still running (PID: $FOUNDRY_PID)."
  echo "You can complete setup manually at http://localhost:$PORT"
  echo "Kill Foundry with: kill $FOUNDRY_PID"
  exit 1
}

echo ""
echo "=== Setup Complete ==="
echo "Foundry VTT is running on http://localhost:$PORT (PID: $FOUNDRY_PID)"
echo "  - PF2e system installed"
echo "  - Module symlinked"
echo "  - Test world created"
echo ""
echo "To stop Foundry: kill $FOUNDRY_PID"
echo "To run integration tests: FOUNDRY_PORT=$PORT npx playwright test"
