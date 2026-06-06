# PBP animation — next steps (handoff)

Continues the Retrosheet sub-season animation work. Phase 1 is **committed**
on branch `pbp-animation` (commit `7060161`). Full design: `~/.claude/plans/
let-s-design-how-to-merry-pearl.md`. Format/scope: `docs/pbp-data-format.md`.

## Current state (done)
- `scripts/convert_retrosheet_pbp.py` — batting only; emits bit-packed `BL2P`
  (`data/pbp/b<year>.bl2p.gz`). Supports a single year or a `START-END` range.
- `data/pbp/b1998.bl2p.gz` committed (68,130 regular-season games, 152 KB).
- `script.js`: `decodePbpSeason` / `parseBl2p` / `pbpPointsAsOf`, the
  `refreshChart` cursor branch, the "Smooth" toggle + scrubber wiring, `t=`
  URL key. `index.html` + `styles.css` have the smooth row.
- Verified end-to-end (McGwire→70, season-end frontier == Lahman frontier).

## Environment notes (so a cold start doesn't re-derive)
- Retrosheet batting CSV already downloaded at `/tmp/retro_batting/batting.csv`
  (681 MB, may be gone if /tmp was cleared — re-fetch:
  `curl -sL https://retrosheet.org/downloads/batting.zip -o /tmp/batting.zip && unzip`).
- Pitching CSV (Phase 2): `https://retrosheet.org/downloads/pitching.zip`.
- Dev server: `python3 -m http.server 8000`. Headless: `node scripts/snap.js`.
- Verification hooks already on `window.__bl2d_*`: `pbpActive()`,
  `pbpPointsAsOf(idx)`, `enableSmooth()`, `pbpGames`, `pbpFallback`,
  `pbpCursorYmd`, `frontierPids`.

## Gotchas already learned (don't rediscover)
- Filter `stattype == "value"` **and** `gametype == "regular"`. The file
  includes allstar/division-series/LCS/world-series rows that otherwise inflate
  totals past official season numbers (caught via a WS cursor date).
- Retrosheet game-sums differ slightly from Lahman season totals (different
  sources). Counting-stat (HR/SB) frontiers match exactly; rate-stat axes will
  be close-but-not-identical. Don't assert byte-equality on rate axes.
- Server must serve `.gz` as raw bytes (python http.server does; Content-Type
  `application/gzip`, no Content-Encoding) so `DecompressionStream` works.

## Phase 2 — multi-year cursor + full batting corpus (T3) — **DONE** (this branch)

**Multi-year cursor (shipped).** The cursor is now a virtual timeline over the
selected `sy..ey` window (`buildPbpTimeline` + helpers in `script.js`). The global
`pbpCursorIdx` indexes a concatenation of every year's game-date table; years are
decoded lazily as the cursor reaches them, the neighbouring year is prefetched
within `PBP_PREFETCH_TAIL` of an edge, and 404 years are marked `missing` and
skipped. `pbpPointsAsOf(decoded, withinIdx, dataset)` is dataset-aware (routes to
`parseBattingRows`/`parsePitchingRows`).

**The frontier ACCUMULATES across years — it does not reset per season.** The point
the cursor is "open" on (the current year) is the only one that grows game-by-game
from its PBP partial; all *completed* seasons stay on the chart at their full
(Lahman) season totals, pulled straight from `data.points`. So the rendered window
runs `sYear..openYear` (not `sY=eY=openYear`), and the all-time-best envelope evolves
outward as the cursor sweeps — you watch records get set and broken across years.
A nice consequence: only the open season needs its PBP file; prior years render from
the already-loaded season data, so the animation only ever fetches one season at a
time. Axes lock to the **full selected window's** final envelope (`pbpComputeExtent`
over `data.points` in `sYear..eYear`), so they're fixed from frame 1 and the frontier
grows into a stable frame.

The `t=YYYYMMDD` deep-link sets the window's end year and lands the cursor on that
date; switching dataset disables smooth; changing s/e re-builds. Verified: single-year
regression (McGwire 1998→70 HR at year-end), 1953–1955 boundary crossing (one
transition each, never lands on a missing year), 404-gap skip, zero-coverage
fallback, deep-link, and two key invariants — (1) 1998 season-final cursor frontier ==
Lahman season frontier on HR×SB (identical 7-player set); (2) the accumulating final
frontier of a multi-year window == the static multi-year season frontier (1953–1955 →
Bruton 1954 / Miñoso 1953 / Mays 1955, identical set), confirming the frontier really
spans years rather than resetting.

