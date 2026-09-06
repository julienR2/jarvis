#!/usr/bin/env bash
# Assembles the static landing page into site/_site/.
# Images live in docs/ (they're the README's too) — they are copied, not duplicated in git.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
out="$here/_site"

rm -rf "$out"
mkdir -p "$out/assets"

cp "$here/index.html" "$here/styles.css" "$here/app.js" "$here/og.html" "$out/"
cp "$root"/docs/*.png "$root"/docs/*.gif "$out/assets/"
cp "$root"/frontend/public/images/jarvis_wave.png "$out/assets/"

echo "built → $out"
