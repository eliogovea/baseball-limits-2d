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
from _display_name import build_display_name_map

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "pbp"
EPOCH_DATE = datetime.date(1910, 4, 14)
EPOCH = EPOCH_DATE.toordinal()
# Format MINOR 0->1 bump introduced by kind 2 (the dates file) in S3a. The decoder is
# version-agnostic (reads minor, never enforces it), so the batting kind-0/1 files already
# committed at MINOR 0 keep working unchanged until the next full plays.csv rebuild.
MAJOR, MINOR = 1, 1
BATS = {"R": 0, "L": 1, "B": 2}

# --- Pitching layer (S3a): Lahman season totals, one season-end cell per player-season ---
PITCHING_CSV = ROOT / "data" / "pitching_lahman_1871-2025.csv"
PITCH_EPOCH_DATE = datetime.date(1871, 1, 1)   # per-file epoch -> pitching keeps 1871-2025
# The 23 counting columns of Lahman Pitching (BAOpp/ERA are client-side rate stats, excluded).
PITCH_STATS = ["W", "L", "G", "GS", "CG", "SHO", "SV", "IPouts", "H", "ER", "HR", "BB", "SO",
               "IBB", "WP", "HBP", "BK", "BFP", "GF", "R", "SH", "SF", "GIDP"]
# Pitchers are colored by THROWING arm, so the dimension's handedness byte holds `throws`
# (same 0=R/1=L/else=3 encoding the batting dimension uses for `bats`).
THROWS = {"R": 0, "L": 1}

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


def write_stat_file(name, by_player, epoch_date=EPOCH_DATE):
    buf = io.BytesIO()
    buf.write(b"BL2S")
    buf.write(struct.pack("<BBB", MAJOR, MINOR, 1))
    nb = name.encode("utf-8")
    buf.write(struct.pack("<B", len(nb))); buf.write(nb)
    buf.write(struct.pack("<HBB", epoch_date.year, epoch_date.month, epoch_date.day))
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


def write_player_dim(rows, epoch_date=EPOCH_DATE, hand_map=BATS):
    """rows = [(id, displayName, birthYear, hand), ...]. `hand` is bats for the batting
    dimension, throws for pitching; `hand_map` maps it to the handedness byte (else 3)."""
    buf = io.BytesIO()
    buf.write(b"BL2S")
    buf.write(struct.pack("<BBB", MAJOR, MINOR, 0))
    buf.write(struct.pack("<HBB", epoch_date.year, epoch_date.month, epoch_date.day))
    buf.write(struct.pack("<I", len(rows)))
    for rid, name, by, hand in rows:
        rb = rid.encode("utf-8"); nmb = name.encode("utf-8")[:255]
        buf.write(struct.pack("<B", len(rb))); buf.write(rb)
        buf.write(struct.pack("<B", len(nmb))); buf.write(nmb)
        buf.write(struct.pack("<HB", int(by) if by.isdigit() else 0, hand_map.get(hand, 3)))
    return gzip.compress(buf.getvalue(), 9)


def write_dates_file(dates, epoch_date=EPOCH_DATE):
    """Kind 2 — the global game-date table the cursor steps over. `dates` = sorted distinct
    epoch-days; same prefix-delta varint scheme as a stat file's per-player cell dates."""
    buf = io.BytesIO()
    buf.write(b"BL2S")
    buf.write(struct.pack("<BBB", MAJOR, MINOR, 2))
    buf.write(struct.pack("<HBB", epoch_date.year, epoch_date.month, epoch_date.day))
    buf.write(struct.pack("<I", len(dates)))
    prev = 0
    for d in dates:
        buf.write(varint(d - prev)); prev = d
    return gzip.compress(buf.getvalue(), 9)


