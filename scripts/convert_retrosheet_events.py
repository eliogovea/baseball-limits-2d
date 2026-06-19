"""Convert Retrosheet parsed play-by-play CSVs into compact, lazy-loadable BL2E
*event-level* season files.

WHERE THIS SITS in the data hierarchy (coarsest -> finest):
  - Lahman season blob (BL2D)  : one row per player per SEASON     (the main chart)
  - BL2S (build_stat_files)    : one date-keyed timeline per stat   (smooth-mode animation)
  - **BL2E (this file)**       : one row per PLAY / EVENT            (true play-by-play)

(BL2P and .evt/STEV were the older sub-season layers; both retired in S3/S4 — see
docs/ROADMAP.md and git history.) So a player who hits two HR in one game is TWO rows here. The corpus
is ~16.5M events (1903/1910-2025). See docs/data-formats.md §BL2E for the full byte layout
and docs/pbp-data-experiments.md (git history) §3 for the sizing that motivated this format.

SOURCE. Retrosheet's *parsed* play-by-play CSV (https://retrosheet.org/downloads/plays.html),
per-season `<year>plays.csv` (or the combined plays.csv). Every field is pre-expanded —
177 columns including the mutually-exclusive outcome flags (single/double/.../k/walk/...),
base-out state (outs_pre/post, br1/2/3_pre/post), scoring (run_b/run1-3, rbi), and the
pitch sequence (pitches/nump). So we read columns directly — NO Retrosheet event-string
grammar parsing and NO Chadwick. This supersedes the hand-rolled classify() in
scripts/pbp_event_experiment.js (that was the sizing experiment off the raw .EVN/.EVA files).

LAYERS (this commit implements Layer A; B/C are follow-up phases — see the plan):
  A  event core   : context + outcome + outs + runs/rbi + per-entity advance disposition
                    + a 20-bit flags bitfield. Reproduces every charted stat + base-out
                    state via replay. (THIS FILE.)
  B  pitch stream : per-event pitch symbols (post-1988). (Phase P3.)
  C  fielding      : f2-f9, loc, hittype, fseq, errors, umpires. (Phase P5, --fielding.)

KEY DESIGN CHOICE — store dispositions, not runner identities. The CSV lists the actual
runner retroIDs on each base (br1_pre, ...), but those are *derivable by replay*: the
runner on a base is whoever a prior play put there. Storing them per event would repeat
~14M player indices. Instead we store, per entity (batter + the runner on each of 1B/2B/3B),
only the NON-derivable outcome — out / stayed / advanced-to-X / scored. A replay decoder
re-threads identities through the game (this is what keeps Layer A near the measured
~14 bits/event instead of bloating). The replay-reconstructs-base-state invariant is the
P2 verification.

OUTPUT. data/pbp/e<year>.bl2e.gz, one gzipped file per season, lazy-loadable like BL2P.
The converter is idempotent/resumable: an existing output is skipped unless --force, so a
range build interrupted at year N resumes from the first missing year.
"""

import argparse
import gzip
import io
import math
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# Reuse the BL2P helpers verbatim — same provenance, same idioms.
from _retro_util import build_retro_to_display, day_of_year, pack_bits

ROOT = Path(__file__).resolve().parent.parent
PEOPLE_PATH = ROOT / "data" / "people_lahman_1871-2025.csv"
OUT_DIR = ROOT / "data" / "pbp"

FORMAT_MAJOR, FORMAT_MINOR = 1, 0

# --- Outcome enum (the `outcome` column) ---------------------------------------
# Exactly one PA-result per pa==1 row (verified: 0 rows in 2023 set >1 of these);
# pa==0 baserunning-only rows (SB/CS/WP/PB/...) get NONE and carry their meaning in
# the flags bitfield instead. 16 codes -> 4 bits.
OUT_NONE, OUT_OUT, OUT_K, OUT_BB, OUT_IBB, OUT_HBP, OUT_1B, OUT_2B = 0, 1, 2, 3, 4, 5, 6, 7
OUT_3B, OUT_HR, OUT_ROE, OUT_FC, OUT_SH, OUT_SF, OUT_XI, OUT_NOOUT = 8, 9, 10, 11, 12, 13, 14, 15
OUTCOME_NAMES = ["NONE", "OUT", "K", "BB", "IBB", "HBP", "1B", "2B",
                 "3B", "HR", "ROE", "FC", "SH", "SF", "XI", "NOOUT"]

