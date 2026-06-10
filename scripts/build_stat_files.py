"""Build the normalized BL2S stat layer from the BL2E event corpus.

Emits, into data/pbp/ (common 'stat_' prefix so the family clusters in listings):
  stat_players.bl2s.gz   shared player dimension (gpid -> retroID, name, birthYear, bats)
  stat_<name>.bl2s.gz     one file per counting stat, per-player date-keyed timeline

Encoding (chosen empirically — see scripts/statfile_experiment.py / docs/pbp-stat-format.md):
per-player varint date-deltas beat columnar-absolute ~2x and CSV ~4x, and grouping
several stats per file does NOT help post-gzip — so one file per stat. Names are factored
into the shared dimension (vs the old .evt which re-embedded a name dict in every file).

Date key = days since 1910-04-14 (the corpus's earliest game), u16-safe (64yr headroom).

Scope here: BATTER-attributed counting stats (PA, AB, H, 2B, 3B, HR, RBI, BB, IBB, SO,
HBP, SF, SH, GIDP, G). SB/CS/R are credited to a baserunner and need the BL2E replay pass
(phase S1b). Lahman backfill for pre-1910 / gaps / full Negro Leagues is phase S2.

    python3 scripts/build_stat_files.py            # all batter stats -> data/pbp/
    python3 scripts/build_stat_files.py --csv       # also write gzipped CSVs
    python3 scripts/build_stat_files.py HR H        # a subset
"""

import argparse
import csv
import datetime
import glob
import gzip
import io
import struct
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from decode_bl2e import decode
from decode_stat import decode_stat, decode_players
from convert_retrosheet_events import build_retro_to_display, PEOPLE_PATH

ROOT = Path(__file__).resolve().parent.parent
CORPUS = sorted(glob.glob(str(ROOT / "data" / "pbp" / "e*.bl2e.gz")))
OUT_DIR = ROOT / "data" / "pbp"
EPOCH_DATE = datetime.date(1910, 4, 14)
EPOCH = EPOCH_DATE.toordinal()
MAJOR, MINOR = 1, 0
BATS = {"R": 0, "L": 1, "B": 2}

# Batter-attributed stats. Each maps to a per-event "+amount" rule over the BL2E columns.
# outcome enum: OUT1 K2 BB3 IBB4 HBP5 1B6 2B7 3B8 HR9 ROE10 FC11 SH12 SF13 XI14 NOOUT15
OUTCOME_STATS = {
    "PA": set(range(1, 16)),                 # any non-NONE
    "AB": {1, 2, 6, 7, 8, 9, 10, 11, 15},    # PA minus BB/IBB/HBP/SH/SF/XI
    "H": {6, 7, 8, 9}, "2B": {7}, "3B": {8}, "HR": {9},
    "BB": {3, 4}, "IBB": {4}, "SO": {2}, "HBP": {5}, "SF": {13}, "SH": {12},
}
GIDP_FLAG_BIT = 15                           # FLAG_COLS index of 'gdp'
# Runner-attributed stats need the game replay (identities threaded through dispositions):
#   SB/CS flag bits (FLAG_COLS): sb2=1 sb3=2 sbh=3, cs2=4 cs3=5 csh=6 — credited to the
#   runner on the ORIGINATING base (1B for sb2/cs2, 2B for sb3/cs3, 3B for sbh/csh).
#   R = a SCORE disposition (code 6), credited to whoever scored (batter or a runner).
RUNNER_STATS = ["SB", "CS", "R"]
SB_BITS = {1: 1, 2: 2, 3: 3}                 # base -> flag bit for a steal of base+1
CS_BITS = {1: 4, 2: 5, 3: 6}
D_STAY, D_TO1, D_TO2, D_TO3, D_SCORE = 2, 3, 4, 5, 6
ALL_STATS = list(OUTCOME_STATS) + ["RBI", "GIDP", "G"] + RUNNER_STATS


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


