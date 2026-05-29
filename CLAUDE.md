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

### Guaranteeing subagent invocation

Per Claude Code's [subagent docs](https://code.claude.com/docs/en/sub-agents#invoke-subagents-explicitly), there are three escalating patterns for invoking a subagent — only the latter two are guaranteed:

> - **Natural language**: name the subagent in your prompt; Claude decides whether to delegate
> - **@-mention**: guarantees the subagent runs for one task
> - **Session-wide**: the whole session uses that subagent's system prompt, tool restrictions, and model via the `--agent` flag or the `agent` setting

For this methodology, **natural-language hints are forbidden whenever the tier table mandates a specific agent.** Use these patterns instead:

| Pattern                            | When to use                                    | How                                                                                                |
|------------------------------------|------------------------------------------------|----------------------------------------------------------------------------------------------------|
| `@"<Agent> (agent)"` opening token | T2+ tasks where the Plan agent is mandatory   | Type `@`, pick the subagent from the typeahead, then write the task prompt — e.g. `@"Plan (agent)" Tier: T3 — design Pareto onion-peeling...` |
| `claude --agent Plan`              | T3/T4 sessions you want fully driven by Plan  | Launch the session with `--agent Plan`; the entire main loop runs in that agent's config          |
| Multiple `@`-mentions in one prompt| T3/T4 where you also want Explore upfront     | `@"Explore (agent)" map the call sites of drawScatterPlot, then @"Plan (agent)" design the change`|

Within a tool call the assistant initiates (e.g. `Agent({ subagent_type: "Plan", model: "opus", ... })`), invocation is guaranteed by the tool call itself — `subagent_type` selects the agent and `model` overrides the agent's default model. The audit script counts these tool-use entries to verify the right agent actually ran (not just that its name appeared in conversation).

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

### Pre-tiered backlog (from README "Ideas & future work") — illustrative

This table is a worked example of the classification rubric applied to the README's known follow-ups. It is **not** the canonical list of taskable items — any incoming task (bug fix, refactor, ad-hoc request, new idea) gets tiered by the rubric above, not by lookup here. Add a row when something useful recurs.

| #  | Idea                                                  | Tier | Notes                                                                 |
|----|-------------------------------------------------------|------|-----------------------------------------------------------------------|
| 1  | Dark mode                                             | T0   | CSS variables + one `@media (prefers-color-scheme: dark)` block       |
| 2  | Reduced-motion support                                | T0   | `@media (prefers-reduced-motion)` + guard around frontier animation   |
| 3  | Axis-label glossary tooltips                          | T1   | Reuse glossary content; hover on `.axis-label`                        |
| 4  | Sparklines in frontier cards                          | T1   | Inline SVG; reuse `playerIndex` per-player season array               |
| 5  | Player search typeahead                               | T1   | Autocomplete over `playerIndex` keys; pin `careerHighlight` on select |
| 6  | Keyboard navigation across frontier points            | T1   | Arrow keys + Enter/Escape on the chart-region focus                   |
| 7  | "Almost frontier" 5% band                             | T2   | Second sweep with relaxed dominance test; new translucent layer       |
| 8  | Pareto dominance count per season                     | T2   | O(N²) precompute on filtered set; tooltip-only render                 |
| 9  | Kernel density contour lines                          | T2   | `d3-contour` add; new SVG layer behind the cloud                      |
| 10 | Voronoi overlay for frontier points                   | T2   | `d3-delaunay`; toggleable layer                                       |
| 11 | Animated transitions on filter change                 | T2   | D3 join with `.transition()` in `drawScatterPlot`                     |
| 12 | World map birthplace view                             | T2   | New companion SVG; reuses meta country data                           |
| 13 | Interactive guided tour                               | T2   | Hand-rolled tooltip-chain or Shepherd.js; CDN-loaded                  |
| 14 | Negro Leagues spotlight mode                          | T2   | New league preset + `colorOf` branch                                  |
| 15 | Frontier longevity / years held                       | T3   | Cross-year precompute; per-point "still standing" flag                |
| 16 | Pareto depth (onion peeling)                          | T3   | Recursive frontier; layered render with opacity ramp                  |
| 17 | Hypervolume shading                                   | T3   | Polygon fill under the frontier curve; gradient                       |
| 18 | Hypervolume contribution per frontier point           | T3   | Leave-one-out hypervolume diff; encode as dot size                    |
| 19 | Crowding distance on the frontier                     | T3   | Per-point neighbor-distance sum; encode as saturation/size            |
| 20 | Era-normalized frontier                               | T3   | League-year aggregates; ERA+/OPS+ formulas; new mode                  |
| 21 | Distance-to-frontier (regret)                         | T3   | Multiple metric choices — pick one in the Plan agent                  |
| 22 | Knee-point / curvature highlight                      | T3   | Local curvature on the frontier; halo render                          |
| 23 | Marginal tradeoff slope at each frontier point        | T3   | Tangent on hover; baseball-unit annotation                            |
| 24 | Convex hull vs concave frontier points                | T3   | Andrew's monotone chain on the frontier subset                        |
| 25 | Era-vs-era frontier comparison                        | T3   | Coverage / GD / IGD metrics; translucent overlay UI                   |
| 26 | Frontier entropy / tradeoff diversity                 | T3   | Scalar + time-series alongside ▶ animation                            |
| 27 | Canvas rendering for the cloud                        | T4   | Hybrid Canvas (cloud) + SVG (axes/frontier/tooltips) migration        |
| 28 | Intra-season day-by-day animation                     | T4   | Blocked on data source; would also need BL2D format bump              |

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

