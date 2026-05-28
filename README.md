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

- **Intra-season / day-by-day animation** — the current ▶ animation steps by full season. With daily cumulative stats (e.g. running HR total after each game) you could watch a record-breaking season unfold game by game. Blocked on data: the Lahman database only publishes season totals; daily logs from BBRef or Statcast come with terms that don't allow bulk redistribution. Worth revisiting if a compatible open dataset appears.
