"""Build a single-file dist/index.html with the dataset packed as inline base64.

Output is fully self-contained — opens with file:// without any network access. D3 is vendored
from vendor/d3.v7.min.js (fetch once with: curl -sL https://d3js.org/d3.v7.min.js -o vendor/d3.v7.min.js).

Binary format (all little-endian):
  Header (12 bytes):
    'BL2D' magic | u8 major | u8 minor | u16 year_base | u32 row_count
  Name dictionary:
    u32 count, then for each: u8 len + utf8 bytes
  Team dictionary (lgID, teamID pairs):
    u16 count, then for each: u8 lg_len + utf8 + u8 tm_len + utf8
  Columnar payload, in this fixed order:
    name_idx: u16 * N
    year_off: u8  * N   (offset from year_base)
    team_idx: u8  * N
    wide stats (u16 * N), in order: G, AB, R, H, BB, SO, RBI
    narrow stats (u8 * N), in order: 2B, 3B, HR, SB, CS, IBB, HBP, SH, SF, GIDP

Blank values use sentinels 0xFFFF (u16) / 0xFF (u8). Sentinels are mapped back to "" at
decode time so the downstream parseInt() in script.js produces NaN, matching d3.csv behavior.
"""

import argparse
import array
import base64
import csv
import gzip
import io
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "data" / "batting_limits_1871-2025.csv"
PITCHING_CSV_PATH = ROOT / "data" / "pitching_limits_1871-2025.csv"
HTML_PATH = ROOT / "index.html"
CSS_PATH = ROOT / "styles.css"
JS_PATH = ROOT / "script.js"
D3_PATH = ROOT / "vendor" / "d3.v7.min.js"
PEOPLE_PATH = ROOT / "data" / "people_lahman_1871-2025.csv"
OUT_DIR = ROOT / "dist"
OUT_PATH = OUT_DIR / "index.html"

YEAR_BASE = 1871

# Each dataset declares its stat columns as (name, width_bytes) pairs.
# width=1 -> u8 (0..254, 0xFF=blank), width=2 -> u16 (0..65534, 0xFFFF=blank).
# Pick the narrowest width that fits the max known value to keep the bundle
# small; widening later is a binary-format-compatible change.
BATTING_COLUMN_SPEC = [
    ("G",    2), ("AB",  2), ("R",   2), ("H",   2),
    ("BB",   2), ("SO",  2), ("RBI", 2),
    ("2B",   1), ("3B",  1), ("HR",  1), ("SB",  1), ("CS",  1),
    ("IBB",  1), ("HBP", 1), ("SH",  1), ("SF",  1), ("GIDP", 1),
]
PITCHING_COLUMN_SPEC = [
    # u16: counting stats whose max exceeds 254.
    ("G",      2), ("IPouts", 2), ("H",   2), ("ER",  2),
    ("BB",     2), ("SO",     2), ("BFP", 2), ("R",   2),
    # u8: everything else fits.
    ("W",   1), ("L",  1), ("GS",  1), ("CG", 1), ("SHO", 1), ("SV",  1),
    ("HR",  1), ("IBB", 1), ("WP", 1), ("HBP", 1), ("BK", 1), ("GF",  1),
    ("SH",  1), ("SF",  1), ("GIDP", 1),
]

ALL_STATS_BATTING = [c for c, _ in BATTING_COLUMN_SPEC]
ALL_STATS_PITCHING = [c for c, _ in PITCHING_COLUMN_SPEC]

W16_BLANK = 0xFFFF
W8_BLANK = 0xFF

# Maps for the people section. 0 = unknown so blank cells round-trip cleanly.
BATS_MAP = {"": 0, "L": 1, "R": 2, "B": 3, "S": 3}
THROWS_MAP = {"": 0, "L": 1, "R": 2, "B": 3, "S": 3}
COUNTRY_UNKNOWN = 0xFF


def parse_int(s, blank_sentinel):
    s = s.strip()
    if not s or not s.lstrip("-").isdigit():
        return blank_sentinel
    return int(s)


_SUMMARY_TEAM_RE = re.compile(r"^\d+TM$")


def _safe_int(s, default=0):
    s = (s or "").strip()
    if not s or not s.lstrip("-").isdigit():
        return default
    return int(s)


def _year_from_date(s):
    s = (s or "").strip()
    if len(s) < 4 or not s[:4].isdigit():
        return 0
    return int(s[:4])


