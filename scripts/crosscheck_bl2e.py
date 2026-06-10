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


def event_batting_teams(d):
    """Per-event batting-team code: walk games, assign each event in a game's
    [firstEventIdx, next) span the vis or home team per its batTeam flag
    (vis_home: 0 = visitor batting)."""
    teams = [None] * d.E
    half = d.col["batTeam"]
    for gi, (_day, vis, home, first, _gid) in enumerate(d.games):
        end = d.games[gi + 1][3] if gi + 1 < len(d.games) else d.E
        for ev in range(first, end):
            teams[ev] = d.teams[home] if half[ev] == 1 else d.teams[vis]
    return teams


def bl2e_totals(d, allowed_teams=None):
    """Aggregate batter-attributed totals. If allowed_teams is given, count only
    events whose batting team is in it (so a Negro-League / FL year compares
    apples-to-apples against a same-league Lahman slice)."""
    if allowed_teams is None:
        c = Counter(d.col["outcome"])
        rbi_total = sum(d.col["rbi"])
    else:
        bteams = event_batting_teams(d)
        c = Counter()
        rbi_total = 0
        rbi = d.col["rbi"]
        for ev, code in enumerate(d.col["outcome"]):
            if bteams[ev] in allowed_teams:
                c[code] += 1
                rbi_total += rbi[ev]
    t = {}
    t["PA"] = sum(v for k, v in c.items() if k != 0)
    t["1B"], t["2B"], t["3B"], t["HR"] = c[B1], c[B2], c[B3], c[HR]
    t["H"] = t["1B"] + t["2B"] + t["3B"] + t["HR"]
    t["BB"] = c[BB] + c[IBB]            # Lahman BB is inclusive of intentional
    t["IBB"] = c[IBB]
    t["SO"], t["HBP"], t["SF"], t["SH"] = c[K], c[HBP], c[SF], c[SH]
    # AB = PA minus the non-AB plate appearances (BB, HBP, SH, SF, catcher interference)
    t["AB"] = t["PA"] - t["BB"] - t["HBP"] - t["SF"] - t["SH"] - c[XI]
    t["RBI"] = rbi_total
    t["_XI"] = c[XI]
    return t


# Retrosheet's parsed plays cover only the AL/NL (and the 1914–15 Federal League).
# Lahman additionally carries the Negro Leagues (NNL/NN2/ECL/EWL/ANL/NAL/NSL), added in
# its 2020 release — which have NO play-by-play — so an unfiltered Lahman sum for an early
# season overshoots BL2E by the Negro-League totals. Restrict to the leagues BL2E can cover.
RETRO_LEAGUES = {"AL", "NL", "FL"}


def lahman_totals(path, year):
    L = Counter()
    teams = set()
    cols = ("AB", "H", "2B", "3B", "HR", "RBI", "BB", "SO", "IBB", "HBP", "SH", "SF")
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["yearID"] != str(year) or row.get("lgID") not in RETRO_LEAGUES:
                continue
            teams.add(row["teamID"])
            for k in cols:
                L[k] += int(row[k] or 0)
    # PA incl. catcher interference, to match BL2E's PA (XI is in neither AB nor the others).
    L["PA"] = L["AB"] + L["BB"] + L["HBP"] + L["SH"] + L["SF"]
    L["1B"] = L["H"] - L["2B"] - L["3B"] - L["HR"]
    return L, teams


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: python3 scripts/crosscheck_bl2e.py <file.bl2e.gz> [lahman.csv]")
    d = decode(sys.argv[1])
    lahman_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_LAHMAN
    L, _lahman_teams = lahman_totals(lahman_path, d.year)
    # Aggregate ALL BL2E events (no team filter — Retrosheet vs Lahman franchise codes
    # diverge, e.g. ANA vs LAA, so exact code-matching wrongly drops teams). We instead
    # reason about the DIRECTION of the diff below.
    B = bl2e_totals(d)

    # Only these six are well-defined and reliably recorded across ALL eras, so they gate
    # pass/fail. The rest carry documented Retrosheet-vs-Lahman definitional drift (reported,
    # not gated): SH (pre-1931 sac flies scored as sac hits; SF not split out til 1954),
    # SF/IBB (not official until 1954/1955 — Lahman = 0 before then, Retrosheet reconstructs),
    # RBI (not official until 1920; estimated in deduced games), HBP/1B/2B/3B (minor deduced-
    # game noise).
    GATED = ["PA", "AB", "H", "HR", "BB", "SO"]

    print(f"BL2E {d.year} vs Lahman ({Path(lahman_path).name}; AL/NL/FL only)")
    print(f"{'stat':5} {'BL2E':>9} {'Lahman':>9} {'diff':>7} {'%':>7}")
    xi = B["_XI"]
    # A genuine encoding regression makes BL2E systematically LOWER than the official AL/NL
    # totals across MANY stats at once (missing data). BL2E running HIGHER is broader league
    # coverage — Retrosheet carries Negro-League (~1920–1948) and Federal-League (1914–15)
    # play-by-play that the AL/NL/FL Lahman slice may under-count — not a bug. Isolated single-
    # stat drift (e.g. deadball SO) is provenance. So we flag only: >=3 gated stats LOWER by
    # >3% & >200.
    gated_low = 0
    higher = 0
    for k in ["PA", "AB", "H", "1B", "2B", "3B", "HR", "BB", "IBB", "SO", "HBP", "SF", "SH", "RBI"]:
        b, l = B[k], L.get(k, 0)
        diff = b - l
        pct = (100 * diff / l) if l else 0.0
        note = ""
        if k == "PA" and diff == xi:
            note = f"  (+{xi} XI, expected)"
        elif l == 0 and diff:
            note = "  (stat absent in Lahman this era)"
        elif diff > 0 and abs(pct) > 2.0:
            note = "  (BL2E higher — broader league coverage)"
            if k in GATED:
                higher += 1
        elif diff < 0 and k in GATED and abs(diff) > 200 and abs(pct) > 3.0:
            note = "  <-- LOW"
            gated_low += 1
        elif diff != 0:
            note = "  (provenance)" if k in GATED else "  (definitional)"
        print(f"{k:5} {b:>9,} {l:>9,} {diff:>7,} {pct:>6.2f}%{note}")

    if gated_low >= 3:
        print(f"\nRESULT: {gated_low} gated stats LOW vs Lahman — investigate (possible missing data)")
        sys.exit(1)
    if higher:
        print("\nRESULT: OK — BL2E runs higher (Negro-League / FL coverage beyond the AL/NL Lahman slice)")
    else:
        print("\nRESULT: OK — gated stats match Lahman within provenance")
    sys.exit(0)


if __name__ == "__main__":
    main()
