# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static D3.js single-page site that scatter-plots MLB batting stats and highlights the 2-D Pareto frontier (the "limits"). Deployed via GitHub Pages from the repo root (`.nojekyll` is present); there is no build step, bundler, or `package.json` — `index.html` loads D3 from a CDN and includes `script.js` / `styles.css` directly.

## Running locally

Two modes:

- **Multi-file (matches production)** — serve over HTTP so `d3.csv()` can fetch from `data/`. `file://` will not work due to CORS.
  ```
  python3 -m http.server 8000
  # open http://localhost:8000
  ```
- **Single-file bundle (no server needed)** — build a self-contained `dist/index.html` with the dataset packed inline and D3 vendored. Opens with `file://`. Use this for remote/sandboxed sessions where opening a port isn't practical.
  ```
  python3 scripts/build_bundle.py
  open dist/index.html
  ```

## Single-file bundle

`scripts/build_bundle.py` packs the CSV into a custom columnar binary, gzips it, base64-encodes it, and inlines the blob into a copy of `index.html` along with `styles.css` and `vendor/d3.v7.min.js`. Output is ~2.1 MB (vs ~7.3 MB for the CSV) and fully offline-capable.

Binary format (little-endian) is documented at the top of `scripts/build_bundle.py`. Key choices:
- `playerID` dictionary-encoded as u16 (20,521 unique names).
- `(lgID, teamID)` dictionary-encoded as u8 (168 unique pairs).
- `yearID` stored as u8 offset from 1871 (span = 154).
- Stats split by range: u16 for `G AB R H BB SO RBI`, u8 for everything else.
- Columnar layout (all values of one column, then the next) — gives gzip more redundancy than row-interleaved.
- Sentinels `0xFFFF` / `0xFF` for blank counting stats; decoder maps them back to `""` so the existing `parseInt(...)` pipeline in `script.js` continues to produce `NaN` exactly as with d3.csv.

The bundler patches `script.js` with a single regex swap (`d3.csv("data/...")` → `decodeBL()`); everything else is untouched. If you rename the CSV path in `script.js`, update the regex in `build_bundle.py` to match.

`vendor/d3.v7.min.js` is fetched once with `curl -sL https://d3js.org/d3.v7.min.js -o vendor/d3.v7.min.js` and committed (the bundler will exit with instructions if it's missing).

`dist/` is gitignored — it's a build artifact, not the deployed site.

## Headless verification (`scripts/snap.js`)

`node scripts/snap.js <url> <out.png> <width> <height> [waitMs] [evalJS]` renders a page in headless Chrome at an exact viewport. Headless Chrome's `--window-size` flag does NOT actually constrain the rendering viewport below ~500px — it clamps internally and the resulting screenshot is just a crop of a larger render. `snap.js` works around this by launching Chrome with `--remote-debugging-port`, connecting via the built-in Node WebSocket, and calling CDP `Emulation.setDeviceMetricsOverride` to force the exact width/height/mobile flag before screenshotting. No external npm deps.

Examples:
```
node scripts/snap.js "file://$PWD/dist/index.html" /tmp/desktop.png 1440 900 2500
node scripts/snap.js "file://$PWD/dist/index.html" /tmp/phone.png 390 844 2500
# Run JS before the screenshot (e.g. expand mobile controls)
node scripts/snap.js "file://$PWD/dist/index.html" /tmp/phone-open.png 390 844 2500 \
  'document.getElementById("controls-toggle").click()'
```

## Layout architecture

- Mobile-first CSS. Default state is a column flex (header on top, chart filling, controls collapsed at the bottom behind a "Filters" toggle).
- At `min-width: 768px`, layout switches to a row: chart left, fixed-width sidebar right, toggle hidden, panel always visible (the `.collapsed` class is overridden to `display: flex`).
- Body uses `display: flex; flex-direction: column` with `overflow: hidden` so the app never scrolls — sub-regions handle their own scrolling. Critical CSS to keep healthy: `min-width: 0` on every flex child, plus `width: 100%` on `.chart-region` to prevent SVG intrinsic size from pushing the layout wider than the viewport.
- The chart redraws on a `ResizeObserver` of `.chart-region`, debounced 120ms, so toggling the mobile controls also resizes the chart cleanly.

## Data pipeline

The browser only ever reads `data/batting_limits_1871-2024.csv`. Everything else under `data/` is source or intermediate. To refresh after a new season:

1. Download standard batting from Baseball Reference to `data/batting_bbref_<YEAR>.csv`.
2. Convert to the canonical schema:
   ```
   python3 scripts/convert_csv_bbref.py data/batting_bbref_<YEAR>.csv data/batting_limits_<YEAR>-<YEAR>.csv <YEAR>
   ```
3. Concatenate with the historical Lahman-derived file:
   ```
   python3 scripts/combine_csv.py data/batting_limits_1871-2023.csv data/batting_limits_<YEAR>-<YEAR>.csv data/batting_limits_1871-<YEAR>.csv
   ```
4. Update the `d3.csv(...)` path in `script.js:1` and the footer year range in `index.html` to match the new combined file.

`scripts/convert_csv_lahman.py` is only used to regenerate `batting_limits_1871-2023.csv` from raw Lahman dumps (`batting_lahman_*.csv` + `people_lahman_*.csv`); it is not part of the per-season refresh.

The canonical CSV schema is the `fieldnames` list in `scripts/convert_csv_bbref.py:39`. `combine_csv.py` asserts both inputs share that exact header — keep BBRef and Lahman converters in sync if you add columns.

## Architecture notes

- **Derived stats live in JS, not CSV.** `PA`, `TB`, `AVG`, `OBP`, `SLG` are computed in the second `.then(...)` of `script.js` from the raw counting stats. To expose a new dimension in the dropdowns, compute it there and add it to the `dimensions` array in the third `.then`.
- **"Special points" = upper-right Pareto frontier.** `drawScatterPlot` in `script.js` sorts points ascending by `(x, y, -year)`, dedups exact `(x, y)` collisions (keeping the most recent year), then sweeps left→right popping any prior point with `y < current.y` (or `y == current.y && x < current.x`). The survivors are the frontier — drawn red and connected by line segments. Tie-breaking on `year` is why two players with identical stats show only the more recent one as a circle, but the tooltip still lists all of them (the tooltip filters `filteredPoints`, not `uniquePoints`).
- **No persisted UI state.** Every selector change calls `refreshChart()`, which re-runs filter + frontier from scratch on the full in-memory array. Window resize also triggers a full redraw.
- **Default view.** x=HR, y=SB, start year clamped to `max(1920, earliest)` (live-ball era), end year = latest available.

## Things that look like bugs but aren't (or are intentional)

- `script.js:9-10` sets `teamID` twice — harmless duplicate, not a typo to "fix" silently.
- `playerID` for post-2023 rows is the full player name (BBRef has no stable ID); pre-2024 rows use Lahman's `<first> <last>` joined string. Don't assume it's a key.

## Git / deployment

`main` is the deployed branch — pushing to `main` updates the live GitHub Pages site. There is no staging environment.
