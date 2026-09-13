#!/usr/bin/env bash
# Run the UI checks against the next stack. deploy.sh calls this; it also works
# on its own from the engine container:  bash /jarvis/e2e/run.sh [playwright args]
#
# Exit codes: 0 passed · 1 failed · 3 next not reachable (nothing was tested).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
API="${E2E_API:-http://next-backend:3005}"
if ! curl -fsS -m 3 "$API/health" >/dev/null 2>&1; then
  echo "next is not reachable at $API — is the \`next\` profile up?"
  exit 3
fi
# Self-contained install: the runner is not a dependency of any service, so it
# never ends up in a container's node_modules volume or in a rebuild.
[ -x node_modules/.bin/playwright ] || npm ci --no-audit --no-fund --silent
exec ./node_modules/.bin/playwright test "$@"
