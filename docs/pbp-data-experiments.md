# PBP data — size, memory & event-packing experiments

Measurements of the play-by-play (PBP) dataset: how big it is, what it costs to
hold fully in memory, and how small a true *event-level* play-by-play corpus
could be. All numbers below are **measured** unless tagged *(modeled)*. Repro
commands are included so a cold start can re-run them.

> TL;DR
> - The committed PBP corpus is **game-aggregated**, not play-level: 106 batting
>   seasons (1920–2025), **5.07 M player-game records**, ~11 MB on disk.
> - Decoding **all** of it into the current structure costs **~690 MB** (≈920 MB RSS)
>   — a **columnar + min-int** layout cuts that to **~88 MB** (~7.8×), same O(1) access.
> - A purpose-built **event-level** corpus (which we do *not* currently have) would
>   fit in **~5 MB** (outcomes only — enough for every stat we chart) to **~45 MB**
>   (full fidelity incl. pitch-by-pitch). Measured per-event cost: **~2.3 bits**
>   (outcome) to **~11–15 bits** (full self-contained event).

---

## 1. Dataset scale (the committed `.bl2p` corpus)

The committed files are `data/pbp/b<year>.bl2p.gz`, **batting only**, 1920–2025
(the pitching corpus was never generated). Each record is one player's batting
line for one game (per-game deltas, bit-packed, gzipped; the client prefix-sums
to cumulative-by-date). See `docs/pbp-data-format.md` for the format.

| | Value |
|---|---|
| Seasons (files) | 106 (1920–2025) |
| Compressed on disk | ~11 MB (66 KB–159 KB/file) |
| Columns per record (C) | 17 (G, AB, R, H, 2B, 3B, HR, RBI, SB, CS, BB, SO, IBB, HBP, SH, SF, GIDP) |
| **Player-game records (ΣG)** | **5,070,007** |
| Player-season entries (ΣP) | 96,166 (avg ~908 players/season) |
| Biggest season | 2019 — 71,685 records, 1,410 players, 185 game-dates |
| Smallest season | 1920 — 26,493 records, 516 players, 172 game-dates |

Batting events the records sum to (derived from the delta columns):

| Event | Total | | Event | Total |
|---|---:|---|---|---:|
| **Plate appearances** | **14,681,579** | | Home runs | 324,718 |
| At-bats | 13,079,102 | | Stolen bases | 216,545 |
| Hits | 3,415,995 | | Strikeouts | 2,140,871 |
| Walks | 1,253,613 | | RBI | 1,605,956 |

For contrast, the season-level Lahman data the app normally plots is **128,598
player-seasons**; on a counting-stat pair like HR×SB those collide onto an integer
lattice and dedup to only **~1,900 distinct dots** (the cheap render case).

**Repro:** `node scripts/pbp_size_experiment.js` (prints §1).

---

## 2. Memory experiment — full PBP resident in RAM

How much does holding **all 106 seasons** decoded cost, and can we shrink it?
Measured in Node (`--expose-gc`, `process.memoryUsage()`), decoding every season
into the structure the browser actually builds.

The decoded structure per season is `perPlayer: Map<name, {dateIdx, cum}>` where
`cum` is **C separate `Int32Array`s per player** (cumulative within the player's
games). Two costs dominate.

| Layout | Managed mem (heap+external) | RSS | As-of access | |
|---|---:|---:|---|---|
| **Current** (per-player, `Int32`) | **~690 MB** | ~920 MB | O(1) | what OOM-crashes a tab |
| **Columnar + per-column min int** | **~88 MB** | ~133 MB | O(1) | **~7.8× smaller, drop-in** |
| In-memory bit-packed deltas + lazy prefix-sum *(modeled)* | ~40 MB | — | O(√n)–O(n) | CPU trade-off |
| `.gz` on disk (reference) | 11 MB | — | — | unusable without decode |

Why 690 MB splits in two, and what the fixes do:

1. **`Int32` is ~4× too wide** (external 324 MB → 84 MB). Cumulative *season* totals
   are tiny; a per-column width chooser picked **1 byte (`Uint8`) for 16 of 17 columns**
   — only `AB` needs 2 bytes (and `H` in a 262-hit Ichiro-2004 season). Average:
   **1.06 bytes/value** vs 4.
2. **1.6 M typed-array objects** (367 MB heap → 4 MB). The current layout gives each
   of the 96,166 players its own `cum` object with 17 `Int32Array`s → ~1.6 M typed
   arrays, and V8's per-object header overhead dwarfs the data. Going **columnar**
   (one array per column per *season*, length G, plus a `playerStart[]` index)
   collapses that to ~1,800 arrays. Heap went **370 MB → 4 MB**.

Both keep O(1) as-of lookup (`col[playerStart[pi] + k]` instead of
`perPlayer[name].cum[col][k]`), so the animation stays ~2 ms/frame.

**Implementation sketch (if we ever want the full corpus resident):** change
`parseBl2p` to emit `{ playerStart: Uint32Array(P+1), names, col: { name: TypedArray }, dateIdxAll }`
with the smallest int type per column; update `pbpPointsAsOf` to index via
`playerStart`. Localized change.

**Production note:** the app never hits this — the `pbpReleaseFarYears` logic keeps
only ~7 seasons decoded (~45 MB), re-decoding on a backward scrub. The optimization
matters only for a hypothetical "whole-corpus resident" mode (e.g. instant scrubbing
across all history with zero load latency), which at ~88 MB becomes feasible.