A methodology you can't measure is just a wish. Claude Code writes per-session transcripts as JSONL at `~/.claude/projects/-Users-eliogovea-Project-baseball-limits-2d/<session-id>.jsonl`. Each `assistant` entry carries `message.model` (e.g. `claude-opus-4-7`), `message.usage` with input/output/cache token counts, `isSidechain: true` for subagent threads, and `tool_use` entries for `Agent` calls. That's the substrate `scripts/methodology_audit.py` reads.

**Session tagging.** Start every task session with one tier marker as the first line of the first user message, e.g. `Tier: T1 — sparklines in frontier cards`. The audit script greps for `^Tier:\s*T[0-4]` to label sessions.

**Audit script.** `scripts/methodology_audit.py [--since YYYY-MM-DD] [--session <id>] [--pricing pricing.json]`:

- Parses every JSONL transcript in `~/.claude/projects/-Users-eliogovea-Project-baseball-limits-2d/`.
- Extracts per session: declared tier (from first user message), distinct models used, list of subagent spawns (subagent_type + overridden model from `Agent` tool-use input), total input/output/cache tokens per model, wall-clock from first to last timestamp.
- With `--pricing pricing.json` (schema below) computes a per-session $ estimate **and** a counterfactual "all Opus 4.7" $ estimate using the same token volumes. Reports absolute and relative savings.
- Runs tier-compliance assertions per session — emits PASS/FAIL with a short reason. Two layers of evidence:
  1. **Intent** — did the user's opening prompt include the required `@`-mention? (Regex `@"<Agent> \(agent\)"` in the first user message text.)
  2. **Effect** — did a corresponding `Agent` tool-use entry actually appear in the transcript, with the right `subagent_type` and `model`?

  Assertions per tier:
  - T0: zero `Agent` tool calls; main model = Haiku.
  - T1: ≤ 1 `Agent` call (Explore only); main model = Sonnet.
  - T2: opening prompt contains `@"Plan (agent)"` **and** ≥ 1 `Agent` call with `subagent_type == "Plan"`; main model = Sonnet.
  - T3: opening prompt contains `@"Plan (agent)"` **and** ≥ 1 `Agent` call with `subagent_type == "Plan"` and `model == "opus"`; main model = Opus.
  - T4: opening prompt contains `@"Plan (agent)"` (or session launched with `--agent Plan`) **and** ≥ 1 `Agent` call with `subagent_type == "Plan"` and `model == "opus"`; at least one Agent call with `isolation == "worktree"`.

The two-layer check matters: a session can fail "intent" (user forgot the `@`) but pass "effect" (the assistant called the agent anyway), or vice-versa. Both failure modes are visible in the report so we can fix the right thing — the prompt template or the assistant behavior.