def load_people(csv_path):
    """Map display-name -> people-row dict.

    Uses the same display-name disambiguation as the converters
    (_display_name.build_display_name_map), so the people lookup key
    matches the playerID stored in the *_limits CSVs and the bundle's
    name dict. Same-name players ("Frank Thomas", "Ken Griffey") get a
    "(b.YYYY)" suffix so they're addressable individually.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from _display_name import build_display_name_map
    display = build_display_name_map(str(csv_path))

    chosen = {}
    with csv_path.open(encoding="utf-8-sig") as f:
        for p in csv.DictReader(f):
            name = display.get(p["playerID"])
            if name is None:
                continue
            chosen[name] = p
    return chosen


def build_people_section(name_to_idx, people_by_name):
    """Return (bytes, stats) for the people section of binary v2.

    Country dictionary first (u8 count + entries), then a u32 record count
    followed by 12-byte fixed-width records sorted by name_idx for cache-friendly
    decode. Records carry: name_idx(u16), birthYear(u16), debutYear(u16),
    countryIdx(u8, 0xFF=unknown), bats(u8), throws(u8), heightInches(u8),
    weightLbs(u16). Zero = unknown for the numeric fields.
    """
    records = []
    for name, idx in name_to_idx.items():
        p = people_by_name.get(name)
        if p is None:
            continue
        records.append((idx, p))
    records.sort(key=lambda r: r[0])

    countries = sorted({p["birthCountry"] for _, p in records if p["birthCountry"].strip()})
    if len(countries) > 254:
        sys.exit(f"too many countries ({len(countries)}); widen countryIdx to u16")
    country_to_idx = {c: i for i, c in enumerate(countries)}

    buf = io.BytesIO()
    buf.write(struct.pack("<B", len(countries)))
    for c in countries:
        cb = c.encode("utf-8")
        if len(cb) > 255:
            sys.exit(f"country name >255 bytes: {c!r}")
        buf.write(struct.pack("<B", len(cb)))
        buf.write(cb)

    buf.write(struct.pack("<I", len(records)))
    for idx, p in records:
        birth = _safe_int(p["birthYear"])
        debut = _year_from_date(p["debut"])
        country_idx = country_to_idx.get(p["birthCountry"].strip(), COUNTRY_UNKNOWN)
        bats = BATS_MAP.get(p["bats"].strip(), 0)
        throws = THROWS_MAP.get(p["throws"].strip(), 0)
        height = _safe_int(p["height"])
        weight = _safe_int(p["weight"])
        if birth > 0xFFFF or birth < 0: birth = 0
        if debut > 0xFFFF or debut < 0: debut = 0
        if height > 0xFF or height < 0: height = 0
        if weight > 0xFFFF or weight < 0: weight = 0
        buf.write(struct.pack("<HHHBBBBH",
            idx, birth, debut, country_idx, bats, throws, height, weight))

    stats = {
        "people_emitted": len(records),
        "people_total": len(people_by_name),
        "countries": len(countries),
    }
    return buf.getvalue(), stats


def aggregate_stints(rows, stat_cols):
    """Collapse traded-mid-season rows into one row per (playerID, yearID).

    Each stat is summed across stints; if every stint left it blank, the result
    is blank too. The primary team for the year is the stint with the most G
    (games), ties broken by first occurrence.

    BBRef 2024 includes pre-computed summary rows for traded players (teamID
    like "2TM" or "3TM"), which would double-count if summed alongside the
    per-team stint rows. Those summary rows are dropped before aggregation.

    Note: playerID here is the human name string, so same-name-same-year
    players (rare) would also be merged — pre-existing data limitation, not
    introduced here.
    """
    groups = {}  # (playerID, yearID) -> list of stint rows (insertion order)
    for r in rows:
        if _SUMMARY_TEAM_RE.match(r["teamID"]):
            continue
        key = (r["playerID"], r["yearID"])
        groups.setdefault(key, []).append(r)

    def g_of(row):
        s = row["G"].strip()
        return int(s) if s.lstrip("-").isdigit() else 0

    out = []
    for (player_id, year_id), stints in groups.items():
        if len(stints) == 1:
            out.append(stints[0])
            continue
        primary = max(stints, key=g_of)
        agg = {
            "playerID": player_id,
            "yearID": year_id,
            "teamID": primary["teamID"],
            "lgID": primary["lgID"],
        }
        for col in stat_cols:
            total = 0
            any_present = False
            for s in stints:
                v = s[col].strip()
                if v and v.lstrip("-").isdigit():
                    total += int(v)
                    any_present = True
            agg[col] = str(total) if any_present else ""
        out.append(agg)
    return out


def build_binary(csv_path: Path, column_spec: list[tuple[str, int]]) -> tuple[bytes, dict]:
    stat_cols = [c for c, _ in column_spec]
    with csv_path.open(encoding="utf-8") as f:
        raw_rows = list(csv.DictReader(f))
    rows = aggregate_stints(raw_rows, stat_cols)
    n = len(rows)

    names = sorted({r["playerID"] for r in rows})
    name_to_idx = {name: i for i, name in enumerate(names)}
    teams = sorted({(r["lgID"], r["teamID"]) for r in rows})
    team_to_idx = {t: i for i, t in enumerate(teams)}

    if len(names) > 0xFFFFFFFF:
        sys.exit(f"name dict overflow: {len(names)}")
    if len(teams) > 0xFFFF:
        sys.exit(f"team dict overflow: {len(teams)}")
    for name in names:
        if len(name.encode("utf-8")) > 255:
            sys.exit(f"player name >255 bytes: {name!r}")
    for lg, tm in teams:
        if len(lg.encode("utf-8")) > 255 or len(tm.encode("utf-8")) > 255:
            sys.exit(f"team string >255 bytes: {lg!r}/{tm!r}")

    min_year = min(int(r["yearID"]) for r in rows)
    max_year = max(int(r["yearID"]) for r in rows)
    if min_year < YEAR_BASE:
        sys.exit(f"min year {min_year} < YEAR_BASE {YEAR_BASE}")
    if max_year - YEAR_BASE > 0xFF:
        sys.exit(f"year span > 255 ({min_year}..{max_year}); widen year_off to u16")
    if len(column_spec) > 0xFF:
        sys.exit(f"column count {len(column_spec)} exceeds u8")

    buf = io.BytesIO()
    buf.write(b"BL2D")
    buf.write(struct.pack("<BB", 4, 0))
    buf.write(struct.pack("<HI", YEAR_BASE, n))

    # v4: column metadata (so the decoder doesn't need to hardcode the
    # column list and we can ship batting + pitching with the same decoder).
    buf.write(struct.pack("<B", len(column_spec)))
    for name, width in column_spec:
        nb = name.encode("utf-8")
        if width not in (1, 2):
            sys.exit(f"unsupported width {width} for column {name!r}")
        if len(nb) > 255:
            sys.exit(f"column name >255 bytes: {name!r}")
        buf.write(struct.pack("<BB", width, len(nb)))
        buf.write(nb)

    buf.write(struct.pack("<I", len(names)))
    for name in names:
        nb = name.encode("utf-8")
        buf.write(struct.pack("<B", len(nb)))
        buf.write(nb)

    buf.write(struct.pack("<H", len(teams)))
    for lg, tm in teams:
        lgb = lg.encode("utf-8")
        tmb = tm.encode("utf-8")
        buf.write(struct.pack("<B", len(lgb)))
        buf.write(lgb)
        buf.write(struct.pack("<B", len(tmb)))
        buf.write(tmb)

    people_by_name = load_people(PEOPLE_PATH)
    people_bytes, people_stats = build_people_section(name_to_idx, people_by_name)
    buf.write(people_bytes)

    name_arr = array.array("H", (name_to_idx[r["playerID"]] for r in rows))
    year_arr = array.array("B", (int(r["yearID"]) - YEAR_BASE for r in rows))
    team_arr = array.array("H", (team_to_idx[(r["lgID"], r["teamID"])] for r in rows))

    buf.write(name_arr.tobytes())
    buf.write(year_arr.tobytes())
    buf.write(team_arr.tobytes())

    # Per-column payloads, written in metadata order.
    for col, width in column_spec:
        if width == 2:
            a = array.array("H", [0] * n)
            for i, r in enumerate(rows):
                v = parse_int(r[col], W16_BLANK)
                if v != W16_BLANK and (v < 0 or v > 0xFFFE):
                    sys.exit(f"{col}[row {i}] value {v} out of u16 range")
                a[i] = v
        else:
            a = array.array("B", [0] * n)
            for i, r in enumerate(rows):
                v = parse_int(r[col], W8_BLANK)
                if v != W8_BLANK and (v < 0 or v > 0xFE):
                    sys.exit(f"{col}[row {i}] value {v} out of u8 range")
                a[i] = v
        buf.write(a.tobytes())

    stats = {
        "raw_rows": len(raw_rows),
        "rows": n,
        "names": len(names),
        "teams": len(teams),
        "year_range": (min_year, max_year),
        "columns": len(column_spec),
        **people_stats,
    }
    return buf.getvalue(), stats


DECODER_JS_TEMPLATE = r"""
// --- BL2D inline decoder (generated by scripts/build_bundle.py) ---
const BL_BATTING_B64 = "__BL_BATTING_B64__";
const BL_PITCHING_B64 = "__BL_PITCHING_B64__";

