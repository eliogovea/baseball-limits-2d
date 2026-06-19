"""Explore normalized per-stat file layouts derived from the BL2E corpus.

Design under exploration (user-driven):
  - a SHARED player document (dimension): gpid -> retroID, name, birthYear, bats —
    so per-stat files carry only (player, value), names stored once;
  - one file PER STAT, event-derived but keyed by DATE (days since 1910-04-14, u16 —
    verified to fit, 64yr headroom), i.e. per-(player, date) counts;
  - measure several encodings per stat so we pick by real bytes, plus a CSV export
    (the "both binary and analysis" ask).

This is a MEASUREMENT harness (like pbp_*_experiment), not a committed format yet.

    python3 scripts/statfile_experiment.py [STAT ...]   # default: a representative spread
"""

import csv
import datetime
import glob
import gzip
import math
import struct
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from decode_bl2e import decode
from _retro_util import pack_bits
from convert_retrosheet_events import build_retro_to_display, PEOPLE_PATH

ROOT = Path(__file__).resolve().parent.parent
CORPUS = sorted(glob.glob(str(ROOT / "data" / "pbp" / "e*.bl2e.gz")))
EPOCH = datetime.date(1910, 4, 14).toordinal()

# Batter-attributed stats: stat -> set of outcome enum codes that add 1.
# (SB/CS/R need runner identity via replay — out of scope for this batting slice.)
OUT = {"OUT": 1, "K": 2, "BB": 3, "IBB": 4, "HBP": 5, "1B": 6, "2B": 7, "3B": 8, "HR": 9}
STAT_CODES = {
    "HR": {9}, "3B": {8}, "2B": {7}, "H": {6, 7, 8, 9},
    "BB": {3, 4}, "SO": {2}, "HBP": {5}, "1B": {6},
}


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


def gz(b):
    return len(gzip.compress(bytes(b), 9))


def kb(n):
    return f"{n / 1024:,.0f} KB"


