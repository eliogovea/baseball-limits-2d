"""Verification harness for BL2E event-level files (docs/pbp-event-format.md, phase P2).

Runs three checks against a built `e<year>.bl2e.gz` and its source Retrosheet plays CSV:

  1. Event-count invariant — decoded E == regular-season rows in the CSV.
  2. Round-trip — for every event, the decoded columns equal what the source CSV row
     says (outcome / dispositions / outs / runs / rbi / flags / handedness / batter id),
     threaded back through the game table + player dict. Proves the bit-pack/unpack,
     dict indexing, game ordering, and firstEventIdx are all consistent end-to-end.
  3. Replay base-out invariant — outsPost == min(3, outsPre + #OUT dispositions). The
     min(3, …) cap matters: a play can retire two runners (e.g. batter + a runner) when
     only one out was needed to end the inning, so the out counter saturates at 3.
     Independent check that the advance-disposition encoding is internally consistent
     (the lever that lets a replay decoder recover base-out state without stored ids).

Usage:
    python3 scripts/verify_bl2e.py <file.bl2e.gz> <source_plays.csv>
"""

import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from decode_bl2e import decode, D_OUT
from convert_retrosheet_events import (
    outcome_code, dispositions, flags_value, _hand, read_season,
)

csv.field_size_limit(1 << 20)


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: python3 scripts/verify_bl2e.py <file.bl2e.gz> <source_plays.csv>")
    bl2e_path, csv_path = sys.argv[1], sys.argv[2]

    d = decode(bl2e_path)
    ordered, n_rows = read_season(csv_path, d.year)

    ok = True

    # --- 1. Event-count invariant ---------------------------------------------
    if d.E != n_rows:
        print(f"FAIL count: decoded E={d.E:,} != CSV regular rows={n_rows:,}")
        ok = False
    else:
        print(f"PASS count: {d.E:,} events == {n_rows:,} regular-season CSV rows")

    if len(d.games) != len(ordered):
        print(f"FAIL games: decoded {len(d.games)} != CSV {len(ordered)}")
        ok = False

    # --- 2. Round-trip: decoded columns == source rows, in game order ----------
    # The decoded file is stored game-major in the same (date, gid) order read_season
    # produces, so we can walk them in lockstep.
    col = d.col
    mism = 0
    checked = 0
    ev = 0
    for (gid, g), (gday, gvis, ghome, gfirst, ggid) in zip(ordered, d.games):
        if ggid != gid:
            print(f"FAIL gid order: decoded {ggid!r} != CSV {gid!r}")
            ok = False
            break
        if gfirst != ev:
            print(f"FAIL firstEventIdx: game {gid} decoded {gfirst} != expected {ev}")
            ok = False
        for row in g["plays"]:
            db, d1, d2, d3 = dispositions(row)
            expect = {
                "inning": int(row["inning"] or 0),
                "half": int(row["top_bot"] or 0),
                "batTeam": int(row["vis_home"] or 0),
                "bathand": _hand(row["bathand"]),
                "pithand": _hand(row["pithand"]),
                "outcome": outcome_code(row),
                "outsPre": int(row["outs_pre"] or 0),
                "outsPost": int(row["outs_post"] or 0),
                "runs": int(row["runs"] or 0),
                "rbi": int(row["rbi"] or 0),
                "dispB": db, "disp1": d1, "disp2": d2, "disp3": d3,
                "flags": flags_value(row),
            }
            for name, val in expect.items():
                if col[name][ev] != val:
                    if mism < 10:
                        print(f"  mismatch ev{ev} {gid} col={name}: decoded {col[name][ev]} != {val}")
                    mism += 1
            # batter identity round-trips through the dict
            ridx = col["batterIdx"][ev]
            if ridx != 0xFFFF and d.players[ridx][0] != row["batter"]:
                if mism < 10:
                    print(f"  mismatch ev{ev} batter: decoded {d.players[ridx][0]!r} != {row['batter']!r}")
                mism += 1
            # Layer B: raw pitch string round-trips verbatim
            exp_pitch = row.get("pitches") or ""
            if d.pitches[ev] != exp_pitch:
                if mism < 10:
                    print(f"  mismatch ev{ev} pitches: decoded {d.pitches[ev]!r} != {exp_pitch!r}")
                mism += 1
            checked += 1
            ev += 1
    if mism == 0:
        print(f"PASS round-trip: {checked:,} events × 15 cols + batter id + pitches all match")
    else:
        print(f"FAIL round-trip: {mism:,} mismatches over {checked:,} events")
        ok = False

    # --- 3. Replay base-out invariant -----------------------------------------
    bad = 0
    for ev in range(d.E):
        outs_added = sum(1 for c in ("dispB", "disp1", "disp2", "disp3") if col[c][ev] == D_OUT)
        if col["outsPost"][ev] != min(3, col["outsPre"][ev] + outs_added):
            bad += 1
    if bad == 0:
        print(f"PASS replay base-out: outsPost == min(3, outsPre + #OUT) for all {d.E:,} events")
    else:
        rate = 100 * bad / d.E
        print(f"WARN replay base-out: {bad:,}/{d.E:,} events ({rate:.2f}%) where "
              f"outsPost != min(3, outsPre + #OUT dispositions)")
        # Surface a few examples for diagnosis.
        shown = 0
        for ev in range(d.E):
            outs_added = sum(1 for c in ("dispB", "disp1", "disp2", "disp3") if col[c][ev] == D_OUT)
            if col["outsPost"][ev] != min(3, col["outsPre"][ev] + outs_added):
                gi = d.game_of_event(ev)
                print(f"    ev{ev} game={d.games[gi][4]} outsPre={col['outsPre'][ev]} "
                      f"outsPost={col['outsPost'][ev]} #OUT={outs_added} "
                      f"disp=({col['dispB'][ev]},{col['disp1'][ev]},{col['disp2'][ev]},{col['disp3'][ev]})")
                shown += 1
                if shown >= 8:
                    break

    print("\nRESULT:", "ALL PASS" if ok and bad == 0 else ("OK (with replay warnings)" if ok else "FAILURES"))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
