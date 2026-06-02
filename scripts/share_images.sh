#!/usr/bin/env bash
# Mint share images for Baseball Limits 2D by rendering the curated deep-links
# (see docs/sharing-playbook.md) through scripts/snap.js.
#
#   - One 1440x900 PNG per curated view  -> /tmp/share-<name>.png
#   - One 1200x630 social card           -> og-image.png  (repo root, committed)
#
# Requires a local server (so d3.csv can fetch from data/):
#   python3 -m http.server 8000 &
#   scripts/share_images.sh [BASE_URL] [OUT_DIR]
#
# BASE_URL defaults to http://localhost:8000 ; OUT_DIR defaults to /tmp.
set -euo pipefail

BASE="${1:-http://localhost:8000}"
OUT_DIR="${2:-/tmp}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SNAP="$HERE/snap.js"
ROOT="$(cd "$HERE/.." && pwd)"
WAIT=2800
# Dismiss the first-visit welcome modal so the chart is visible in the shot.
DISMISS='document.getElementById("explainer-dismiss")?.click()'

# name|hash  (hash includes the leading #; empty = default view)
VIEWS=(
  "career-power-speed|#m=career"
  "hr-vs-avg|#x=HR&y=AVG"
  "3b-vs-hr|#x=3B&y=HR"
  "obp-vs-slg|#x=OBP&y=SLG"
  "pitching-career|#ds=pitching&m=career"
  "pitching-k9-era|#ds=pitching&x=K/9&y=ERA"
)

echo "Rendering curated views from $BASE -> $OUT_DIR"
for entry in "${VIEWS[@]}"; do
  name="${entry%%|*}"
  hash="${entry#*|}"
  out="$OUT_DIR/share-$name.png"
  echo "  $name  $hash"
  node "$SNAP" "$BASE/$hash" "$out" 1440 900 "$WAIT" "$DISMISS"
done

# Social card: render the default view at the 1200x630 OG standard, into the repo
# root so GitHub Pages serves it at /og-image.png (referenced by index.html).
echo "Rendering og-image.png (1200x630) -> $ROOT/og-image.png"
node "$SNAP" "$BASE/" "$ROOT/og-image.png" 1200 630 "$WAIT" "$DISMISS"

echo "Done."
