# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static D3.js single-page site that scatter-plots MLB batting and pitching statistics and highlights the 2-D Pareto frontier (the "limits"). Deployed via GitHub Pages from the repo root (`.nojekyll` present); no build step, bundler, or `package.json` — `index.html` loads D3 from a CDN and includes `script.js` / `styles.css` directly.

The same code also packs into a self-contained `dist/index.html` with all data inlined, for offline / remote sessions.

## Data sources & license

All stats come from the [SABR Lahman Baseball Database](https://sabr.org/lahman-database/) (1871–2025 release) under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). The derived CSVs in `data/` and the binary blobs inlined in `dist/index.html` inherit that license; the source code is MIT (see `LICENSE`). Full text in `DATA-LICENSE.md`.

No in-progress-season data ships — `README.md` explains the licensing reasons (BBRef terms, MLB Stats API's "non-bulk" restriction). Lahman is updated by SABR roughly once a year; the canonical refresh procedure is in `README.md`.

## Running locally

- **Multi-file (matches production)** — serve over HTTP so `d3.csv()` can fetch from `data/`. `file://` won't work due to CORS.
  ```
  python3 -m http.server 8000   # then open http://localhost:8000
  ```
- **Single-file bundle (no server needed)** — opens with `file://`. Use this for remote/sandboxed sessions.
  ```
  python3 scripts/build_bundle.py   # writes dist/index.html
  open dist/index.html
  ```

## Data pipeline

```
data/Batting.csv                              data/People.csv
data/Pitching.csv (Lahman release)            (Lahman release)
        │                                            │
        ▼                                            ▼
data/batting_lahman_1871-2025.csv      data/people_lahman_1871-2025.csv
data/pitching_lahman_1871-2025.csv
        │                                            │
        │  convert_csv_lahman.py                     │
        │  convert_csv_lahman_pitching.py            │
        ▼                                            │
data/batting_limits_1871-2025.csv                    │
data/pitching_limits_1871-2025.csv                   │
        │                                            │
        │      build_bundle.py reads both, plus      │
        │      people for metaFor lookup ────────────┘
        ▼
dist/index.html (single-file bundle with two BL2D v4 blobs)
```

The converters drop the `stint` column (the bundler aggregates traded-mid-season rows in `aggregate_stints`), strip BBRef-style "NTM" summary rows if present, and rewrite the opaque Lahman `playerID` to a display string via `scripts/_display_name.py` — same-name players get a `(b.YYYY)` suffix to avoid conflating Frank Thomas (b.1929) / (b.1968) / (b.1970), Ken Griffey Sr. / Jr., etc.

`scripts/combine_csv.py` is an older helper kept for the rare case where you want to merge canonical CSVs; not in the default pipeline.

## Single-file bundle

`scripts/build_bundle.py` produces `dist/index.html` containing:
- `vendor/d3.v7.min.js` (committed to the repo; fetch with `curl -sL https://d3js.org/d3.v7.min.js -o vendor/d3.v7.min.js` if missing)
- The original `styles.css`
- A patched copy of `script.js`: three `d3.csv(...)` calls get regex-swapped to in-memory decoders.
- Two base64-encoded gzipped binary blobs (batting + pitching) inlined as constants.

Bundle is ~3.9 MB total, ~20% of the CSV sources combined. Opens with `file://`, fully offline. `dist/` is gitignored.

### Binary format (BL2D v4, little-endian)

One blob per dataset (batting and pitching are built separately, share the format):

```
Header (12 bytes):
  'BL2D' magic | u8 major=4 | u8 minor=0 | u16 year_base | u32 row_count
Column metadata (NEW in v4):
  u8 column_count
  for each col: u8 width (1=u8, 2=u16) | u8 name_len | utf8 name
Name dictionary:        u32 count, then u8 len + utf8 per name
Team dictionary:        u16 count, then u8 lg_len + utf8 + u8 tm_len + utf8
People section:
  Country dict:  u8 count, then u8 len + utf8 per country
  Records:       u32 count, then per player:
                   u16 name_idx | u16 birthYear | u16 debutYear |
                   u8 country_idx (0xFF=unknown) | u8 bats | u8 throws |
                   u8 heightIn | u16 weightLb
Columnar payload:
  name_idx: u16 × N
  year_off: u8 × N      (year - year_base)
  team_idx: u16 × N     (widened to u16 in v3 — Negro Leagues addition
                         pushed unique team count past 256)
  per column from metadata: uX × N    (in declared order)
```

Sentinels `0xFFFF` (u16) / `0xFF` (u8) mark blank counting stats; decoder maps them back to `""` so the existing `parseInt(...)` pipeline in `script.js` produces `NaN`. The v4 column-metadata change lets one decoder serve both datasets — batting and pitching just declare different column sets.

The bundler patches `script.js` with three regex swaps:
- `d3.csv("data/batting_limits_*.csv")` → `decodeBatting()`
- `d3.csv("data/pitching_limits_*.csv")` → `decodePitching()`
- `d3.csv("data/people_lahman_*.csv")` → `Promise.resolve(null)` (bundle's decoder already builds metaFor)

If you rename a CSV path in `script.js`, update the matching regex in `build_bundle.py`.

## Headless verification (`scripts/snap.js`)

`node scripts/snap.js <url> <out.png> <width> <height> [waitMs] [evalJS]` renders a page in headless Chrome at an exact viewport via CDP. Headless Chrome's `--window-size` flag does NOT actually constrain rendering below ~500px — it clamps internally and the resulting screenshot is just a crop of a larger render. `snap.js` works around this by launching Chrome with `--remote-debugging-port`, connecting via Node's built-in WebSocket, and calling CDP `Emulation.setDeviceMetricsOverride` to force the exact width/height/mobile flag. No external npm deps.

Page `console.log` is forwarded to stderr as `[page log] …`. Pass `awaitPromise: true`-friendly JS (e.g. `(async () => { ... })()`) as the optional last arg if you need the eval to finish async work before the screenshot.

Examples:
```
node scripts/snap.js "file://$PWD/dist/index.html" /tmp/desktop.png 1440 900 2500
node scripts/snap.js "file://$PWD/dist/index.html" /tmp/phone.png 390 844 2500
node scripts/snap.js "file://$PWD/dist/index.html#m=career&lg=AL" /tmp/al-career.png 1600 900 2500
node scripts/snap.js "file://$PWD/dist/index.html" /tmp/phone-open.png 390 844 2500 \
  'document.getElementById("controls-toggle").click()'
```

## Layout architecture

- **Mobile-first.** Default state is a column flex: header on top, chart filling, controls collapsed at the bottom behind a "Filters" drawer. At `min-width: 768px`, layout switches to a row: chart left, fixed-width sidebar right, toggle hidden, panel always visible.
- **Sidebar split (desktop).** `.controls-panel` is itself a flex column with two children: `.controls-inputs` (all the controls, scrollable on its own if too tall) and `.frontier-section` (flex-grows to fill the remaining space with `min-height: 220px`, has its own scrollable card list). This keeps the frontier card list visible without losing access to the inputs.
- **Body** uses `display: flex; flex-direction: column` with `overflow: hidden` so the app never scrolls — sub-regions handle their own scrolling. Critical CSS to keep healthy: `min-width: 0` on every flex child, plus `width: 100%` on `.chart-region` so the SVG's intrinsic size doesn't push the layout wider than the viewport.
- **Compact controls.** Stats and Mode share one row at the top; Year Range collapses to a single inline "1920 – 2025" row. See the `@media (min-width: 768px)` block in `styles.css`.
- The chart redraws on a `ResizeObserver` of `.chart-region`, debounced 120ms, so toggling the mobile drawer also resizes the chart cleanly.

## App architecture

### Data flow (script.js)

1. Two parallel `d3.csv()` loads (batting + pitching) → `loadDataset(key)` parses each.
2. `parseBattingRows` / `parsePitchingRows` convert strings to numbers and compute derived stats:
   - Batting: `PA`, `TB`, `AVG`, `OBP`, `SLG`
   - Pitching: `IP` (from `IPouts/3`), `ERA`, `WHIP`, `K/9`, `BB/9`, `K/BB`, `H/9`
3. `buildPlayerIndex(points)` builds a `Map<playerID, Point[]>` per dataset for career-trail lookups.
4. `metaFor(playerID)` — populated either by the bundle's decoder (which packs the people section) or by `buildMetaFromPeopleCsv` from the parallel multi-file CSV load.
5. State + UI handlers wire up; `refreshChart()` reads all selectors and dispatches to `drawScatterPlot()`.

### Dataset switching (`DATASETS` in script.js)

Each entry declares its dimensions, default X/Y, threshold field (`PA` vs `IP`), threshold label, rate-stat set (for formatting), and per-mode slider config. The Stats toggle (`#stats-toggle`) sets `activeDatasetKey`; `populateSelectorsForActive()` rebuilds the axis dropdowns and `applyModeConfig()` rebuilds the slider + presets.

### Frontier algorithm (`drawScatterPlot`)

1. Filter rows by year, league, bats, country (predicate `seasonMatches`).
2. **Career mode**: group filtered rows by `playerID`, aggregate counting stats per `aggregateCareer(seasons, dataset)`, recomputing rate stats from summed components.
3. Apply the threshold filter (PA or IP) on aggregated/raw points.
4. Sort by `(x ascending, y ascending, year descending)`, dedup exact `(x, y)` collisions.
5. **Pareto sweep**: left-to-right, pop any prior point with `y < current.y` (or `y == current.y && x < current.x`). Survivors = frontier.

The tooltip filters the full `filtered` array (not the deduped `unique`), so collisions show all players at that point.

### Click-to-highlight career (B3)

Module-level `careerHighlight` (a playerID) is set by clicking a frontier point in Season mode. `drawScatterPlot` checks `playerIndex.get(careerHighlight)`, plots that player's other seasons in gold with a connecting line. Clearing: click empty chart area, hit Escape, or change any filter. Disabled in Career mode (each dot already IS the career).

### URL state (C4)

All filter/axis state is serialized into the URL hash on every refresh (debounced 120ms via `writeUrlState`). Defaults are omitted to keep the hash compact. `applyUrlState()` runs once at startup before the first render so deep-links land on the right view. The career highlight rides in the hash as `hl=<playerID>`, so sharing a URL with a pinned point preserves it.

### Display encoding (D4)

`colorOf(point, colorBy, getMeta)` picks the dot's fill from the active color encoding: era (default — uses the year), handedness (uses meta.bats), or league (uses lgID). Frontier red and career gold always win — color-by only affects the background cloud. `sizeBy` uses `d3.scaleSqrt` from the chosen stat's min/max into a radius range.

## Player-name disambiguation

`scripts/_display_name.py` builds a map from Lahman playerID → display name. Single-occurrence names stay as `"<first> <last>"`; names that collide for multiple Lahman IDs get a `(b.YYYY)` suffix. Used by both `convert_csv_lahman*.py` (so the canonical CSVs have the disambiguated key) and by `build_bundle.py`'s `load_people` (so people lookups by name match what the chart code holds).

The multi-file fallback `buildMetaFromPeopleCsv` in `script.js` mirrors the same logic so dev mode (no bundle) renders identically.

## Things that look like bugs but aren't

- **Same-named players get a `(b.YYYY)` tag in tooltips and cards.** Slightly verbose but intentional — it's the disambiguator from `_display_name.py`. The on-chart label strips the suffix and shows just the last name via `lastNameOf()`.
- **ERA / WHIP / BB/9 / H/9 on the pitching frontier highlight the WORST seasons.** Those stats are "lower is better" but the frontier algorithm finds the upper-right envelope, so the highest values bubble up. Glossary entries note this; inverting the sweep per-stat is a clean follow-up.
- **The header `console.log` from `script.js` doesn't reach `scripts/snap.js`'s capture in some headless setups** (Runtime per-execution-context quirk). For debug diagnostics, expose state on `window.__bl2d_*` and read it via `snap.js`'s evalJS argument.

## Git / deployment

`main` is the deployed branch — pushing to `main` updates the live GitHub Pages site. There is no staging environment. The bundle in `dist/` is gitignored and not part of the deployed site (production serves the multi-file `index.html` + `script.js` + `styles.css` + `data/*.csv` directly).

When you regenerate the bundle locally, the dev-site behavior should remain identical to production — they share `script.js` verbatim except for the three regex swaps the bundler applies.
