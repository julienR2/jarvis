#!/usr/bin/env bash
# deploy.sh — put the code on disk into the running Jarvis.
#
# Prod runs without file watchers, so a saved edit is inert until this runs.
# It works out which services changed since the last deploy, typechecks them,
# and applies each the cheapest safe way:
#
#   frontend  build from here, copy hashed assets in, swap index.html last
#   backend   POST /internal/restart, wait for /health
#   engine    kill its node process after a delay (only with --engine: it ends the
#             conversation's Claude process; --resume brings the context back)
#   Dockerfile / compose / frontend deps   cannot be applied from inside a
#             container — reported for the host
#
# Runs inside the engine container, as the agent. Needs BACKEND_URL and
# INTERNAL_SECRET, both already in the agent's environment.
#
#   deploy.sh [--fast] [--dry-run] [--allow-dirty] [--engine] [--all]
set -euo pipefail

REPO=/jarvis
MARKER="$REPO/agent/data/deployed.json"
FAST=0 DRY=0 ALLOW_DIRTY=0 ENGINE_OK=0 FORCE_ALL=0
for a in "$@"; do
  case "$a" in
    --fast) FAST=1 ;;            # skip the e2e run against next
    --dry-run) DRY=1 ;;          # decide and report, change nothing
    --allow-dirty) ALLOW_DIRTY=1 ;;  # deploy uncommitted work (records HEAD anyway)
    --engine) ENGINE_OK=1 ;;     # allowed to restart the engine
    --all) FORCE_ALL=1 ;;        # ignore the marker, treat everything as changed
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

cd "$REPO"
trap 'rm -rf "$REPO/frontend/dist-next"' EXIT
HEAD=$(git rev-parse HEAD)
SHORT=$(git rev-parse --short HEAD)
DIRTY_FILES=$(git status --porcelain | awk '{print $NF}')
DIRTY=$(printf '%s' "$DIRTY_FILES" | grep -c . || true)

if [ "$DIRTY" -gt 0 ] && [ "$ALLOW_DIRTY" = 0 ]; then
  echo "✗ $DIRTY uncommitted change(s). Commit first, or pass --allow-dirty."
  printf '%s\n' "$DIRTY_FILES" | sed 's/^/    /'
  exit 1
fi

LAST=$(python3 -c "import json;print(json.load(open('$MARKER'))['commit'])" 2>/dev/null || true)

# ── what changed ─────────────────────────────────────────────────────────────
FE=0 BE=0 EN=0 FE_BLOCKED=0 HOST=() NOTES=()
if [ -z "$LAST" ] || [ "$FORCE_ALL" = 1 ]; then
  FE=1 BE=1 EN=1
  CHANGED="(all)"
  if [ -z "$LAST" ]; then
    # First run: nothing to diff against. Bring frontend and backend in line
    # with disk; leave the engine alone unless asked — it is what you are
    # talking through, and there is no evidence it changed.
    echo "· no deploy marker yet — frontend and backend treated as changed, engine only with --engine"
    [ "$ENGINE_OK" = 1 ] || EN=0
  fi
else
  CHANGED=$( { git diff --name-only "$LAST" HEAD 2>/dev/null; printf '%s\n' "$DIRTY_FILES"; } | grep . | sort -u || true)
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      frontend/package.json|frontend/package-lock.json) HOST+=("frontend dependencies changed — the frontend container installs them on start: homelab skill POST /rebuild/jarvis (restarts every Jarvis container, this conversation included) or, on the host, docker compose up -d --force-recreate frontend") ;;
      # Backend and engine install their dependencies on start too, but the
      # typecheck below runs against the modules already installed — so a new
      # dependency fails it until the service has restarted once. Say so.
      backend/package.json|backend/package-lock.json) BE=1; NOTES+=("backend dependencies changed — they install on its restart; if the typecheck fails on a missing module, restart it first (curl -X POST -H \"X-Internal-Secret: \$INTERNAL_SECRET\" \$BACKEND_URL/internal/restart) and rerun deploy") ;;
      engine/package.json|engine/package-lock.json) EN=1; NOTES+=("engine dependencies changed — they install on its restart; if the engine typecheck fails on a missing module, deploy with --engine (it restarts) and rerun deploy afterwards") ;;
      # The preview server reads its proxy table once, at start — a build alone
      # does not carry a change here. Still built below, for the bundle side.
      frontend/vite.config.ts) FE=1; HOST+=("frontend/vite.config.ts changed — the preview proxy only reloads on \`docker compose up -d frontend\`") ;;
      frontend/*) FE=1 ;;
      backend/*) BE=1 ;;
      engine/*) EN=1 ;;
      */Dockerfile|docker-compose*.yml|*/docker-compose*.yml) HOST+=("$f — image/compose change: homelab skill POST /start/jarvis (= docker compose up -d, recreates only what changed; a Dockerfile change needs /rebuild/jarvis, which restarts everything) or the same on the host") ;;
      *) ;;  # agent/, docs, site, README: read at runtime or irrelevant
    esac
  done <<< "$CHANGED"
