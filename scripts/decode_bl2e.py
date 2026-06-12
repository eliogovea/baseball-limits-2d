"""Decode a BL2E event-level season file (see docs/data-formats.md §BL2E).

Reference reader for the format `convert_retrosheet_events.py` writes — used by the
verification harness (`verify_bl2e.py`) and as the spec-by-example for the eventual JS
consumer in script.js. Pure stdlib.

    from decode_bl2e import decode
    d = decode("data/pbp/e2023.bl2e.gz")
    d.E, d.games[0], d.players[d.col["batterIdx"][0]], d.col["outcome"][0]
"""

import gzip
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

# Mirror the encoder's enums so callers can read symbolically (kept in sync by hand;
# the files are self-describing for *widths* but not for these semantic codes).
OUTCOME_NAMES = ["NONE", "OUT", "K", "BB", "IBB", "HBP", "1B", "2B",
                 "3B", "HR", "ROE", "FC", "SH", "SF", "XI", "NOOUT"]
DISP_NAMES = ["ABSENT", "OUT", "STAY", "TO1", "TO2", "TO3", "SCORE"]
FLAG_COLS = ["iw", "sb2", "sb3", "sbh", "cs2", "cs3", "csh", "pko1", "pko2", "pko3",
             "wp", "pb", "bk", "oa", "di", "gdp", "othdp", "tp", "fle", "k_safe"]
D_OUT = 1


@dataclass
class Bl2e:
    major: int
    minor: int
    flags: int
    year: int
    E: int                      # event count
    teams: list                 # team codes, index-aligned
    colmeta: list               # [(name, bitWidth), ...] in payload order
    players: list               # [(retroID, displayName), ...]
    games: list                 # [(dayOfYear, visIdx, homeIdx, firstEventIdx, gid), ...]
    col: dict                   # name -> [value per event]
    pitches: list               # Layer B: raw pitch string per event ([] if none)
    fielding: dict              # Layer C: {col, umpires, valdict} or None

    def game_of_event(self, ev):
        """Binary-search the game table for the game containing event index `ev`."""
        lo, hi = 0, len(self.games)
        while lo + 1 < hi:
            mid = (lo + hi) // 2
            if self.games[mid][3] <= ev:
                lo = mid
            else:
                hi = mid
        return lo


def _unpack_bits(buf, off, n, width):
    """Inverse of convert_retrosheet_pbp.pack_bits: n values of `width` bits, LSB-first,
    starting byte-aligned at `off`. Returns (values, next_byte_offset)."""
    vals = []
    acc = 0
    nbits = 0
    bp = off
    mask = (1 << width) - 1
    for _ in range(n):
        while nbits < width:
            acc |= buf[bp] << nbits
            bp += 1
            nbits += 8
        vals.append(acc & mask)
        acc >>= width
        nbits -= width
    return vals, off + (n * width + 7) // 8


