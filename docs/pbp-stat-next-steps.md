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
  season. ✅ **2023 validated exact** (HR 5,868, BB 15,819 [walk col is inclusive — not
  15,345], SO 41,843, H 40,839, 2B 8,228, RBI 21,512 all == Lahman; SB 3,503 / CS 866 /
  R 22,432 populated). Builder is correct; full 1910-2025 build was kicked off next.
- The committed S1 stat files are **BL2E-sourced and use a different gpid scheme**
  (sorted-retroID) than the new builder (first-appearance order). The full plays.csv rebuild
  will **overwrite** `stat_players.bl2s.gz` + all `stat_*.bl2s.gz` with a consistent new gpid
  scheme. **All stat files must be rebuilt together** so gpids match the dimension.

## ✅ S1 + S1b DONE — all stats from plays.csv (1910–2025)

Full build complete & verified: 17,698 players + 18 stats (PA AB H 2B 3B HR RBI BB IBB SO
HBP SF SH GIDP SB CS R G) = 15.3 MB. Records exact — Bonds 762 HR, **Henderson 1,406 SB**,
Brock 938, Coleman 752; 2023 batting totals == Lahman. Committed (supersedes the S1
BL2E-sourced files in place; gpid is now first-appearance order). **Remaining: S2, S3.**

## Immediate next steps (resume here) — superseded by the above; kept for reference

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

- **S3 — migrate app to BL2S, remove `.evt`.** Phased plan below (§"S3 phased plan").

## S3 phased plan (resumable — pick up at the first unticked phase)

Decisions already made (2026-06-12 session, binding):
1. **Pitching ports to BL2S too** (new `--pitching` builder mode → `stat_p_*.bl2s.gz` from
   Lahman season totals), so ALL 40 `.evt.gz` files + `scripts/build_stat_streams.js` go away.
