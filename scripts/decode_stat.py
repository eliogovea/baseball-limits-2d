"""Decoder for the BL2S normalized stat layer (see docs/pbp-stat-format.md).

Two file kinds, both magic 'BL2S':
  - PLAYERS (kind 0): the shared dimension — gpid -> retroID, display name, birthYear, bats.
  - STAT    (kind 1): one counting stat, per-player date-keyed timeline (player-grouped
    varint date-deltas). Date = days since the epoch stored in the file (1910-04-14).

    from decode_stat import decode_players, decode_stat
    dim = decode_players("data/pbp/stat_players.bl2s.gz")   # dim["players"][gpid] = (...)
    hr  = decode_stat("data/pbp/stat_hr.bl2s.gz")           # hr["series"][gpid] = [(date,count),...]
"""

import gzip
import struct
from pathlib import Path

MAGIC = b"BL2S"


def _varint(b, p):
    shift = 0
    val = 0
    while True:
        x = b[p]; p += 1
        val |= (x & 0x7F) << shift
        if not (x & 0x80):
            return val, p
        shift += 7


def _header(raw, expect_kind):
    if raw[:4] != MAGIC:
        raise ValueError("bad BL2S magic")
    major, minor, kind = struct.unpack("<BBB", raw[4:7])
    if kind != expect_kind:
        raise ValueError(f"expected kind {expect_kind}, got {kind}")
    return major, minor, 7


def decode_players(path):
    raw = gzip.decompress(Path(path).read_bytes())
    major, minor, p = _header(raw, 0)
    ey, em, ed = struct.unpack("<HBB", raw[p:p + 4]); p += 4
    n, = struct.unpack("<I", raw[p:p + 4]); p += 4
    players = []
    for _ in range(n):
        l = raw[p]; p += 1; rid = raw[p:p + l].decode("utf-8"); p += l
        l = raw[p]; p += 1; nm = raw[p:p + l].decode("utf-8"); p += l
        by, bats = struct.unpack("<HB", raw[p:p + 3]); p += 3
        players.append((rid, nm, by, bats))
    return {"epoch": (ey, em, ed), "players": players}


def decode_stat(path):
    raw = gzip.decompress(Path(path).read_bytes())
    major, minor, p = _header(raw, 1)
    l = raw[p]; p += 1; name = raw[p:p + l].decode("utf-8"); p += l
    ey, em, ed = struct.unpack("<HBB", raw[p:p + 4]); p += 4
    n, = struct.unpack("<I", raw[p:p + 4]); p += 4
    series = {}
    gpid = 0
    for _ in range(n):
        dg, p = _varint(raw, p); gpid += dg
        nc, p = _varint(raw, p)
        date = 0
        cells = []
        for _ in range(nc):
            dd, p = _varint(raw, p); date += dd
            ct, p = _varint(raw, p)
            cells.append((date, ct))
        series[gpid] = cells
    return {"name": name, "epoch": (ey, em, ed), "series": series}


if __name__ == "__main__":
    import sys
    path = sys.argv[1]
    if "players" in path:
        d = decode_players(path)
        print(f"BL2S players: {len(d['players']):,} | epoch {d['epoch']}")
        for rid, nm, by, bats in d["players"][:5]:
            print(f"  {rid} {nm!r} b.{by} bats={bats}")
    else:
        d = decode_stat(path)
        cells = sum(len(v) for v in d["series"].values())
        tot = sum(c for v in d["series"].values() for _, c in v)
        print(f"BL2S stat {d['name']!r}: {len(d['series']):,} players, {cells:,} cells, "
              f"total {tot:,} | epoch {d['epoch']}")