Pricing JSON schema (no values hardcoded — fetch current prices from Anthropic's pricing page and fill in; see `scripts/methodology_pricing.example.json`):

```json
{
  "claude-haiku-4-5":  { "input_per_mtok": 0.0, "output_per_mtok": 0.0, "cache_read_per_mtok": 0.0, "cache_write_per_mtok": 0.0 },
  "claude-sonnet-4-6": { "input_per_mtok": 0.0, "output_per_mtok": 0.0, "cache_read_per_mtok": 0.0, "cache_write_per_mtok": 0.0 },
  "claude-opus-4-7":   { "input_per_mtok": 0.0, "output_per_mtok": 0.0, "cache_read_per_mtok": 0.0, "cache_write_per_mtok": 0.0 }
}
```

Run it:

```bash
python3 scripts/methodology_audit.py --since 2026-05-29 --pricing ~/.claude/pricing.json
```

**Pilot before adoption.** Three pilot sessions, one per tier band, run end-to-end via `scripts/run_methodology_pilot.sh`. The runner:

- Creates one git worktree per pilot off your baseline (default `HEAD`).
- Runs `claude -p '<verbatim opening prompt>' --model <X> --permission-mode acceptEdits --output-format json` inside each worktree.
- For T3, passes `--agent Plan` (session-wide Plan, documented and guaranteed) plus `--model opus`. The TUI `@"Plan (agent)"` typeahead syntax does not parse in `-p` mode; the runner uses the documented `--agent` path instead.
- Writes a side-channel meta file per pilot (`.pilot-results/pilot-N.meta.json`) recording the tier, model flag, and session-agent flag.
- Calls `methodology_audit.py --pilot-meta .pilot-results --session <id1> --session <id2> --session <id3>` at the end so compliance is reported against what the runner declared.

```bash
# Dry-run (prints commands + the exact claude -p invocation per pilot, costs nothing)
./scripts/run_methodology_pilot.sh

# Actually run (spends tokens; each pilot runs in an isolated worktree)
./scripts/run_methodology_pilot.sh --execute

# Clean up worktrees + results afterward
./scripts/run_methodology_pilot.sh --cleanup
```

Pilots:

| Pilot # | Tier | Backlog item                                       | Runner uses                                                  | Expected effect                                                                |
|---------|------|----------------------------------------------------|--------------------------------------------------------------|--------------------------------------------------------------------------------|
| 1       | T0   | #1 Dark mode                                       | `--model haiku`                                              | Main Haiku; zero `Agent` tool calls                                            |
| 2       | T1   | #3 Axis-label glossary tooltips                    | `--model sonnet`                                             | Main Sonnet; zero or one `Explore` Agent call                                  |
| 3       | T3   | #16 Pareto depth (onion peeling) — design only     | `--model opus --agent Plan`                                  | Main Opus; session_agent=Plan (effect via session-wide flag)                   |

Acceptance: all three sessions report `compliance: PASS`, **and** the aggregate cost across the three sessions is strictly less than the all-Opus counterfactual. If a pilot fails compliance because work bled across tiers, fix the methodology — not the data.

**Baseline requirement.** The runner branches each pilot worktree from your baseline ref (default `HEAD`, override with `--baseline <ref>`). The baseline **must** already contain this "Working methodology" section in `CLAUDE.md` — otherwise Claude in `-p` mode won't have the tier rules loaded and the pilots will run without methodology guidance. The runner emits a warning and continues, but a failed compliance read is uninformative if the methodology wasn't present. Commit the methodology before running with `--execute`.

**Continuous use.** After adoption, re-run the audit weekly. It picks up every tier-tagged session, regardless of whether the task was on the backlog or arrived ad-hoc — bug fixes, refactors, perf work, and one-off requests are all in scope as long as they opened with the required `Tier: TX — …` line.

Three trend signals to watch over time:

1. **Compliance rate** (% of tagged sessions PASSing) — if it drops, either the prompt templates need fixing or the assistant is silently escalating models.
2. **Tier distribution** — if T0/T1 sessions dwindle while T3 grows without a matching shift in the work, the rubric is drifting and over-classifying. Re-calibrate signals.
3. **Resource savings vs. all-Opus counterfactual** — should hold steady at >40% if T0–T2 work is being routed correctly. If savings flatten or invert, the tier definitions probably need to shift to match the real distribution of tasks coming in.

## Git / deployment

`main` is the deployed branch — pushing to `main` updates the live GitHub Pages site. There is no staging environment. The bundle in `dist/` is gitignored and not part of the deployed site (production serves the multi-file `index.html` + `script.js` + `styles.css` + `data/*.csv` directly).

When you regenerate the bundle locally, the dev-site behavior should remain identical to production — they share `script.js` verbatim except for the three regex swaps the bundler applies.