# --- Advance disposition enum (per entity: batter + runner on 1B/2B/3B) ---------
# 7 codes -> 3 bits. ABSENT = no runner there / batter didn't complete a PA.
D_ABSENT, D_OUT, D_STAY, D_TO1, D_TO2, D_TO3, D_SCORE = 0, 1, 2, 3, 4, 5, 6
DISP_NAMES = ["ABSENT", "OUT", "STAY", "TO1", "TO2", "TO3", "SCORE"]
_TO_BASE = {1: D_TO1, 2: D_TO2, 3: D_TO3}

# --- Flags bitfield (bit index -> CSV column). 20 flags -> packed at <=20 bits. --
FLAG_COLS = ["iw", "sb2", "sb3", "sbh", "cs2", "cs3", "csh", "pko1", "pko2", "pko3",
             "wp", "pb", "bk", "oa", "di", "gdp", "othdp", "tp", "fle", "k_safe"]

# --- Layer C (fielding detail) — header flag bit1, opt-in via --fielding ----------
# The "everything Retrosheet encodes" superset. f2-f9 reference the main player dict
# (fielders are players); umpires get their own dict; loc/fseq/hittype are small
# value-coded string dicts; e1-e9 are sparse error counts.
FIELD_POS = ["f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9"]          # C,1B,2B,3B,SS,LF,CF,RF
UMP_FIELDS = ["umphome", "ump1b", "ump2b", "ump3b", "umplf", "umprf"]
ERR_FIELDS = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"]
VALUE_DICT_COLS = ["loc", "fseq", "hittype"]                          # string-coded

# Handedness L/R/B(switch)/? -> 2 bits.
HAND = {"R": 0, "L": 1, "B": 2}

# PA-outcome flag column -> enum code (when pa==1). `walk` becomes IBB if iw is set.
_PA_FLAG_TO_OUT = {
    "single": OUT_1B, "double": OUT_2B, "triple": OUT_3B, "hr": OUT_HR,
    "walk": OUT_BB, "k": OUT_K, "hbp": OUT_HBP, "sf": OUT_SF, "sh": OUT_SH,
    "xi": OUT_XI, "roe": OUT_ROE, "fc": OUT_FC, "othout": OUT_OUT, "noout": OUT_NOOUT,
}


def outcome_code(row):
    """Map a row's mutually-exclusive PA-result columns to one enum code."""
    if row["pa"] != "1":
        return OUT_NONE
    for col, code in _PA_FLAG_TO_OUT.items():
        if row[col] == "1":
            if code == OUT_BB and row["iw"] == "1":
                return OUT_IBB
            return code
    # pa==1 but no flag set: treat as a generic out so AB accounting stays sane.
    return OUT_OUT


def dispositions(row):
    """(batter, on-1B, on-2B, on-3B) advance dispositions for one play.

    Uses the CSV's own bookkeeping so SCORE vs OUT is unambiguous:
      - run_b / run1 / run2 / run3 hold the retroID of whoever SCORED from that
        starting base (batter / 1B / 2B / 3B respectively),
      - br{1,2,3}_post hold who occupies each base AFTER the play,
      - lob_id* hold runners stranded at the third out (still on base).
    A pre-runner not found scored / on-base / stranded was put out.
    """
    post_base = {}                       # retroID -> base number after the play
    for b in (1, 2, 3):
        rid = row[f"br{b}_post"]
        if rid:
            post_base[rid] = b
    scored = {row[c] for c in ("run_b", "run1", "run2", "run3") if row[c]}
    stranded = {row[c] for c in ("lob_id1", "lob_id2", "lob_id3") if row[c]}

    def disp_for(rid, pre_base):
        if not rid:
            return D_ABSENT
        if rid in scored:
            return D_SCORE
        if rid in post_base:
            nb = post_base[rid]
            return D_STAY if nb == pre_base else _TO_BASE[nb]
        if rid in stranded:
            return D_STAY
        return D_OUT

    # Batter: pre_base 0 (at the plate). ABSENT if this is a non-PA continuation row.
    if row["pa"] != "1":
        db = D_ABSENT
    else:
        bid = row["batter"]
        if bid in scored:
            db = D_SCORE
        elif bid in post_base:
            db = _TO_BASE[post_base[bid]]
        else:
            db = D_OUT                     # struck out, grounded out, etc.
    return (db,
            disp_for(row["br1_pre"], 1),
            disp_for(row["br2_pre"], 2),
            disp_for(row["br3_pre"], 3))