def build_player_dim():
    """retroID -> gpid (sorted), and rows[gpid] = (retroID, display, birthYear, bats)."""
    retro_to_display = build_retro_to_display(PEOPLE_PATH)
    bio = {}
    with open(PEOPLE_PATH, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            r = (row.get("retroID") or "").strip()
            if r:
                bio[r] = (row.get("birthYear") or "", row.get("bats") or "")
    retros = set()
    for path in CORPUS:
        for rid, _ in decode(path, lite=True).players:
            retros.add(rid)
    retro_to_gpid = {r: i for i, r in enumerate(sorted(retros))}
    rows = [None] * len(retro_to_gpid)
    for r, i in retro_to_gpid.items():
        by, bats = bio.get(r, ("", ""))
        rows[i] = (r, retro_to_display.get(r, r), by, bats)
    return retro_to_gpid, rows


def aggregate(stats, retro_to_gpid):
    """One corpus pass (game-by-game, so the runner replay has clean boundaries)
    -> agg[stat] = {(gpid,gdate): count}."""
    want_outcome = {s: OUTCOME_STATS[s] for s in stats if s in OUTCOME_STATS}
    want_rbi = "RBI" in stats
    want_gidp = "GIDP" in stats
    want_sb = "SB" in stats; want_cs = "CS" in stats; want_r = "R" in stats
    want_runner = want_sb or want_cs or want_r
    agg = {s: defaultdict(int) for s in stats if s != "G"}
    gmask = 1 << GIDP_FLAG_BIT
    for path in CORPUS:
        d = decode(path, lite=True)
        base = datetime.date(d.year, 1, 1).toordinal() - 1
        idx_gpid = [retro_to_gpid.get(rid, -1) for rid, _ in d.players]
        oc = d.col["outcome"]; bidx = d.col["batterIdx"]; rbi = d.col["rbi"]
        flags = d.col["flags"]; inning = d.col["inning"]; half = d.col["batTeam"]
        dB, d1, d2, d3 = (d.col["dispB"], d.col["disp1"], d.col["disp2"], d.col["disp3"])
        for gi, (day, _v, _h, first, _g) in enumerate(d.games):
            end = d.games[gi + 1][3] if gi + 1 < len(d.games) else d.E
            gdate = base + day - EPOCH
            occ = [None, None, None, None]       # base 1..3 occupant gpid (None = empty)
            cur_half = None
            for ev in range(first, end):
                bi = bidx[ev]
                g = idx_gpid[bi] if bi != 0xFFFF else -1
                # New half-inning clears the bases. (inning, batting-team) is the key —
                # batTeam flips each half and increments make a fresh inning.
                hk = (inning[ev], half[ev])
                if hk != cur_half:
                    occ = [None, None, None, None]; cur_half = hk
                r1, r2, r3 = occ[1], occ[2], occ[3]
                # --- batter-attributed ---
                if g >= 0:
                    code = oc[ev]; key = g * 100000 + gdate
                    for s, cs in want_outcome.items():
                        if code in cs:
                            agg[s][key] += 1
                    if want_rbi and rbi[ev]:
                        agg["RBI"][key] += rbi[ev]
                    if want_gidp and (flags[ev] & gmask):
                        agg["GIDP"][key] += 1
                # --- runner-attributed (replay) ---
                if want_runner:
                    fl = flags[ev]
                    runners = (r1, r2, r3)
                    if want_sb:
                        for b in (1, 2, 3):
                            r = runners[b - 1]
                            if r is not None and r >= 0 and (fl & (1 << SB_BITS[b])):
                                agg["SB"][r * 100000 + gdate] += 1
                    if want_cs:
                        for b in (1, 2, 3):
                            r = runners[b - 1]
                            if r is not None and r >= 0 and (fl & (1 << CS_BITS[b])):
                                agg["CS"][r * 100000 + gdate] += 1
                    if want_r:
                        if g >= 0 and dB[ev] == D_SCORE:
                            agg["R"][g * 100000 + gdate] += 1
                        for r, dp in ((r1, d1[ev]), (r2, d2[ev]), (r3, d3[ev])):
                            if r is not None and r >= 0 and dp == D_SCORE:
                                agg["R"][r * 100000 + gdate] += 1
                    # advance the base state for the next event
                    nb = [None, None, None, None]
                    for b, (r, dp) in ((1, (r1, d1[ev])), (2, (r2, d2[ev])), (3, (r3, d3[ev]))):
                        if r is None:
                            continue
                        dest = {D_STAY: b, D_TO1: 1, D_TO2: 2, D_TO3: 3}.get(dp)
                        if dest:
                            nb[dest] = r          # OUT / SCORE / ABSENT -> off base
                    db = dB[ev]
                    dest = {D_TO1: 1, D_TO2: 2, D_TO3: 3}.get(db)
                    if dest and g is not None:
                        nb[dest] = g
                    occ = nb
    if "G" in stats and "PA" in agg:             # appearances: 1 per (gpid,date) with a PA
        agg["G"] = {k: 1 for k in agg["PA"]}
    return agg


def cells_by_player(agg_stat):
    """{(gpid,gdate):count} -> {gpid: sorted [(gdate,count)]}."""
    by = defaultdict(list)
    for key, ct in agg_stat.items():
        by[key // 100000].append((key % 100000, ct))
    for g in by:
        by[g].sort()
    return by


def write_stat_file(name, by_player):
    buf = io.BytesIO()
    buf.write(b"BL2S")
    buf.write(struct.pack("<BBB", MAJOR, MINOR, 1))           # kind 1 = stat
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
    buf.write(struct.pack("<BBB", MAJOR, MINOR, 0))           # kind 0 = players
    buf.write(struct.pack("<HBB", EPOCH_DATE.year, EPOCH_DATE.month, EPOCH_DATE.day))
    buf.write(struct.pack("<I", len(rows)))
    for rid, name, by, bats in rows:
        rb = rid.encode("utf-8"); nmb = name.encode("utf-8")[:255]
        buf.write(struct.pack("<B", len(rb))); buf.write(rb)
        buf.write(struct.pack("<B", len(nmb))); buf.write(nmb)
        buf.write(struct.pack("<HB", int(by) if by.isdigit() else 0, BATS.get(bats, 3)))
    return gzip.compress(buf.getvalue(), 9)


def write_csv(name, by_player):
    out = io.StringIO()
    out.write("gpid,date,count\n")
    for g in sorted(by_player):
        for dt, ct in by_player[g]:
            out.write(f"{g},{dt},{ct}\n")
    return gzip.compress(out.getvalue().encode(), 9)


def main():
    ap = argparse.ArgumentParser(description="Build the BL2S normalized stat layer from BL2E")
    ap.add_argument("stats", nargs="*", help="subset of stats (default: all batter-attributed)")
    ap.add_argument("--out", default=str(OUT_DIR))
    ap.add_argument("--csv", action="store_true", help="also write gzipped per-stat CSVs")
    args = ap.parse_args()
    stats = args.stats or ALL_STATS
    out_dir = Path(args.out); out_dir.mkdir(parents=True, exist_ok=True)
    print(f"corpus: {len(CORPUS)} season files | stats: {stats}")

    retro_to_gpid, rows = build_player_dim()
    pdata = write_player_dim(rows)
    (out_dir / "stat_players.bl2s.gz").write_bytes(pdata)
    print(f"  stat_players.bl2s.gz: {len(rows):,} players, {len(pdata) / 1024:,.0f} KB")

    agg = aggregate(stats, retro_to_gpid)
    total = len(pdata)
    print(f"  {'stat':6} {'players':>8} {'cells':>10} {'total':>12} {'KB':>7}")
    for s in stats:
        by = cells_by_player(agg[s])
        data = write_stat_file(s, by)
        (out_dir / f"stat_{s.lower()}.bl2s.gz").write_bytes(data)
        total += len(data)
        if args.csv:
            (out_dir / f"stat_{s.lower()}.csv.gz").write_bytes(write_csv(s, by))
        tot = sum(c for v in by.values() for _, c in v)
        print(f"  {s:6} {len(by):>8,} {sum(len(v) for v in by.values()):>10,} "
              f"{tot:>12,} {len(data) / 1024:>7,.0f}")
    print(f"  TOTAL binary: {total / 1024 / 1024:.1f} MB" + (" (+ CSVs)" if args.csv else ""))


if __name__ == "__main__":
    main()
