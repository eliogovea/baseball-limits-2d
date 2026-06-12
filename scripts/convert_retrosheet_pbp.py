"""Convert Retrosheet per-game CSVs into compact, lazy-loadable BL2P season files.

The site's main data is season/career totals from Lahman (one row per player-year).
This produces a *sub-season* layer: for one season, every player's PER-GAME counting
deltas in date order, so the client can prefix-sum them into cumulative-as-of-date
trajectories and animate the Pareto frontier game by game.

Source: Retrosheet parsed CSV downloads (https://retrosheet.org/downloads/csvoverview.html),
e.g. batting.csv ("batting statistics by player by game", 1898-2025). One row per
(player-game); column `stattype == "value"` is the actual stat line (older deduced
games also carry lower/official/upper rows, which we drop). Player IDs are 8-char
retroIDs, crosswalked to the site's Lahman display names via people_lahman's retroID
column (so the keys match playerIndex / metaFor / highlights in script.js).

Output: data/pbp/b<year>.bl2p.gz (batting). One file per season per dataset, gzipped,
fetched on demand by decodePbpSeason() in script.js. NOT inlined into dist/index.html.

Binary format BL2P v1 (all little-endian; mirrors the BL2D idioms in build_bundle.py):

  HEADER (16 bytes):
    'BL2P' magic (4) | u8 major (1) | u8 minor (0) | u8 dataset (0=bat,1=pit)
    | u8 flags (0) | u16 year | u16 playerCount P | u16 dateCount D | u16 colCount C
  DATE TABLE:
    u16 * D   sorted distinct day-of-year (1..366); a cursor indexes into this
  COLUMN META  (C entries, in payload order):
    u8 bitWidth + u8 nameLen + utf8 name
    bitWidth = max(1, ceil(log2(max_per_game_delta + 1)))  -- minimal bits to hold the value
  NAME DICTIONARY  (P entries; crosswalked DISPLAY names, not retroIDs):
    per player: u8 len + utf8 display-name
  PLAYER INDEX  (P entries, same order as names):
    u16 gameCount g_i        -- games stored densely per player in date order
  GAME-DATE-INDEX STREAM:
    for each player, g_i * u16 dateIdx (index into DATE TABLE)
  BIT-PACKED DELTA PAYLOAD  (columnar, payload order):
    for each column: G values * bitWidth bits, LSB-first, byte-aligned at each
    column boundary (so the decoder slices per column without cross-column bit math)

  G (total games) = sum of all g_i; the decoder recovers it from the player index.

gzip-on-top is applied to the whole file; the client gunzips via DecompressionStream.
"""

import argparse
import csv
import gzip
import io
import math
import struct
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _display_name import build_display_name_map

ROOT = Path(__file__).resolve().parent.parent
PEOPLE_PATH = ROOT / "data" / "people_lahman_1871-2025.csv"
OUT_DIR = ROOT / "data" / "pbp"

# Output counting columns, in the same order/names the site uses for batting
# (script.js BATTING_COUNT_COLS). The payload is self-describing by name, so the
# client maps by name regardless of order. Each entry: (out_name, retro_field).
# G has no Retrosheet column — it's a constant 1 (the player appeared in the game).
BATTING_COLUMNS = [
    ("G", None),    ("AB", "b_ab"),  ("R", "b_r"),    ("H", "b_h"),
    ("2B", "b_d"),  ("3B", "b_t"),   ("HR", "b_hr"),  ("RBI", "b_rbi"),
    ("SB", "b_sb"), ("CS", "b_cs"),  ("BB", "b_w"),   ("SO", "b_k"),
    ("IBB", "b_iw"),("HBP", "b_hbp"),("SH", "b_sh"),  ("SF", "b_sf"),
    ("GIDP", "b_gdp"),
]

DATASET_BAT = 0
DATASET_PIT = 1

# Pitching output columns, same names the site uses (script.js
# PITCHING_COUNT_COLS). Self-describing by name, so client order is irrelevant.
# G has no Retrosheet column — constant 1 (the pitcher appeared in the game).
# NOTE: these are only the columns that map DIRECTLY to a Retrosheet pitching.csv
# field (header confirmed 2026-06: p_ipouts, p_bfp, p_h, p_hr, p_r, p_er, p_w
# [=walks], p_iw, p_k, p_hbp, p_wp, p_bk, p_sh, p_sf, p_gs, p_gf, p_cg).
# The remaining PITCHING_COUNT_COLS — W, L, SV, SHO, GIDP — are NOT direct columns:
#   W/L/SV are per-game DECISION fields (the `wp`/`lp`/`save` columns hold the
#     credited pitcher's retroID — W += 1 when row.id == row.wp, etc.),
#   SHO must be derived (complete game with zero runs: p_cg == 1 and p_r == 0),
#   GIDP is absent from pitching.csv entirely.
# Generating a correct pitching corpus therefore needs derivation logic in
# read_season AND end-to-end verification against the chart's pitching read path
# (deferred). Until that lands, the pitching dataset is gated off (see convert()).
PITCHING_COLUMNS = [
    ("G", None),     ("GS", "p_gs"),  ("CG", "p_cg"),  ("IPouts", "p_ipouts"),
    ("H", "p_h"),    ("ER", "p_er"),  ("HR", "p_hr"),  ("BB", "p_w"),
    ("SO", "p_k"),   ("IBB", "p_iw"), ("WP", "p_wp"),  ("HBP", "p_hbp"),
    ("BK", "p_bk"),  ("BFP", "p_bfp"),("GF", "p_gf"),  ("R", "p_r"),
    ("SH", "p_sh"),  ("SF", "p_sf"),
]