def flags_value(row):
    v = 0
    for i, col in enumerate(FLAG_COLS):
        if row.get(col) == "1":
            v |= (1 << i)
    return v


def _hand(s):
    return HAND.get(s, 3)


def _int(s):
    """Tolerant int parse — older Retrosheet rows leave numeric fields blank."""
    return int(s) if s else 0


def read_season(csv_path, year):
    """Stream the CSV once; return games in (date, gid)-sorted order, each a list
    of its plays in CSV (pn) order. Filters to the year and gametype == 'regular'
    (parity with BL2P and the season frontier — drops allstar/postseason rows)."""
    import csv as _csv
    _csv.field_size_limit(1 << 20)
    year_s = str(year)
    games = {}                            # gid -> {"date":, "vis":, "home":, "plays":[]}
    n_rows = 0
    with open(csv_path, encoding="utf-8-sig") as f:
        reader = _csv.DictReader(f)
        for col in ("gid", "date", "gametype", "batter", "pitcher"):
            if col not in reader.fieldnames:
                sys.exit(f"missing expected column {col!r} in {csv_path}")
        for row in reader:
            if row["date"][:4] != year_s or row["gametype"] != "regular":
                continue
            g = games.get(row["gid"])
            if g is None:
                # gid is e.g. 'BOS202303300' = home-site + YYYYMMDD + game-number.
                g = {"date": row["date"], "plays": []}
                games[row["gid"]] = g
            g["plays"].append(row)
            n_rows += 1
    # Chronological game order, then plays in file order (pn ascending).
    ordered = sorted(games.items(), key=lambda kv: (kv[1]["date"], kv[0]))
    return ordered, n_rows


