#!/usr/bin/env bash
# Assembles the page screenshots into the tour GIF used by the README and the
# landing page.
#
#   bash demo/record/shots.sh              # the frames
#   bash demo/record/tour.sh               # → out/demo.gif + demo.webm/.mp4
#   THEME=light bash demo/record/tour.sh   # → out/demo-light.*
#
# Stills crossfaded into each other, rather than a continuous screen recording:
# each page gets a predictable moment on screen, re-shooting one page does not
# mean re-performing the whole tour, and the result is a fraction of the size.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

THEME="${THEME:-dark}"
SHOTS="demo/record/out/shots/$THEME"
OUT='demo/record/out'
suffix=''
[ "$THEME" = 'dark' ] || suffix="-$THEME"
GIF="$OUT/demo$suffix.gif"
VIDEO_W="${VIDEO_W:-1920}"

# The GIF is for the README, where GitHub will not reliably play a
# repo-relative <video>. The site gets the same take as a video instead: at
# 1920 wide it is under a megabyte, where the equivalent GIF is over five.
WIDTH="${WIDTH:-1440}"
HOLD="${HOLD:-1.6}"     # seconds each page is fully on screen
# Crossfades dominate the file size — every pixel changes on every fade frame,
# so a GIF's delta compression has nothing to work with there while a held
# still costs almost nothing. 0.3s still reads as a dissolve; 0.6s doubled the
# output for no more legibility.
FADE="${FADE:-0.3}"
FPS="${FPS:-10}"
COLORS="${COLORS:-64}"

# Order of the tour. Each must exist in $SHOTS as <name>.png; missing ones are
# skipped with a warning so a partial capture still assembles.
# `browser` is deliberately absent: the Chromium container streams its screen
# over WebRTC, and that never negotiates inside headless Playwright, so the
# capture is a white "Waiting for stream…" placeholder rather than a browser.
# The page is fine in a real browser on localhost or behind HTTPS — it is the
# capture that cannot see it. Shoot that one by hand if you want it.
SCENES=(home chat app image code connectors crons connection plugins)

present=()
for s in "${SCENES[@]}"; do
  if [ -f "$SHOTS/$s.png" ]; then present+=("$s"); else echo "  (skipping $s — no $SHOTS/$s.png)" >&2; fi
done
[ "${#present[@]}" -ge 2 ] || { echo 'need at least two scenes' >&2; exit 1; }

# Each still becomes a clip of HOLD+FADE, because xfade consumes FADE seconds
# of the outgoing clip; without the extra the last frames get eaten and the
# page is never fully still on screen.
clip=$(awk -v h="$HOLD" -v f="$FADE" 'BEGIN{print h+f}')

inputs=()
for s in "${present[@]}"; do inputs+=(-loop 1 -t "$clip" -i "$SHOTS/$s.png"); done

# Normalise every input first: the shots are all the same size today, but one
# re-shot at a different viewport would otherwise fail the xfade with a size
# mismatch rather than just looking wrong.
filter=''
for i in "${!present[@]}"; do
  filter+="[$i:v]scale=$WIDTH:-2:flags=lanczos,setsar=1,fps=$FPS,format=yuv420p[v$i];"
done

# Chain the crossfades: v0×v1 → x1, x1×v2 → x2, …
# Each clip runs HOLD+FADE, and every xfade eats FADE of the outgoing one, so
# a completed scene advances the timeline by exactly HOLD. The i-th transition
# therefore begins at i*HOLD.
prev='v0'
for (( i=1; i<${#present[@]}; i++ )); do
  offset=$(awk -v h="$HOLD" -v i="$i" 'BEGIN{printf "%.3f", i*h}')
  out="x$i"
  filter+="[$prev][v$i]xfade=transition=fade:duration=$FADE:offset=$offset[$out];"
  prev="$out"
done

echo '→ assembling…'
ffmpeg -y -loglevel error "${inputs[@]}" \
  -filter_complex "${filter%;}" -map "[$prev]" -an "$OUT/tour$suffix.mp4"

echo '→ converting to gif…'
gf="fps=$FPS,scale=$WIDTH:-1:flags=lanczos"
ffmpeg -y -loglevel error -i "$OUT/tour$suffix.mp4" -vf "$gf,palettegen=max_colors=$COLORS:stats_mode=diff" "$OUT/palette.png"
ffmpeg -y -loglevel error -i "$OUT/tour$suffix.mp4" -i "$OUT/palette.png" \
  -lavfi "$gf[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" "$GIF"
rm -f "$OUT/palette.png"

echo '→ encoding video…'
# Retina for the site. yuv420p + faststart because anything else refuses to
# play in one browser or another; the webm is the smaller of the two and the
# mp4 is the Safari fallback.
MP4="$OUT/demo$suffix.mp4"
WEBM="$OUT/demo$suffix.webm"
vf="fps=$FPS,scale=$VIDEO_W:-2:flags=lanczos"
ffmpeg -y -loglevel error -i "$OUT/tour$suffix.mp4" -vf "$vf,format=yuv420p" \
  -c:v libx264 -crf 26 -preset slow -movflags +faststart -an "$MP4"
ffmpeg -y -loglevel error -i "$OUT/tour$suffix.mp4" -vf "$vf" \
  -c:v libvpx-vp9 -crf 38 -b:v 0 -row-mt 1 -an "$WEBM"

rm -f "$OUT/tour$suffix.mp4"

secs=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$GIF" | cut -d. -f1)
echo "  $GIF   ($(du -h "$GIF" | cut -f1), ${WIDTH}px, ${secs}s, ${#present[@]} scenes)"
echo "  $WEBM  ($(du -h "$WEBM" | cut -f1), ${VIDEO_W}px)"
echo "  $MP4   ($(du -h "$MP4" | cut -f1), ${VIDEO_W}px)"