2. **Accept the pre-1910 batting regression until S2**: batting gains 1910–1919 exact daily
   animation (Retrosheet), loses the 1871–1909 Lahman season-step animation `.evt` had
   (early careers like Cobb's lose their pre-1910 portion in smooth mode; S2 restores).
   Pitching keeps full 1871–2025 coverage (per-file epoch, see S3a).
3. **POCs are NOT ported** (`poc-webgpu`, `poc-webgpu-spring` parse `.evt` in their C/WASM
   cores); their READMEs get a one-line note that `.evt` was removed (data in git history).

Key feasibility fact (mapped 2026-06-12): everything downstream of `buildEvtModel` is
**shape-agnostic** — `evtPointsAsOf`, `evtOpenSeasonPoints`, `buildEvtEventStream` (GPU),
`evtGpuMonotone`, `evtSeasonSnap`, scrubber (`yearOf`/`doy`), deep-links read only the model
object's fields. The swap is loader-level: new decoders + `loadEvtStat` URL change +
`buildEvtModel` internals; the returned model must be field-for-field identical
(`xDim/yDim/xs/ys/usesQual/qual/thresholdField/depList/numDates/players[{name,comp:{dep:{dates,cum}},debutYear,lastYear}]/doy/yearOf/seasonStartByYear/seasonEndByYear/xMax/yMax/minYear/maxYear`).
Player names: the BL2S dimension's displayName comes from `build_retro_to_display` — the same
Lahman-disambiguated `(b.YYYY)` names `.evt` used, so `metaFor()` (bats/country) is unchanged.

### [ ] S3a — builder: global date-table files + pitching layer

- **Why a dates file:** STEV carried a global game-date table (`numDates`/`seasons[]`/`doy[]`)
  the cursor steps over; BL2S stat files store per-player epoch-days only, and reconstructing
  from the loaded axis pair's union would coarsen the cursor. Emit **`stat_dates.bl2s.gz`**
  (new **kind 2**: `'BL2S'|maj|min|2 | epoch | u32 nDates | nDates×varint dateDelta`) by
  unioning the committed `stat_pa.bl2s.gz` cells (every game date has a PA — no plays.csv
  re-download). ~25–30k dates, <60 KB. Bump format MINOR 0→1.
- **Pitching layer** (`build_stat_files.py --pitching`): source `data/pitching_limits_1871-2025.csv`
  (Lahman season totals, exactly what `build_stat_streams.js --pitching` consumed); names via
  `_display_name.py`. Emits `stat_p_players.bl2s.gz` (kind 0; the retroID slot holds the Lahman
  playerID), 23 `stat_p_<stat>.bl2s.gz` (one season-end cell per player-season, date = Oct 1 of
  the year), `stat_p_dates.bl2s.gz`. **Per-file epoch 1871-01-01** (the header carries epoch per
  file; ~56,600 days to 2025 fits varint/u16-delta fine) → pitching keeps full 1871–2025.
- **Files:** `scripts/build_stat_files.py` (+`--dates-from-pa`, `--pitching`), `scripts/decode_stat.py`
  (kind 2), `docs/pbp-stat-format.md` (kind 2 + pitching spec + decision-log entry), new data files.
- **Gate:** `decode_stat.py` round-trips all new files; dates count == distinct `stat_pa` dates;
  pitching career spot-checks vs Lahman (Cy Young 511 W, Ryan 5,714 SO, Rivera 652 SV).

### [ ] S3b — script.js batting swap (`.evt` files untouched = instant rollback)

- New decoders mirroring `decode_stat.py`: `decodeBl2sPlayers` (kind 0), `decodeBl2sStat`
  (kind 1, prefix-sum day-deltas → `cum`), `decodeBl2sDates` (kind 2); delete `decodeStev`
  only in S3d. `loadEvtStat` (~script.js:1075) fetches `data/pbp/stat_<stat>.bl2s.gz` +
  one-time `stat_players`/`stat_dates` (cached in `evtStreamCache`). `buildEvtModel`
  (~1087–1133): date table from the dates file (epoch-day → calendar via JS `Date` for
  `yearOf`/`doy`; season boundaries = calendar-year runs; epoch-day → index Map for cell
  conversion); iterate by gpid; `player.name` = dimension displayName. `EVT_REGISTRY`
  semantically unchanged.
- **Gate:** Bonds 762/514 + Henderson 296/1406 via `__bl2d_verifySpring` records;
  `?verifyFrontier=1` `mis 0` over a forward+backward scrub; season-mode boundary crossing
  (1953–1955 recipe) + `evtSeasonSnap` lands on season ends; `t=YYYYMMDD` deep-link
  round-trips; `snap.js` desktop+mobile final-frame before/after (only documented early-era
  deltas allowed).

### [ ] S3c — pitching swap

- Route `prefix: "p_"` to `stat_p_*.bl2s.gz` + its own dimension/dates (epoch differs per
  file — the decoder already reads epoch from each header, so no special-casing).
- **Gate:** `ds=pitching` smooth view animates season steps; Ryan 5,714 SO on chart; ERA
  (rate) qualifier behavior unchanged.

### [ ] S3d — removal + deploy

- Delete `data/pbp/*.evt.gz` (40 files), `scripts/build_stat_streams.js`, the now-dead
  `decodeStev`/STEV comments in script.js. `.github/workflows/deploy-pages.yml`: drop the
  `*.bl2s.gz` exclude (~line 79) so `stat_*.bl2s.gz` ships; update its `.evt` comment +
  `docs/pages-preview-deploys.md` size note. POC README notes (decision 3). README backlog
  update (same commit).
- **Gate:** zero `.evt` requests in a full session (server log); bundle builds; `file://`
  bundle still falls back static.

### [ ] S3e (optional) — `qualDeps: ["PA"]`

- BL2S has raw `stat_pa`, so batting rate-stat qualifiers can load 1 file instead of 5
  components. Own commit, only after S3b/S3c parity is green.

### Progress trail

| Phase | Status | Notes / commit |
|---|---|---|
| S3a builder (dates + pitching) | ☐ not started | |
| S3b batting swap | ☐ not started | |
| S3c pitching swap | ☐ not started | |
| S3d removal + deploy | ☐ not started | |
| S3e qualDeps opt (optional) | ☐ not started | |

_Update this table + the `### [ ]` checkboxes in the same commit as each phase._

## Format quick reference (full spec in pbp-stat-format.md)

- `stat_players.bl2s.gz` (kind 0): `'BL2S'|maj|min|0 | u16 epochY u8 epochM u8 epochD |
  u32 N | N×(u8 idLen+retroID, u8 nameLen+name, u16 birthYear, u8 bats)`. gpid = array index.
- `stat_<name>.bl2s.gz` (kind 1): `…|1 | u8 nameLen+name | epoch | u32 nPlayers |
  nPlayers×(varint gpidDelta, varint nCells, nCells×(varint dateDelta, varint count))`.
- date = days since **1910-04-14** (u16-safe, verified). Decoder: `decode_stat.py`.
- Stats built: PA AB H 2B 3B HR RBI BB IBB SO HBP SF SH GIDP **SB CS R** G.
  Column→stat map + runner attribution rules are in `build_stat_files.py` (`BATTER_FLAG`,
  `SB_SRC`/`CS_SRC`/`RUN_COLS`).