DATASETS = {
    "batting":  {"columns": BATTING_COLUMNS, "dataset": DATASET_BAT, "prefix": "b"},
    "pitching": {"columns": PITCHING_COLUMNS, "dataset": DATASET_PIT, "prefix": "p"},
}

csv.field_size_limit(1 << 20)


def build_retro_to_display(people_path):
    """retroID -> Lahman display name, composing the two existing maps."""
    lahman_display = build_display_name_map(people_path)  # lahman playerID -> display
    retro_to_display = {}
    with open(people_path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            retro = (row.get("retroID") or "").strip()
            pid = row["playerID"]
            if retro and pid in lahman_display:
                retro_to_display[retro] = lahman_display[pid]
    return retro_to_display


def day_of_year(yyyymmdd):
    y, m, d = int(yyyymmdd[:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:8])
    return date(y, m, d).timetuple().tm_yday


def read_season(csv_path, year, columns):
    """Single streaming pass; return {retroID: [(dayOfYear, [delta,...]), ...]}.

    Filters to the requested year, stattype == 'value' (the actual stat line),
    and gametype == 'regular' so cumulative totals match the regular-season
    semantics of the Lahman season-level data (Retrosheet also ships allstar /
    division series / LCS / world series rows, which would inflate the totals
    past official season numbers and break parity with the season frontier).
    """
    year_s = str(year)
    retro_fields = [rf for _, rf in columns if rf is not None]
    by_player = {}
    n_rows = 0
    with open(csv_path, encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        idx = {name: i for i, name in enumerate(header)}
        for c in ("id", "date", "stattype", "gametype"):
            if c not in idx:
                sys.exit(f"missing expected column {c!r} in {csv_path}")
        missing = [rf for rf in retro_fields if rf not in idx]
        if missing:
            sys.exit(f"missing Retrosheet columns {missing} in {csv_path}")
        i_id, i_date, i_stat, i_gt = idx["id"], idx["date"], idx["stattype"], idx["gametype"]
        col_idx = [None if rf is None else idx[rf] for _, rf in columns]
        for row in reader:
            if row[i_date][:4] != year_s or row[i_stat] != "value" or row[i_gt] != "regular":
                continue
            deltas = []
            for ci in col_idx:
                if ci is None:
                    deltas.append(1)  # G: one appearance
                else:
                    v = row[ci]
                    deltas.append(int(v) if v else 0)
            by_player.setdefault(row[i_id], []).append((day_of_year(row[i_date]), deltas))
            n_rows += 1
    return by_player, n_rows


def pack_bits(values, width):
    """Pack `values` into a byte string, `width` bits each, LSB-first.

    The first value occupies the lowest bits of the first byte. The stream is
    byte-padded at the end so the next column starts byte-aligned.
    """
    out = bytearray()
    acc = 0
    nbits = 0
    mask = (1 << width) - 1
    for v in values:
        acc |= (v & mask) << nbits
        nbits += width
        while nbits >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            nbits -= 8
    if nbits > 0:
        out.append(acc & 0xFF)
    return bytes(out)


def build_bl2p(by_player, retro_to_display, year, dataset, columns):
    # Resolve retroID -> display name; players missing from people keep their
    # retroID as the key (they animate but won't join metaFor — logged).
    n_unmapped = 0
    resolved = {}  # display_name -> list of (dayOfYear, deltas)
    for retro, games in by_player.items():
        name = retro_to_display.get(retro)
        if name is None:
            name = retro
            n_unmapped += 1
        # Merge in case two retroIDs ever map to the same display key.
        resolved.setdefault(name, []).extend(games)

    # Sorted player order (deterministic); games per player sorted by date.
    names = sorted(resolved)
    P = len(names)

    # Distinct game dates (day-of-year) -> sorted date table + index map.
    all_days = sorted({d for games in resolved.values() for (d, _) in games})
    day_to_idx = {d: i for i, d in enumerate(all_days)}
    D = len(all_days)

    # Flatten games player-major, date-ordered. Build per-player gameCount,
    # the date-index stream, and per-column value lists (for bit-packing).
    n_cols = len(columns)
    col_values = [[] for _ in range(n_cols)]
    date_idx_stream = []
    game_counts = []
    for name in names:
        games = sorted(resolved[name], key=lambda g: g[0])
        game_counts.append(len(games))
        for day, deltas in games:
            date_idx_stream.append(day_to_idx[day])
            for c in range(n_cols):
                col_values[c].append(deltas[c])
    G = len(date_idx_stream)

    # Minimal bit width per column: enough bits to hold the season's max delta.
    bit_widths = []
    for c in range(n_cols):
        mx = max(col_values[c]) if col_values[c] else 0
        bit_widths.append(1 if mx == 0 else max(1, math.ceil(math.log2(mx + 1))))

    if P > 0xFFFF:
        sys.exit(f"player count {P} exceeds u16")
    if D > 0xFFFF:
        sys.exit(f"date count {D} exceeds u16")
    if G > 0:
        if max(game_counts) > 0xFFFF:
            sys.exit("a player has > 65535 games?!")
        if D and max(date_idx_stream) > 0xFFFF:
            sys.exit("dateIdx exceeds u16")

    buf = io.BytesIO()
    buf.write(b"BL2P")
    buf.write(struct.pack("<BBBB", 1, 0, dataset, 0))
    buf.write(struct.pack("<HHHH", year, P, D, n_cols))

    # Date table.
    buf.write(struct.pack(f"<{D}H", *all_days))

    # Column meta.
    for (name, _), w in zip(columns, bit_widths):
        nb = name.encode("utf-8")
        buf.write(struct.pack("<BB", w, len(nb)))
        buf.write(nb)

    # Name dictionary.
    for name in names:
        nb = name.encode("utf-8")
        if len(nb) > 255:
            sys.exit(f"display name >255 bytes: {name!r}")
        buf.write(struct.pack("<B", len(nb)))
        buf.write(nb)

    # Player index (gameCount per player).
    buf.write(struct.pack(f"<{P}H", *game_counts))

    # Game-date-index stream.
    buf.write(struct.pack(f"<{G}H", *date_idx_stream))

    # Bit-packed delta payload, columnar.
    for c in range(n_cols):
        buf.write(pack_bits(col_values[c], bit_widths[c]))

    stats = {
        "players": P,
        "dates": D,
        "games": G,
        "unmapped": n_unmapped,
        "bit_widths": dict(zip((n for n, _ in columns), bit_widths)),
        "raw_bytes": buf.tell(),
    }
    return buf.getvalue(), stats


def convert(csv_path, year, out_dir, dataset_name, retro_to_display):
    cfg = DATASETS[dataset_name]
    columns, dataset, prefix = cfg["columns"], cfg["dataset"], cfg["prefix"]
    if dataset_name == "pitching":
        sys.exit(
            "pitching conversion is not yet complete: W/L/SV/SHO need derivation "
            "from the wp/lp/save decision fields and CG+runs (GIDP is absent from "
            "pitching.csv). See the PITCHING_COLUMNS note above and "
            "docs/ROADMAP.md §Backlog before generating a pitching corpus."
        )

    by_player, n_rows = read_season(csv_path, year, columns)
    if n_rows == 0:
        print(f"  {year}: no value-rows found (box-score-only or out of coverage) — skipping")
        return None

    binary, stats = build_bl2p(by_player, retro_to_display, year, dataset, columns)
    compressed = gzip.compress(binary, compresslevel=9)

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{prefix}{year}.bl2p.gz"
    out_path.write_bytes(compressed)

    print(f"  {year} {dataset_name}: rows={n_rows:,} games={stats['games']:,} "
          f"players={stats['players']:,} dates={stats['dates']} "
          f"unmapped={stats['unmapped']}")
    print(f"    bit widths: {stats['bit_widths']}")
    try:
        shown = out_path.relative_to(ROOT)
    except ValueError:
        shown = out_path                      # custom --out outside the repo
    print(f"    raw {stats['raw_bytes']:,} B -> gzip {len(compressed):,} B ({shown})")
    return stats


def main():
    ap = argparse.ArgumentParser(description="Build BL2P sub-season files from a Retrosheet per-game CSV")
    ap.add_argument("csv", help="Retrosheet per-game CSV (batting.csv or pitching.csv)")
    ap.add_argument("year", help="season year, or START-END range (e.g. 1998 or 1998-2025)")
    ap.add_argument("--dataset", choices=["batting", "pitching"], default="batting",
                    help="dataset type (default: batting); selects columns + 'b'/'p' file prefix")
    ap.add_argument("--out", default=str(OUT_DIR), help="output dir (default data/pbp)")
    args = ap.parse_args()

    out_dir = Path(args.out)
    if "-" in args.year:
        lo, hi = (int(x) for x in args.year.split("-", 1))
        years = range(lo, hi + 1)
    else:
        years = [int(args.year)]

    # Built once (reads the full people CSV); shared across all years/datasets.
    retro_to_display = build_retro_to_display(PEOPLE_PATH)
    for y in years:
        convert(args.csv, y, out_dir, args.dataset, retro_to_display)


if __name__ == "__main__":
    main()
