#!/usr/bin/env bash
# Screenshot every page of the demo instance.
#
#   bash demo/demo.sh up
#   node demo/record/seed.mjs --fresh     # content for the sidebar and pages
#   bash demo/record/shots.sh             # → demo/record/out/shots/*.png
#
# The browser runs in the pinned Playwright image for the same reasons as
# record.sh — see the header there.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

IMAGE='mcr.microsoft.com/playwright:v1.63.0-noble'

# Host networking, reaching the demo on localhost rather than joining its
# Compose network and using `frontend:5173`. That is not a convenience: the
# Browser page embeds the Chromium container's own web client, which refuses to
# run outside a secure context, and browsers count `localhost` as one while
# `frontend:5173` is just insecure http. Over the compose network that page
# screenshots as a black rectangle reading "requires a secure connection".
FRONTEND="http://localhost:${DEMO_FRONTEND_PORT:-5273}"
API="http://localhost:${DEMO_BACKEND_PORT:-3105}"

curl -sf "$FRONTEND" -o /dev/null || {
  echo "$FRONTEND not responding — start the demo first: bash demo/demo.sh up" >&2; exit 1; }
[ -d demo/record/node_modules ] || (cd demo/record && npm install)

docker run --rm \
  --network host \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e DEMO_URL="$FRONTEND" \
  -e DEMO_API="$API" \
  -v "$PWD:/repo" -w /repo --ipc=host \
  "$IMAGE" node demo/record/scenes.mjs

echo "→ demo/record/out/shots/"
