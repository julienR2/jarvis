#!/usr/bin/env bash
# Copies a finished take into docs/, under the names the README and the landing
# page already reference. Nothing else in the repo needs to know about demo/.
#
#   bash demo/record/publish.sh          # show what would change
#   bash demo/record/publish.sh --write  # actually copy
#
# Screenshots are published at their captured 2560x1600 and displayed at 1280
# CSS px, so they stay sharp on a high-DPI screen instead of being resampled.
# Light-theme copies get a -light suffix; the site swaps on the visitor's theme.
# site/build.sh copies docs/* into the built page, so updating docs/ updates
# the website too.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

SHOTS='demo/record/out/shots'
OUT='demo/record/out'
DOCS='docs'
WRITE=''
[ "${1:-}" = '--write' ] && WRITE=1

# <source in out/shots> → <name in docs/>. `code` keeps the historical
# screenshot-git.png name so the README's existing links stay valid.
# No home/chat entries: the tour GIF opens on the home screen and spends a
# scene on a plain conversation, so a still of each would be a file nothing
# links to. They are still captured — add them here if you find a use.
MAP='
app:screenshot-app
image:screenshot-image
code:screenshot-git
connectors:screenshot-connectors
crons:screenshot-crons
webhooks:screenshot-webhooks
connection:screenshot-connection
plugins:screenshot-plugins
'
# No browser:screenshot-browser — see tour.sh: that page cannot be captured
# headlessly (WebRTC never negotiates), so it would publish a blank placeholder.

copy() { # src dst size
  if [ -n "$WRITE" ]; then
    cp "$1" "$2"
    printf '  wrote   %-38s %s\n' "$2" "$3"
  else
    printf '  would write %-34s %s\n' "$2" "$3"
  fi
}

# A screenshot of a flat UI uses far fewer than 16 million colours, and a
# truecolour PNG of one is mostly wasted bytes — palettising at 256 takes these
# down by about two thirds with no visible difference, text and all. Worth it
# at 2x, where the files are large enough to notice on a clone.
quantize() { # src dst
  python3 - "$1" "$2" <<'PYQ'
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
im.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).save(dst, optimize=True)
PYQ
}

echo "→ docs/"
for theme in dark light; do
  sfx=''
  [ "$theme" = 'dark' ] || sfx='-light'
  for pair in $MAP; do
    src="$SHOTS/$theme/${pair%%:*}.png"
    dst="$DOCS/${pair##*:}$sfx.png"
    [ -f "$src" ] || { printf '  skip    %-38s (no %s)\n' "$dst" "$src"; continue; }
    if [ -n "$WRITE" ]; then
      quantize "$src" "$dst"
      printf '  wrote   %-38s %s (from %s)\n' "$dst" "$(du -h "$dst" | cut -f1)" "$(du -h "$src" | cut -f1)"
    else
      printf '  would write %-34s (from %s)\n' "$dst" "$src"
    fi
  done
done

for f in demo.gif demo.webm demo.mp4 demo-light.gif demo-light.webm demo-light.mp4; do
  if [ -f "$OUT/$f" ]; then
    copy "$OUT/$f" "$DOCS/$f" "$(du -h "$OUT/$f" | cut -f1)"
  else
    printf '  skip    %-38s (no %s)\n' "$DOCS/$f" "$OUT/$f"
  fi
done

[ -n "$WRITE" ] || echo $'\n(dry run — pass --write to copy)'
