"""Build the normalized BL2S stat layer directly from Retrosheet's parsed plays.csv.

Emits into data/pbp/ (common 'stat_' prefix so the family clusters in listings):
  stat_players.bl2s.gz   shared dimension (gpid -> retroID, name, birthYear, bats)
  stat_<name>.bl2s.gz     one file per counting stat, per-player date-keyed timeline

SOURCE = plays.csv (per season, downloaded like build_bl2e_corpus). This is the EXACT
per-player source — see docs/data-formats.md §BL2S Decision 10. Batter stats come from the
row's own count columns; runner stats use Retrosheet's real identities, so substitutions
(pinch-runners) are handled and records are exact (Henderson SB = 1406, not the ~1398 a
BL2E replay produced because BL2E doesn't store substitutions):
  - SB: sb2/sb3/sbh -> the runner on br1_pre / br2_pre / br3_pre
  - CS: cs2/cs3/csh -> same
  - R : run_b / run1 / run2 / run3 hold the scorer's retroID
Coverage = whatever plays.csv has (1910-2025, incl. Negro ~1920-48 / Federal 1914-15).
Lahman backfill for pre-1910 / gaps / full Negro Leagues is phase S2 (Lahman is kept).

Encoding (per-player varint date-deltas, one file per stat) chosen empirically — see
scripts/statfile_experiment.py. Date key = days since 1910-04-14 (u16-safe).

    python3 scripts/build_stat_files.py             # all stats, 1910-2025 -> data/pbp/
    python3 scripts/build_stat_files.py 2023         # one season (testing)
    python3 scripts/build_stat_files.py --csv        # also write gzipped CSVs
"""

import argparse
import csv
import datetime
import io
import struct
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gzip
from decode_stat import decode_stat, decode_players
from build_bl2e_corpus import fetch_season_csv
from convert_retrosheet_events import build_retro_to_display, PEOPLE_PATH

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "pbp"
EPOCH_DATE = datetime.date(1910, 4, 14)
EPOCH = EPOCH_DATE.toordinal()
MAJOR, MINOR = 1, 0
BATS = {"R": 0, "L": 1, "B": 2}

# stat -> the plays.csv column whose '1' (or value, for RBI) adds to the BATTER's total.
# H is the sum of the four hit columns; G (appearances) is derived from PA afterward.
BATTER_FLAG = {
    "PA": "pa", "AB": "ab", "2B": "double", "3B": "triple", "HR": "hr",
    "BB": "walk", "IBB": "iw", "SO": "k", "HBP": "hbp", "SF": "sf", "SH": "sh", "GIDP": "gdp",
}
HIT_COLS = ["single", "double", "triple", "hr"]
# runner stat -> [(flag column, base-runner column), ...] crediting the named runner.
SB_SRC = [("sb2", "br1_pre"), ("sb3", "br2_pre"), ("sbh", "br3_pre")]
CS_SRC = [("cs2", "br1_pre"), ("cs3", "br2_pre"), ("csh", "br3_pre")]
RUN_COLS = ["run_b", "run1", "run2", "run3"]
STATS = (["PA", "AB", "H", "2B", "3B", "HR", "RBI", "BB", "IBB", "SO", "HBP", "SF", "SH",
          "GIDP"] + ["SB", "CS", "R"] + ["G"])


