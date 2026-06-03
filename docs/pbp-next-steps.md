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

## Phase 2 — pitching + multi-year cursor (T3)
1. **Converter pitching support.** Generalize `convert_retrosheet_pbp.py`:
   - Add a `PITCHING_COLUMNS` map (out_name -> Retrosheet `p_*` field). Inspect
     `head -1 pitching.csv` for the real column names (likely `p_ip`/`p_bfp`/
     `p_h`/`p_er`/`p_bb`/`p_so`/`p_hr`/… and `p_gs`,`p_cg`,`p_sho`,`p_sv`,`p_w`,
     `p_l`). IPouts: Retrosheet may give outs directly or innings — confirm and
     convert to IPouts to match the site's `PITCHING_COUNT_COLS`.
   - Add a `--dataset {batting,pitching}` flag (or auto-detect by header); emit
     `p<year>.bl2p.gz` with `dataset=1` in the header. The `parseBl2p` reader
     already ignores the dataset byte, so add a `pbpPointsAsOf` pitching branch
     (call `parsePitchingRows` instead of `parseBattingRows`, keyed off the
     active dataset / a field in the decoded struct).
2. **Generate the corpus.** `python3 scripts/convert_retrosheet_pbp.py <batting.csv> 1920-2025`
   and the pitching equivalent. Expect ~18 MB of `.bl2p.gz` total. Commit them.
3. **Multi-year cursor.** Today the cursor is single-season (tied to the end-year
   input). Generalize: a virtual timeline over the selected year range; when the
   cursor crosses a season boundary, lazy-load the next year (`decodePbpSeason`),
   prefetch the next year when the cursor enters the last ~10 dates. The "Smooth"
   toggle should drive the whole `sy..ey` window, not just `ey`.
4. **Default-year UX.** Right now clicking "Smooth" with the default end-year
   (2024) 404s → "No game-by-game data". With the full corpus this disappears,
   but verify the toggle picks a sensible season.

**Verify:** decode-count per season == regular-season CSV rows; a known pitching
record (e.g. a 20-win season reaches W=20 at year end, Pedro 2000 ERA sane);
pitching season-end frontier ≈ Lahman pitching frontier.

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
