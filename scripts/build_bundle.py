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
CSV_PATH = ROOT / "data" / "batting_limits_1871-2024.csv"
HTML_PATH = ROOT / "index.html"
CSS_PATH = ROOT / "styles.css"
JS_PATH = ROOT / "script.js"
D3_PATH = ROOT / "vendor" / "d3.v7.min.js"
PEOPLE_PATH = ROOT / "data" / "people_lahman_1871-2023.csv"
OUT_DIR = ROOT / "dist"
OUT_PATH = OUT_DIR / "index.html"

YEAR_BASE = 1871
WIDE_COLS = ["G", "AB", "R", "H", "BB", "SO", "RBI"]
NARROW_COLS = ["2B", "3B", "HR", "SB", "CS", "IBB", "HBP", "SH", "SF", "GIDP"]
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


ALL_STATS = WIDE_COLS + NARROW_COLS


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
    """Map '{nameFirst} {nameLast}' -> chosen people-row dict.

    Lahman's playerID is unique, but the visible "{first} {last}" key collides
    for ~568 names (e.g. 5 Luis Garcias). On collision, prefer the player with
    the latest debut date — they're the one a present-day visitor is more
    likely to be looking up. This is the same data limitation that already
    affects tooltips, just made explicit here.
    """
    chosen = {}
    chosen_debut = {}
    with csv_path.open(encoding="utf-8") as f:
        for p in csv.DictReader(f):
            key = "{} {}".format(p["nameFirst"], p["nameLast"])
            debut = _year_from_date(p["debut"])
            if key not in chosen or debut > chosen_debut[key]:
                chosen[key] = p
                chosen_debut[key] = debut
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


def aggregate_stints(rows):
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
        for col in ALL_STATS:
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


def build_binary(csv_path: Path) -> tuple[bytes, dict]:
    with csv_path.open(encoding="utf-8") as f:
        raw_rows = list(csv.DictReader(f))
    rows = aggregate_stints(raw_rows)
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

    buf = io.BytesIO()
    buf.write(b"BL2D")
    buf.write(struct.pack("<BB", 2, 0))
    buf.write(struct.pack("<HI", YEAR_BASE, n))

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
    team_arr = array.array("B", (team_to_idx[(r["lgID"], r["teamID"])] for r in rows))

    wide_arrays = {}
    for col in WIDE_COLS:
        a = array.array("H", [0] * n)
        for i, r in enumerate(rows):
            v = parse_int(r[col], W16_BLANK)
            if v != W16_BLANK and (v < 0 or v > 0xFFFE):
                sys.exit(f"{col}[row {i}] value {v} out of u16 range")
            a[i] = v
        wide_arrays[col] = a

    narrow_arrays = {}
    for col in NARROW_COLS:
        a = array.array("B", [0] * n)
        for i, r in enumerate(rows):
            v = parse_int(r[col], W8_BLANK)
            if v != W8_BLANK and (v < 0 or v > 0xFE):
                sys.exit(f"{col}[row {i}] value {v} out of u8 range")
            a[i] = v
        narrow_arrays[col] = a

    buf.write(name_arr.tobytes())
    buf.write(year_arr.tobytes())
    buf.write(team_arr.tobytes())
    for col in WIDE_COLS:
        buf.write(wide_arrays[col].tobytes())
    for col in NARROW_COLS:
        buf.write(narrow_arrays[col].tobytes())

    stats = {
        "raw_rows": len(raw_rows),
        "rows": n,
        "names": len(names),
        "teams": len(teams),
        "year_range": (min_year, max_year),
        **people_stats,
    }
    return buf.getvalue(), stats


DECODER_JS_TEMPLATE = r"""
// --- BL2D inline decoder (generated by scripts/build_bundle.py) ---
const BL_DATA_B64 = "__BL_DATA_B64__";
const BL_WIDE_COLS = ['G','AB','R','H','BB','SO','RBI'];
const BL_NARROW_COLS = ['2B','3B','HR','SB','CS','IBB','HBP','SH','SF','GIDP'];

async function decodeBL() {
    const bin = atob(BL_DATA_B64);
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
    if (major !== 2) throw new Error('decodeBL: unsupported version ' + major + '.' + minor);
    const yearBase = dv.getUint16(off, true); off += 2;
    const N = dv.getUint32(off, true); off += 4;

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

    // People section (v2): country dict, then fixed-width per-player records.
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
    const teamIdx = sliceU8();
    const wide = {}; for (const c of BL_WIDE_COLS) wide[c] = sliceU16();
    const narrow = {}; for (const c of BL_NARROW_COLS) narrow[c] = sliceU8();

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
        for (const c of BL_WIDE_COLS) {
            const v = wide[c][i];
            p[c] = v === W16 ? '' : String(v);
        }
        for (const c of BL_NARROW_COLS) {
            const v = narrow[c][i];
            p[c] = v === W8 ? '' : String(v);
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

    binary, stats = build_binary(CSV_PATH)
    compressed = gzip.compress(binary, compresslevel=9)
    b64 = base64.b64encode(compressed).decode("ascii")

    html = HTML_PATH.read_text(encoding="utf-8")
    css = CSS_PATH.read_text(encoding="utf-8")
    js = JS_PATH.read_text(encoding="utf-8")
    if not D3_PATH.exists():
        sys.exit(f"missing {D3_PATH.relative_to(ROOT)} — run: "
                 f"curl -sL https://d3js.org/d3.v7.min.js -o vendor/d3.v7.min.js")
    d3_js = D3_PATH.read_text(encoding="utf-8")

    # Swap the single d3.csv() call for our decoder. Keep the rest of script.js intact —
    # downstream parseInt() works equally well on the string values we emit.
    js_patched, n_subs = re.subn(
        r'd3\.csv\("data/batting_limits_1871-2024\.csv"\)',
        "decodeBL()",
        js,
    )
    if n_subs != 1:
        sys.exit(f"build_bundle: expected exactly one d3.csv() call to patch, found {n_subs}")

    decoder_js = DECODER_JS_TEMPLATE.replace("__BL_DATA_B64__", b64)
    combined_js = decoder_js + "\n" + js_patched

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

    csv_size = CSV_PATH.stat().st_size
    out_size = OUT_PATH.stat().st_size
    print(f"rows={stats['rows']:,} (aggregated from {stats['raw_rows']:,} stints)  "
          f"names={stats['names']:,}  teams={stats['teams']}  "
          f"years={stats['year_range'][0]}-{stats['year_range'][1]}")
    print(f"people: {stats['people_emitted']:,} matched of {stats['names']:,} batting names  "
          f"(pool {stats['people_total']:,}, {stats['countries']} countries)")
    print(f"binary raw:   {len(binary):>10,} bytes")
    print(f"binary gzip:  {len(compressed):>10,} bytes  ({len(compressed)/csv_size:.1%} of CSV)")
    print(f"b64 inline:   {len(b64):>10,} bytes")
    print(f"dist HTML:    {out_size:>10,} bytes -> {OUT_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    build_bundle()
