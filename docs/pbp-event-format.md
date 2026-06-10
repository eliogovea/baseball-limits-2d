# `BL2E` event-level play-by-play format

The finest grain in the data hierarchy: **one record per play/event** (a 2-HR game is two
rows). Built from Retrosheet's *parsed* play-by-play CSV by
[`scripts/convert_retrosheet_events.py`](../scripts/convert_retrosheet_events.py). Motivated
and sized in [`pbp-data-experiments.md`](pbp-data-experiments.md) §3. Sits below the other
layers:

| Layer | Grain | Builder |
|---|---|---|
| BL2D (season blob) | player × season | `build_bundle.py` |
| BL2P | player × game | `convert_retrosheet_pbp.py` |
| `.evt` / STEV | one stat, sparse timeline | `build_stat_streams.js` |
| **BL2E** | **one play / event** | **`convert_retrosheet_events.py`** |

## Build status (update at the end of each session)

- [x] **P1** — spec + single-season converter (Layer A). Validated on 2023:
  191,073 events, round-trips, decoded PA = 184,104 (matches `pbp-data-experiments.md`).
- [x] **P2** — decoder (`decode_bl2e.py`) + invariants harness (`verify_bl2e.py`). All pass
  on 2023 + 1955: event-count, full round-trip (15 cols + batter id), replay base-out.
- [x] **P3** — Layer B pitch sequences (`--no-pitches` to omit) + cross-check
  (`crosscheck_bl2e.py`). Pitches round-trip verbatim. Batting totals: 2023 EXACT vs Lahman;
  1955 sub-1% (Retrosheet-vs-Lahman provenance) yet EXACT vs Retrosheet's own column sums.
  With pitches: 2023 = 53.7 b/event (1.28 MB), 1955 = 32.6 b/event.
- [ ] **P4** — full corpus build (1903/1910–2025), resumable. *Last built through: none yet.*
  Needs the combined `plays.zip` or per-season zips; projected ~84 MB committed.
- [ ] **P5** — optional Layer C fielding detail behind `--fielding`.

**Size decision — RESOLVED (keep explicit).** Layer A measures **~33 bits/event** (2023):
of that, `batterIdx` (9.0 b/ev) + `pitcherIdx` (5.3) + inning/half/outs/handedness (~6.4)
are replay-derivable, but we deliberately **keep them explicit** so a single event reads
without re-simulating its game. Accepted projection: **~68 MB Layer A, ~86 MB with pitches**
(≈2× the minimal ~45 MB replay-decoded design). The replay-decode option remains documented
in `pbp-data-experiments.md` §3 should size ever need to drop.

## Source

