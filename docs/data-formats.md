# Data formats — canonical reference

**Direction (decided 2026-06-12, binding):** the end-state data layer is three formats —
**Lahman CSVs** (canonical seasons), **BL2S** (the app's animatable per-stat layer),
**BL2E** (archival event-grain source of truth) — plus **BL2D** for the offline bundle.
`.evt`/STEV and **BL2P** are transitional and are removed by the S3/S4 phases in
[`ROADMAP.md`](ROADMAP.md). All source→format converters are kept so every layer
regenerates from raw sources.

## Layer map

| Layer | Grain | Files | Builder | Consumed by | Status |
|---|---|---|---|---|---|
| Lahman CSVs | player × season | `data/*_limits_1871-2025.csv` | `convert_csv_lahman*.py` | app static views, season points, bundle | **live** (canonical seasons) |
| BL2D | player × season blob | inlined in `dist/index.html` | `build_bundle.py` | offline bundle | **live** |
| BL2E | one play/event | `data/pbp/e1910..e2025.bl2e.gz` (76.8 MB) | `convert_retrosheet_events.py` | nothing at runtime (research/archival) | **archival** |
| **BL2S** | one stat, star schema | `data/pbp/stat_*.bl2s.gz` (batting 20 + pitching 25 = 45 files, ~17 MB) | `build_stat_files.py` | nothing yet — S3 wires it in | **current target** |
| `.evt` / STEV | one stat, sparse timeline | `data/pbp/*.evt.gz` (40 files, ~13 MB) | `build_stat_streams.js` | the app's smooth mode today | **deprecated — removed at S3d** |
| BL2P | player × game | `data/pbp/b1920..b2025.bl2p.gz` (~12 MB, batting only) | `convert_retrosheet_pbp.py` | rate-stat smooth fallback, group-career animation | **deprecated — removed at S4** |

**What the app reads today:** Lahman CSVs (static + season points), `.evt` (smooth mode —
auto-enabled for every eligible axis pair), `.bl2p` (rate-stat-pair fallback +
group-career). BL2S is committed and verified but unread until S3b.

**Serving note (applies to every `data/pbp/*.gz`):** the server must send `.gz` as raw
bytes (Content-Type `application/gzip`, **no** `Content-Encoding`) so the browser's
`DecompressionStream("gzip")` sees the gzip bytes — Python's `http.server` does this.
`file://` (the bundle) can't fetch these at all → static fallback, by design.

---

## BL2S — normalized per-stat layer (the target)

A star schema: player identity factored into **one shared dimension file**
(`stat_players.bl2s.gz`), each counting stat its own date-keyed file referencing
players by a small integer `gpid` (= array index, first-appearance order — **all stat
files must be rebuilt together with the dimension** if the builder re-runs). Built by
`scripts/build_stat_files.py` directly from Retrosheet `plays.csv` (one exact pass;
runner stats from the real `br*_pre`/`run*` identities); read by
`scripts/decode_stat.py`. Coverage 1910–2025 incl. Negro (~1920–48) and Federal
(1914–15) Leagues: 17,698 players × 18 stats (PA, AB, H, 2B, 3B, HR, RBI, BB, IBB, SO,
HBP, SF, SH, GIDP, G, SB, CS, R). Verified exact: Bonds 762 HR, **Henderson 1,406 SB**,
Brock 938, Coleman 752; 2023 totals == Lahman.

### File layout (little-endian, gzipped; common `stat_` prefix)

**`stat_players.bl2s.gz`** (kind 0, the dimension):
```
'BL2S' | u8 major | u8 minor | u8 kind=0
u16 epochYear | u8 epochMonth | u8 epochDay        -- 1910-04-14
u32 playerCount
playerCount × ( u8 idLen + retroID | u8 nameLen + displayName | u16 birthYear | u8 bats )
              -- gpid = array index; bats 0=R 1=L 2=B 3=?
```

**`stat_<name>.bl2s.gz`** (kind 1, one per stat):
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

**`stat_dates.bl2s.gz`** (kind 2 — added in S3a, format MINOR 0→1): the global
game-date table the cursor steps over:
```
'BL2S' | u8 major | u8 minor | u8 kind=2
epoch (as above) | u32 nDates | nDates × varint dateDelta
```

**Pitching layer (S3a, shipped):** `stat_p_players` / 23 × `stat_p_<stat>` /
`stat_p_dates` (epoch **1871-01-01**, so pitching keeps 1871–2025), built from Lahman
season totals (`build_stat_files.py --pitching`; one season-end cell per player-season at
Oct 1, stints summed; the 23 counting columns — BAOpp/ERA are client-side rate stats).
The dimension's **retroID slot holds the opaque Lahman `playerID`** (stable identity) and
its **handedness byte holds `throws`** (pitchers are colored by throwing arm), reusing the
0=R/1=L/else=3 encoding the batting dimension uses for `bats`. Batting's own
`stat_dates.bl2s.gz` (epoch 1910-04-14) is built `--dates-from-pa` (union of the committed
`stat_pa` cell dates — no plays.csv re-download).

### Decoding

`decode_players()` → `players[gpid] = (retroID, name, birthYear, bats)`.
`decode_stat()` → `series[gpid] = [(date, count), …]`; prefix-sum the date-deltas for
absolute days, map via the epoch to calendar dates. `decode_dates()` → `{epoch, dates}`
(the kind-2 global game-date table, prefix-summed epoch-days). Rate stats (AVG/OBP/…) are computed
client-side from component counting-stat files. Value as of a cursor date = binary
search for the last `date ≤ cursor`, summing counts. Player `displayName` comes from
`build_retro_to_display` — the same Lahman-disambiguated `(b.YYYY)` names the app's
`metaFor()` expects.

### Design decisions (durable rationale; numbered)

1. **Normalize** — `.evt` re-embedded a full name dict in every stat file (a 20-year
   player stored 20×); BL2S stores identity once.
2. **Encoding = per-player varint date-deltas** — *measured* (`statfile_experiment.py`,
   full corpus): beats columnar-absolute ~2× and gzipped-CSV ~4× on every stat
   (e.g. HR 337 KB vs 651 vs 832).
3. **One file per stat; grouping rejected** — *measured*: grouping correlated stats
   saved ~3%, uncorrelated was ~4% *worse* (zero-padding). Grouping is only ever a
   fetch-count convenience, never a compression win.
4. **Date key = days since 1910-04-14, u16-safe** — corpus span 42,171 days, ~64 yr
   headroom (good to ~2089).
5. **Common `stat_` prefix** so the family sorts contiguously in `data/pbp/`.
6. **Binary is shipped; a gzipped per-stat CSV export (`--csv`)** is the
   analysis/portability form (~2.5× the binary).
7. **Retrosheet primary, Lahman complement** — Retrosheet (→ BL2S) is the date-keyed
   animatable layer 1910–2025; Lahman stays the authoritative season/career source and
   backfills pre-1910 / gaps / complete Negro Leagues at season grain (S2, see ROADMAP).
8. **All converters kept** so every layer regenerates from raw sources.
9. **BL2S supersedes `.evt`** (user decision) rather than coexisting.
10. **Runner stats need plays.csv identities** — BL2E replay can't credit pinch-runners
    (substitutions aren't stored, ~0.5–1.5% off); resolved by sourcing *all* stats from
    `plays.csv` in one pass (S1b).

---

## BL2E — event-grain archival corpus

The finest grain: **one record per play** (a 2-HR game is two rows). Built from
Retrosheet's parsed `plays.csv` (177 pre-expanded columns — no event-grammar parsing,
no Chadwick) by `scripts/convert_retrosheet_events.py`; corpus driver
`scripts/build_bl2e_corpus.py` (per-season download → convert → clean; resumable).
Coverage 1910–2025, 116 files, 76.8 MB, incl. Negro/Federal-League play the AL/NL
Lahman slice lacks. Verified by exact round-trip (15 cols + batter id), base-out
replay, and direction-aware cross-checks vs Lahman / Retrosheet column sums
(`decode_bl2e.py`, `verify_bl2e.py`, `crosscheck_bl2e.py`).

**Role:** archival source of truth and research corpus; nothing reads it at runtime
(BL2S sources plays.csv directly since S1b). Kept because it is the only local
event-grain record and the basis for any future pitch-by-pitch work.

### Layers

- **A — event core**: context + outcome + outs + runs/rbi + per-entity advance
  disposition + a 20-bit flags bitfield. Reproduces every charted stat and the
  base-out state via replay.
- **B — pitch sequences** (header flags bit0; `--no-pitches` to omit): per-event pitch
  symbols (post-1988).
- **C — fielding detail** (flags bit1, opt-in `--fielding`, NOT in the corpus):
  f2–f9, umpires, loc/fseq/hittype, errors. +~44 b/event.

**Size decision (resolved — keep explicit):** `batterIdx`/`pitcherIdx`/context are
replay-derivable (~20 of ~33 bits/event) but kept explicit so a single event reads
without re-simulating its game. Accepted: ~68 MB Layer A, ~86 MB with pitches.

### Byte layout (little-endian) — v1.0

```
HEADER:  'BL2E' | u8 major | u8 minor | u8 flags (bit0=hasPitches, bit1=hasFielding)
         | u16 year | u32 eventCount E | u16 gameCount Gn | u16 playerCount P
         | u16 teamCount T | u16 colCount C
TEAM DICT:    T × (u8 len + team code)
COLUMN META:  C × (u8 bitWidth + u8 nameLen + name)        -- self-describing
PLAYER DICT:  P × (u8 idLen + retroID + u8 nameLen + displayName)  -- keyed by retroID
GAME TABLE:   Gn × ( u16 dayOfYear | u8 visTeamIdx | u8 homeTeamIdx
                     | u32 firstEventIdx | u8 gidLen + gid )
EVENT PAYLOAD: per column, E values × bitWidth bits (LSB-first, byte-padded per column)
LAYER B (flags bit0): pitch-symbol alphabet + per-event lengths + packed symbol stream
LAYER C (flags bit1): self-describing columns + umpire/value dicts + packed payload
```

Events are grouped by game (chronological), within a game in `pn` order; the game
table's `firstEventIdx` maps any event back to its game by binary search.

Columns (Layer A payload order): `inning, half, batTeam, batterIdx, pitcherIdx,
bathand, pithand, outcome, outsPre, outsPost, runs, rbi, dispB, disp1, disp2, disp3,
flags`. **Outcome enum (4 b):** 0 NONE, 1 OUT, 2 K, 3 BB, 4 IBB, 5 HBP, 6 1B, 7 2B,
8 3B, 9 HR, 10 ROE, 11 FC, 12 SH, 13 SF, 14 XI, 15 NOOUT. **Disposition enum (3 b):**
0 ABSENT, 1 OUT, 2 STAY, 3 TO1, 4 TO2, 5 TO3, 6 SCORE (runner identities not stored —
a replay decoder re-threads them). **Flags bits:** iw, sb2, sb3, sbh, cs2, cs3, csh,
pko1-3, wp, pb, bk, oa, di, gdp, othdp, tp, fle, k_safe.

---

## BL2D — offline-bundle blob

The single-file `dist/index.html` inlines two base64 gzipped BL2D blobs (batting +
pitching): magic `'BL2D'|major|minor|year_base|row_count`, little-endian columnar with
name/team/people dictionaries, u16/u8 per column. Fully specified in
`scripts/build_bundle.py` (the spec lives with the code). ~3.9 MB total, ~20% of the
source CSVs; opens from `file://`. Not part of the deployed site (production serves
the multi-file CSVs).

---

## Lahman CSVs

`data/batting_limits_1871-2025.csv` / `pitching_limits_…` / `people_lahman_…`,
produced from the SABR Lahman release by `convert_csv_lahman*.py` (drops `stint`,
strips NTM rows, rewrites playerID → disambiguated display name via
`_display_name.py`). CC BY-SA 3.0 (see `LICENSE-DATA.md`); refresh procedure in
`README.md`. The pipeline diagram is in `CLAUDE.md` §Data pipeline.

---

## Deprecated formats (specs in git history)

- **`.evt` / STEV** — single-stat sparse timeline (~2 MB resident decoded → instant
  full-history scrubbing), built from `.bl2p` (so 1920–2025 AL/NL batting only).
  Magic `"STEV"`; global date table + per-player varint `(dateDelta, count)` blocks.
  The app's smooth mode today; replaced file-for-file by BL2S in S3b/S3c and deleted
  in S3d. Full spec: `docs/pbp-evt-format.md` in git history (pre-consolidation).
- **BL2P** — per-game counting-stat deltas, bit-packed sparse columnar, one gzipped
  file per season (~150 KB batting). Its remaining consumers (`.evt` builder,
  rate-stat-pair fallback, group-career animation) migrate or retire in S3/S4. Full
  spec: header of `scripts/convert_retrosheet_pbp.py` and `docs/pbp-data-format.md`
  in git history.
- **Measurements** behind all the format choices (size/memory/packing experiments):
  `docs/pbp-data-experiments.md` in git history; the load-bearing numbers are restated
  inline above.

---

## Gotchas (hard-won — don't rediscover)

- **Retrosheet downloads:** `https://retrosheet.org/downloads/{batting,pitching}.zip`
  (~681 MB CSVs, keep in `/tmp`, never commit); per-season `plays.csv` zips fetched by
  `build_bl2e_corpus.fetch_season_csv` (used by `build_stat_files.py`).
- **Filter `stattype == "value"` AND `gametype == "regular"`** — Retrosheet includes
  all-star/postseason rows that inflate totals.
- **Provenance drift:** Retrosheet game-sums ≠ Lahman season totals exactly on older
  seasons; gates must use modern-era records (Bonds/Henderson) or known-exact values;
  never assert byte-equality on rate axes.
- **BB includes IBB** in plays.csv's `walk` column (2023 BB = 15,819, not 15,345).
- **Verification hooks:** `window.__bl2d_verifySpring` (records + GPU invariants),
  `?verifyFrontier=1` (incremental == full sweep), `__bl2d_pbpFrameMs` (frame timing),
  `snap.js` / `poc-webgpu/snap-webgpu.js` (headless).