def build_bl2e(ordered_games, year, retro_to_display, include_pitches=True,
               include_fielding=False):
    """Assemble the BL2E byte payload (Layer A + B pitches + C fielding) for one season."""
    # --- Player dictionary, keyed by retroID (identity matters for replay; unlike
    # BL2P we must NOT merge two retroIDs onto one display name). Collect every
    # retroID that appears as batter, pitcher, or a pre-play baserunner.
    pid_index = {}                        # retroID -> dict index
    def intern(rid):
        if not rid:
            return 0xFFFF                  # sentinel: no player (rare; pitcher blank)
        i = pid_index.get(rid)
        if i is None:
            i = len(pid_index)
            pid_index[rid] = i
        return i

    # First pass over plays to populate the dict (deterministic: appearance order).
    for _gid, g in ordered_games:
        for row in g["plays"]:
            intern(row["batter"]); intern(row["pitcher"])
            for b in (1, 2, 3):
                if row[f"br{b}_pre"]:
                    intern(row[f"br{b}_pre"])
            if include_fielding:                 # fielders are players too
                for fp in FIELD_POS:
                    if row[fp]:
                        intern(row[fp])
    P = len(pid_index)
    if P >= 0xFFFF:
        sys.exit(f"player count {P} hits the u16 sentinel")
    retro_by_index = [None] * P
    for rid, i in pid_index.items():
        retro_by_index[i] = rid

    # --- Team dictionary (from gid home-site is ambiguous; use batteam/pitteam). ---
    team_index = {}
    def intern_team(t):
        i = team_index.get(t)
        if i is None:
            i = len(team_index); team_index[t] = i
        return i

    # --- Columnar per-event value lists (payload order; see docs/data-formats.md §BL2E).
    cols = {name: [] for name in (
        "inning", "half", "batTeam", "batterIdx", "pitcherIdx", "bathand", "pithand",
        "outcome", "outsPre", "outsPost", "runs", "rbi",
        "dispB", "disp1", "disp2", "disp3", "flags")}
    game_table = []                       # (dayOfYear, visIdx, homeIdx, firstEventIdx, gid)
    pitch_strings = []                    # Layer B: raw pitch sequence per event, in order

    # Layer C raw collectors (only filled when include_fielding).
    fc = {fp: [] for fp in FIELD_POS}     # fielder -> player-dict index per event
    uc = {u: [] for u in UMP_FIELDS}      # umpire  -> umpire-dict index per event
    ump_index = {}                        # umpire retroID ('' included) -> index
    def intern_ump(rid):
        i = ump_index.get(rid)
        if i is None:
            i = len(ump_index); ump_index[rid] = i
        return i
    vc = {c: [] for c in VALUE_DICT_COLS}  # loc/fseq/hittype -> raw string per event
    ec = {e: [] for e in ERR_FIELDS}       # e1..e9 -> int per event

    E = 0
    for gid, g in ordered_games:
        first_event = E
        vis_team = home_team = None
        for row in g["plays"]:
            # batteam/pitteam + vis_home (0=visitor batting,1=home batting) give us the
            # game's vis/home team codes regardless of which half we're in.
            if row["vis_home"] == "0":
                vis_team = row["batteam"]; home_team = row["pitteam"]
            else:
                home_team = row["batteam"]; vis_team = row["pitteam"]
            db, d1, d2, d3 = dispositions(row)
            cols["inning"].append(_int(row["inning"]))
            cols["half"].append(_int(row["top_bot"]))
            cols["batTeam"].append(_int(row["vis_home"]))
            cols["batterIdx"].append(intern(row["batter"]))
            cols["pitcherIdx"].append(intern(row["pitcher"]))
            cols["bathand"].append(_hand(row["bathand"]))
            cols["pithand"].append(_hand(row["pithand"]))
            cols["outcome"].append(outcome_code(row))
            cols["outsPre"].append(int(row["outs_pre"] or 0))
            cols["outsPost"].append(int(row["outs_post"] or 0))
            cols["runs"].append(int(row["runs"] or 0))
            cols["rbi"].append(int(row["rbi"] or 0))
            cols["dispB"].append(db); cols["disp1"].append(d1)
            cols["disp2"].append(d2); cols["disp3"].append(d3)
            cols["flags"].append(flags_value(row))
            pitch_strings.append(row.get("pitches") or "")
            if include_fielding:
                for fp in FIELD_POS:
                    fc[fp].append(intern(row[fp]))      # 0xFFFF if blank
                for u in UMP_FIELDS:
                    uc[u].append(intern_ump(row[u]))
                for c in VALUE_DICT_COLS:
                    vc[c].append(row[c])
                for e in ERR_FIELDS:
                    ec[e].append(_int(row[e]))
            E += 1
        game_table.append((day_of_year(g["date"]),
                           intern_team(vis_team), intern_team(home_team),
                           first_event, gid))
    Gn = len(game_table)
    if E > 0xFFFFFFFF:
        sys.exit("event count exceeds u32")

    # 0xFFFF sentinel must survive bit-packing: widen batterIdx/pitcherIdx so the
    # max VALUE present (which may be the sentinel) fits.
    col_order = ["inning", "half", "batTeam", "batterIdx", "pitcherIdx", "bathand",
                 "pithand", "outcome", "outsPre", "outsPost", "runs", "rbi",
                 "dispB", "disp1", "disp2", "disp3", "flags"]
    widths = {}
    for name in col_order:
        mx = max(cols[name]) if cols[name] else 0
        widths[name] = 1 if mx == 0 else max(1, math.ceil(math.log2(mx + 1)))

    # --- Layer B: pitch alphabet (sorted, deterministic) -----------------------
    # Pre-1988 seasons have no recorded pitches -> empty alphabet, flag stays off.
    pitch_alphabet = sorted({c for s in pitch_strings for c in s}) if include_pitches else []
    has_pitches = len(pitch_alphabet) > 0
    sym_index = {c: i for i, c in enumerate(pitch_alphabet)}
    sym_width = max(1, math.ceil(math.log2(len(pitch_alphabet)))) if len(pitch_alphabet) > 1 else 1
    pitch_lens = [len(s) for s in pitch_strings]
    len_width = 1
    if has_pitches:
        mx = max(pitch_lens) if pitch_lens else 0
        len_width = 1 if mx == 0 else max(1, math.ceil(math.log2(mx + 1)))

    # --- Serialize -------------------------------------------------------------
    buf = io.BytesIO()
    buf.write(b"BL2E")
    flags_byte = (0x01 if has_pitches else 0) | (0x02 if include_fielding else 0)
    buf.write(struct.pack("<BBB", FORMAT_MAJOR, FORMAT_MINOR, flags_byte))
    buf.write(struct.pack("<HIHHH", year, E, Gn, P, len(team_index)))
    buf.write(struct.pack("<H", len(col_order)))

    # Team dict.
    teams_by_index = [None] * len(team_index)
    for t, i in team_index.items():
        teams_by_index[i] = t
    for t in teams_by_index:
        tb = (t or "").encode("utf-8")
        buf.write(struct.pack("<B", len(tb))); buf.write(tb)

    # Column meta: width + name (self-describing, same idiom as BL2P).
    for name in col_order:
        nb = name.encode("utf-8")
        buf.write(struct.pack("<BB", widths[name], len(nb))); buf.write(nb)

    # Player dict: retroID + crosswalked display name (kept distinct so replay
    # identity is exact; the app can join on either).
    n_unmapped = 0
    for rid in retro_by_index:
        name = retro_to_display.get(rid)
        if name is None:
            name = rid; n_unmapped += 1
        rb = rid.encode("utf-8"); nb = name.encode("utf-8")
        if len(nb) > 255:
            sys.exit(f"display name >255 bytes: {name!r}")
        buf.write(struct.pack("<BB", len(rb), len(nb))); buf.write(rb); buf.write(nb)

    # Game table.
    for day, vis, home, first_event, gid in game_table:
        gb = gid.encode("utf-8")
        buf.write(struct.pack("<HBBI", day, vis, home, first_event))
        buf.write(struct.pack("<B", len(gb))); buf.write(gb)

    # Bit-packed columnar event payload (Layer A).
    for name in col_order:
        buf.write(pack_bits(cols[name], widths[name]))

    # --- Layer B pitch section (only if flag set) ------------------------------
    # u8 symCount | symCount × utf8 char | u8 lenWidth | pitchLen[E] packed @ lenWidth
    # | symbol stream packed @ symWidth (total = sum(pitchLen); decoder derives it).
    pitch_bytes = 0
    if has_pitches:
        before = buf.tell()
        buf.write(struct.pack("<B", len(pitch_alphabet)))
        buf.write("".join(pitch_alphabet).encode("utf-8"))
        buf.write(struct.pack("<B", len_width))
        buf.write(pack_bits(pitch_lens, len_width))
        symbol_stream = [sym_index[c] for s in pitch_strings for c in s]
        buf.write(pack_bits(symbol_stream, sym_width))
        pitch_bytes = buf.tell() - before

    # --- Layer C fielding section (only if --fielding) -------------------------
    # u16 colCount | colCount × (u8 width + u8 nameLen + name)   -- self-describing
    # u16 umpCount | umpCount × (u8 len + retroID)               -- umpire dict
    # for loc,fseq,hittype: u16 nVals | nVals × (u8 len + value) -- value dicts
    # payload: each column E values bit-packed @ its width (player/umpire/value index, or err count)
    fielding_bytes = 0
    if include_fielding:
        before = buf.tell()
        # Value dicts for the string-coded columns (sorted -> deterministic).
        val_dicts = {c: sorted(set(vc[c])) for c in VALUE_DICT_COLS}
        val_index = {c: {v: i for i, v in enumerate(vals)} for c, vals in val_dicts.items()}
        # Assemble the Layer C columns in fixed order: fielders, umpires, value-coded, errors.
        c_cols = ([(fp, fc[fp]) for fp in FIELD_POS]
                  + [(u, uc[u]) for u in UMP_FIELDS]
                  + [(c, [val_index[c][v] for v in vc[c]]) for c in VALUE_DICT_COLS]
                  + [(e, ec[e]) for e in ERR_FIELDS])
        c_widths = []
        for _name, vals in c_cols:
            mx = max(vals) if vals else 0
            c_widths.append(1 if mx == 0 else max(1, math.ceil(math.log2(mx + 1))))
        buf.write(struct.pack("<H", len(c_cols)))
        for (name, _), w in zip(c_cols, c_widths):
            nb = name.encode("utf-8")
            buf.write(struct.pack("<BB", w, len(nb))); buf.write(nb)
        # Umpire dict (own index space; '' is a real entry, no sentinel).
        ump_by_index = [None] * len(ump_index)
        for rid, i in ump_index.items():
            ump_by_index[i] = rid
        buf.write(struct.pack("<H", len(ump_by_index)))
        for rid in ump_by_index:
            b = (rid or "").encode("utf-8")
            buf.write(struct.pack("<B", len(b))); buf.write(b)
        # Value dicts.
        for c in VALUE_DICT_COLS:
            buf.write(struct.pack("<H", len(val_dicts[c])))
            for v in val_dicts[c]:
                b = v.encode("utf-8")
                buf.write(struct.pack("<B", len(b))); buf.write(b)
        # Payload.
        for (_name, vals), w in zip(c_cols, c_widths):
            buf.write(pack_bits(vals, w))
        fielding_bytes = buf.tell() - before

    stats = {"events": E, "games": Gn, "players": P, "teams": len(team_index),
             "unmapped": n_unmapped, "widths": widths, "raw_bytes": buf.tell(),
             "has_pitches": has_pitches, "pitch_chars": sum(pitch_lens),
             "pitch_alphabet": "".join(pitch_alphabet), "pitch_bytes": pitch_bytes,
             "has_fielding": include_fielding, "umpires": len(ump_index),
             "fielding_bytes": fielding_bytes}
    return buf.getvalue(), stats