def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def load_bio(path):
    bio = {}
    with open(path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            r = (row.get("retroID") or "").strip()
            if r:
                bio[r] = (row.get("birthYear") or "", row.get("bats") or "")
    return bio


def gdate_of(yyyymmdd):
    return datetime.date(int(yyyymmdd[:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:8])).toordinal() - EPOCH


def aggregate(years):
    """Single download pass over plays.csv -> (agg, retro_to_gpid). gpid assigned in
    first-appearance order (opaque index; consumers map via the dimension)."""
    retro_to_gpid = {}

    def intern(rid):
        i = retro_to_gpid.get(rid)
        if i is None:
            i = len(retro_to_gpid); retro_to_gpid[rid] = i
        return i

    agg = {s: defaultdict(int) for s in STATS if s != "G"}
    csv.field_size_limit(1 << 20)
    for y in years:
        with tempfile.TemporaryDirectory() as td:
            path = fetch_season_csv(y, Path(td))
            if path is None:
                continue
            n = 0
            with open(path, encoding="utf-8-sig") as f:
                for row in csv.DictReader(f):
                    if row["gametype"] != "regular":
                        continue
                    gd = gdate_of(row["date"])
                    bkey = intern(row["batter"]) * 100000 + gd
                    for stat, col in BATTER_FLAG.items():
                        if row[col] == "1":
                            agg[stat][bkey] += 1
                    if row["single"] == "1" or row["double"] == "1" or \
                       row["triple"] == "1" or row["hr"] == "1":
                        agg["H"][bkey] += 1
                    r = row["rbi"]
                    if r and r != "0":
                        agg["RBI"][bkey] += int(r)
                    for flag, brcol in SB_SRC:
                        if row[flag] == "1" and row[brcol]:
                            agg["SB"][intern(row[brcol]) * 100000 + gd] += 1
                    for flag, brcol in CS_SRC:
                        if row[flag] == "1" and row[brcol]:
                            agg["CS"][intern(row[brcol]) * 100000 + gd] += 1
                    for rc in RUN_COLS:
                        if row[rc]:
                            agg["R"][intern(row[rc]) * 100000 + gd] += 1
                    n += 1
            print(f"  {y}: {n:,} regular rows  ({len(retro_to_gpid):,} players so far)")
    agg["G"] = {k: 1 for k in agg["PA"]}        # appearance: 1 per (gpid,date) with a PA
    return agg, retro_to_gpid


def cells_by_player(agg_stat):
    by = defaultdict(list)
    for key, ct in agg_stat.items():
        by[key // 100000].append((key % 100000, ct))
    for g in by:
        by[g].sort()
    return by


def write_stat_file(name, by_player):
    buf = io.BytesIO()
    buf.write(b"BL2S")
    buf.write(struct.pack("<BBB", MAJOR, MINOR, 1))
    nb = name.encode("utf-8")
    buf.write(struct.pack("<B", len(nb))); buf.write(nb)
    buf.write(struct.pack("<HBB", EPOCH_DATE.year, EPOCH_DATE.month, EPOCH_DATE.day))
    buf.write(struct.pack("<I", len(by_player)))
    prev_g = 0
    for g in sorted(by_player):
        cells = by_player[g]
        buf.write(varint(g - prev_g)); prev_g = g
        buf.write(varint(len(cells)))
        pd = 0
        for dt, ct in cells:
            buf.write(varint(dt - pd)); pd = dt
            buf.write(varint(ct))
    return gzip.compress(buf.getvalue(), 9)


def write_player_dim(rows):
    buf = io.BytesIO()
    buf.write(b"BL2S")
    buf.write(struct.pack("<BBB", MAJOR, MINOR, 0))
    buf.write(struct.pack("<HBB", EPOCH_DATE.year, EPOCH_DATE.month, EPOCH_DATE.day))
    buf.write(struct.pack("<I", len(rows)))
    for rid, name, by, bats in rows:
        rb = rid.encode("utf-8"); nmb = name.encode("utf-8")[:255]
        buf.write(struct.pack("<B", len(rb))); buf.write(rb)
        buf.write(struct.pack("<B", len(nmb))); buf.write(nmb)
        buf.write(struct.pack("<HB", int(by) if by.isdigit() else 0, BATS.get(bats, 3)))
    return gzip.compress(buf.getvalue(), 9)


def write_csv(by_player):
    out = io.StringIO()
    out.write("gpid,date,count\n")
    for g in sorted(by_player):
        for dt, ct in by_player[g]:
            out.write(f"{g},{dt},{ct}\n")
    return gzip.compress(out.getvalue().encode(), 9)


def main():
    ap = argparse.ArgumentParser(description="Build the BL2S stat layer from Retrosheet plays.csv")
    ap.add_argument("years", nargs="?", default="1910-2025", help="year or START-END (default 1910-2025)")
    ap.add_argument("--out", default=str(OUT_DIR))
    ap.add_argument("--csv", action="store_true", help="also write gzipped per-stat CSVs")
    args = ap.parse_args()
    if "-" in args.years:
        lo, hi = (int(x) for x in args.years.split("-", 1))
        years = range(lo, hi + 1)
    else:
        years = [int(args.years)]
    out_dir = Path(args.out); out_dir.mkdir(parents=True, exist_ok=True)
    print(f"source: Retrosheet plays.csv {years.start if isinstance(years, range) else years[0]}.. | stats: {STATS}")

    agg, retro_to_gpid = aggregate(years)
    retro_to_display = build_retro_to_display(PEOPLE_PATH)
    bio = load_bio(PEOPLE_PATH)
    rows = [None] * len(retro_to_gpid)
    for r, i in retro_to_gpid.items():
        by, bats = bio.get(r, ("", ""))
        rows[i] = (r, retro_to_display.get(r, r), by, bats)
    pdata = write_player_dim(rows)
    (out_dir / "stat_players.bl2s.gz").write_bytes(pdata)
    print(f"\n  stat_players.bl2s.gz: {len(rows):,} players, {len(pdata) / 1024:,.0f} KB")

    total = len(pdata)
    print(f"  {'stat':6} {'players':>8} {'cells':>10} {'total':>12} {'KB':>7}")
    for s in STATS:
        by = cells_by_player(agg[s])
        data = write_stat_file(s, by)
        (out_dir / f"stat_{s.lower()}.bl2s.gz").write_bytes(data)
        total += len(data)
        if args.csv:
            (out_dir / f"stat_{s.lower()}.csv.gz").write_bytes(write_csv(by))
        tot = sum(c for v in by.values() for _, c in v)
        print(f"  {s:6} {len(by):>8,} {sum(len(v) for v in by.values()):>10,} "
              f"{tot:>12,} {len(data) / 1024:>7,.0f}")
    print(f"  TOTAL binary: {total / 1024 / 1024:.1f} MB" + (" (+ CSVs)" if args.csv else ""))


if __name__ == "__main__":
    main()
