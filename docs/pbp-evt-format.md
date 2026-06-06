# `.evt` (STEV) single-stat event-stream format

A compact, self-contained per-stat timeline for animating **one counting statistic**
across all of MLB history. Motivated and sized in
[`pbp-data-experiments.md`](pbp-data-experiments.md) §5: a single counting stat is a
sparse event set (HR = 324,718 events, SB = 216,545), so storing just the game-dates
where each player's total increased is ~20× smaller than the general 17-column
`.bl2p` corpus and small enough to hold **all of history resident** (~2 MB), enabling
instant full-history scrubbing with no per-season streaming.

Built by [`scripts/build_stat_streams.js`](../scripts/build_stat_streams.js) from the
committed `data/pbp/b*.bl2p.gz` corpus; consumed by the standalone demo
[`evt-demo.html`](../evt-demo.html) / [`evt-demo.js`](../evt-demo.js).

```
node scripts/build_stat_streams.js          # writes data/pbp/hr.evt.gz, sb.evt.gz
node scripts/build_stat_streams.js HR SB RBI
```

## Files

`data/pbp/<stat>.evt.gz` — one gzipped file per stat (e.g. `hr.evt.gz`, `sb.evt.gz`).
Committed (like the `.bl2p.gz`) so the demo works on GitHub Pages with no build step.
Current sizes: `hr.evt.gz` ≈ 358 KB, `sb.evt.gz` ≈ 264 KB.

The server must send `.gz` as **raw bytes** (Content-Type `application/gzip`, no
`Content-Encoding`) so the browser's `DecompressionStream("gzip")` sees the gzip
bytes — Python's `http.server` does this, same as for `.bl2p.gz`.

## Layout (little-endian)

Decompress the gzip, then parse:

| Field | Type | Notes |
|---|---|---|
| magic | `"STEV"` (4 B) | |
| version | `u8` | = 1 |
| stat name | `u8 len` + UTF-8 | e.g. `"HR"` |
| `numDates` | `u16` | global game-dates (1920–2025 ⇒ 18,137) |
| `numSeasons` | `u16` | |
| seasons | `numSeasons × { u16 year, u16 nDates }` | global-date → calendar **year** |
| dayOfYear | `numDates × u16` | global-date → month/day (for labels) |
| `numPlayers` | `u32` | |
| player dict | `numPlayers × { u8 nameLen, UTF-8 name }` | display names |
| event blocks | `numPlayers ×` … | same order as the dict |

Each player's event block:

```
varint nEvents
nEvents × ( varint dateDelta,   // gap in global game-dates from the previous event (≥0)
            varint count )      // how much the stat increased on that game-date (usually 1)
```

`varint` = unsigned LEB128 (7 bits/byte, low byte first, high bit = continuation).

## Decoding

Prefix-sum each player's block into two parallel arrays:

- `dates[k] = dates[k-1] + dateDelta` → global game-date of the k-th increase
- `cum[k]   = cum[k-1]   + count`     → cumulative stat **as of** that date

Both fit in `Uint16Array` (max global date 18,137 < 65,536; max career HR 762, SB
1,406). The cumulative value as of any cursor date `d` is a binary search for the
last `dates[k] ≤ d`, returning `cum[k]` (or 0 before the player's first event). The
global date maps to a calendar date via the season table (year) + `dayOfYear[d]`.

A player may appear in one stat's file but not another's; the consumer takes the
**union** by name and treats a missing series as 0.

## Properties

- **Resident, not streamed.** Decoded, HR+SB for 1920–2025 is ~2 MB in RAM — load
  once, scrub anywhere instantly. None of the `.bl2p` lazy-load / prefetch / release /
  OOM machinery is needed.
- **Axis-specific.** Each file carries exactly one counting stat. Switching the chart
  to a different pair needs different `.evt` files; **rate** stats (AVG, OBP, …) are
  not sparse and would need their numerator+denominator components instead — the
  general `.bl2p` format remains the "any axis" path. See `pbp-data-experiments.md` §5.
- **Batting only**, 1920–2025 (the extent of the committed `.bl2p` corpus).