fi

# The frontend container builds dist/ as root; the engine deploys as uid 1000.
# The compose command chowns dist on start, but until that container has been
# recreated with it, nothing from here can write there — say so, don't half-copy.
if [ "$FE" = 1 ] && [ -d "$REPO/frontend/dist" ] && ! { [ -w "$REPO/frontend/dist" ] && [ -w "$REPO/frontend/dist/index.html" ]; }; then
  HOST+=("frontend/dist files are owned by $(stat -c %U "$REPO/frontend/dist/index.html") and not writable from here — recreate the frontend container once with the current compose: docker compose up -d frontend. Frontend NOT deployed.")
  FE=0; FE_BLOCKED=1
fi

echo "deploy $SHORT$( [ "$DIRTY" -gt 0 ] && echo " (+$DIRTY uncommitted)")"
[ -n "$LAST" ] && echo "· since $(git rev-parse --short "$LAST" 2>/dev/null || echo "$LAST"): $(printf '%s\n' "$CHANGED" | grep -c . || echo 0) file(s)"
echo "· plan: frontend=$FE backend=$BE engine=$EN host=${#HOST[@]}"
for n in "${NOTES[@]:-}"; do [ -n "$n" ] && echo "! note: $n"; done

if [ "$FE" = 0 ] && [ "$BE" = 0 ] && [ "$EN" = 0 ] && [ "${#HOST[@]}" = 0 ]; then
  echo "✓ nothing to deploy"
  [ "$DRY" = 1 ] || python3 - "$MARKER" "$HEAD" "$DIRTY" <<'PY'
import json,sys,time
json.dump({"commit":sys.argv[2],"at":int(time.time()),"services":[],"dirty":int(sys.argv[3])},open(sys.argv[1],'w'))
PY
  exit 0
fi

# ── checks ───────────────────────────────────────────────────────────────────
[ "$BE" = 1 ] && { echo "· typecheck backend";  npm --prefix "$REPO/backend"  run -s typecheck >/dev/null || { echo "✗ backend typecheck failed"; npm --prefix "$REPO/backend" run -s typecheck 2>&1 | tail -15; exit 1; }; }
[ "$FE" = 1 ] && { echo "· typecheck frontend"; npm --prefix "$REPO/frontend" run -s typecheck >/dev/null || { echo "✗ frontend typecheck failed"; npm --prefix "$REPO/frontend" run -s typecheck 2>&1 | tail -15; exit 1; }; }
if [ "$EN" = 1 ] && [ -x "$REPO/engine/node_modules/.bin/tsc" ]; then
  echo "· typecheck engine"; "$REPO/engine/node_modules/.bin/tsc" --noEmit -p "$REPO/engine" >/dev/null || { echo "✗ engine typecheck failed"; "$REPO/engine/node_modules/.bin/tsc" --noEmit -p "$REPO/engine" 2>&1 | tail -15; exit 1; }
fi
if [ "$FAST" = 0 ]; then
  # UI checks against next — the same tree that is about to be deployed, in
  # dev mode. Exit 3 means next is not up: nothing was tested, say so, go on.
  echo "· e2e against next"
  set +e
  bash "$REPO/e2e/run.sh" > /tmp/deploy-e2e.log 2>&1
  E2E_RC=$?
  set -e
  if [ "$E2E_RC" = 0 ]; then
    echo "✓ e2e: $(grep -oE '[0-9]+ passed[^\n]*' /tmp/deploy-e2e.log | tail -1)"
  elif [ "$E2E_RC" = 3 ]; then
    echo "! e2e not run — $(tail -1 /tmp/deploy-e2e.log)"
  else
    echo "✗ e2e failed — nothing deployed. Details:"
    grep -E "✘|Error:|expect\(|Timeout|passed|failed|flaky" /tmp/deploy-e2e.log | head -30
    echo "  full log: /tmp/deploy-e2e.log"
    exit 1
  fi
fi

[ "$DRY" = 1 ] && { echo "· dry run — stopping here"; for h in "${HOST[@]:-}"; do [ -n "$h" ] && echo "  host: $h"; done; exit 0; }

DONE=()

