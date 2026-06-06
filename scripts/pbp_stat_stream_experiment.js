#!/usr/bin/env node
// Single-stat event-stream experiment (see docs/pbp-data-experiments.md §5).
//
// For a counting stat that's plotted on the chart (default HR and SB), extract the
// per-player event stream from the committed data/pbp/b*.bl2p.gz corpus and measure
// how small an "animate this stat across all history" representation can be, plus the
// resident memory and how often the HRxSB Pareto frontier actually changes.
//
//   node scripts/pbp_stat_stream_experiment.js [STAT1 STAT2]   (default: HR SB)
//
// No deps; uses Node's built-in zlib. BL2P layout mirrors parseBl2p in script.js.

const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const STATS = (process.argv.slice(2).length ? process.argv.slice(2) : ["HR", "SB"]).map((s) => s.toUpperCase());
const PBP_DIR = path.join(__dirname, "..", "data", "pbp");
const files = fs.readdirSync(PBP_DIR).filter((f) => /^b\d+\.bl2p\.gz$/.test(f)).sort();

// Decode only the requested stat columns' per-game DELTAS (+ dateIdx per player).
function parse(buf, want) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dec = new TextDecoder();
    let off = 8;
    const year = dv.getUint16(off, true); off += 2;
    const P = dv.getUint16(off, true); off += 2;
    const D = dv.getUint16(off, true); off += 2;
    const C = dv.getUint16(off, true); off += 2;
    off += D * 2;
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
        if (!want.has(name)) { off += Math.ceil((G * width) / 8); continue; }   // skip columns we don't need
        const arr = new Int32Array(G); const mask = (1 << width) - 1;
        let acc = 0, nbits = 0, p = off;
        for (let i = 0; i < G; i++) { while (nbits < width) { acc |= buf[p++] << nbits; nbits += 8; } arr[i] = acc & mask; acc >>>= width; nbits -= width; }
        off += Math.ceil((G * width) / 8); raw[name] = arr;
    }
    return { year, P, D, names, gc, dateIdxAll, raw };
}

// Build per-player event lists {name -> [[globalDate, delta], ...]} for each stat.
// Global date = seasons concatenated in year order.
const want = new Set(STATS);
const ev = Object.fromEntries(STATS.map((s) => [s, new Map()]));
let gbase = 0, globalDates = 0;
for (const f of files) {
    const s = parse(zlib.gunzipSync(fs.readFileSync(path.join(PBP_DIR, f))), want);
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
globalDates = gbase;
for (const st of STATS) for (const a of ev[st].values()) a.sort((x, y) => x[0] - y[0]);

const gz = (b) => zlib.gzipSync(Buffer.from(b), { level: 9 }).length;
const mb = (x) => (x / 1048576).toFixed(2);
function varint(arr, v) { v = v >>> 0; while (v >= 128) { arr.push((v & 127) | 128); v >>>= 7; } arr.push(v); }

// Encodings: (A) naive 5B/cell, (B) columnar 3 streams, (C) per-player varint date-deltas.
function encode(map) {
    const names = [...map.keys()]; const idx = new Map(names.map((n, i) => [n, i]));
    const A = [], Bp = [], Bd = [], Bc = [], C = [], dict = [];
    let cells = 0, total = 0;
    for (const nm of names) { const b = Buffer.from(nm, "latin1"); dict.push(b.length); for (const x of b) dict.push(x); }
    for (const nm of names) {
        const list = map.get(nm), pid = idx.get(nm); cells += list.length;
        varint(C, list.length); let prev = 0;
        for (const [gd, d] of list) {
            total += d;
            A.push(pid & 255, (pid >> 8) & 255, gd & 255, (gd >> 8) & 255, Math.min(255, d));
            const dd = gd - prev; Bp.push(pid & 255, (pid >> 8) & 255); Bd.push(dd & 255, (dd >> 8) & 255); Bc.push(Math.min(255, d));
            varint(C, dd); varint(C, d); prev = gd;
        }
    }
    return { A: gz(A), B: gz(Bp) + gz(Bd) + gz(Bc), C: gz(C), dict: gz(dict), cells, total, players: names.length };
}
// Resident decoded: Uint16 global-date + Uint16 cumulative per cell.
const resident = (map) => { let c = 0; for (const a of map.values()) c += a.length; return c * 4; };

console.log(`global game-dates: ${globalDates.toLocaleString()}  | stats: ${STATS.join(", ")}`);
const enc = {};
for (const st of STATS) {
    const e = encode(ev[st]); enc[st] = e;
    console.log(`\n=== ${st}: ${e.cells.toLocaleString()} event-cells, total ${e.total.toLocaleString()}, ${e.players.toLocaleString()} players ===`);
    console.log(`  A naive 5B/cell: ${mb(e.A)} MB | B columnar: ${mb(e.B)} MB | C per-player varint: ${mb(e.C)} MB (+dict ${mb(e.dict)} MB)`);
    console.log(`  best (C+dict): ${mb(e.C + e.dict)} MB  (${((e.C + e.dict) * 8 / e.cells).toFixed(2)} bits/event) | resident decoded: ${mb(resident(ev[st]))} MB`);
}
const sumC = STATS.reduce((a, s) => a + enc[s].C, 0);
const sharedDict = Math.max(...STATS.map((s) => enc[s].dict));   // players overlap; one shared dict
console.log(`\ncombined ${STATS.join("+")} (shared name dict): ${mb(sumC + sharedDict)} MB on disk | ${mb(STATS.reduce((a, s) => a + resident(ev[s]), 0))} MB resident`);
console.log("vs full 17-column .bl2p corpus: ~11 MB on disk, ~690 MB fully resident");

// How often does the HRxSB Pareto frontier actually change? (only meaningful for HR+SB)
if (STATS.length === 2 && want.has("HR") && want.has("SB")) {
    const [X, Y] = STATS;
    const all = [];
    for (const [nm, a] of ev[X]) for (const [gd, d] of a) all.push([gd, nm, d, 0]);
    for (const [nm, a] of ev[Y]) for (const [gd, d] of a) all.push([gd, nm, 0, d]);
    all.sort((a, b) => a[0] - b[0]);
    const pts = new Map(); let key = "", changes = 0, frames = 0, last = -1;
    const rebuild = () => {
        const arr = [...pts.values()].filter((p) => p.x > 0 || p.y > 0).sort((a, b) => a.x - b.x || a.y - b.y);
        let best = -1; const fr = [];
        for (let i = arr.length - 1; i >= 0; i--) if (arr[i].y > best) { best = arr[i].y; fr.push(arr[i].x + "-" + arr[i].y); }
        return fr.join(",");
    };
    for (const [gd, nm, dx, dy] of all) {
        let p = pts.get(nm); if (!p) { p = { x: 0, y: 0 }; pts.set(nm, p); } p.x += dx; p.y += dy;
        if (gd !== last) { frames++; last = gd; const k = rebuild(); if (k !== key) { changes++; key = k; } }
    }
    console.log(`\nfrontier-change timeline: ${frames.toLocaleString()} distinct game-dates, frontier actually changes on ${changes.toLocaleString()} of them`);
}
