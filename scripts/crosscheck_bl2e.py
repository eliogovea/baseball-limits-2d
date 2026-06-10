"""Cross-check BL2E-derived season batting totals against Lahman (phase P3).

A provenance sanity report: aggregate the directly batter-attributable counting stats
from a decoded BL2E file's `outcome`/`rbi` columns and compare to the Lahman regular-
season totals for the same year (data/batting_limits_*.csv).

Interpretation: BL2E's per-event fidelity to its *Retrosheet* source is already proven
exactly by verify_bl2e.py (every column round-trips). This script instead compares to
Lahman, a *different* source. Expect:
  - modern seasons (~1974+, full PBP): exact match — Retrosheet and Lahman agree.
  - older seasons: small diffs (sub-1%) — Retrosheet's reconstructed play-by-play
    legitimately differs from Lahman's official totals (e.g. 1955 SO off by 27/10,830
    = 0.25%). These are source-provenance, NOT encoding bugs.
So this only FAILS on an implausibly large diff (>2% and >50 absolute), which would
signal a real encoding regression rather than provenance drift.

NOT checked here: SB / CS / R. Those are credited to a *runner*, whose identity BL2E
does not store (only the per-base advance disposition) — recovering them needs the
game replay. PA includes catcher interference (XI), which the naive AB+BB+HBP+SH+SF
formula omits, so we add it explicitly.

Usage:
    python3 scripts/crosscheck_bl2e.py <file.bl2e.gz> [lahman_batting_limits.csv]
"""

import csv
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from decode_bl2e import decode

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LAHMAN = ROOT / "data" / "batting_limits_1871-2025.csv"

# outcome enum indices (mirror convert_retrosheet_events / decode_bl2e)
K, BB, IBB, HBP, B1, B2, B3, HR, XI, SH, SF = 2, 3, 4, 5, 6, 7, 8, 9, 14, 12, 13


def bl2e_totals(d):
    c = Counter(d.col["outcome"])
    t = {}
    t["PA"] = sum(v for k, v in c.items() if k != 0)
    t["1B"], t["2B"], t["3B"], t["HR"] = c[B1], c[B2], c[B3], c[HR]
    t["H"] = t["1B"] + t["2B"] + t["3B"] + t["HR"]
    t["BB"] = c[BB] + c[IBB]            # Lahman BB is inclusive of intentional
    t["IBB"] = c[IBB]
    t["SO"], t["HBP"], t["SF"], t["SH"] = c[K], c[HBP], c[SF], c[SH]
    # AB = PA minus the non-AB plate appearances (BB, HBP, SH, SF, catcher interference)
    t["AB"] = t["PA"] - t["BB"] - t["HBP"] - t["SF"] - t["SH"] - c[XI]
    t["RBI"] = sum(d.col["rbi"])
    return t


def lahman_totals(path, year):
    L = Counter()
    cols = ("AB", "H", "2B", "3B", "HR", "RBI", "BB", "SO", "IBB", "HBP", "SH", "SF")
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["yearID"] != str(year):
                continue
            for k in cols:
                L[k] += int(row[k] or 0)
    # PA incl. catcher interference, to match BL2E's PA (XI is in neither AB nor the others).
    L["PA"] = L["AB"] + L["BB"] + L["HBP"] + L["SH"] + L["SF"]
    L["1B"] = L["H"] - L["2B"] - L["3B"] - L["HR"]
    return L


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: python3 scripts/crosscheck_bl2e.py <file.bl2e.gz> [lahman.csv]")
    d = decode(sys.argv[1])
    lahman_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_LAHMAN
    B = bl2e_totals(d)
    L = lahman_totals(lahman_path, d.year)

    print(f"BL2E {d.year} vs Lahman ({Path(lahman_path).name})")
    print(f"{'stat':5} {'BL2E':>9} {'Lahman':>9} {'diff':>7} {'%':>7}")
    # PA carries the XI offset (XI is in neither AB nor BB/HBP/SH/SF); expected, not drift.
    xi = Counter(d.col["outcome"])[XI]
    exact = True       # any nonzero diff at all (provenance or bug)
    bug = 0            # implausibly large diff -> likely a real encoding regression
    for k in ["PA", "AB", "H", "1B", "2B", "3B", "HR", "BB", "IBB", "SO", "HBP", "SF", "SH", "RBI"]:
        b, l = B[k], L.get(k, 0)
        diff = b - l
        pct = (100 * diff / l) if l else 0.0
        note = ""
        if k == "PA" and diff == xi:
            note = f"  (+{xi} XI, expected)"
        elif diff != 0:
            exact = False
            if abs(diff) > 50 and abs(pct) > 2.0:
                note = "  <-- LIKELY BUG"
                bug += 1
            else:
                note = "  (provenance)"
        print(f"{k:5} {b:>9,} {l:>9,} {diff:>7,} {pct:>6.2f}%{note}")
    if bug:
        print(f"\nRESULT: {bug} IMPLAUSIBLE diff(s) — investigate encoding")
    elif exact:
        print("\nRESULT: EXACT match to Lahman")
    else:
        print("\nRESULT: OK — small diffs within Retrosheet-vs-Lahman provenance")
    sys.exit(1 if bug else 0)


if __name__ == "__main__":
    main()
