#!/usr/bin/env bash
# Screenshot Jarvis's own pages, as the code on disk renders them right now.
#
#   bash /jarvis/e2e/shot.sh <route> [route...] [--phone]
#   bash /jarvis/e2e/shot.sh --out /some/dir settings routines
#
# Prod runs the last deployed build, so a page cannot be shown by pointing at it
# — this starts the same throwaway stack the e2e suite uses (fixtures, its own
# database, no Docker), shoots the routes, and stops it again. Nothing prod owns
# is touched, and the pictures are of the edit, not of what is live.
#
# Without --out the files land in this conversation's uploads folder, where a
# markdown link to the literal path renders them inline in the chat.
#
# Exit codes: 0 shot · 1 failed · 3 the throwaway stack never came up.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

OUT=""
ROUTES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    *) ROUTES+=("$1"); shift ;;
  esac
done
if [ "${#ROUTES[@]}" = 0 ]; then
  sed -n '2,13p' "$0"; exit 2
fi
if [ -z "$OUT" ]; then
  : "${WORKSPACE_DIR:?set WORKSPACE_DIR or pass --out}"
  : "${JARVIS_CONVERSATION_ID:?not in a conversation — pass --out}"
  OUT="$WORKSPACE_DIR/uploads/$JARVIS_CONVERSATION_ID"
fi

# Its own ports, so a screenshot can be taken while the suite is running.
export E2E_API_PORT=${E2E_API_PORT:-3106}
export E2E_WEB_PORT=${E2E_WEB_PORT:-5274}
export E2E_ENGINE_PORT=${E2E_ENGINE_PORT:-3111}

source ./stack.sh
stack_up || exit 3

[ -x node_modules/.bin/playwright ] || npm ci --no-audit --no-fund --silent
node ./shot.mjs "$OUT" "${ROUTES[@]}"