def convert(csv_path, year, out_dir, retro_to_display, force=False, include_pitches=True,
            include_fielding=False):
    out_path = out_dir / f"e{year}.bl2e.gz"
    if out_path.exists() and not force:
        print(f"  {year}: e{year}.bl2e.gz exists — skipping (use --force to rebuild)")
        return None
    ordered, n_rows = read_season(csv_path, year)
    if n_rows == 0:
        print(f"  {year}: no regular-season plays found — skipping")
        return None
    binary, stats = build_bl2e(ordered, year, retro_to_display,
                               include_pitches=include_pitches, include_fielding=include_fielding)
    compressed = gzip.compress(binary, compresslevel=9)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(compressed)
    print(f"  {year}: events={stats['events']:,} games={stats['games']:,} "
          f"players={stats['players']:,} teams={stats['teams']} unmapped={stats['unmapped']}")
    print(f"    widths: {stats['widths']}")
    if stats["has_pitches"]:
        print(f"    pitches: {stats['pitch_chars']:,} chars, alphabet {stats['pitch_alphabet']!r}, "
              f"raw section {stats['pitch_bytes']:,} B")
    else:
        print("    pitches: none (pre-pitch era or --no-pitches)")
    if stats["has_fielding"]:
        print(f"    fielding (Layer C): {stats['umpires']} umpires, raw section "
              f"{stats['fielding_bytes']:,} B")
    print(f"    raw {stats['raw_bytes']:,} B -> gzip {len(compressed):,} B "
          f"({len(compressed) * 8 / max(1, stats['events']):.1f} bits/event)")
    return stats


