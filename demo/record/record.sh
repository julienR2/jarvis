#!/usr/bin/env bash
# Record a demo GIF of the Jarvis UI, driving the demo instance.
#
#   bash demo/demo.sh up                     # the instance being filmed
#   CLEAN=1 bash demo/record/record.sh       # → demo/record/out/jarvis.gif
#
# Knobs: CLEAN=1 (empty the conversation list first, for a clean sidebar),
# SPEED, GIF_WIDTH, FPS, COLORS, KEEP_VIDEO=1.
#
# Two stages, deliberately split:
#
#   1. The browser runs in the PINNED Playwright image. Headless Chromium needs
#      GTK/ATK system libraries, and `playwright install-deps` only knows how to
#      install those on Debian/Ubuntu — on any other host distro a local run
#      dies with "libatk-1.0.so.0: cannot open shared object file". The image
#      also pins the browser build, so the framing can't shift under you.
#   2. ffmpeg runs on the HOST. The image ships only Playwright's private
#      ffmpeg (video capture), not one on PATH with the palette filters.
#
# The container joins the demo's own Compose network and reaches it as
# `frontend:5173`, so recording works even with the demo bound to loopback.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

IMAGE='mcr.microsoft.com/playwright:v1.63.0-noble'   # keep in step with package.json
NETWORK='jarvis-demo_default'
OUT='demo/record/out'
GIF="$OUT/jarvis.gif"

GIF_WIDTH="${GIF_WIDTH:-800}"
FPS="${FPS:-10}"
# The UI is flat dark with one accent colour, so a 64-entry palette is
# indistinguishable from the full 256 here and roughly halves the file.
COLORS="${COLORS:-64}"
# Most of a real take is spent watching the model think. Played back at 1x that
# is a two-minute GIF nobody scrolls through; at 3x the pacing reads as a demo
# without faking anything that happened. Set SPEED=1 for a true-time recording.
SPEED="${SPEED:-4}"

command -v ffmpeg >/dev/null || { echo 'ffmpeg not found on PATH' >&2; exit 1; }
docker network inspect "$NETWORK" >/dev/null 2>&1 || {
  echo "network $NETWORK not found — start the demo first: bash demo/demo.sh up" >&2; exit 1; }

[ -d demo/record/node_modules ] || (cd demo/record && npm install)

# CLEAN=1 empties the demo's conversation list first, so the sidebar in the
# take shows exactly the thread being recorded and nothing from earlier runs.
# Opt-in rather than default: it deletes data, and that should be a choice even
# on a throwaway instance.
if [ "${CLEAN:-}" = '1' ]; then
  api="http://127.0.0.1:${DEMO_BACKEND_PORT:-3105}"
  email=$(sed -n 's/^ADMIN_EMAIL=//p' demo/.env)
  password=$(sed -n 's/^ADMIN_PASSWORD=//p' demo/.env)
  token=$(curl -sf -X POST "$api/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}" |
    sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  [ -n "$token" ] || { echo 'could not log in to clean conversations' >&2; exit 1; }
  curl -sf "$api/api/conversations" -H "Authorization: Bearer $token" |
    grep -o '"id":"[^"]*"' | cut -d'"' -f4 |
    while read -r cid; do
      curl -sf -X DELETE "$api/api/conversations/$cid" -H "Authorization: Bearer $token" >/dev/null
    done
  echo '→ cleared previous conversations'
fi

echo '→ recording…'
# --user so the video lands owned by you rather than root. HOME must be
# writable for Chromium's own scratch files; the image's default home is not
# ours to write once --user is in play.
docker run --rm \
  --network "$NETWORK" \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -v "$PWD:/repo" \
  -w /repo \
  --ipc=host \
  "$IMAGE" \
  node demo/record/record.mjs

webm=$(find "$OUT/video" -name '*.webm' | head -1)
[ -n "$webm" ] || { echo 'no video produced' >&2; exit 1; }

echo '→ converting to gif…'
# Two passes: palettegen builds one palette from the whole clip, paletteuse
# maps against it. The one-pass default picks a palette per frame, which makes
# flat UI backgrounds visibly shimmer.
# setpts first, so fps= resamples the already-sped-up stream and drops frames
# rather than the other way round — the ordering is what keeps the file small.
filters="setpts=PTS/$SPEED,fps=$FPS,scale=$GIF_WIDTH:-1:flags=lanczos"
ffmpeg -y -loglevel error -i "$webm" -vf "$filters,palettegen=max_colors=$COLORS:stats_mode=diff" "$OUT/palette.png"
ffmpeg -y -loglevel error -i "$webm" -i "$OUT/palette.png" \
  -lavfi "$filters[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" "$GIF"
rm -f "$OUT/palette.png"

[ "${KEEP_VIDEO:-}" = '1' ] || rm -rf "$OUT/video"

echo "  $GIF  ($(du -h "$GIF" | cut -f1), $(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$GIF" | cut -d. -f1)s)"
