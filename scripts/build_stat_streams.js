#!/usr/bin/env node
// Build per-stat event streams (the "STEV" format) for full-history animation of a
// single counting stat — see docs/pbp-data-experiments.md §5.
//
// Reads the committed data/pbp/b*.bl2p.gz corpus and, for each requested stat,
// extracts every player's sparse event timeline (the game-dates where the stat
// increased, + by how much) and writes a compact gzipped file:
//
//   data/pbp/hr.evt.gz   (default), data/pbp/sb.evt.gz, …
//
//   node scripts/build_stat_streams.js [HR SB ...]
//
// No deps; uses Node's built-in zlib. Format is documented in docs/pbp-evt-format.md.

const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

// Default set = the committed offensive counting streams (must match EVT_STATS in
// script.js). Pass stat names to (re)build a subset.
const DEFAULT_STATS = ["HR", "SB", "H", "2B", "3B", "RBI", "R", "BB", "SO", "CS", "AB", "HBP", "SF", "SH", "IBB", "GIDP", "G"];
const STATS = (process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_STATS).map((s) => s.toUpperCase());
const PBP_DIR = path.join(__dirname, "..", "data", "pbp");
const files = fs.readdirSync(PBP_DIR).filter((f) => /^b\d+\.bl2p\.gz$/.test(f)).sort();
if (!files.length) { console.error("no data/pbp/b*.bl2p.gz found"); process.exit(1); }

// Decode a BL2P season: season dates (day-of-year per game-date) + per-game DELTAS
// for the requested stat columns + each game's date index + player game counts.
function parse(buf, want) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dec = new TextDecoder();
    let off = 8;
    const year = dv.getUint16(off, true); off += 2;
    const P = dv.getUint16(off, true); off += 2;
    const D = dv.getUint16(off, true); off += 2;
    const C = dv.getUint16(off, true); off += 2;
    const dates = new Uint16Array(D);
    for (let i = 0; i < D; i++) { dates[i] = dv.getUint16(off, true); off += 2; }
    const cols = [];
    for (let i = 0; i < C; i++) { const w = buf[off++]; const nl = buf[off++]; cols.push({ name: dec.decode(buf.subarray(off, off + nl)), width: w }); off += nl; }
    const names = [];
    for (let i = 0; i < P; i++) { const nl = buf[off++]; names.push(dec.decode(buf.subarray(off, off + nl))); off += nl; }
    const gc = new Uint16Array(P); let G = 0;
    for (let i = 0; i < P; i++) { gc[i] = dv.getUint16(off, true); off += 2; G += gc[i]; }
    const dateIdxAll = new Uint16Array(G);
    for (let i = 0; i < G; i++) { dateIdxAll[i] = dv.getUint16(off, true); off += 2; }
    const raw = {};
    for (const { name, width } of cols) {
        if (!want.has(name)) { off += Math.ceil((G * width) / 8); continue; }
        const arr = new Int32Array(G); const mask = (1 << width) - 1;
        let acc = 0, nbits = 0, p = off;
        for (let i = 0; i < G; i++) { while (nbits < width) { acc |= buf[p++] << nbits; nbits += 8; } arr[i] = acc & mask; acc >>>= width; nbits -= width; }
        off += Math.ceil((G * width) / 8); raw[name] = arr;
    }
    return { year, P, D, dates, names, gc, dateIdxAll, raw };
}

// ── Extract event timelines, building the shared global date table ──────────────
const want = new Set(STATS);
const ev = Object.fromEntries(STATS.map((s) => [s, new Map()]));   // stat -> name -> [[globalDate, delta]]
const seasons = [];                                                // {year, nDates}
const doy = [];                                                    // day-of-year per global date
let gbase = 0;
for (const f of files) {
    const s = parse(zlib.gunzipSync(fs.readFileSync(path.join(PBP_DIR, f))), want);
    seasons.push({ year: s.year, nDates: s.D });
    for (let i = 0; i < s.D; i++) doy.push(s.dates[i]);
    let g = 0;
    for (let pi = 0; pi < s.P; pi++) {
        const n = s.gc[pi], nm = s.names[pi];
        for (let k = 0; k < n; k++) {
            const gd = gbase + s.dateIdxAll[g + k];
            for (const st of STATS) {
                const d = s.raw[st] ? s.raw[st][g + k] : 0;
                if (d > 0) { const m = ev[st]; if (!m.has(nm)) m.set(nm, []); m.get(nm).push([gd, d]); }
            }
        }
        g += n;
    }
    gbase += s.D;
}
const numDates = gbase;
for (const st of STATS) for (const a of ev[st].values()) a.sort((x, y) => x[0] - y[0]);

// ── STEV encoder ────────────────────────────────────────────────────────────
// Little-endian. Layout:
//   "STEV"            magic (4)
//   u8                version = 1
//   u8 len + UTF-8    stat name (e.g. "HR")
//   u16               numDates (global game-dates)
//   u16               numSeasons
//   numSeasons ×      { u16 year, u16 nDates }          (global-date -> calendar year)
//   numDates ×        u16 dayOfYear                      (global-date -> month/day label)
//   u32               numPlayers
//   numPlayers ×      { u8 nameLen, UTF-8 name }         (player dictionary)
//   numPlayers ×      varint nEvents,
//                     nEvents × { varint dateDelta (gap from prev event, ≥0),
//                                 varint count (stat delta on that game-date) }
// Decoder prefix-sums dateDelta -> global date and count -> cumulative.
const enc = new TextEncoder();
function pushVarint(out, v) { v = v >>> 0; while (v >= 128) { out.push((v & 127) | 128); v >>>= 7; } out.push(v); }
function pushU16(out, v) { out.push(v & 255, (v >> 8) & 255); }
function pushU32(out, v) { out.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255); }

function buildStev(stat, map) {
    const out = [];
    for (const ch of "STEV") out.push(ch.charCodeAt(0));
    out.push(1);
    const sn = enc.encode(stat); out.push(sn.length); for (const b of sn) out.push(b);
    pushU16(out, numDates);
    pushU16(out, seasons.length);
    for (const s of seasons) { pushU16(out, s.year); pushU16(out, s.nDates); }
    for (let i = 0; i < numDates; i++) pushU16(out, doy[i]);
    const names = [...map.keys()];
    pushU32(out, names.length);
    for (const nm of names) { const b = enc.encode(nm); out.push(b.length); for (const x of b) out.push(x); }
    for (const nm of names) {
        const list = map.get(nm);
        pushVarint(out, list.length);
        let prev = 0;
        for (const [gd, d] of list) { pushVarint(out, gd - prev); pushVarint(out, d); prev = gd; }
    }
    return Buffer.from(out);
}

const kb = (x) => (x / 1024).toFixed(0);
for (const st of STATS) {
    const raw = buildStev(st, ev[st]);
    const gzipped = zlib.gzipSync(raw, { level: 9 });
    const outPath = path.join(PBP_DIR, `${st.toLowerCase()}.evt.gz`);
    fs.writeFileSync(outPath, gzipped);
    const cells = [...ev[st].values()].reduce((a, l) => a + l.length, 0);
    console.log(`${st}: ${ev[st].size.toLocaleString()} players, ${cells.toLocaleString()} events -> ${path.relative(path.join(__dirname, ".."), outPath)}  (raw ${kb(raw.length)} KB, gz ${kb(gzipped.length)} KB)`);
}
console.log(`global game-dates: ${numDates.toLocaleString()} across ${seasons.length} seasons (${seasons[0].year}-${seasons[seasons.length - 1].year})`);
