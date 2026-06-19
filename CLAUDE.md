# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static D3.js single-page site that scatter-plots MLB batting and pitching statistics and highlights the 2-D Pareto frontier (the "limits"). Deployed via GitHub Pages from the repo root (`.nojekyll` present); no build step, bundler, or `package.json` — `index.html` loads D3 from a CDN and includes `script.js` / `styles.css` directly.

The same code also packs into a self-contained `dist/index.html` with all data inlined, for offline / remote sessions.

## Data sources & license

All stats come from the [SABR Lahman Baseball Database](https://sabr.org/lahman-database/) (1871–2025 release) under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). The derived CSVs in `data/` and the binary blobs inlined in `dist/index.html` inherit that license; the source code is MIT (see `LICENSE`). Full text in `LICENSE-DATA.md`.

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

The bundler patches `script.js` with three regex swaps: `d3.csv("data/batting_limits_*.csv")` → `decodeBatting()`, `d3.csv("data/pitching_limits_*.csv")` → `decodePitching()`, and `d3.csv("data/people_lahman_*.csv")` → `Promise.resolve(null)`. If you rename a CSV path in `script.js`, update the matching regex in `build_bundle.py`. The binary blob format (BL2D v4, little-endian columnar with name/team/people dictionaries) is fully specified in `scripts/build_bundle.py`.

## Headless verification (`scripts/snap.js`)

`node scripts/snap.js <url> <out.png> <width> <height> [waitMs] [evalJS]` renders a page at an exact viewport via CDP. Page `console.log` is forwarded to stderr as `[page log] …`; pass an async IIFE as the last arg to run JS before the screenshot. No external npm deps.

```
node scripts/snap.js "http://localhost:8000/#m=season&lg=ALL" /tmp/desktop.png 1440 900 2500
node scripts/snap.js "http://localhost:8000/#m=season&lg=ALL" /tmp/phone.png 390 844 2500 \
  'document.getElementById("controls-toggle").click()'
node scripts/snap.js "file://$PWD/dist/index.html#m=career&lg=AL" /tmp/al-career.png 1600 900 2500
```

**Full-GPU graph (G-track) frames need `scripts/snap-gpu.js`, not `snap.js`.** Under headless
Chrome the WebGPU backend can't configure a visible canvas (SwiftShader), so the G-track
renders to an OFFSCREEN texture that `Page.captureScreenshot` can't see — `snap.js` would show
only the SVG layer. `snap-gpu.js` forces the GPU path and writes the app's
`__bl2d_exportDataURLs()` offscreen readback to PNG, plus prints the `__bl2d_verifyGraph`
invariants. The G-track engages only in STATIC views (no `pbpEvt`), so use the `file://` bundle
(no stat layer → static) with `?webgpuHeadless=1&gpugraph=1`:
```
python3 scripts/build_bundle.py
node scripts/snap-gpu.js "file://$PWD/dist/index.html?webgpuHeadless=1&gpugraph=1#m=career&ds=pitching&x=ERA&y=SO" /tmp/g.png 1440 900 3500
# stderr: [verifyGraph] {…glyphMis:0,tickMis:0,radiusMis:0,…}
```

**One-run G-track parity matrix (`__bl2d_verifyGraphMatrix`)** — instead of one-off `verifyGraph`
combos, drive the whole invariant sweep across ~15 representative dataset/mode/axis/depth/toggle
combos in one shot. Normal run must be ALL-GREEN; the `?matrixPerturb=1` negative control must FAIL:
```
node scripts/snap-gpu.js "file://$PWD/dist/index.html?webgpuHeadless=1&gpugraph=1" /tmp/m.png 1440 900 4500 \
  '(async()=>{ const r = await window.__bl2d_verifyGraphMatrix(); console.log("MATRIX "+JSON.stringify({allGreen:r.allGreen,fails:r.fails})); })()'
# stderr: MATRIX-SUMMARY ALL-GREEN 15/15 pass   (append &matrixPerturb=1 → FAILED 0/15)
```

The full set of dev/verification URL hatches (`?renderer=canvas`, `?gpugraph=0`, `?gpustream=0`,
`?gpuonly=1`, `?webgpuHeadless=1`, `?legacyPresent=0`, `?verifyFrontier=1`, `?deviceLossTest=1`,
`?matrixPerturb=1`) is tabulated in [`docs/rendering.md`](docs/rendering.md) §"G6f" — none is a
user-facing toggle.

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
- **ERA / WHIP / BB/9 / H/9 frontiers point the "right" way now.** The sweep is sign-aware: `lowerIsBetter` stats flip `xSign`/`ySign` so the frontier finds the correct (low) limit, and the Best/Worst toggle flips both signs deliberately. (An older note here claimed lower-is-better stats highlighted the worst seasons — that predates the sign-aware sweep.)
- **The header `console.log` from `script.js` doesn't reach `scripts/snap.js`'s capture in some headless setups** (Runtime per-execution-context quirk). For debug diagnostics, expose state on `window.__bl2d_*` and read it via `snap.js`'s evalJS argument.

## Working methodology

Tasks in this repo span trivial CSS to multi-objective-optimization algorithms. To keep model cost and turnaround proportional to difficulty, classify the task into a tier first, then pick the model + agent + verification recipe from the table below. Use the cheapest tier the task fits — Tier 1 work does not need Opus.

**Apply this to every task, not just the listed backlog.** Bug reports, refactors, performance work, ad-hoc requests, and tasks that arrive mid-session all get tiered using the same signals. The backlog at the bottom is illustrative — a reference of how the rules cash out on already-known work — not the universe of taskable items.

### Classifying a new task

Run this rubric on every incoming task (including bug reports and mid-session pivots) before doing anything else. Score each signal; the **highest tier whose signal matches** wins. Ties go up.

| Tier | Signal — "this task…"                                                                                                                              | Examples (not the only members)                                       |
|------|-----------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------|
| T0   | …touches ≤1 file, ≤5 net lines, no new abstraction, no logic decision (rename, typo, copy edit, single CSS rule, dependency version bump)           | Fix a typo in a tooltip; bump D3 from 7.8 to 7.9; change a hex color  |
| T1   | …touches ≤2 files, adds behavior local to one feature/UI region, follows a pattern already in the codebase, no new algorithm                        | One-file bug fix; add a key handler; add a tooltip; rename a public symbol with grep |
| T2   | …touches 3–5 files (or one large file across multiple sections), integrates a library or pattern in a new region, "what to build" clear, "how" templated by existing code | Cross-file refactor; new chart layer; new preset; library swap; non-trivial bug spanning the chart + bundler |
| T3   | …requires designing or deriving an algorithm/formula/invariant; correctness depends on math, geometry, or statistics; edge cases must be reasoned about, not just copied | New frontier metric; performance optimization needing complexity analysis; security fix requiring threat-model reasoning |
| T4   | …rewrites a layer's contract (render pipeline, binary format, build system) or changes an interface used by multiple modules                        | Canvas migration; BL2D format bump; switch the data pipeline; replace the bundler |

**When classification is ambiguous:**

- **Mixed-tier task** (UI part T1, algorithm part T3): the tier is the max. Split into two sessions if the parts are independent.
- **Unclear scope** (user says "improve performance"): ask via `AskUserQuestion` to nail down which subsystem before tiering.
- **Mid-flight escalation** (T1 turned out to need an algorithm): stop, state the new tier and why, switch model, restart the agent strategy. Don't quietly Opus your way through what was billed as T1.
- **Non-code tasks** (code review, explain-this-code, write a PR description): the methodology doesn't apply — these aren't tier-shaped. Just answer.

The assistant's first reply to any task must contain: `Tier: TX — <one-line reason naming the deciding signal>.` That line is what the audit script greps for; without it, the session is `untagged — skipped` in compliance reports.

### Tier table

| Tier | Shape of task                                                                 | Main model | Required agents (invocation mechanism)                                                                                          | Verification floor                                                                 |
|------|-------------------------------------------------------------------------------|------------|---------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------|
| T0   | Typo / single-line copy edit / one CSS rule / variable rename in one file     | Haiku 4.5  | None — direct edit. No `@`-mention needed.                                                                                       | Read the diff. If visible, one `snap.js` shot at 1440×900.                          |
| T1   | Single-file additive UI (tooltip, key handler, sparkline, typeahead)          | Sonnet 4.6 | Optional `Explore` only if call sites unclear (assistant decides via Agent tool).                                                | `snap.js` before/after at 1440×900 **and** 390×844 + one manual browser interaction |
| T2   | Multi-region change following an existing pattern (new chart layer, animation, new color encoding, new preset, library integration) | Sonnet 4.6 | **Required**: `@"Plan (agent)"` in opening prompt. Optional `@"Explore (agent)"` if scope >3 files.                              | `snap.js` at desktop + mobile in ≥2 states (default + new toggle); URL-hash deep-link round-trips; manual interaction |
| T3   | Algorithmic / mathematical work (new metric on frontier, era-normalization, curvature, hypervolume, convex-hull classification) | Opus 4.7   | **Required**: `@"Plan (agent)"` + explicit "use Opus" instruction so the assistant passes `model: "opus"` on the Agent call. Plus `@"Explore (agent)"` for recon. | All T2 checks **plus** algorithmic invariants (see below) **plus** spot-check against ≥2 known records |
| T4   | Architecture / cross-cutting (Canvas migration, BL2D format bump, new data pipeline) | Opus 4.7 (Fast mode useful) | **Required**: launch with `claude --agent Plan` **or** open with `@"Plan (agent)"`; instruct assistant to pass `model: "opus"` and `isolation: "worktree"` on the implementation Agent call; parallel `@"Explore (agent)"` recon. | All T3 checks **plus** full viewport suite (1440×900, 1600×900, 390×844 panel open/closed) **plus** bundle decode count == CSV row count **plus** rendering-perf smoke via `snap.js` evalJS |

**Rule of thumb for the main session:** start every chat on Sonnet 4.6. Escalate to Opus 4.7 only when entering a T3/T4 block. Drop to Haiku 4.5 for a string of T0 tasks. Use `/model` to switch mid-session.

**Rule of thumb for agents:** the `model` parameter on `Agent` overrides the agent's default. Pass `model: "haiku"` for pure search/locate tasks, `model: "sonnet"` for typical Plan work, `model: "opus"` only when the agent itself must reason about an algorithm. Cold-start cost is the same regardless of model, so for ≤2 lookups skip the agent and `grep`/`Read` directly.

### Agent-selection rules

1. **No agent (default for T0/T1).** Cold-start cost is real. If you know the file and the change is local, edit directly.
2. **`Explore` subagent** — read-only multi-file search. Use when locating call sites across `script.js` (88 KB) + `scripts/build_bundle.py` + `index.html` would take >3 grep/read iterations. Never use for code review or cross-file consistency checks (it reads excerpts, not whole files).
3. **`Plan` subagent** — required for T2+ before implementation. Brief it with the tier, the affected files, the verification recipe, and the existing patterns to reuse.
4. **`general-purpose` subagent** — only when the task needs both research and writes and doesn't fit `Plan`. Rare here.
5. **Parallel agents** — for T3/T4, dispatch up to 3 `Explore` agents in one message (one per code region: chart code, data pipeline, bundler) to amortize wall-clock.
6. **Worktree isolation** — for T4 only, pass `isolation: "worktree"` so the architecture experiment can't disturb a clean tree until the diff is reviewed.

### Verification protocols (mandatory)

The project ships with no tests or type checker. These are the substitute. Every PR-sized change must run the floor for its tier; skipping is not allowed.

**UI changes (T0 visible / T1 / T2 / T3 / T4):**

```bash
# Start a server if not running
python3 -m http.server 8000 &
SERVER_PID=$!

# Baseline BEFORE editing — capture the state(s) the change will touch
node scripts/snap.js "http://localhost:8000/#m=season&lg=ALL" /tmp/before-desktop.png 1440 900 2500
node scripts/snap.js "http://localhost:8000/#m=season&lg=ALL" /tmp/before-mobile.png 390 844 2500 \
  'document.getElementById("controls-toggle").click()'

# ... make changes ...

# After
node scripts/snap.js "http://localhost:8000/#m=season&lg=ALL" /tmp/after-desktop.png 1440 900 2500
node scripts/snap.js "http://localhost:8000/#m=season&lg=ALL" /tmp/after-mobile.png 390 844 2500 \
  'document.getElementById("controls-toggle").click()'

# Inspect both before/after pairs; open browser to interact with the change
open http://localhost:8000

kill $SERVER_PID
```

Send the before/after screenshots to the user with `SendUserFile` in the same turn — never wait to be asked.

**Data-pipeline changes (T2+ on `scripts/convert_csv_lahman*.py` or `_display_name.py`):**

```bash
# Pin the inputs and outputs
INPUT_PREV=data/batting_limits_1871-2025.csv

# Capture baseline
wc -l "$INPUT_PREV" > /tmp/rows-before.txt
md5 -q "$INPUT_PREV" > /tmp/md5-before.txt   # macOS; use md5sum on Linux

# ... rerun the conversion ...

wc -l "$INPUT_PREV" > /tmp/rows-after.txt
md5 -q "$INPUT_PREV" > /tmp/md5-after.txt
diff /tmp/rows-before.txt /tmp/rows-after.txt
diff /tmp/md5-before.txt  /tmp/md5-after.txt
```

State explicitly in the report whether the diff is expected (e.g., "additive new season → +N rows, md5 changes") or a regression.

**Bundle integrity (T2+ touching `scripts/build_bundle.py` or anything `script.js` regex-swap depends on):**

```bash
python3 scripts/build_bundle.py
ls -la dist/index.html   # expect ~3.9 MB

# Decoded row count must match CSV row counts.
# Add a one-time exposure in script.js for verification:
#   window.__bl2d_battingRows = battingPoints.length;
#   window.__bl2d_pitchingRows = pitchingPoints.length;
node scripts/snap.js "file://$PWD/dist/index.html" /tmp/bundle.png 1440 900 3000 \
  '(async () => { await new Promise(r => setTimeout(r, 2500)); return JSON.stringify({b: window.__bl2d_battingRows, p: window.__bl2d_pitchingRows}); })()'
# Compare against `wc -l` of the source CSVs minus 1 (header).
```

**Algorithmic invariants (T3):** every new metric must come with at least one invariant that can be asserted, even informally:

- **Pareto depth:** layer `i+1` is the Pareto frontier of (all points − ⋃ layers ≤ i).
- **Hypervolume:** monotonic non-decreasing as the year range widens.
- **Hypervolume contribution:** Σ contributions ≤ total hypervolume; the highest-contribution point's removal strictly decreases hypervolume.
- **Era-normalized:** Bonds 2002 OPS+ ≈ 268, Pedro 2000 ERA+ ≈ 291 — spot-check ±5%.
- **Frontier longevity:** Henderson 1982 SB = 130 must be on the frontier with year-held > 40.
- **Convex hull vs concave:** the convex-hull subset is itself a valid Pareto frontier.

Expose intermediate state on `window.__bl2d_*` and read it via `snap.js` evalJS — that's the project's standard for headless diagnostics (see "Things that look like bugs but aren't" above).

### Reproducible-steps template

For every task, follow this script. Deviations require a written reason in the response.

1. **Classify.** State the tier and quote the row from the tier table.
2. **Set the main model.** `/model` to the tier's main model if not already there.
3. **Open the prompt with the right invocation token.** This is the load-bearing step — natural language is not enough.
   - T0/T1: `Tier: T0|T1 — <task>` (no `@`-mention required).
   - T2: `@"Plan (agent)" Tier: T2 — <task>` — the `@` guarantees Plan is invoked once.
   - T3: `@"Explore (agent)" first map <regions>, then @"Plan (agent)" use Opus to design <task>. Tier: T3.` — two `@`-mentions, plus an instruction so the assistant passes `model: "opus"` on the Plan Agent call.
   - T4: `claude --agent Plan` to launch, or open with `@"Plan (agent)"` and add `pass isolation: "worktree"` on implementation. Tier: T4.
4. **Explore (if not already covered by step 3).** T0/T1: read the named files directly. T2: one `Explore` agent if scope unclear. T3/T4: already triggered via the opening `@`-mention.
5. **Baseline capture.** Run the tier's verification floor BEFORE any edit to capture the baseline (screenshots, row counts, md5s).
6. **Implement.** Scope edits to the files identified; do not opportunistically refactor.
7. **Re-verify.** Re-run the same verification commands. Diff the artifacts.
8. **Surface artifacts.** `SendUserFile` for screenshots / decoded outputs in the same turn they're produced.
9. **Stop.** Do not commit unless asked.

### When to deviate

These rules exist to keep effort proportional, not to be a straitjacket. Drop down a tier when the task turns out smaller than expected; escalate when a "simple" change turns out to touch the Pareto algorithm or the binary format. State the deviation explicitly in the response so the next session can see what changed and why.

### Tracking what's shipped (README is the source of truth)

The `## Ideas & future work` section in `README.md` uses GitHub task-list syntax: `- [ ]` for open items and `- [x] *(shipped <sha>)*` for shipped ones. **In the same commit that ships, moots, or partially-discards a backlog item, update its README entry.** This is mandatory, not advisory:

- **Shipped**: flip `- [ ]` to `- [x]` and append `*(shipped <commit-sha>)*` after the bold name. Use the SHA from the commit doing the work (use the first 7 chars).
- **Design-only progress**: keep `- [ ]` and append `*(Design in [`docs/<file>.md`](docs/<file>.md); implementation pending.)*` so the next session can pick up the design and ship.
- **Discarded / partial attempt**: keep `- [ ]` and append a parenthetical explaining what was tried, what didn't work, and what the holistic next attempt needs to address. Future-you should not re-fall into the same partial trap.
- **New ideas surfaced during work**: add as `- [ ]` bullets under the most relevant subsection, or under "Methodology infrastructure follow-ups" if they're about the methodology itself.

The README is the single source of truth for "what's done". The pre-tiered backlog table in this file is illustrative; if it diverges from the README, the README wins.

### Validating the methodology

**Session tagging** — the first line of every task session must be `Tier: TX — <one-line reason>`. The audit script at `scripts/methodology_audit.py` greps for this to label sessions and check compliance. Run it with:

```bash
python3 scripts/methodology_audit.py --since 2026-05-29 --pricing ~/.claude/pricing.json
```

See `scripts/methodology_pricing.example.json` for the pricing schema. Full audit tooling and pilot runner docs are in the script headers.

## Git / deployment

`main` is the deployed branch — pushing to `main` updates the live GitHub Pages site. There is no staging environment. The bundle in `dist/` is gitignored and not part of the deployed site (production serves the multi-file `index.html` + `script.js` + `styles.css` + `data/*.csv` directly).

When you regenerate the bundle locally, the dev-site behavior should remain identical to production — they share `script.js` verbatim except for the three regex swaps the bundler applies.