def main():
    ap = argparse.ArgumentParser(description="Build BL2E event-level season files from Retrosheet parsed plays CSV")
    ap.add_argument("csv", help="Retrosheet parsed plays CSV (e.g. 2023plays.csv or the combined plays.csv)")
    ap.add_argument("year", help="season year, or START-END range (e.g. 2023 or 1903-2025)")
    ap.add_argument("--out", default=str(OUT_DIR), help="output dir (default data/pbp)")
    ap.add_argument("--force", action="store_true", help="rebuild even if the output file exists")
    ap.add_argument("--no-pitches", action="store_true", help="omit Layer B pitch sequences")
    ap.add_argument("--fielding", action="store_true",
                    help="include Layer C fielding detail (f2-f9, umpires, loc, fseq, hittype, e1-e9)")
    args = ap.parse_args()
    out_dir = Path(args.out)
    if "-" in args.year:
        lo, hi = (int(x) for x in args.year.split("-", 1))
        years = range(lo, hi + 1)
    else:
        years = [int(args.year)]
    retro_to_display = build_retro_to_display(PEOPLE_PATH)
    for y in years:
        convert(args.csv, y, out_dir, retro_to_display, force=args.force,
                include_pitches=not args.no_pitches, include_fielding=args.fielding)


if __name__ == "__main__":
    main()
