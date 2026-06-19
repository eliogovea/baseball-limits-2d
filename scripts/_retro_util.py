"""Shared Retrosheet/Lahman helpers used across the data converters.

These used to live in `convert_retrosheet_pbp.py` (the BL2P writer), which the BL2E
and BL2S builders imported them from. BL2P was retired in S4 (see docs/ROADMAP.md §S4),
so the genuinely shared helpers moved here to keep them after that file was deleted.

Imported by `convert_retrosheet_events.py` (BL2E), `build_stat_files.py` (BL2S, via the
re-export there), and `statfile_experiment.py`.
"""

import csv
from datetime import date

from _display_name import build_display_name_map


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
