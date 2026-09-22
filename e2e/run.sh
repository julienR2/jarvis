#!/usr/bin/env bash
# Run the UI checks against a throwaway stack, started and stopped for the run.
#
#   bash /jarvis/e2e/run.sh [playwright args]     # e.g. specs/chat.spec.ts
#
# Exit codes: 0 passed · 1 failed · 3 the throwaway stack never came up.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./stack.sh
stack_up || exit 3

# Self-contained install: the runner is not a dependency of any service, so it
# never ends up in a container's node_modules volume or in a rebuild.
[ -x node_modules/.bin/playwright ] || npm ci --no-audit --no-fund --silent

# Deliberately not `exec`: that would replace this shell and with it the EXIT
# trap, leaving the whole stack — and its ports — behind after the suite ends.
./node_modules/.bin/playwright test "$@"
