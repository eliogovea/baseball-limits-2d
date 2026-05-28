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

The CC BY-SA license carries over to derivative data we ship, including the canonical `data/*_limits_*.csv` files and the binary blobs inlined in `dist/index.html`. See [DATA-LICENSE.md](DATA-LICENSE.md) for the full attribution + license text. The source code (everything outside `data/` and the inline binary in the bundle) is MIT-licensed; see [LICENSE](LICENSE).

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

### Analytical / Pareto frontier concepts

- **Pareto depth (onion peeling)** — recursively remove the frontier and compute the next one from the remaining points, repeating 3–5 times. Render each layer in decreasing opacity or a stepped color. Seasons that survive to layer 1 are the all-time elite; layer 2 are the near-misses; and so on. Visually turns the chart into a topographic map of dominance.

- **Hypervolume shading** — fill the area "dominated" by the frontier (the region beneath and to the left of the curve) with a light gradient. The shaded region is the hypervolume indicator — a single scalar capturing how much of the objective space the frontier controls. Pairs perfectly with the ▶ animation: you can watch the shaded area grow as history advances.

- **Hypervolume contribution per frontier point** — for each red dot, compute how much the total dominated area would shrink if that point were removed. High contribution = the point "owns" a large exclusive territory on the frontier. A natural complement to the Loneliness Radius: Loneliness measures nearest-neighbour distance in the cloud; hypervolume contribution measures the frontier point's structural importance.

- **Crowding distance on the frontier** — the standard NSGA-II metric: for each frontier point, the sum of distances to its immediate left and right neighbours along the frontier. High crowding distance = the point sits in a sparse, uncrowded region of the frontier curve. Could be encoded as dot size or saturation on the frontier, immediately showing which seasons occupy distinct niches vs. cluster together.

- **Frontier longevity / years held** — for each frontier point, track how many seasons it has stood as the record (and whether it still does). Henderson's 130 SB in 1982 has been untouched for 40+ years; Maris's 61 HR stood 37 years. A "time-on-frontier" color scale — older = more saturated — would make durability legible at a glance.

- **Era-normalised frontier** — divide each stat by that season's league average (like ERA+, OPS+). The raw frontier is dominated by the steroid era for power stats and the dead-ball era for pitching volume. An era-adjusted view would show who was most exceptional *relative to their peers*, which is a different (and arguably fairer) question.

- **"Almost frontier" band** — a faint second layer just inside the frontier showing seasons within, say, 5% of both axis values simultaneously. Shows how deep the talent pool is right behind the record-holders and makes the frontier's exclusivity visible.

### Visual / interaction improvements

- **Kernel density contour lines** — overlay smooth topographic contours on the point cloud using `d3-contour`. Makes the shape of the distribution legible (where do most qualified seasons cluster?) without obscuring individual dots. Especially useful for dense axes like AVG or ERA.

- **Voronoi overlay for frontier points** — partition the chart space into cells, one per frontier point, each cell showing the region "closest" to that frontier dot. Visually answers: "if a new season entered, which frontier record would it challenge?" Could be a toggleable layer.

- **Animated transitions on filter change** — when the axis, year range, or filters change, smoothly morph the frontier line and dots to their new positions using D3 transitions rather than an instant snap. Easier to follow how the frontier shifts when something changes.

- **Sparklines in frontier cards** — add a tiny inline career sparkline (e.g. HR by year) to each entry in the "On the Frontier" sidebar card. Shows at a glance whether the record season was a peak or part of a sustained run.

- **Dark mode** — a dark colour scheme where the chart background is near-black and the dot cloud uses muted colours. The red frontier curve and highlight colours (gold, teal, purple) would pop more dramatically against a dark field.

- **Canvas rendering** — switch the point-cloud layer from SVG circles to an HTML Canvas overlay (D3 still manages axes, labels, and interactions in SVG). Unlocks smooth rendering with 50 k+ points and removes the current lag at large datasets.

- **World map birthplace view** — a companion mini-map showing where frontier (or highlighted) players were born, one dot per player. Leverages the existing country/birthplace data already in the dataset.

### Data / scope

- **Intra-season / day-by-day animation** — the current ▶ animation steps by full season. With daily cumulative stats (e.g. running HR total after each game) you could watch a record-breaking season unfold game by game. Blocked on data: the Lahman database only publishes season totals; daily logs from BBRef or Statcast come with terms that don't allow bulk redistribution. Worth revisiting if a compatible open dataset appears.

- **Interactive guided tour** — replace (or supplement) the static welcome modal with a step-by-step walkthrough that highlights each UI region in sequence: the chart, the frontier curve, the axis selectors, the year-range animation button, the Loneliness Radius, the filters, and the frontier card list. Libraries like [Shepherd.js](https://shepherdjs.dev/) or a lightweight hand-rolled tooltip-chain would work. Keeps the first-visit experience self-contained without needing external docs.
