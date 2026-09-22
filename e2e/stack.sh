#!/usr/bin/env bash
# The throwaway Jarvis stack, for anything that needs a running instance that is
# not prod. Sourced, not executed:
#
#   source /jarvis/e2e/stack.sh
#   stack_up                       # exits 3 if it cannot come up
#   ...                            # $E2E_API, $E2E_BASE_URL, $E2E_CREDENTIALS
#
# It starts, in the engine container and with no Docker at all:
#
#   engine    a stub (stub-engine.mjs) — nothing here sends a message, but a few
#             pages ask the backend things only an engine can answer. The real
#             engine is never touched.
#   backend   the real server on a database created by mktemp and deleted on the
#             way out, seeded with fixtures at boot (SEED_FIXTURES=1). Its own
#             secrets, its own workspace. Prod's data is never opened.
#   frontend  a vite dev server, so what runs is the source on disk — the point
#             being to see a change BEFORE the deploy that would make it live.
#
# The caller inherits an EXIT trap that stops all three and removes the dir.
set -euo pipefail

E2E_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=${JARVIS_REPO_DIR:-/jarvis}
API_PORT=${E2E_API_PORT:-3105}
WEB_PORT=${E2E_WEB_PORT:-5273}
ENGINE_PORT=${E2E_ENGINE_PORT:-3110}
RUN=$(mktemp -d "${TMPDIR:-/tmp}/jarvis-e2e.XXXXXX")

# Kill the process group, then the pid as a fallback, then both again with KILL
# for whatever ignored the first round. A stack that outlives its run is the one
# failure that makes the NEXT run lie: it answers on the same ports, with its
# fixtures in a temp dir that is already gone.
PIDS=()
stack_down() {
  for sig in TERM KILL; do
    for p in "${PIDS[@]:-}"; do
      [ -n "$p" ] || continue
      kill "-$sig" -- "-$p" 2>/dev/null || true
      kill "-$sig" "$p" 2>/dev/null || true
    done
    # An `&&` here instead would return 1 on the KILL pass and, under `set -e`,
    # abort before the rm below ever runs.
    if [ "$sig" = TERM ]; then sleep 1; fi
  done
  rm -rf "$RUN"
}
trap stack_down EXIT

# Wait for $1 to answer, up to $2 seconds, while $4 is still alive. Prints the
# service's log ($3) either way — waiting out a full minute for a process that
# died on its first line only delays the reason.
stack_wait_for() {
  local deadline=$(( $(date +%s) + $2 ))
  until curl -fsS -m 2 -o /dev/null "$1" 2>/dev/null; do
    if ! kill -0 "$4" 2>/dev/null; then
      echo "the process behind $1 exited before it was ready" >&2
      tail -20 "$3" >&2
      return 1
    fi
    if [ "$(date +%s)" -gt "$deadline" ]; then
      echo "timed out waiting for $1 after ${2}s" >&2
      tail -20 "$3" >&2
      return 1
    fi
    sleep 0.5
  done
}

stack_up() {
  for port in "$API_PORT" "$WEB_PORT" "$ENGINE_PORT"; do
    # A TCP connect, not an HTTP probe: the backend answers 404 on `/` and would
    # go unnoticed by anything that only accepts a 2xx as "in use".
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      echo "port $port is already in use — an earlier run is still up. Stop it with:" >&2
      # Bracketed so the pattern does not match the shell running it: a plain
      # `pkill -f stub-engine` kills its own `bash -c` and leaves the job undone.
      echo "  pkill -f '[b]ackend/src/index.ts'; pkill -f '[b]in/vite'; pkill -f '[s]tub-engine'" >&2
      return 3
    fi
  done

  echo "· stub engine on :$ENGINE_PORT" >&2
  setsid env PORT="$ENGINE_PORT" node "$E2E_DIR/stub-engine.mjs" > "$RUN/engine.log" 2>&1 &
  PIDS+=($!)

  # The fixtures seed under the first user, so the backend must create one at
  # boot. The engine container has no ADMIN_* of its own; these never leave $RUN.
  echo "· throwaway backend on :$API_PORT (state in $RUN)" >&2
  setsid env \
    PORT="$API_PORT" \
    DB_PATH="$RUN/jarvis.db" \
    SECRETS_PATH="$RUN/secrets.json" \
    WORKSPACE_DIR="$RUN/workspace" \
    JARVIS_REPO_DIR="$REPO" \
    SEED_FIXTURES=1 \
    ADMIN_EMAIL=admin@jarvis.local \
    ADMIN_PASSWORD="$(head -c 18 /dev/urandom | base64)" \
    RATE_LIMIT_MAX=3000 \
    ENGINE_URL="http://127.0.0.1:$ENGINE_PORT" \
    "$REPO/backend/node_modules/.bin/tsx" "$REPO/backend/src/index.ts" \
    > "$RUN/backend.log" 2>&1 &
  local backend_pid=$!
  PIDS+=($backend_pid)
  stack_wait_for "http://127.0.0.1:$API_PORT/health" 60 "$RUN/backend.log" "$backend_pid" || return 3

  # --configLoader native: vite otherwise bundles vite.config.ts into
  # node_modules/.vite-temp, which is read-only from this container (deploy.sh
  # needs the same flag for the same reason). VITE_CACHE_DIR covers the other
  # write, the dependency scan.
  echo "· dev server on :$WEB_PORT" >&2
  setsid env \
    BACKEND_URL="http://127.0.0.1:$API_PORT" \
    VITE_CACHE_DIR="$RUN/vite" \
    "$REPO/frontend/node_modules/.bin/vite" "$REPO/frontend" \
    --config "$REPO/frontend/vite.config.ts" --configLoader native \
    --host 127.0.0.1 --port "$WEB_PORT" --strictPort \
    > "$RUN/frontend.log" 2>&1 &
  local frontend_pid=$!
  PIDS+=($frontend_pid)
  stack_wait_for "http://127.0.0.1:$WEB_PORT/" 60 "$RUN/frontend.log" "$frontend_pid" || return 3

  export E2E_API="http://127.0.0.1:$API_PORT"
  export E2E_BASE_URL="http://127.0.0.1:$WEB_PORT/"
  export E2E_CREDENTIALS="$RUN/e2e-credentials.json"
}
