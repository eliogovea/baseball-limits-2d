# Baseball Limits 2D

## Overview

**[Baseball Limits 2D](https://eliogovea.github.io/baseball-limits-2d/)** visualizes the Pareto frontier of MLB batting and pitching statistics — pick any two dimensions and see which player-seasons (or careers) define the outer edge of what's ever been done.

Per-season and career-totals modes; filters for league, handedness, country of birth, and plate appearances or innings pitched; click any frontier dot to trace that player's full career arc.

## Data sources

All stats are from the [SABR Lahman Baseball Database](https://sabr.org/lahman-database/) (1871–2025 release), distributed under the [Creative Commons Attribution-ShareAlike 3.0 license](https://creativecommons.org/licenses/by-sa/3.0/).

Three tables are used:
- `Batting.csv` — per-player-season batting stats
- `Pitching.csv` — per-player-season pitching stats
- `People.csv` — player names, birth dates, country, handedness, height, weight

Why nothing from the in-progress current season? Lahman publishes once a year (~December/January), so we're current through the most recent completed season. Other public sources (MLB Stats API, Baseball Reference, FanGraphs) either restrict bulk redistribution or prohibit scraping — none of them is compatible with shipping the data inside this open-source site. We'll pick up the next season when SABR releases the following year's Lahman snapshot.

The CC BY-SA license carries over to derivative data we ship, including the canonical `data/*_limits_*.csv` files and the binary blobs inlined in `dist/index.html`. See [LICENSE-DATA.md](LICENSE-DATA.md) for the full attribution + license text. The source code (everything outside `data/` and the inline binary in the bundle) is MIT-licensed; see [LICENSE](LICENSE).

## Update data

When SABR releases a new Lahman snapshot:

1. Download the CSV release ZIP from [sabr.org/lahman-database](https://sabr.org/lahman-database/) and extract into `data/`:

   ```
   unzip -j data/lahman_1871-<YEAR>_csv.zip \
     "lahman_1871-<YEAR>_csv/Batting.csv" \
     "lahman_1871-<YEAR>_csv/Pitching.csv" \
     "lahman_1871-<YEAR>_csv/People.csv" -d data/
   mv data/Batting.csv  data/batting_lahman_1871-<YEAR>.csv
   mv data/Pitching.csv data/pitching_lahman_1871-<YEAR>.csv
   mv data/People.csv   data/people_lahman_1871-<YEAR>.csv
   ```

2. Regenerate the canonical limit CSVs:

   ```
   python3 scripts/convert_csv_lahman.py \
     data/people_lahman_1871-<YEAR>.csv \
     data/batting_lahman_1871-<YEAR>.csv \
     data/batting_limits_1871-<YEAR>.csv

   python3 scripts/convert_csv_lahman_pitching.py \
     data/people_lahman_1871-<YEAR>.csv \
     data/pitching_lahman_1871-<YEAR>.csv \
     data/pitching_limits_1871-<YEAR>.csv
   ```

3. Update the input paths in `script.js` and `scripts/build_bundle.py` to point at the new files.

4. Rebuild the self-contained bundle:

   ```
   python3 scripts/build_bundle.py
   ```

See [CLAUDE.md](CLAUDE.md) for the broader architecture and dev workflow.

## Ideas & future work

Status convention: `- [ ]` open, `- [x] *(shipped <sha>)*` shipped. Items with a design but no implementation note the design doc inline. Update this list in the same commit that ships or moots an item — see CLAUDE.md §"Working methodology" for why this is mandatory.

### Analytical / Pareto frontier concepts

- [ ] **Pareto depth (onion peeling)** — recursively remove the frontier and compute the next one from the remaining points, repeating 3–5 times. Render each layer in decreasing opacity or a stepped color. Seasons that survive to layer 1 are the all-time elite; layer 2 are the near-misses; and so on. Visually turns the chart into a topographic map of dominance. *(Design in [`docs/pareto-onion-peeling-design.md`](docs/pareto-onion-peeling-design.md); implementation pending.)*

- [ ] **Hypervolume shading** — fill the area "dominated" by the frontier (the region beneath and to the left of the curve) with a light gradient. The shaded region is the hypervolume indicator — a single scalar capturing how much of the objective space the frontier controls. Pairs perfectly with the ▶ animation: you can watch the shaded area grow as history advances.

- [x] **Hypervolume contribution per frontier point** *(shipped 6e543a1)* — for each red dot, compute how much the total dominated area would shrink if that point were removed. High contribution = the point "owns" a large exclusive territory on the frontier. A natural complement to the Loneliness Radius: Loneliness measures nearest-neighbour distance in the cloud; hypervolume contribution measures the frontier point's structural importance. Toggle on/off via the "Show HV" checkbox in Filters; URL hash `hv=1`. Encoded as red-dot radius (sqrt(contribution / max)). The two unchosen encodings — saturation/opacity ramp on the red fill, and contribution-scaled halo rings — remain open follow-ups that would compose with this metric.

- [ ] **Crowding distance on the frontier** — the standard NSGA-II metric: for each frontier point, the sum of distances to its immediate left and right neighbours along the frontier. High crowding distance = the point sits in a sparse, uncrowded region of the frontier curve. Could be encoded as dot size or saturation on the frontier, immediately showing which seasons occupy distinct niches vs. cluster together.

- [ ] **Frontier longevity / years held** — for each frontier point, track how many seasons it has stood as the record (and whether it still does). Henderson's 130 SB in 1982 has been untouched for 40+ years; Maris's 61 HR stood 37 years. A "time-on-frontier" color scale — older = more saturated — would make durability legible at a glance.

- [ ] **Era-normalised frontier** — divide each stat by that season's league average (like ERA+, OPS+). The raw frontier is dominated by the steroid era for power stats and the dead-ball era for pitching volume. An era-adjusted view would show who was most exceptional *relative to their peers*, which is a different (and arguably fairer) question.

- [ ] **"Almost frontier" band** — a faint second layer just inside the frontier showing seasons within, say, 5% of both axis values simultaneously. Shows how deep the talent pool is right behind the record-holders and makes the frontier's exclusivity visible.

- [x] **Distance-to-frontier for non-frontier points** — for every season *off* the frontier, compute the shortest objective-space distance to the nearest red dot (Euclidean, dominance distance, or an additive/multiplicative epsilon indicator). Encode as cloud-dot opacity or surface as a "regret" tooltip line — e.g. "Mike Trout 2018 was 4 HR and 0.012 AVG away from the frontier." Turns the background cloud into a heatmap of near-misses. *(shipped 7b9a80e)*

- [ ] **Knee-point / curvature highlight** — flag frontier seasons where the curve bends sharpest. Knee points are the "sweet spot" records: small sacrifice on either axis for a large gain on the other, often the most interesting tradeoffs in a discussion. Compute via local curvature or the angle between adjacent frontier segments and emphasise those dots with a halo or label.

- [ ] **Marginal tradeoff slope at each frontier point** — show the local exchange rate between objectives ("at this point, +1 HR costs roughly -0.004 AVG"). Could appear as a tangent line on hover or as a small annotation on each frontier card. Makes the geometric meaning of the curve concrete in baseball units rather than abstract Pareto-speak.

- [ ] **Convex hull vs. concave frontier points** — distinguish "supported" frontier points (those on the convex hull, reachable by any linear utility weighting) from "unsupported" ones sitting in concave dips. Concave-region seasons are often the most distinctive because no scalar weighted average of the two stats would have surfaced them — they're records that only multi-objective thinking finds.

- [ ] **Era-vs-era frontier comparison** — pick two year ranges side-by-side and quantify how much one era's frontier dominates the other using coverage / generational distance / inverted generational distance. Answers questions like "does the steroid-era HR-vs-AVG frontier strictly dominate the dead-ball frontier?" with a single number plus a translucent overlay showing where the two curves diverge.

- [ ] **Frontier entropy / tradeoff diversity** — a single scalar summarising how spread-out the frontier's tradeoffs are along its length. High entropy = a long, balanced frontier with many distinct niches; low entropy = a short frontier crowded near one extreme. Plotted as a time series alongside the ▶ animation, it would show eras when the sport allowed many different paths to greatness vs. eras when one archetype dominated.

- [ ] **Pareto dominance count per season** — for each point, store how many other seasons strictly dominate it (lower is better) and how many it dominates (higher is better). Surfaces "second-place" and "near-elite" seasons that the binary frontier/non-frontier split currently hides; pairs naturally with the Pareto depth idea above as a continuous companion to the discrete layer count.

### Visual / interaction improvements

- [ ] **Kernel density contour lines** — overlay smooth topographic contours on the point cloud using `d3-contour`. Makes the shape of the distribution legible (where do most qualified seasons cluster?) without obscuring individual dots. Especially useful for dense axes like AVG or ERA.

- [ ] **Voronoi overlay for frontier points** — partition the chart space into cells, one per frontier point, each cell showing the region "closest" to that frontier dot. Visually answers: "if a new season entered, which frontier record would it challenge?" Could be a toggleable layer.

- [ ] **Animated transitions on filter change** — when the axis, year range, or filters change, smoothly morph the frontier line and dots to their new positions using D3 transitions rather than an instant snap. Easier to follow how the frontier shifts when something changes.

- [ ] **Sparklines in frontier cards** — add a tiny inline career sparkline (e.g. HR by year) to each entry in the "On the Frontier" sidebar card. Shows at a glance whether the record season was a peak or part of a sustained run.

- [x] **Dark mode** *(shipped e9eec27)* — shipped as the **Night** theme in a 3-theme system (Classic / Editorial / Night), selectable from the header swatch switcher and persisted in `localStorage`. The holistic pass the earlier attempts lacked: every literal color was first tokenized (`--glass-bg`, `--gold`, `--league-al/-nl`, `--on-primary`), and `applyTheme()` re-skins both the CSS-var chrome and the D3-painted chart (by mutating the in-place `ERAS`/`COLOR_PALETTES` tables). Night uses a near-black field with a light frontier staircase and a blue sequential era ramp.

- [ ] **Canvas rendering** — switch the point-cloud layer from SVG circles to an HTML Canvas overlay (D3 still manages axes, labels, and interactions in SVG). Unlocks smooth rendering with 50 k+ points and removes the current lag at large datasets.

- [ ] **World map birthplace view** — a companion mini-map showing where frontier (or highlighted) players were born, one dot per player. Leverages the existing country/birthplace data already in the dataset.

- [x] **Player search box** *(shipped 7752a0f)* — a typeahead in the filter panel that highlights a player's seasons (colored dots, dimmed cloud) and pins them as a chip. Uses the disambiguated display names already in `playerIndex`. Replaces the "scroll the frontier card list and hope they're on it" flow with a direct lookup. (The box existed earlier but didn't highlight — `pick()` called the closure-scoped `refreshChart`; `7752a0f` routes it through the `bl2d:refresh` event.)

- [x] **Reduced-motion support** *(shipped e9eec27)* — a `@media (prefers-reduced-motion: reduce)` block collapses decorative transitions and the modal pop/fade to instant. The loading spinner is re-exempted (it conveys state), and the user-initiated ▶ frontier animation is left intact as opt-in motion.

- [x] **Theme system (Classic / Editorial / Night)** *(shipped e9eec27)* — header swatch switcher, `localStorage` persistence, and per-theme era ramps. See **Dark mode** above for the architecture. From the Claude Design review.

- [x] **CVD-safe era encoding + legend-reflects-encoding** *(shipped e9eec27)* — the era cloud now uses a luminance-monotonic sequential ramp (protanopia/deuteranopia-safe; the old 7-hue categorical scale wasn't), and the chart legend renders the key for whatever the active **Color-by** encoding is (era colorbar with year ends / AL-NL / handedness) instead of a static league key. Adds an **Era / League / Bats** color-by control (era is now the default, matching the welcome copy); state rides in the URL hash as `cb`. From the Claude Design review.

- [x] **Keyboard focus ring** *(shipped e9eec27)* — a global `:focus-visible` ring restores a visible focus indicator on the custom controls (segmented toggles, chips, icon buttons) that previously stripped the UA outline. From the Claude Design review.

- [x] **Sidebar hierarchy + mobile axis bar** *(shipped e9eec27)* — the controls are grouped into **Plot / Filter / Highlight** bands with the axis selects emphasized, and a persistent compact X-vs-Y bar sits above the mobile drawer so axis switching doesn't require opening it. From the Claude Design review.

- [x] **Frontier-label collision avoidance** *(shipped e9eec27)* — label placement now measures real text width via `getComputedTextLength()` (replacing the per-character estimate) and adds leader lines for dodged labels. Invariant: no two `.frontier-label` boxes overlap after layout (`window.__bl2d_labelOverlaps === 0`). From the Claude Design review.

- [x] **Logomark + favicon / app-icon set** *(shipped e9eec27)* — the product had a wordmark only; added the "apex" mark (Pareto staircase + gold record dot) inline in the header plus `favicon.svg`/PNGs, `apple-touch-icon`, and `manifest.webmanifest`. From the Claude Design review.

- [x] **Axis-label glossary tooltips** *(shipped f192458)* — hover the X/Y axis label to get the same stat blurb the glossary modal shows, without opening the modal. Especially useful on first visit when users don't yet know that ERA or WHIP on the frontier highlights the *worst* seasons (since the frontier finds the upper-right envelope and those stats are "lower is better"). Surfaces the explanation exactly where the confusion happens.

- [ ] **Keyboard navigation across frontier points** — arrow keys cycle through frontier dots left-to-right with focus + tooltip, Enter pins the career highlight, Escape clears it. Makes the chart usable without a mouse, improves accessibility, and gives power users a fast way to scan the whole frontier without precise pointer aim.

### Data / scope

- [ ] **Intra-season / day-by-day animation** — the current ▶ animation steps by full season. With daily cumulative stats (e.g. running HR total after each game) you could watch a record-breaking season unfold game by game. Blocked on data: the Lahman database only publishes season totals; daily logs from BBRef or Statcast come with terms that don't allow bulk redistribution. Worth revisiting if a compatible open dataset appears.

- [ ] **Interactive guided tour** — replace (or supplement) the static welcome modal with a step-by-step walkthrough that highlights each UI region in sequence: the chart, the frontier curve, the axis selectors, the year-range animation button, the Loneliness Radius, the filters, and the frontier card list. Libraries like [Shepherd.js](https://shepherdjs.dev/) or a lightweight hand-rolled tooltip-chain would work. Keeps the first-visit experience self-contained without needing external docs.

- [ ] **Negro Leagues spotlight mode** — the 2020 Lahman release added Negro Leagues seasons and they're already in the dataset, but the league filter and broad year ranges make them easy to overlook. A dedicated toggle (or league preset) that emphasises Negro Leagues seasons in a distinct colour would surface a slice of baseball history that's currently invisible by default, and would pair well with the era-vs-era frontier comparison idea above.

### Methodology infrastructure follow-ups

These came out of the methodology validation pilots and aren't user-facing features — they make the methodology itself sharper. See CLAUDE.md §"Working methodology" for the framework.

- [ ] **`snap.js --color-scheme` flag** — wire CDP `Emulation.setEmulatedMedia` for `prefers-color-scheme` so the verification floor can exercise dark-mode (and any future `@media` feature query) headlessly. TODO marker is already in `scripts/snap.js` near `setDeviceMetricsOverride`.

- [ ] **Fill in `~/.claude/pricing.json`** — one-time: copy `scripts/methodology_pricing.example.json` to `~/.claude/pricing.json` and fill in current per-million-token rates from anthropic.com/pricing. `methodology_audit.py`'s $-savings columns will become meaningful instead of $0.

- [ ] **Broaden pilot runner's Bash allowlist** — Sonnet's natural shell style (multi-line, backgrounded `&`) didn't match `Bash(python3 -m http.server *)`. Either pre-ship a `scripts/verify_pilot.sh` helper that pre-allowlists with one path, or document the shell-style constraints in the pilot prompt itself.

- [ ] **Bias glossary popover above the title for X-axis hover** — `positionNear` only flips above when truly off-screen, so X-axis hover lands the popover near the bottom viewport edge. Small `positionNear` tweak.