**Full batting corpus (shipped).** `data/pbp/b1920..b2025.bl2p.gz` committed
(~12 MB). Converter generalized with a `--dataset {batting,pitching}` flag +
`DATASETS` table; batting output is byte-identical to before (decompressed-bytes
diff clean on 1998). Re-fetch sources per the env notes; the 681 MB CSV is streamed
once per year (slow — ~minutes for the full range).

### Phase 2 leftover — **pitching corpus + read path (deferred, T3)**
The converter's `--dataset pitching` path is scaffolded but **gated off** with a
`sys.exit` because the pitching source needs derivation work that the simple
column-map can't express (and can't be verified until the pitching read path
exists). Confirmed against the real `pitching.csv` header (2026-06):
- **Direct columns** (already in `PITCHING_COLUMNS`): `p_ipouts`→IPouts, `p_bfp`,
  `p_h`, `p_hr`, `p_r`, `p_er`, `p_w`(=BB/walks), `p_iw`→IBB, `p_k`→SO, `p_hbp`,
  `p_wp`, `p_bk`, `p_sh`, `p_sf`, `p_gs`, `p_gf`, `p_cg`.
- **Need derivation** (not direct columns): `W`/`L`/`SV` are per-game *decision*
  fields — the `wp`/`lp`/`save` columns hold the credited pitcher's retroID, so
  `W += 1 when row.id == row.wp`, etc. `SHO` = complete game with zero runs
  (`p_cg == 1 && p_r == 0`). `GIDP` is **absent** from `pitching.csv` (drop it or
  leave it 0 — it isn't a pitching chart dimension anyway).
- To finish: extend `read_season` to compute these derived deltas for pitching,
  remove the `sys.exit` gate in `convert()`, generate `p1920..p2025.bl2p.gz`
  (~6 MB), and exercise the JS read path — `pbpPointsAsOf` already routes to
  `parsePitchingRows`, so the remaining JS work is just letting the dataset toggle
  re-enable smooth onto a pitching corpus instead of disabling it.
- **Verify (pitching):** decode-count == regular-season rows; a 20-win season
  reaches `W=20` at year end; Pedro 2000 ERA sane; pitching season-end frontier
  ≈ Lahman pitching frontier (rate axes close-but-not-equal, don't assert equality).

## Phase 3 — career-cumulative smooth sweep (T3)
- Career synthetic point = `aggregateCareer` (script.js ~L1340) over prior
  completed seasons **+** `pbpPointsAsOf` of the open season, summed via the
  shared derive path. Years lacking PBP contribute only their season total
  (a step), so a career sweep is smooth within PBP years and steps across gaps.
- Extend `animExtentCache` to a cursor-aware key with end-of-window extents so
  axes lock and the frontier grows outward over the whole sweep.

## Phase 4 — rendering-perf gate (T4, evaluate-then-decide)
- Instrument the cursor sweep: record per-frame time to `window.__bl2d_pbpFrameMs`
  (p50/p95) across viewport sizes and the largest frontier.
- **Decision rule:** if p95 stays under budget (~16 ms / 60fps, ~33 ms / 30fps
  acceptable) on SVG, keep SVG and only tune FLIP/throttle. If it blows the
  budget, rewrite the dot + frontier-staircase render as a **Canvas 2D layer**
  (WebGL only if Canvas 2D also falls short); keep SVG for axes/labels/overlays;
  move hit-testing to `d3-quadtree`. Capture before/after frame-time numbers.

## Verification floor (every phase)
- `node scripts/snap.js` desktop (1440×900, 1600×900) + mobile (390×844, panel
  open); two cursor states (mid-season + season-final); send before/after via
  `SendUserFile`.
- Equivalence check (#2 above) is the most important: season-final PBP frontier
  == Lahman season frontier on a counting-stat axis pair.
- Update the README backlog item + flip to `- [x] *(shipped <sha>)*` in the
  same commit when the feature is fully general (per the project convention).

## Housekeeping
- The big Retrosheet source CSVs stay in `/tmp` (not committed). Only the
  `.bl2p.gz` artifacts are committed; `data/pbp/*.bl2p` (uncompressed) is
  gitignored.
- Not yet pushed; `pbp-animation` is local. `main` is the live Pages deploy —
  don't push there until the feature is ready to go live.