async function decodeBatting() { return decodeBL(BL_BATTING_B64); }
async function decodePitching() { return decodeBL(BL_PITCHING_B64); }

async function decodeBL(b64) {
    const bin = atob(b64);
    const compressed = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) compressed[i] = bin.charCodeAt(i);
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dec = new TextDecoder();
    let off = 0;
    const magic = dec.decode(buf.subarray(off, off + 4)); off += 4;
    if (magic !== 'BL2D') throw new Error('decodeBL: bad magic ' + magic);
    const major = buf[off++]; const minor = buf[off++];
    if (major !== 4) throw new Error('decodeBL: unsupported version ' + major + '.' + minor);
    const yearBase = dv.getUint16(off, true); off += 2;
    const N = dv.getUint32(off, true); off += 4;

    // v4 column metadata: list of {name, width} the columnar payload uses.
    const colCount = buf[off++];
    const columnSpec = new Array(colCount);
    for (let i = 0; i < colCount; i++) {
        const width = buf[off++];
        const nl = buf[off++];
        const name = dec.decode(buf.subarray(off, off + nl)); off += nl;
        columnSpec[i] = { name, width };
    }

    const nameCount = dv.getUint32(off, true); off += 4;
    const names = new Array(nameCount);
    for (let i = 0; i < nameCount; i++) {
        const len = buf[off++];
        names[i] = dec.decode(buf.subarray(off, off + len));
        off += len;
    }
    const teamCount = dv.getUint16(off, true); off += 2;
    const teams = new Array(teamCount);
    for (let i = 0; i < teamCount; i++) {
        const lglen = buf[off++];
        const lg = dec.decode(buf.subarray(off, off + lglen)); off += lglen;
        const tmlen = buf[off++];
        const tm = dec.decode(buf.subarray(off, off + tmlen)); off += tmlen;
        teams[i] = { lgID: lg, teamID: tm };
    }

    // People section (unchanged from v2): country dict + fixed records.
    const countryCount = buf[off++];
    const countries = new Array(countryCount);
    for (let i = 0; i < countryCount; i++) {
        const len = buf[off++];
        countries[i] = dec.decode(buf.subarray(off, off + len));
        off += len;
    }
    const peopleCount = dv.getUint32(off, true); off += 4;
    const BL_BATS = [null, 'L', 'R', 'S'];
    const BL_THROWS = [null, 'L', 'R', 'S'];
    const peopleByName = new Map();
    for (let i = 0; i < peopleCount; i++) {
        const nameIdxP = dv.getUint16(off, true); off += 2;
        const birthYear = dv.getUint16(off, true); off += 2;
        const debutYear = dv.getUint16(off, true); off += 2;
        const cIdx = buf[off++];
        const bats = buf[off++];
        const throws_ = buf[off++];
        const heightIn = buf[off++];
        const weightLb = dv.getUint16(off, true); off += 2;
        peopleByName.set(names[nameIdxP], {
            birthYear: birthYear || null,
            debutYear: debutYear || null,
            country: cIdx === 0xFF ? null : countries[cIdx],
            bats: BL_BATS[bats] || null,
            throws: BL_THROWS[throws_] || null,
            heightIn: heightIn || null,
            weightLb: weightLb || null,
        });
    }

    // Use .slice() because byte offsets aren't guaranteed aligned for Uint16Array.
    const sliceU16 = () => {
        const view = new Uint16Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + N * 2));
        off += N * 2;
        return view;
    };
    const sliceU8 = () => {
        const view = new Uint8Array(buf.buffer, buf.byteOffset + off, N);
        off += N;
        return view;
    };

    const nameIdx = sliceU16();
    const yearOff = sliceU8();
    const teamIdx = sliceU16();
    const cols = {};
    for (const { name, width } of columnSpec) {
        cols[name] = width === 2 ? sliceU16() : sliceU8();
    }

    const W16 = 0xFFFF, W8 = 0xFF;
    const points = new Array(N);
    for (let i = 0; i < N; i++) {
        const t = teams[teamIdx[i]];
        const p = {
            playerID: names[nameIdx[i]],
            yearID: String(yearBase + yearOff[i]),
            teamID: t.teamID,
            lgID: t.lgID,
        };
        for (const { name, width } of columnSpec) {
            const v = cols[name][i];
            const blank = width === 2 ? W16 : W8;
            p[name] = v === blank ? '' : String(v);
        }
        points[i] = p;
    }
    Object.defineProperty(points, 'metaFor', {
        value: (playerID) => peopleByName.get(playerID) || null,
        enumerable: false,
    });
    return points;
}
"""


def build_bundle():
    OUT_DIR.mkdir(exist_ok=True)

    bat_binary, bat_stats = build_binary(CSV_PATH, BATTING_COLUMN_SPEC)
    bat_compressed = gzip.compress(bat_binary, compresslevel=9)
    bat_b64 = base64.b64encode(bat_compressed).decode("ascii")

    pit_binary, pit_stats = build_binary(PITCHING_CSV_PATH, PITCHING_COLUMN_SPEC)
    pit_compressed = gzip.compress(pit_binary, compresslevel=9)
    pit_b64 = base64.b64encode(pit_compressed).decode("ascii")

    html = HTML_PATH.read_text(encoding="utf-8")
    css = CSS_PATH.read_text(encoding="utf-8")
    js = JS_PATH.read_text(encoding="utf-8")
    if not D3_PATH.exists():
        sys.exit(f"missing {D3_PATH.relative_to(ROOT)} — run: "
                 f"curl -sL https://d3js.org/d3.v7.min.js -o vendor/d3.v7.min.js")
    d3_js = D3_PATH.read_text(encoding="utf-8")

    # Swap the dataset fetches for our inline decoders. People CSV is only
    # needed by the multi-file site (bundle's decoder builds metaFor itself);
    # short-circuit it so the bundle doesn't 404 against a file it doesn't ship.
    def swap(pattern, replacement, n_expected=1):
        nonlocal js
        js, n = re.subn(pattern, replacement, js)
        if n != n_expected:
            sys.exit(f"build_bundle: expected {n_expected} matches for {pattern!r}, found {n}")

    swap(r'd3\.csv\("data/batting_limits_1871-2025\.csv"\)',  "decodeBatting()")
    swap(r'd3\.csv\("data/pitching_limits_1871-2025\.csv"\)', "decodePitching()")
    swap(r'd3\.csv\("data/people_lahman_1871-2025\.csv"\)',   "Promise.resolve(null)")

    decoder_js = (DECODER_JS_TEMPLATE
                  .replace("__BL_BATTING_B64__", bat_b64)
                  .replace("__BL_PITCHING_B64__", pit_b64))
    combined_js = decoder_js + "\n" + js

    html = html.replace(
        '<link rel="stylesheet" href="styles.css">',
        f"<style>\n{css}\n</style>",
    )
    html = html.replace(
        '<script src="https://d3js.org/d3.v7.min.js" defer></script>',
        f"<script defer>\n{d3_js}\n</script>",
    )
    html = html.replace(
        '<script src="script.js" defer></script>',
        f"<script defer>\n{combined_js}\n</script>",
    )

    OUT_PATH.write_text(html, encoding="utf-8")

    csv_size = CSV_PATH.stat().st_size + PITCHING_CSV_PATH.stat().st_size
    out_size = OUT_PATH.stat().st_size

    def report(label, stats, binary, compressed):
        print(f"--- {label} ---")
        print(f"  rows={stats['rows']:,} (from {stats['raw_rows']:,} stints)  "
              f"names={stats['names']:,}  teams={stats['teams']}  "
              f"cols={stats['columns']}  years={stats['year_range'][0]}-{stats['year_range'][1]}")
        print(f"  binary raw:  {len(binary):>10,} bytes  gzip: {len(compressed):>10,} bytes")
    report("batting", bat_stats, bat_binary, bat_compressed)
    report("pitching", pit_stats, pit_binary, pit_compressed)
    total_gz = len(bat_compressed) + len(pit_compressed)
    print(f"--- total ---")
    print(f"  binary gzip: {total_gz:>10,} bytes ({total_gz/csv_size:.1%} of CSV sources)")
    print(f"  dist HTML:   {out_size:>10,} bytes -> {OUT_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    build_bundle()