# ── frontend ─────────────────────────────────────────────────────────────────
if [ "$FE" = 1 ]; then
  echo "· building frontend"
  cd "$REPO/frontend"
  rm -rf dist-next
  # --configLoader native: vite otherwise bundles vite.config.ts into
  # node_modules/.vite-temp, which is read-only from this container.
  ./node_modules/.bin/vite build --outDir dist-next --emptyOutDir --configLoader native --logLevel error
  [ -f dist-next/index.html ] || { echo "✗ build produced no index.html"; exit 1; }
  mkdir -p dist
  # Additive first: new hashed assets land next to the old ones, so a tab on
  # the old bundle can still lazy-load its chunks. index.html goes last, by a
  # same-directory rename — preview never serves a torn page, and the backend's
  # dist watcher (which triggers the reload banner) sees exactly that file change.
  for item in dist-next/*; do
    n=$(basename "$item")
    [ "$n" = index.html ] && continue
    if [ -d "$item" ]; then mkdir -p "dist/$n" && cp -a "$item/." "dist/$n/"
    else cp -a "$item" "dist/.$n.tmp" && mv -f "dist/.$n.tmp" "dist/$n"; fi
  done
  cp dist-next/index.html dist/.index.html.tmp && mv -f dist/.index.html.tmp dist/index.html
  # Prune assets that are neither in this build nor recent — yesterday's tabs
  # have had their banner; keep today's chunks for anyone still on them.
  for f in dist/assets/*; do
    [ -e "dist-next/assets/$(basename "$f")" ] && continue
    find "$f" -mmin +1440 -delete 2>/dev/null || true
  done
  rm -rf dist-next
  cd "$REPO"
  DONE+=(frontend)
  echo "✓ frontend deployed — open tabs get the reload banner"
fi

# ── backend ──────────────────────────────────────────────────────────────────
if [ "$BE" = 1 ]; then
  echo "· restarting backend"
  H="X-Internal-Secret: $INTERNAL_SECRET"
  # /health reports uptime; a real restart brings it back near zero. That is
  # the proof — the first few hundred ms after the POST the old process would
  # still answer, so "it responded" alone proves nothing.
  U0=$(curl -fsS -m 2 "$BACKEND_URL/health" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('uptime',-1))" 2>/dev/null || echo -1)
  MODE=$(curl -fsS -m 5 -X POST -H "$H" "$BACKEND_URL/internal/restart" | python3 -c "import sys,json;print(json.load(sys.stdin).get('mode','?'))" 2>/dev/null || echo '?')
  echo "  · restart requested (mode: $MODE)"
  T0=$(date +%s%3N); UP=0
  for i in $(seq 1 60); do
    sleep 0.5
    curl -fsS -m 1 "$BACKEND_URL/health" >/dev/null 2>&1 && { UP=1; break; }
    # Safety net for a `tsx watch` supervisor left waiting on a dead child:
    # a byte-identical rewrite of the entry file is a change event to it.
    if [ "$i" = 20 ]; then
      echo "  · still down after 10s — nudging the file watcher"
      python3 -c "p='$REPO/backend/src/index.ts'; d=open(p,'rb').read(); open(p,'wb').write(d)"
    fi
  done
  if [ "$UP" = 1 ]; then
    MS=$(( $(date +%s%3N) - T0 ))
    U1=$(curl -fsS -m 2 "$BACKEND_URL/health" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('uptime',-1))" 2>/dev/null || echo -1)
    if [ "$U0" -ge 0 ] && [ "$U1" -ge 0 ] && [ "$U1" -gt "$U0" ]; then
      echo "✗ backend answered but never restarted (uptime ${U0}s → ${U1}s) — old code still running"; exit 1
    fi
    DONE+=(backend)
    echo "✓ backend back in $((MS/1000)).$(( (MS%1000)/100 ))s (uptime now ${U1}s)"
  else
    echo "✗ backend did not answer /health within 30s — check its logs (homelab skill: logs jarvis)"; exit 1
  fi
fi

# ── engine ───────────────────────────────────────────────────────────────────
if [ "$EN" = 1 ]; then
  if [ "$ENGINE_OK" = 1 ]; then
    # Detached and delayed so the reply that announces it is persisted first.
    # Kill the node process, not PID 1: a non-interactive sh as init ignores
    # SIGTERM. With no watcher above it, node ending ends the `sh -c` chain and
    # the restart policy brings the container back on the new code.
    setsid sh -c 'sleep 10; pkill -TERM -f "tsx src/index.ts" || kill 1' >/dev/null 2>&1 &
    DONE+=(engine)
    echo "✓ engine restarts in 10s — this conversation's Claude process ends; the next message resumes it with the new code"
  else
    echo "! engine changed but not restarted — rerun with --engine (it ends the running conversation for a few seconds)"
  fi
fi

for h in "${HOST[@]:-}"; do [ -n "$h" ] && echo "! host: $h"; done

if [ "$FE_BLOCKED" = 1 ]; then
  echo "· marker not updated — rerun deploy after the host step so the frontend catches up"
else
  python3 - "$MARKER" "$HEAD" "$DIRTY" "${DONE[@]:-}" <<'PY'
import json,sys,time
m,commit,dirty,*services=sys.argv[1:]
json.dump({"commit":commit,"at":int(time.time()),"services":[s for s in services if s],"dirty":int(dirty)},open(m,'w'))
PY
  echo "· recorded $SHORT in agent/data/deployed.json"
fi
