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

# For the social card: dismiss the modal, then overlay a headline + call-to-action
# banner along the bottom (social-card best practice — gives the unfurl a clear
# headline and CTA rather than a bare screenshot).
OG_OVERLAY='(async()=>{document.getElementById("explainer-dismiss")?.click();await new Promise(r=>setTimeout(r,600));var o=document.createElement("div");o.style.cssText="position:fixed;left:0;right:0;bottom:0;padding:26px 44px;display:flex;align-items:center;justify-content:space-between;gap:28px;background:linear-gradient(to top, rgba(0,45,114,0.97), rgba(0,45,114,0.82) 55%, rgba(0,45,114,0));z-index:99999;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;box-sizing:border-box;";o.innerHTML="<div style=\"color:#fff;font-size:32px;font-weight:800;line-height:1.12;max-width:780px;text-shadow:0 1px 4px rgba(0,0,0,.35)\">The outer edge of 150 years of MLB stats</div><div style=\"flex-shrink:0;background:#fff;color:#002d72;font-size:21px;font-weight:700;padding:13px 24px;border-radius:999px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25)\">Explore the frontier &#8594;</div>";document.body.appendChild(o);await new Promise(r=>setTimeout(r,200));})()'

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
node "$SNAP" "$BASE/" "$ROOT/og-image.png" 1200 630 "$WAIT" "$OG_OVERLAY"

echo "Done."