def load_people_hand(path, key, hand_col):
    """People.csv -> dict[key_col -> (birthYear, hand_col)] for a dimension's bio + handedness.
    Batting keys by retroID/bats; pitching keys by playerID/throws."""
    bio = {}
    with open(path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            k = (row.get(key) or "").strip()
            if k:
                bio[k] = (row.get("birthYear") or "", row.get(hand_col) or "")
    return bio


def write_csv(by_player):
    out = io.StringIO()
    out.write("gpid,date,count\n")
    for g in sorted(by_player):
        for dt, ct in by_player[g]:
            out.write(f"{g},{dt},{ct}\n")
    return gzip.compress(out.getvalue().encode(), 9)


def build_dates_from_pa(out_dir):
    """Emit stat_dates.bl2s.gz (kind 2) by unioning the dates in the committed stat_pa file.
    Every game date has a PA, so this is the full game-date table without a plays.csv pass."""
    pa = decode_stat(out_dir / "stat_pa.bl2s.gz")
    dates = sorted({dt for cells in pa["series"].values() for dt, _ in cells})
    data = write_dates_file(dates, EPOCH_DATE)
    (out_dir / "stat_dates.bl2s.gz").write_bytes(data)
    print(f"  stat_dates.bl2s.gz: {len(dates):,} dates, {len(data) / 1024:.1f} KB "
          f"(epoch {EPOCH_DATE})")


def build_pitching(out_dir, also_csv=False):
    """Build the pitching BL2S family from Lahman season totals (stat_p_*). One season-end
    cell per (player, season) at Oct 1; stints summed; per-file epoch 1871-01-01."""
    epoch_ord = PITCH_EPOCH_DATE.toordinal()
    display = build_display_name_map(str(PEOPLE_PATH))
    bio = load_people_hand(PEOPLE_PATH, "playerID", "throws")
    pid_to_gpid = {}

    def intern(pid):
        i = pid_to_gpid.get(pid)
        if i is None:
            i = len(pid_to_gpid); pid_to_gpid[pid] = i
        return i

    agg = {s: defaultdict(int) for s in PITCH_STATS}    # agg[stat][(gpid, day)] = season total
    dates_set = set()
    nrows = 0
    with open(PITCHING_CSV, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            pid = (row.get("playerID") or "").strip()
            if not pid:
                continue
            g = intern(pid)
            day = datetime.date(int(row["yearID"]), 10, 1).toordinal() - epoch_ord
            dates_set.add(day)
            for s in PITCH_STATS:
                v = row.get(s, "")
                if v and v != "0":
                    try:
                        agg[s][(g, day)] += int(v)
                    except ValueError:
                        pass                            # non-integer (shouldn't happen for counts)
            nrows += 1

    rows = [None] * len(pid_to_gpid)
    for pid, i in pid_to_gpid.items():
        by, throws = bio.get(pid, ("", ""))
        rows[i] = (pid, display.get(pid, pid), by, throws)   # retroID slot = Lahman playerID
    pdata = write_player_dim(rows, PITCH_EPOCH_DATE, THROWS)
    (out_dir / "stat_p_players.bl2s.gz").write_bytes(pdata)
    print(f"source: Lahman {PITCHING_CSV.name} | {nrows:,} rows -> {len(rows):,} players")
    print(f"\n  stat_p_players.bl2s.gz: {len(rows):,} players, {len(pdata) / 1024:,.0f} KB")

    total = len(pdata)
    print(f"  {'stat':8} {'players':>8} {'cells':>10} {'total':>12} {'KB':>7}")
    for s in PITCH_STATS:
        by = defaultdict(list)
        for (g, day), ct in agg[s].items():
            by[g].append((day, ct))
        for g in by:
            by[g].sort()
        data = write_stat_file(s, by, PITCH_EPOCH_DATE)
        (out_dir / f"stat_p_{s.lower()}.bl2s.gz").write_bytes(data)
        total += len(data)
        if also_csv:
            (out_dir / f"stat_p_{s.lower()}.csv.gz").write_bytes(write_csv(by))
        tot = sum(c for v in by.values() for _, c in v)
        print(f"  {s:8} {len(by):>8,} {sum(len(v) for v in by.values()):>10,} "
              f"{tot:>12,} {len(data) / 1024:>7,.0f}")

    dates = sorted(dates_set)
    ddata = write_dates_file(dates, PITCH_EPOCH_DATE)
    (out_dir / "stat_p_dates.bl2s.gz").write_bytes(ddata)
    total += len(ddata)
    print(f"  stat_p_dates.bl2s.gz: {len(dates):,} dates, {len(ddata) / 1024:.1f} KB "
          f"(epoch {PITCH_EPOCH_DATE})")
    print(f"  TOTAL binary: {total / 1024 / 1024:.1f} MB" + (" (+ CSVs)" if also_csv else ""))


# --- S2: Lahman complement (backfill what Retrosheet lacks, at SEASON grain) ----------------
BATTING_LIMITS_CSV = ROOT / "data" / "batting_limits_1871-2025.csv"   # display-name keyed (matches the dim)
COMPLEMENT_EPOCH_DATE = datetime.date(1871, 1, 1)                     # pre-1910 cells need a pre-1910 epoch
INV_BATS = {0: "R", 1: "L", 2: "B"}                                   # dim byte -> string (for re-encode)
# Lahman batting_limits columns that map 1:1 to a BL2S stat. PA is derived (no Lahman column),
# G is the season appearances. The remaining STATS not here (none) get 0.
LAHMAN_BAT_COLS = ["AB", "H", "2B", "3B", "HR", "RBI", "BB", "IBB", "SO",
                   "HBP", "SF", "SH", "GIDP", "SB", "CS", "R", "G"]


def build_display_bio(people_path):
    """display name -> (birthYear str, bats str) via the Lahman playerID->display map, for the
    bio of NEW complement players (pre-1910 / Negro-League-only) absent from the Retrosheet dim."""
    disp = build_display_name_map(str(people_path))   # playerID -> display name
    bio = {}
    with open(people_path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            d = disp.get((row.get("playerID") or "").strip())
            if d and d not in bio:
                bio[d] = (row.get("birthYear") or "", row.get("bats") or "")
    return bio


def build_lahman_complement(src_dir, out_dir):
    """S2: backfill the BATTING BL2S family with Lahman season totals where Retrosheet doesn't
    cover (pre-1910, gaps, Negro Leagues) — ONE season-end cell (Oct 1) per missing (player, year).
    The batting files are re-epoched 1910-04-14 -> 1871-01-01 first (pre-1910 days are negative
    under the old epoch; varint deltas are unsigned). A Lahman cell is added ONLY where that
    (gpid, calendar-year) has ZERO Retrosheet cells, so existing game-grain data is never
    double-counted; new players (no display-name match in the dim) append. Reads the committed
    family from src_dir, writes the merged family to out_dir."""
    new_ord = COMPLEMENT_EPOCH_DATE.toordinal()
    dim = decode_players(src_dir / "stat_players.bl2s.gz")
    old_ord = datetime.date(*dim["epoch"]).toordinal()
    shift = old_ord - new_ord                                  # add to every existing day -> NEW epoch
    rows = [[rid, nm, str(by), INV_BATS.get(bats, "")] for rid, nm, by, bats in dim["players"]]
    name_to_gpid = {nm: i for i, (_rid, nm, _by, _b) in enumerate(rows)}

    # Decode + re-epoch every existing stat file; record (gpid, year) coverage across ALL stats.
    series = {}
    covered = set()
    for s in STATS:
        dec = decode_stat(src_dir / f"stat_{s.lower()}.bl2s.gz")
        ser = {g: [(d + shift, c) for d, c in cells] for g, cells in dec["series"].items()}
        series[s] = ser
        for g, cells in ser.items():
            for d, _ in cells:
                covered.add((g, datetime.date.fromordinal(new_ord + d).year))

    # Sum Lahman stints per (display name, year).
    lah = defaultdict(lambda: defaultdict(int))
    with open(BATTING_LIMITS_CSV, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            key = (r["playerID"], int(r["yearID"]))
            for s in LAHMAN_BAT_COLS:
                v = r.get(s, "")
                if v and v != "0":
                    try:
                        lah[key][s] += int(v)
                    except ValueError:
                        pass

    bio = build_display_bio(PEOPLE_PATH)
    added_cells = added_pseasons = new_players = 0
    for (nm, yr), tot in sorted(lah.items()):
        g = name_to_gpid.get(nm)
        if g is None:                                          # pre-1910 / NeL-only player -> append
            g = len(rows); name_to_gpid[nm] = g
            by, bats = bio.get(nm, ("", ""))
            rows.append([nm, nm, by, bats])                    # no retroID -> display name fills the slot
            new_players += 1
        if (g, yr) in covered:
            continue                                           # Retrosheet covers this player-year -> skip
        day = datetime.date(yr, 10, 1).toordinal() - new_ord
        pa = tot.get("AB", 0) + tot.get("BB", 0) + tot.get("HBP", 0) + tot.get("SH", 0) + tot.get("SF", 0)
        added_pseasons += 1
        for s in STATS:
            v = pa if s == "PA" else tot.get(s, 0)
            if v:
                series[s].setdefault(g, []).append((day, v))
                added_cells += 1

    # Re-sort each player's cells (complement Oct-1 cells slot before the 1910+ game cells).
    for s in STATS:
        for g in series[s]:
            series[s][g].sort()

    # Re-encode: dimension (existing + new), each stat, and the rebuilt global dates table.
    pdata = write_player_dim([(rid, nm, by, bats) for rid, nm, by, bats in rows],
                             COMPLEMENT_EPOCH_DATE, BATS)
    (out_dir / "stat_players.bl2s.gz").write_bytes(pdata)
    print(f"source: {BATTING_LIMITS_CSV.name} (complement) + committed Retrosheet family "
          f"(re-epoched +{shift}d -> {COMPLEMENT_EPOCH_DATE})")
    print(f"  +{new_players:,} new players, +{added_pseasons:,} season-end cells "
          f"({added_cells:,} stat cells)")
    print(f"  stat_players.bl2s.gz: {len(rows):,} players, {len(pdata) / 1024:,.0f} KB")

    all_days = set()
    total = len(pdata)
    for s in STATS:
        by = series[s]
        data = write_stat_file(s, by, COMPLEMENT_EPOCH_DATE)
        (out_dir / f"stat_{s.lower()}.bl2s.gz").write_bytes(data)
        total += len(data)
        for g in by:
            for d, _ in by[g]:
                all_days.add(d)

    dates = sorted(all_days)
    ddata = write_dates_file(dates, COMPLEMENT_EPOCH_DATE)
    (out_dir / "stat_dates.bl2s.gz").write_bytes(ddata)
    total += len(ddata)
    print(f"  stat_dates.bl2s.gz: {len(dates):,} dates, {len(ddata) / 1024:.1f} KB "
          f"(epoch {COMPLEMENT_EPOCH_DATE})")
    print(f"  TOTAL binary: {total / 1024 / 1024:.1f} MB")


def main():
    ap = argparse.ArgumentParser(description="Build the BL2S stat layer from Retrosheet plays.csv")
    ap.add_argument("years", nargs="?", default="1910-2025", help="year or START-END (default 1910-2025)")
    ap.add_argument("--out", default=str(OUT_DIR))
    ap.add_argument("--csv", action="store_true", help="also write gzipped per-stat CSVs")
    ap.add_argument("--dates-from-pa", action="store_true",
                    help="emit stat_dates.bl2s.gz (kind 2) by unioning the committed stat_pa file")
    ap.add_argument("--pitching", action="store_true",
                    help="build the pitching family (stat_p_*) from Lahman season totals")
    ap.add_argument("--lahman-complement", action="store_true",
                    help="S2: backfill the batting family with Lahman season-end cells where "
                         "Retrosheet lacks coverage (pre-1910 / gaps / Negro Leagues); re-epochs to 1871")
    ap.add_argument("--src", default=str(OUT_DIR),
                    help="source dir of the committed batting family (for --lahman-complement)")
    args = ap.parse_args()
    out_dir = Path(args.out); out_dir.mkdir(parents=True, exist_ok=True)
    if args.dates_from_pa:
        build_dates_from_pa(out_dir)
        return
    if args.pitching:
        build_pitching(out_dir, args.csv)
        return
    if args.lahman_complement:
        build_lahman_complement(Path(args.src), out_dir)
        return
    if "-" in args.years:
        lo, hi = (int(x) for x in args.years.split("-", 1))
        years = range(lo, hi + 1)
    else:
        years = [int(args.years)]
    print(f"source: Retrosheet plays.csv {years.start if isinstance(years, range) else years[0]}.. | stats: {STATS}")

    agg, retro_to_gpid = aggregate(years)
    retro_to_display = build_retro_to_display(PEOPLE_PATH)
    bio = load_people_hand(PEOPLE_PATH, "retroID", "bats")
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
