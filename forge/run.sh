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

# Locate a binary by name. If not on PATH, probe common locations (flatpak host,
# user-local installs, nvm/fnm, system) and prepend the directory to PATH.
ensure_on_path() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    return 0
  fi
  local candidates=(
    "/run/host/usr/local/bin/$name"
    "/run/host/usr/bin/$name"
    "/run/host/home/$USER/.local/bin/$name"
    "$HOME/.local/bin/$name"
    "/usr/local/bin/$name"
  )
  # nvm / fnm — pick the highest-versioned install
  local nvm_dir
  for nvm_dir in "$HOME/.nvm/versions/node"/*/bin "$HOME/.fnm/node-versions"/*/installation/bin "$HOME/.local/share/fnm/node-versions"/*/installation/bin; do
    [ -x "$nvm_dir/$name" ] && candidates+=("$nvm_dir/$name")
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
  if ! ensure_on_path node || ! ensure_on_path npm; then
    echo "error: node/npm not found." >&2
    echo "       If you're inside the VS Code flatpak, install Node on the host" >&2
    echo "       (dnf install nodejs / nvm) and re-run, or run this script from" >&2
    echo "       a host terminal where 'npm' is on PATH." >&2
    exit 1
  fi
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
    npm install --no-audit --no-fund --silent --prefer-offline
  else
    npm install --no-audit --no-fund --silent
  fi
  echo "[frontend] starting vite on http://127.0.0.1:5173"
  exec npm run dev
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
