# Sub-season play-by-play data: what to ship and how to store it

This note summarizes the data the site needs for smooth game-by-game (and
eventually career) frontier animation, and the format chosen to store and
transmit it. The format is implemented in `scripts/convert_retrosheet_pbp.py`
(writer) and `script.js` `parseBl2p()` (reader). Phase 1 ships 1998 batting;
the format and sizing below cover the full intended corpus.

## 1. What data the site should have

**Source.** Retrosheet parsed game-level CSVs (https://retrosheet.org/downloads/),
`batting.csv` and `pitching.csv` — one row per player per game, 1898–2025,
CC BY-SA-compatible (see `LICENSE-DATA.md`). No event-file parser needed.

**Granularity.** Per-game **counting-stat deltas**, not cumulative totals and not
pitch-level events. Everything the chart plots is derived from the same counting
columns the season data already uses:

- Batting — 17 columns: `G, AB, R, H, 2B, 3B, HR, RBI, SB, CS, BB, SO, IBB, HBP, SH, SF, GIDP`
- Pitching — 23 columns: `W, L, G, GS, CG, SHO, SV, IPouts, H, ER, HR, BB, SO, IBB, WP, HBP, BK, BFP, GF, R, SH, SF, GIDP`

Rate stats (AVG, OBP, ERA, WHIP, …) are **recomputed client-side** from the
cumulative counting components — exactly as `parseBattingRows` / `parsePitchingRows`
already do — so we never store them.

**Filtering at ingest.** Keep only `stattype == "value"` (the actual line, not the
deduced lower/official/upper bounds) and `gametype == "regular"` (Retrosheet also
ships allstar / division-series / LCS / world-series rows that would inflate
totals past official season numbers and break parity with the season frontier).

**Identity.** Retrosheet's 8-char `retroID` is crosswalked at build time to the
site's Lahman **display name** via `people_lahman`'s `retroID` column, so the keys
match `playerIndex` / `metaFor` / highlights with no client-side join.

**Recommended coverage.** Batting **and** pitching, per game, for **1920–2025**
(the live-ball era, where game-level coverage is complete). Pre-1920 deadball
seasons can be added opportunistically; pre-1910 is box-score-only and is skipped
(the client 404 → graceful fallback to the existing year-step animation). One file
per season per dataset, lazy-loaded on demand — the user only ever downloads the
seasons they actually animate.

## 2. Optimal format: `BL2P` (one gzipped file per season per dataset)

Full byte layout is documented in the header of `scripts/convert_retrosheet_pbp.py`.
The design decisions and why:

| Decision | Choice | Why |
|---|---|---|
| Deltas vs cumulative | **Per-game deltas** | Deltas are tiny (0–7 for most columns) so they bit-pack into 1–4 bits. Cumulative totals reach the hundreds and need u16, killing the packing win. Client prefix-sums to cumulative once at load (O(games)). |
| Layout | **Columnar, sparse player-major** | Store only games actually played (~68k rows/modern season), not a dense players×dates matrix (~8× larger, mostly zeros). Columnar groups like values for better gzip. |
| Per-column width | **Minimal bit width**, stored in the column header | Each column packed at `ceil(log2(max+1))` bits (e.g. HR→2, AB→4, IBB→2). Self-describing, so a future u8 fallback is just "width 8". |
| Rare-zero columns (3B/CS/SF/IBB) | **Rely on gzip**, no bitmap/exception layer | At 1–2 bits they already cost almost nothing; gzip crushes the long zero runs. A bitmap layer adds complexity for ~2 KB. |
| Compression | **gzip the whole file** (`.bl2p.gz`) | Reuses the bundle's exact `DecompressionStream('gzip')` path. Deterministic, no reliance on server content-encoding. |
| Delivery | **Lazy-load per season**, not inlined in the offline bundle | Keeps the main bundle ~3.9 MB and pure-offline; sub-season is an opt-in feature that fetches one ~150 KB file when the user hits "Smooth". |

**Cursor model.** A season has ~177 distinct game dates (a small `u16` date
table). The animation cursor is an index into that table; "as of date D" =
binary-search each player's game list for the last game ≤ D and read the
prefix-summed cumulative there. This produces a synthetic points array shaped
exactly like the season data, so the existing frontier sweep runs unchanged.

## 3. Size & transmission budget

Measured, 1998 batting (68,130 regular-season games, 1,186 players, 177 dates):

| | bytes |
|---|---|
| Bit-packed raw payload | 513 KB |
| **gzipped (what ships)** | **152 KB** |
| vs columnar-u8 + gzip | ~180 KB (so bit-packing saves ~15% post-gzip, ~4× pre-gzip / in-memory) |

**Per-use transmission (the number that matters):** animating one year fetches
one season file — **~150 KB batting, ~70–100 KB pitching**, ~220 KB for a
season-pair. A 22-year career sweep streams ~3–5 MB total, but progressively,
one year at a time as the cursor crosses Jan 1 (with prefetch of the next year).

**Total committed corpus (full 1920–2025, both datasets):** batting averages
~110 KB/season (fewer teams in early seasons offset by wider modern rosters),
pitching ~55 KB/season → roughly **~12 MB batting + ~6 MB pitching ≈ 18 MB**
of `.bl2p.gz` files in the repo. That is committed but never downloaded in bulk
by any client — GitHub Pages serves each season file only on demand.

## 4. Alternatives rejected

- **Inlining into `dist/index.html`** — would bloat the offline bundle from
  ~3.9 MB to ~22 MB and defeat the lazy-load. Sub-season stays out of the bundle.
- **Reusing the BL2D season blob format** — it's row-per-season with u8/u16
  columns and full name/team/people dictionaries; wrong shape and no bit-packing
  for per-game deltas. BL2P is a separate, leaner format.
- **Shipping `plays.csv` (16.5M event rows)** — pitch/event granularity is ~100×
  the data for a use case (frontier animation) that only needs game-level
  cumulative counts. Out of scope.
- **Dense players×dates matrix** — ~8× larger (mostly zero cells) and slower to
  decode than the sparse player-major stream.
