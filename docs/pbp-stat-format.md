# `BL2S` normalized per-stat layer

A normalized redesign of the single-stat timeline layer (supersedes `.evt`/STEV): the
player identity is factored into **one shared dimension file**, and each counting stat is
its own date-keyed file referencing players by a small integer `gpid`. Built by
[`scripts/build_stat_files.py`](../scripts/build_stat_files.py) from the BL2E event corpus;
read by [`scripts/decode_stat.py`](../scripts/decode_stat.py). Encoding chosen empirically
in [`scripts/statfile_experiment.py`](../scripts/statfile_experiment.py).

## Why this exists / how it differs from `.evt`

`.evt` worked but re-embedded a full player name dict in **every** stat file. BL2S:
- **one shared `stat_players` dimension** (gpid → retroID, name, birthYear, bats), loaded once;
- **one file per stat**, holding only `(gpid, date, count)` — no names;
- **absolute date key** = days since **1910-04-14** (corpus's earliest game), u16-safe
  (span 42,171 days; ~64yr headroom — verified across the corpus);
- sourced from **BL2E** (1910–2025, incl. Negro-League ~1920–48 and Federal-League 1914–15),
  vs `.evt`'s narrower `.bl2p`-derived 1920–2025 AL/NL.

**Encoding decision (measured):** per-player varint date-deltas beat columnar-absolute ~2×
and gzipped-CSV ~4×; **grouping several stats per file does NOT help post-gzip** (gzip + the
per-player grouping already capture the shared-addressing win; uncorrelated groups get
*worse* from zero-padding). So: one file per stat. Numbers in `statfile_experiment.py`.

## Data strategy — Retrosheet primary, Lahman complement

Retrosheet (→ BL2S) is the fine-grained, date-keyed, *animatable* layer for 1910–2025.
Lahman stays the authoritative season/career source and **backfills coverage Retrosheet
lacks** — pre-1910, gaps, and the complete Negro Leagues — at season grain (one end-of-season
cell, no intra-season motion). All source→format converters are kept so any layer regenerates.

## Build status (update each session)

- [x] **S1** — `BL2S` format + builder for **batter-attributed** stats: shared
  `stat_players.bl2s.gz` + `stat_<name>.bl2s.gz` for PA, AB, H, 2B, 3B, HR, RBI, BB, IBB,
  SO, HBP, SF, SH, GIDP, G. Built 1910–2025 (~13.9 MB total). Verified: round-trips; career
  HR exact (Bonds 762, Ruth 714, Aaron 755, Mays 660; Henderson 296 = our pipeline's value);
  2023 HR date-filtered = 5,868 (exact).
- [x] **S1b** — runner-attributed **SB, CS, R** — **DONE (option A)**. `build_stat_files.py`
  now sources ALL stats directly from `plays.csv` (one exact pass); runner stats use the real
  `br*_pre` (SB/CS) and `run*` (R) identities, so substitutions are handled and records are
  exact: **Henderson SB 1,406**, Brock 938, Coleman 752. The BL2E replay (which landed ~1,398)
  was rejected and removed (it lives in git history). Whole layer is now plays.csv-sourced.
- [ ] **S2** — Lahman complement (pre-1910 / gaps / full Negro Leagues), season grain.
- [ ] **S3** — migrate `script.js` off `.evt` onto the shared dim + `stat_*`; remove the old
  `.evt` data and supersede `build_stat_streams.js`. Keep all source→format converters.

## Design decisions (rationale + open items)

Durable record of *why* this layer is shaped as it is. Numbered for reference.

1. **Normalize (shared dimension + per-stat facts).** The old `.evt` re-embedded a full
   player name dict in *every* stat file (a 20-year player stored 20×). BL2S factors identity
   into one `stat_players` file; stat files hold only `(gpid, date, count)`. Star schema:
   one dimension, many fact files.
2. **Encoding = per-player varint date-deltas** (the `.evt`-style "B"). *Measured*
   (`statfile_experiment.py`, full corpus): beats columnar-absolute ~2× and gzipped-CSV ~4×
   on every stat (e.g. HR 337 KB vs 651 vs 832).
3. **One file per stat; grouping rejected for size.** *Measured*: grouping correlated stats
   (hit types) saved only ~3%, and grouping uncorrelated stats (BB/SO/HBP) was ~4% *worse*
   (zero-padding). gzip + per-player grouping already capture the shared-addressing win.
   Grouping is reserved only for *fetch-count* convenience (e.g. bundling a rate stat's
   components into one request) — a delivery choice, not a compression one.
4. **Date key = u16 days since 1910-04-14.** *Verified* against the corpus: span 1910-04-14 →
   2025-09-28 = 42,171 days, ~64 yr of u16 headroom (good to ~2089). `(yearOffset<<9 |
   dayOfYear)` is also exactly 16 bits if calendar structure is ever preferred.
5. **Common `stat_` filename prefix** so the family sorts contiguously in `data/pbp/` instead
   of scattering among `b*.bl2p.gz` / `e*.bl2e.gz` / `*.evt.gz`.
6. **Both binary and CSV.** Binary (gzipped, `gpid`-referenced) is the shipped/app artifact;
   a gzipped per-stat CSV export (`--csv`) is the analysis/portability form (~2.5× the binary).
7. **Source strategy: Retrosheet primary, Lahman complement.** Retrosheet (→ BL2S) is the
   fine-grained, date-keyed, *animatable* layer for 1910–2025 (incl. Negro ~1920–48 / Federal
   1914–15). **Lahman is NOT dropped** — it stays the authoritative season/career source and
   backfills coverage Retrosheet lacks (pre-1910, gaps, *complete* Negro Leagues) at season
   grain (one end-of-season cell, no intra-season motion). [S2]
8. **All source→format converters are kept** (`convert_csv_lahman*`, `build_bundle`,
   `convert_retrosheet_pbp`, `convert_retrosheet_events`, `build_bl2e_corpus`, `build_stat_files`)
   so every layer regenerates from raw sources, even as shipped formats change.
9. **BL2S supersedes `.evt`** (user decision) rather than coexisting — the app's `.evt` read
   path migrates to the shared dim + `stat_*`, and the old `.evt` data is removed. [S3]
10. **Batter stats exact from BL2E; runner stats (SB/CS/R) need an exact non-replay source.**
    Batter-attributed stats (HR/H/BB/SO/…) derive unambiguously from the BL2E `outcome` column
    and are *verified exact* (Bonds 762, 2023 HR 5,868). Runner-attributed stats can't be
    replayed exactly from BL2E (Decision in S1b: substitutions aren't stored → pinch-runner
    mis-credit, ~0.5–1.5% off). **OPEN — pick the exact source:**
    - **A. re-read `plays.csv`** (`br*_pre` for SB/CS, `run*` for R): exact, full 1910–2025 +
      Negro/Federal (matches batter-stat coverage), but re-downloads ~500 MB of season files;
      optionally re-derive *all* stats from `plays.csv` for one clean exact pass.
    - **B. use committed `.bl2p`** (`b_sb`/`b_cs`/`b_r`, what `.evt` used → Henderson 1,406 exact):
      no download, but 1920–2025 AL/NL only → *narrower* than the batter stats.
    **RESOLVED: A** — all stats re-derived from `plays.csv` in one exact pass.
    `build_stat_files.py` downloads each season's `plays.csv`, credits batter stats from the
    row's own count columns and runner stats from the real `br*_pre`/`run*` identities. Built
    1910–2025: 17,698 players + 18 stats = 15.3 MB. Verified exact: Bonds 762 HR, Henderson
    1,406 SB, Brock 938, Coleman 752. (gpid is now first-appearance order, opaque — map via
    the dimension. This rebuild superseded the earlier BL2E-sourced S1 files in place.)

## File layout (little-endian, gzipped; common `stat_` prefix)

**`stat_players.bl2s.gz`** (the dimension):
```
'BL2S' | u8 major | u8 minor | u8 kind=0
u16 epochYear | u8 epochMonth | u8 epochDay        -- 1910-04-14
u32 playerCount
playerCount × ( u8 idLen + retroID | u8 nameLen + displayName | u16 birthYear | u8 bats )
              -- gpid = array index; bats 0=R 1=L 2=B 3=?
```

**`stat_<name>.bl2s.gz`** (one per stat):
```
'BL2S' | u8 major | u8 minor | u8 kind=1
u8 nameLen + statName
u16 epochYear | u8 epochMonth | u8 epochDay
u32 nPlayers                                       -- players with ≥1 cell
nPlayers × (                                       -- ascending gpid
  varint gpidDelta | varint nCells |
  nCells × ( varint dateDelta, varint count )      -- date = days since epoch
)
```

## Decoding

`decode_players()` → `players[gpid] = (retroID, name, birthYear, bats)`.
`decode_stat()` → `series[gpid] = [(date, count), …]`; prefix-sum dates for the absolute
day, map via epoch to a calendar date. A rate stat (AVG/OBP/…) is computed client-side from
its component stat files (all components are counting stats). The value as of a cursor date
is a binary search for the last `date ≤ cursor`, summing counts.

Served as raw `.gz` bytes (Content-Type `application/gzip`, no `Content-Encoding`), like the
other `data/pbp/` blobs.