**Repro:** `node --expose-gc scripts/pbp_size_experiment.js current` and
`… optimized` (one layout per process — measuring both in one run pollutes the
heap deltas). The optimized variant prefix-sums columnar and picks `Uint8/Uint16/Int32`
per column by its max cumulative value.

---

## 3. Event-packing experiment — how small can a *play* get?

The committed corpus stores game totals, not plays. This experiment measures what a
true **event-level** play-by-play corpus would cost, by parsing real Retrosheet
event files and entropy-/gzip-encoding them.

**Source & method.** Downloaded `https://www.retrosheet.org/events/<year>eve.zip`
(CC BY-SA-compatible, same provenance as the existing PBP data) for **2023** (modern,
full pitch data) and **1955** (pre-pitch-data era). Parsed the `play,inning,side,
batter,count,pitches,event` records directly (no Chadwick needed), classified each
`event` string into outcome classes, and measured Shannon entropy + real
bit-packed-then-gzip sizes.

### Measured per-event cost

| Metric | 1955 | 2023 | *(modeled, §earlier)* |
|---|---:|---:|---:|
| Plays parsed | 104,606 | 217,862 | |
| Plate appearances | 92,539 | 184,104 | |
| **Pitches per PA** | **0.45** | **4.00** | 3.8 |
| **Outcome entropy** | **2.23 b/PA** | **2.34 b/PA** | 2.15 |
| Outcome-only (1 B/PA → gzip) | 2.74 b/PA | 2.85 b/PA | — |
| **Full event record¹ (→ gzip)** | **11.2 b/ev** | **14.6 b/ev** | ~16 |
| Pitch-symbol entropy | 2.26 b/pitch | 2.32 b/pitch | 2.2 |
| Pitch stream (1 B/pitch → gzip) | — | 2.66 b/pitch | — |

¹ Record = inning + half + batter (within-game index) + outcome class + pitch count.

2023 outcome distribution (PA share): BIP-out 43.1%, **SO 22.7%**, 1B 14.1%, BB 8.6%,
2B 4.5%, HR 3.2%, HBP 1.1%, SF 1.1%, ROE 0.6%, 3B 0.4%, FC 0.4%, SH 0.2%.

### Findings

1. **A play's outcome is ~2.3 bits.** Measured 2.23 (1955) → 2.34 (2023). A real
   entropy coder reaches that; gzip-of-bytes lands ~2.7–2.85 (per-symbol overhead).
   Every batting stat the app charts is reconstructable from this stream.
2. **A full self-contained event is ~11–15 bits (≈1.4–1.8 bytes), measured post-gzip.**
   1955 is smaller because its all-zero pitch-count field compresses away.
3. **Pitch sequences are genuinely modern-only.** 1955 = **0.45 pitches/PA** (none
   recorded) vs 2023 = **4.00**. The ~2.6 b/pitch layer applies only from ~1988 on,
   so the pre-1988 corpus is pitch-free and cheaper.
4. **Outcome entropy drifts up over time** (2.23 → 2.34) with the modern strikeout
   era (2023 SO rate 22.7% vs all-era 14.6%), so the all-era average is ~2.25–2.3 b/PA.
5. **The model held:** *(modeled)* event+pitches full corpus = 46.4 MB vs **measured
   (2023-scaled) 46.3 MB.**

### Full-corpus projection (16.4 M events, measured-anchored)

| Layer | Size | Reproduces |
|---|---:|---|
| **Outcome-only** | **~4.5–5.5 MB** | every batting stat, at *play* granularity |
| **Full event records** | **~25–28 MB** | situational play-by-play, box scores |
| **+ pitch sequences** (post-1988) | **+~15–18 MB** | counts, pitch-by-pitch |
| Event + pitches (full fidelity) | **~45 MB** | everything |

So event-level play-by-play for 106 years is feasible in **~5 MB** (stats) to
**~45 MB** (full) — the "stats at play granularity" tier is *less than half* the size
of today's 11 MB game-aggregated format, at far finer resolution.

**The big lever — replay decoding** *(modeled, not yet measured)*: inning, outs, base
state, and batter are deterministic if you re-simulate the game, so a stream decoder
need only store the non-deterministic part (outcome + runner advances + substitution
flags ≈ 5.5 b/event). That would put a fully replayable 106-year corpus near **~7–11 MB**.

**Repro:**
```
cd /tmp && curl -sL -o 2023eve.zip https://www.retrosheet.org/events/2023eve.zip
unzip -q 2023eve.zip -d 2023eve
node scripts/pbp_event_experiment.js /tmp/2023eve
```
(`scripts/pbp_event_experiment.js` parses the `play,` records, classifies the
`event` string into outcome classes, and gzips a 1-byte/PA outcome stream and a
packed event record. Try a pre-1988 season too, e.g. `1955eve.zip`.)

---

## 4. Takeaways / open directions

- The current game-aggregated format is well-tuned for what it stores (11 MB for
  5 M game records), but it is *not* event-level.
- If memory for a whole-corpus-resident mode ever matters, **columnar + min-int**
  is a clean ~7.8× win with no access-pattern change.
- An **event-level** corpus is surprisingly cheap: a few MB for outcomes (enough to
  drive every chart in this app at play resolution), ~25–45 MB for full fidelity.
  The next concrete step would be a converter emitting a `b<year>.evt` outcome/replay
  stream from Retrosheet event files, and measuring the real codec across all 106
  seasons (rather than scaling a single modern season).
