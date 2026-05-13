#!/usr/bin/env bash
# Start the ForgeBOT backend (FastAPI) and frontend (Vite) together.
# Bootstraps the Python venv and frontend node_modules if missing.
# Ctrl-C stops both.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
VENV_DIR="$BACKEND_DIR/.venv"

BACKEND_HOST="${FORGEBOT_HOST:-127.0.0.1}"
BACKEND_PORT="${FORGEBOT_PORT:-8420}"

# --- Make sure node/npm are reachable. They're often installed in ~/.local/bin
# (e.g. WebStorm-managed node) but that's not always on PATH.
if ! command -v npm >/dev/null 2>&1; then
    if [[ -x "$HOME/.local/bin/npm" ]]; then
        export PATH="$HOME/.local/bin:$PATH"
    fi
fi
if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm not found. Install Node.js or put npm on your PATH." >&2
    exit 1
fi
if ! command -v node >/dev/null 2>&1; then
    echo "Error: node not found. Install Node.js or put node on your PATH." >&2
    exit 1
fi

# --- Python venv: create + install if missing, otherwise just use it.
PYTHON_BIN="${PYTHON:-python3}"
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
    echo "Creating Python venv at $VENV_DIR ..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

VENV_PY="$VENV_DIR/bin/python"

if ! "$VENV_PY" -c "import uvicorn, fastapi, forgebot" >/dev/null 2>&1; then
    echo "Installing backend dependencies (this may take a minute) ..."
    "$VENV_PY" -m pip install --upgrade pip >/dev/null
    "$VENV_PY" -m pip install -e "$BACKEND_DIR[api,dev,mesh]"
fi

# --- Frontend deps.
if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    echo "Installing frontend dependencies ..."
    (cd "$FRONTEND_DIR" && npm install)
fi

# --- Run both. Trap cleans them up on exit/Ctrl-C.
cleanup() {
    echo
    echo "Shutting down..."
    if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
        kill "$BACKEND_PID" 2>/dev/null || true
    fi
    if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
        kill "$FRONTEND_PID" 2>/dev/null || true
    fi
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting backend on http://$BACKEND_HOST:$BACKEND_PORT ..."
(
    cd "$BACKEND_DIR"
    exec "$VENV_PY" -m uvicorn forgebot.api.main:app \
        --host "$BACKEND_HOST" \
        --port "$BACKEND_PORT" \
        --reload
) &
BACKEND_PID=$!

echo "Starting frontend (Vite) ..."
(
    cd "$FRONTEND_DIR"
    exec npm run dev
) &
FRONTEND_PID=$!

wait -n "$BACKEND_PID" "$FRONTEND_PID"
