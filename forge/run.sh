#!/usr/bin/env bash
# Run ForgeBOT backend (FastAPI on :8420) and frontend (Vite on :5173).
# Usage:
#   ./run.sh            # both
#   ./run.sh backend    # backend only
#   ./run.sh frontend   # frontend only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"

TARGET="${1:-all}"

# Are we inside a flatpak sandbox? If so, npm/node usually live on the host.
IN_FLATPAK=0
if [ -f "/.flatpak-info" ] || [ -n "${FLATPAK_ID:-}" ]; then
  IN_FLATPAK=1
fi

# NPM_CMD is either "npm" or "flatpak-spawn --host npm" depending on env.
NPM_CMD=""

# Locate a binary by name on PATH or in common install dirs (nvm/fnm/local).
ensure_on_path() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    return 0
  fi
  local candidates=("$HOME/.local/bin/$name" "/usr/local/bin/$name")
  local d
  for d in "$HOME/.nvm/versions/node"/*/bin "$HOME/.fnm/node-versions"/*/installation/bin "$HOME/.local/share/fnm/node-versions"/*/installation/bin; do
    [ -x "$d/$name" ] && candidates+=("$d/$name")
  done
  local c
  for c in "${candidates[@]}"; do
    if [ -x "$c" ]; then
      export PATH="$(dirname "$c"):$PATH"
      echo "[env] using $name from $(dirname "$c")"
      return 0
    fi
  done
  return 1
}

require_python() {
  if ! ensure_on_path python3; then
    echo "error: python3 not found. Install Python 3.11+ and retry." >&2
    exit 1
  fi
}

require_node() {
  if ensure_on_path npm; then
    NPM_CMD="npm"
    return 0
  fi
  if [ "$IN_FLATPAK" = "1" ] && command -v flatpak-spawn >/dev/null 2>&1; then
    if flatpak-spawn --host sh -c 'command -v npm >/dev/null 2>&1'; then
      echo "[env] using host npm via flatpak-spawn"
      NPM_CMD="flatpak-spawn --host --watch-bus --env=PATH=$PATH:/usr/local/bin:/usr/bin:$HOME/.local/bin npm"
      return 0
    fi
  fi
  echo "error: node/npm not found on PATH or host." >&2
  echo "       Install Node 20+ (dnf install nodejs / nvm / fnm) and retry." >&2
  exit 1
}

run_backend() {
  require_python
  cd "$BACKEND_DIR"
  if [ ! -d ".venv" ]; then
    echo "[backend] creating venv..."
    python3 -m venv .venv
  fi
  echo "[backend] syncing dependencies..."
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet -e ".[api,mesh]"
  echo "[backend] starting uvicorn on http://127.0.0.1:8420"
  exec .venv/bin/uvicorn forgebot.api.main:app --host 127.0.0.1 --port 8420 --reload
}

run_frontend() {
  require_node
  cd "$FRONTEND_DIR"
  echo "[frontend] syncing npm deps..."
  if [ -f "package-lock.json" ]; then
    $NPM_CMD install --no-audit --no-fund --silent --prefer-offline
  else
    $NPM_CMD install --no-audit --no-fund --silent
  fi
  echo "[frontend] starting vite on http://127.0.0.1:5173"
  exec $NPM_CMD run dev
}

case "$TARGET" in
  backend)
    run_backend
    ;;
  frontend)
    run_frontend
    ;;
  all|"")
    pids=()
    cleanup() {
      echo
      echo "[run.sh] shutting down..."
      for pid in "${pids[@]}"; do
        kill "$pid" 2>/dev/null || true
      done
      wait 2>/dev/null || true
    }
    trap cleanup INT TERM EXIT

    ( run_backend ) &
    pids+=($!)

    ( run_frontend ) &
    pids+=($!)

    wait -n "${pids[@]}"
    ;;
  *)
    echo "Usage: $0 [backend|frontend|all]" >&2
    exit 1
    ;;
esac