Retrosheet parsed plays (https://retrosheet.org/downloads/plays.html):
`https://www.retrosheet.org/downloads/plays/<year>plays.zip` (per season, 1903–2025) or the
combined `plays.zip` (16,538,512 rows). 177 columns, all pre-expanded — no event-string
grammar parsing, no Chadwick. We filter `gametype == "regular"` (parity with BL2P and the
season frontier). `retroID` → Lahman display name via the shared
`build_retro_to_display` (`convert_retrosheet_pbp.py:105`).

```
cd /tmp && curl -sLO https://www.retrosheet.org/downloads/plays/2023plays.zip
unzip -q 2023plays.zip
python3 scripts/convert_retrosheet_events.py /tmp/2023plays.csv 2023 --out /tmp/bl2e_out
# range + resumable (skips existing files unless --force):
python3 scripts/convert_retrosheet_events.py /path/to/plays.csv 1903-2025
```

## Layers

- **A — event core** (this version): context + outcome + outs + runs/rbi + per-entity
  advance disposition + a 20-bit flags bitfield. Reproduces every charted stat **and** the
  base-out game state via replay.
- **B — pitch sequences** (P3, header `flags` bit0): per-event pitch symbols (post-1988).
- **C — fielding detail** (P5, header `flags` bit1, `--fielding`): `f2`–`f9`, `loc`,
  `hittype`, `fseq`, errors, umpires.

## Byte layout (little-endian) — Layer A, format v1.0

```
HEADER:
  'BL2E' (4) | u8 major | u8 minor | u8 flags (bit0=hasPitches, bit1=hasFielding)
  | u16 year | u32 eventCount E | u16 gameCount Gn | u16 playerCount P
  | u16 teamCount T | u16 colCount C
TEAM DICT:    T × (u8 len + utf8 team code)        -- e.g. "BAL"
COLUMN META:  C × (u8 bitWidth + u8 nameLen + utf8 name)   -- self-describing, BL2P idiom
PLAYER DICT:  P × (u8 idLen + utf8 retroID + u8 nameLen + utf8 displayName)
              -- keyed by retroID (identity preserved for replay; NOT merged by name)
GAME TABLE:   Gn × ( u16 dayOfYear | u8 visTeamIdx | u8 homeTeamIdx
                     | u32 firstEventIdx | u8 gidLen + utf8 gid )
EVENT PAYLOAD: for each column in order, E values × bitWidth bits (LSB-first,
               byte-padded at each column boundary — same `pack_bits` as BL2P)
```

Events are stored grouped by game (chronological by date, then gid), and within a game in
`pn` order. The game table's `firstEventIdx` lets a decoder map any event back to its game
by binary search, so `gid`/`pn` are **not** repeated per event.

### Columns (payload order; widths are per-season minimal, example = 2023)

| # | Column | 2023 width | Meaning |
|--:|---|--:|---|
| 1 | `inning` | 4 | inning number (u8-range; extra innings widen it) |
| 2 | `half` | 1 | `top_bot` (0=top, 1=bottom) |
| 3 | `batTeam` | 1 | `vis_home` (0=visitor batting, 1=home batting) |
| 4 | `batterIdx` | 11 | index into player dict (`0xFFFF` = none) |
| 5 | `pitcherIdx` | 11 | index into player dict |
| 6 | `bathand` | 2 | 0=R 1=L 2=B(switch) 3=unknown |
| 7 | `pithand` | 1–2 | same encoding |
| 8 | `outcome` | 4 | outcome enum (below) |
| 9 | `outsPre` | 2 | outs before the play |
| 10 | `outsPost` | 2 | outs after (0–3) |
| 11 | `runs` | 3 | runs scored on the play |
| 12 | `rbi` | 3 | RBI on the play (credited to the batter) |
| 13–16 | `dispB`,`disp1`,`disp2`,`disp3` | 3 each | advance disposition: batter, and the runner on 1B/2B/3B |
| 17 | `flags` | ≤20 | bitfield (below) |

**Outcome enum** (4 bits): `0 NONE` (non-PA continuation row), `1 OUT`, `2 K`, `3 BB`,
`4 IBB`, `5 HBP`, `6 1B`, `7 2B`, `8 3B`, `9 HR`, `10 ROE`, `11 FC`, `12 SH`, `13 SF`,
`14 XI`, `15 NOOUT`. Exactly one PA-result per `pa==1` row.

**Disposition enum** (3 bits): `0 ABSENT` (no runner there / non-PA batter), `1 OUT`,
`2 STAY`, `3 TO1`, `4 TO2`, `5 TO3`, `6 SCORE`. Computed at encode time from the CSV's
`run_b`/`run1-3` (who scored from which base), `br1-3_post` (final positions), and
`lob_id*` (stranded at the third out). Runner *identities* are not stored — a replay
decoder re-threads them through the game (see the size note above).

**Flags bitfield** (bit index → CSV column): `0 iw, 1 sb2, 2 sb3, 3 sbh, 4 cs2, 5 cs3,
6 csh, 7 pko1, 8 pko2, 9 pko3, 10 wp, 11 pb, 12 bk, 13 oa, 14 di, 15 gdp, 16 othdp, 17 tp,
18 fle, 19 k_safe`.

## Decoding

Decompress the gzip, parse the header/dicts/game-table, then unpack each column
(`(E*width+7)//8` bytes, byte-aligned). Charted batting stats follow directly from the
`outcome` column for the batter (`batterIdx`); runner-credited stats (R, SB, CS) and the
base-out replay need the disposition columns + flags threaded through each game in order.
See `pbp-data-experiments.md` §3 and the P2 verification harness.

## Serving

Like `.bl2p.gz` / `.evt.gz`: the server must send `.gz` as raw bytes
(Content-Type `application/gzip`, **no** `Content-Encoding`) so the browser's
`DecompressionStream("gzip")` sees the gzip bytes. Python's `http.server` does this.
