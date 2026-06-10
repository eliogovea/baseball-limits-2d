# BL2S stat layer — continuation handoff

Resumable plan for the normalized per-stat layer (`BL2S`). Full design + decision log is in
[`pbp-stat-format.md`](pbp-stat-format.md); this is the "where we are / what to do next" doc.
Branch: `feat/event-level-pbp`.

## Status snapshot (as of this handoff)

**Committed:**
- BL2E corpus + tooling (P1–P5): `convert_retrosheet_events.py`, `decode_bl2e.py`,
  `verify_bl2e.py`, `crosscheck_bl2e.py`, `build_bl2e_corpus.py`; 116 `data/pbp/e*.bl2e.gz`
  (1910–2025, 76.8 MB). Commits `3fdf193`, `3540d85`, `7995ffd`, `fc6aa11`, `c95efb3`.
- BL2S **S1** (batter stats from BL2E): `build_stat_files.py` (BL2E-sourced version),
  `decode_stat.py`, `statfile_experiment.py`, `docs/pbp-stat-format.md`. Commit `6a508f7`.
  Shipped `data/pbp/stat_players.bl2s.gz` + 15 `stat_<batter>.bl2s.gz`.
- Decision log + S1b finding. Commit `cbc0d3e`.

**IN-FLIGHT / UNCOMMITTED (the active work):**
- `scripts/build_stat_files.py` was **rewritten** to source from **Retrosheet `plays.csv`
  directly** (Decision 10 = option A) instead of BL2E. This is the resolution of the S1b
  block: runner stats SB/CS/R are now exact (real `br*_pre`/`run*` identities → substitutions
  handled), and ALL stats come from one exact pass. **This rewrite is UNTESTED** — the next
  step was `python3 scripts/build_stat_files.py 2023 --out /tmp/stat_test` to validate one
  season, which got interrupted.
- The committed S1 stat files are **BL2E-sourced and use a different gpid scheme**
  (sorted-retroID) than the new builder (first-appearance order). The full plays.csv rebuild
  will **overwrite** `stat_players.bl2s.gz` + all `stat_*.bl2s.gz` with a consistent new gpid
  scheme. **All stat files must be rebuilt together** so gpids match the dimension.

## Immediate next steps (resume here)

1. **Validate the rewritten builder on one season** (no full download):
   ```
   python3 scripts/build_stat_files.py 2023 --out /tmp/stat_test
   ```
   Then decode + check 2023 totals against Lahman (must match exactly):
   - HR 5,868 · BB 15,819 (BB = `walk` column, includes intentional — verify it's NOT 15,345;
     if low by the IBB count, BB should stay = walk column) · SO 41,843 · H 40,839.
   - SB/R: spot-check a 2023 player; confirm runner attribution is populated.
   Use `decode_stat.py` + sum cells per gpid (map names via `decode_players`).

2. **Full build** (downloads ~500 MB of season zips, several minutes; like `build_bl2e_corpus`):
   ```
   python3 scripts/build_stat_files.py 1910-2025          # -> data/pbp/stat_*.bl2s.gz
   python3 scripts/build_stat_files.py 1910-2025 --csv     # if CSV export wanted too
   ```
   Run in background; it prints per-season row counts + a final size table.

3. **Verify the full build** — career records must be EXACT (this is a records app):
   - HR: Bonds 762, Ruth 714, Aaron 755, Mays 660, Henderson 296 (Retrosheet value, not 297).
   - SB: **Henderson 1,406** (the key fix vs replay's 1,398), Brock 938, Coleman 752.
   - R: Henderson ~2,295, etc. (small provenance drift OK; should be far closer than replay).
   - 2023 date-filtered HR = 5,868.
   Write/extend a `verify_stat.py` or reuse the inline checks from this session's transcript.
   Cross-check season totals vs Lahman AL/NL/FL (reuse the direction-aware idea from
   `crosscheck_bl2e.py`); pre-1910 absent, Negro/Federal make BL2S run higher (expected).

4. **Update docs**: in `pbp-stat-format.md` flip Decision 10 to "RESOLVED: A (all stats from
   plays.csv)"; mark S1b done in the build-status; note replay was prototyped + rejected
   (now removed from code — it lives in git history, commit `cbc0d3e` era).

5. **Commit** the plays.csv-sourced builder + rebuilt `stat_*.bl2s.gz` (supersedes the S1
   BL2E-sourced files — same paths, new gpid scheme + added SB/CS/R).

## Remaining phases

- **S2 — Lahman complement.** Backfill coverage Retrosheet lacks, at SEASON grain (one
  end-of-season cell, no intra-season motion): pre-1910, gaps, and the *complete* Negro
  Leagues (Lahman has official NeL totals Retrosheet only partially reconstructs). Source:
  `data/batting_limits_1871-2025.csv`. For each (player, year) Lahman has but Retrosheet's
  stat files don't (or under-cover), add a cell at that season's end date (e.g. Oct 1) with
  the season total. Keep Retrosheet where it exists (finer + animatable). New players (pre-1910,
  NeL-only) get appended to the dimension. **Keep all converters.** Decide: a separate
  `stat_<name>_lahman` overlay vs merging into the same files (probably merge, flagged by date
  granularity — a season-end cell vs game-date cells).

- **S3 — migrate app to BL2S, remove `.evt`.** Point `script.js`'s `.evt` read path at the
  shared `stat_players` dim + `stat_*.bl2s` files. Relevant `script.js` anchors: the `.evt`
  loader/decoder (`EVT_STATS`, `EVT_DERIVED`, the STEV parser ~`parseEvt`/`decodeStat`), the
  full-history cursor, and `buildSmoothActiveFrontier`. Rate stats (AVG/OBP/SLG/OPS/…) compute
  client-side from component stat files (all components are counting stats). Then delete the
  old `data/pbp/*.evt.gz` and supersede `scripts/build_stat_streams.js`. **Verification (T2/T3,
  UI):** `snap.js` desktop 1440×900 + mobile 390×844, default HR×SB and the Play-by-play
  animation, before/after; URL-hash deep-link round-trips; records on chart read Bonds 762/514,
  Henderson 296/1406. Keep all source→format converters.

## Format quick reference (full spec in pbp-stat-format.md)

- `stat_players.bl2s.gz` (kind 0): `'BL2S'|maj|min|0 | u16 epochY u8 epochM u8 epochD |
  u32 N | N×(u8 idLen+retroID, u8 nameLen+name, u16 birthYear, u8 bats)`. gpid = array index.
- `stat_<name>.bl2s.gz` (kind 1): `…|1 | u8 nameLen+name | epoch | u32 nPlayers |
  nPlayers×(varint gpidDelta, varint nCells, nCells×(varint dateDelta, varint count))`.
- date = days since **1910-04-14** (u16-safe, verified). Decoder: `decode_stat.py`.
- Stats built: PA AB H 2B 3B HR RBI BB IBB SO HBP SF SH GIDP **SB CS R** G.
  Column→stat map + runner attribution rules are in `build_stat_files.py` (`BATTER_FLAG`,
  `SB_SRC`/`CS_SRC`/`RUN_COLS`).