def build_player_dim():
    """Global retroID -> gpid (sorted), joined to Lahman name/birth/bats. Returns
    (retro_to_gpid, rows) where rows[gpid] = (retroID, name, birthYear, bats)."""
    retro_to_display = build_retro_to_display(PEOPLE_PATH)
    # Lahman bio (birthYear, bats) keyed by retroID, via people CSV.
    bio = {}
    with open(PEOPLE_PATH, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            r = (row.get("retroID") or "").strip()
            if r:
                bio[r] = (row.get("birthYear") or "", row.get("bats") or "")
    retros = set()
    for path in CORPUS:
        for rid, _name in decode(path, lite=True).players:
            retros.add(rid)
    retro_to_gpid = {r: i for i, r in enumerate(sorted(retros))}
    rows = [None] * len(retro_to_gpid)
    for r, i in retro_to_gpid.items():
        by, bats = bio.get(r, ("", ""))
        rows[i] = (r, retro_to_display.get(r, r), by, bats)
    return retro_to_gpid, rows


def measure_player_dim(rows):
    # Binary: per entry u8 idLen+retroID, u8 nameLen+name, u16 birthYear, u8 bats(0=R1=L2=B3=?)
    buf = bytearray()
    BATS = {"R": 0, "L": 1, "B": 2}
    for rid, name, by, bats in rows:
        rb = rid.encode(); nb = name.encode()[:255]
        buf += struct.pack("<B", len(rb)) + rb
        buf += struct.pack("<B", len(nb)) + nb
        buf += struct.pack("<H", int(by) if by.isdigit() else 0)
        buf += struct.pack("<B", BATS.get(bats, 3))
    # CSV
    cbuf = "gpid,retroID,name,birthYear,bats\n" + "".join(
        f"{i},{rid},{name},{by},{bats}\n" for i, (rid, name, by, bats) in enumerate(rows))
    cb = cbuf.encode()
    print(f"PLAYER DIM: {len(rows):,} players | binary {kb(len(buf))} raw -> {kb(gz(buf))} gz "
          f"| CSV {kb(len(cb))} raw -> {kb(gz(cb))} gz")


def aggregate(stats, retro_to_gpid):
    """One pass over the corpus -> per stat, dict (gpid,gdate)->count (compact int key)."""
    codes_for = {s: STAT_CODES[s] for s in stats}
    agg = {s: defaultdict(int) for s in stats}
    for path in CORPUS:
        d = decode(path, lite=True)
        base = datetime.date(d.year, 1, 1).toordinal() - 1
        # per-event global date via the game spans
        ev_date = [0] * d.E
        for gi, (day, _v, _h, first, _g) in enumerate(d.games):
            end = d.games[gi + 1][3] if gi + 1 < len(d.games) else d.E
            gdate = base + day - EPOCH
            for ev in range(first, end):
                ev_date[ev] = gdate
        # season-local player index -> gpid
        idx_gpid = [retro_to_gpid.get(rid, -1) for rid, _ in d.players]
        oc = d.col["outcome"]; bidx = d.col["batterIdx"]
        for ev in range(d.E):
            code = oc[ev]
            bi = bidx[ev]
            g = idx_gpid[bi] if bi != 0xFFFF else -1
            if g < 0:
                continue
            key = g * 100000 + ev_date[ev]
            for s, codeset in codes_for.items():
                if code in codeset:
                    agg[s][key] += 1
    return agg


def encode_stat(cells, max_gpid):
    """cells: list of (gpid, gdate, count) sorted by (gpid, gdate). Return dict of
    encoding -> gz bytes."""
    gpids = [c[0] for c in cells]
    dates = [c[1] for c in cells]
    counts = [c[2] for c in cells]
    gw = max(1, (max_gpid).bit_length())
    cw = max(1, (max(counts)).bit_length())

    # A. columnar absolute: gpid (bitpacked) + date (u16) + count (bitpacked)
    a = pack_bits(gpids, gw) + struct.pack(f"<{len(dates)}H", *dates) + pack_bits(counts, cw)

    # B. player-grouped varint date-deltas (.evt style, gpid-delta header)
    b = bytearray()
    i = 0
    prev_g = 0
    n = len(cells)
    while i < n:
        g = gpids[i]
        j = i
        while j < n and gpids[j] == g:
            j += 1
        b += varint(g - prev_g); prev_g = g
        b += varint(j - i)
        pd = 0
        for k in range(i, j):
            b += varint(dates[k] - pd); pd = dates[k]
            b += varint(counts[k])
        i = j

    # C. CSV
    c = ("gpid,date,count\n" + "".join(f"{g},{dt},{ct}\n"
         for g, dt, ct in cells)).encode()

    return {"A_columnar": gz(a), "B_varint": gz(b), "C_csv_gz": gz(c), "C_csv_raw": len(c)}


def encode_group(per_stat_cells, group, max_gpid):
    """One file holding several stats that share (gpid,date) addressing. Union the
    cells; per cell store date once + one varint count per stat in the group (0 if
    absent). Player-grouped varint, like B. Returns gz size."""
    # merge: (gpid,date) -> [count per stat in group]
    merged = defaultdict(lambda: [0] * len(group))
    for gi, s in enumerate(group):
        for (g, dt, ct) in per_stat_cells[s]:
            merged[(g, dt)][gi] = ct
    cells = sorted(merged.items())                # ((gpid,date), counts)
    b = bytearray()
    prev_g = 0
    i = 0
    n = len(cells)
    while i < n:
        g = cells[i][0][0]
        j = i
        while j < n and cells[j][0][0] == g:
            j += 1
        b += varint(g - prev_g); prev_g = g
        b += varint(j - i)
        pd = 0
        for k in range(i, j):
            (_, dt), counts = cells[k]
            b += varint(dt - pd); pd = dt
            for c in counts:
                b += varint(c)
        i = j
    return gz(b), len(cells)


def main():
    stats = sys.argv[1:] or ["HR", "3B", "2B", "H", "BB", "SO", "HBP"]
    print(f"corpus: {len(CORPUS)} season files | stats: {stats}\n")
    retro_to_gpid, rows = build_player_dim()
    measure_player_dim(rows)
    max_gpid = len(rows) - 1
    print()
    agg = aggregate(stats, retro_to_gpid)
    per_stat_cells = {}
    per_stat_b = {}
    print(f"{'stat':5} {'cells':>10} {'players':>8} {'A col':>9} {'B varint':>9} "
          f"{'C csv.gz':>9} {'C csv raw':>10}")
    for s in stats:
        cells = sorted((k // 100000, k % 100000, v) for k, v in agg[s].items())
        per_stat_cells[s] = cells
        players = len({c[0] for c in cells})
        enc = encode_stat(cells, max_gpid)
        per_stat_b[s] = enc["B_varint"]
        print(f"{s:5} {len(cells):>10,} {players:>8,} {kb(enc['A_columnar']):>9} "
              f"{kb(enc['B_varint']):>9} {kb(enc['C_csv_gz']):>9} {kb(enc['C_csv_raw']):>10}")

    # Grouping: combine stats that share addressing. Compare one grouped file vs the
    # sum of the separate per-stat (B) files.
    groups = {
        "hits {H,2B,3B,HR}": ["H", "2B", "3B", "HR"],
        "discipline {BB,SO,HBP}": ["BB", "SO", "HBP"],
        "rare {HR,3B,HBP}": ["HR", "3B", "HBP"],
    }
    print(f"\n{'group':24} {'grouped':>9} {'sep sum':>9} {'win':>7}")
    for name, grp in groups.items():
        if not all(s in agg for s in grp):
            continue
        gsize, _ = encode_group(per_stat_cells, grp, max_gpid)
        sep = sum(per_stat_b[s] for s in grp)
        print(f"{name:24} {kb(gsize):>9} {kb(sep):>9} {100*(sep-gsize)/sep:>6.0f}%")


if __name__ == "__main__":
    main()