def decode(path, lite=False):
    """Decode a BL2E file. lite=True stops after the Layer A columns (skips pitch /
    fielding parsing) — for callers that only need the core columns + game table."""
    raw = gzip.decompress(Path(path).read_bytes())
    p = 0

    def take(n):
        nonlocal p
        b = raw[p:p + n]
        p += n
        return b

    if take(4) != b"BL2E":
        sys.exit(f"{path}: bad magic")
    major, minor, flags = struct.unpack("<BBB", take(3))
    year, E, Gn, P, nteams = struct.unpack("<HIHHH", take(12))
    ncols, = struct.unpack("<H", take(2))

    teams = []
    for _ in range(nteams):
        l, = struct.unpack("<B", take(1))
        teams.append(take(l).decode())

    colmeta = []
    for _ in range(ncols):
        w, l = struct.unpack("<BB", take(2))
        colmeta.append((take(l).decode(), w))

    players = []
    for _ in range(P):
        rl, nl = struct.unpack("<BB", take(2))
        rid = take(rl).decode()
        nm = take(nl).decode()
        players.append((rid, nm))

    games = []
    for _ in range(Gn):
        day, vis, home, first = struct.unpack("<HBBI", take(8))
        gl, = struct.unpack("<B", take(1))
        games.append((day, vis, home, first, take(gl).decode()))

    col = {}
    off = p
    for name, w in colmeta:
        col[name], off = _unpack_bits(raw, off, E, w)

    if lite:                              # skip Layer B/C — caller only needs core columns
        return Bl2e(major, minor, flags, year, E, teams, colmeta, players, games, col,
                    [""] * E, None)

    # Layer B pitch section (header flag bit0): symbol alphabet + per-event length
    # column + a flat symbol stream sliced back into one string per event.
    pitches = []
    if flags & 0x01:
        sym_count = raw[off]; off += 1
        alphabet = raw[off:off + sym_count].decode("utf-8"); off += sym_count
        len_width = raw[off]; off += 1
        pitch_lens, off = _unpack_bits(raw, off, E, len_width)
        total = sum(pitch_lens)
        sym_width = max(1, (sym_count - 1).bit_length()) if sym_count > 1 else 1
        syms, off = _unpack_bits(raw, off, total, sym_width)
        pos = 0
        for n in pitch_lens:
            pitches.append("".join(alphabet[s] for s in syms[pos:pos + n]))
            pos += n
    else:
        pitches = [""] * E

    # Layer C fielding section (header flag bit1): self-describing columns + umpire dict
    # + value dicts for loc/fseq/hittype.
    fielding = None
    if flags & 0x02:
        ccount, = struct.unpack("<H", raw[off:off + 2]); off += 2
        cmeta = []
        for _ in range(ccount):
            w, l = struct.unpack("<BB", raw[off:off + 2]); off += 2
            cmeta.append((raw[off:off + l].decode("utf-8"), w)); off += l
        ump_count, = struct.unpack("<H", raw[off:off + 2]); off += 2
        umpires = []
        for _ in range(ump_count):
            l = raw[off]; off += 1
            umpires.append(raw[off:off + l].decode("utf-8")); off += l
        valdict = {}
        for name in ("loc", "fseq", "hittype"):
            n, = struct.unpack("<H", raw[off:off + 2]); off += 2
            vals = []
            for _ in range(n):
                l = raw[off]; off += 1
                vals.append(raw[off:off + l].decode("utf-8")); off += l
            valdict[name] = vals
        fcol = {}
        for name, w in cmeta:
            fcol[name], off = _unpack_bits(raw, off, E, w)
        fielding = {"col": fcol, "umpires": umpires, "valdict": valdict}

    if off != len(raw):
        sys.exit(f"{path}: {len(raw) - off} trailing bytes after payload")

    return Bl2e(major, minor, flags, year, E, teams, colmeta, players, games, col,
                pitches, fielding)


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: python3 scripts/decode_bl2e.py <file.bl2e.gz>")
    d = decode(sys.argv[1])
    print(f"BL2E v{d.major}.{d.minor} flags={d.flags} year={d.year}")
    print(f"events={d.E:,} games={len(d.games):,} players={len(d.players):,} teams={len(d.teams)}")
    print(f"columns: {[f'{n}/{w}b' for n, w in d.colmeta]}")
    from collections import Counter
    oc = Counter(d.col["outcome"])
    print("outcome:", {OUTCOME_NAMES[k]: v for k, v in sorted(oc.items())})
    if d.flags & 0x01:
        nchars = sum(len(s) for s in d.pitches)
        print(f"pitches: {nchars:,} chars over {sum(1 for s in d.pitches if s):,} events; "
              f"e.g. {next((s for s in d.pitches if s), '')!r}")
    if d.fielding:
        f = d.fielding
        print(f"fielding (Layer C): {len(f['col'])} cols, {len(f['umpires'])} umpires, "
              f"loc/{len(f['valdict']['loc'])} fseq/{len(f['valdict']['fseq'])} "
              f"hittype/{len(f['valdict']['hittype'])} value dicts")


if __name__ == "__main__":
    main()
