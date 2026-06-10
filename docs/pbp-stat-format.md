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
- [ ] **S1b** — BL2E **replay** pass for runner-attributed **SB, CS, R** (credited to the
  baserunner / scorer via threaded identities). Needed: SB is the default chart axis.
- [ ] **S2** — Lahman complement (pre-1910 / gaps / full Negro Leagues), season grain.
- [ ] **S3** — migrate `script.js` off `.evt` onto the shared dim + `stat_*`; remove the old
  `.evt` data and supersede `build_stat_streams.js`. Keep all source→format converters.

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
