#!/usr/bin/env node
// PBP dataset size + memory experiment (see docs/pbp-data-experiments.md (git history) §1–§2).
//
// Reads the committed data/pbp/b*.bl2p.gz corpus and reports:
//   • record/event counts (player-game records, plate appearances, stat totals)
//   • the cost of holding ALL seasons decoded in RAM, in two layouts:
//       - "current"  : the per-player Int32 structure the browser builds today
//       - "optimized": columnar (one array per column per season) + smallest int
//                      type per column — the ~5.5x-smaller drop-in alternative
//
// Always prints §1 (counts). For §2 (resident memory) it measures ONE layout per
// process so the heap deltas stay clean — run it once per layout:
//   node --expose-gc scripts/pbp_size_experiment.js current
//   node --expose-gc scripts/pbp_size_experiment.js optimized
// (default layout is "current"). Measuring both in one process pollutes the deltas
// because freeing the first layout overlaps measuring the second.
//
// No deps; uses Node's built-in zlib. The BL2P layout mirrors parseBl2p in script.js.

const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const PBP_DIR = path.join(__dirname, "..", "data", "pbp");
const files = fs.readdirSync(PBP_DIR).filter((f) => /^b\d+\.bl2p\.gz$/.test(f)).sort();
if (!files.length) { console.error("no data/pbp/b*.bl2p.gz files found"); process.exit(1); }

// Parse a BL2P buffer up to the per-game delta columns; `mode` selects what to retain.
//   "headers"   – counts only (P, D, C, G, gameCounts) and per-column delta sums
//   "current"   – per-player {dateIdx, cum:{col:Int32Array}}  (today's structure)
//   "optimized" – columnar {playerStart, col:{name:TypedArray}} with min int width
function parse(buf, mode) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dec = new TextDecoder();
    let off = 8; // magic(4) + major,minor,dataset,flags(4)
    const year = dv.getUint16(off, true); off += 2;
    const P = dv.getUint16(off, true); off += 2;
    const D = dv.getUint16(off, true); off += 2;
    const C = dv.getUint16(off, true); off += 2;
    const dates = mode === "current" ? new Uint16Array(D) : null;
    for (let i = 0; i < D; i++) { const v = dv.getUint16(off, true); off += 2; if (dates) dates[i] = v; }
    const cols = new Array(C);
    for (let i = 0; i < C; i++) {
        const width = buf[off++]; const nl = buf[off++];
        const name = dec.decode(buf.subarray(off, off + nl)); off += nl;
        cols[i] = { name, width };
    }
    const names = new Array(P);
    for (let i = 0; i < P; i++) { const nl = buf[off++]; names[i] = dec.decode(buf.subarray(off, off + nl)); off += nl; }
    const gameCounts = new Uint16Array(P);
    let G = 0;
    for (let i = 0; i < P; i++) { gameCounts[i] = dv.getUint16(off, true); off += 2; G += gameCounts[i]; }
    const dateIdxAll = new Uint16Array(G);
    for (let i = 0; i < G; i++) { dateIdxAll[i] = dv.getUint16(off, true); off += 2; }

    // Bit-unpack each column (LSB-first), byte-aligned at each column boundary.
    const raw = {}, colSum = {};
    for (const { name, width } of cols) {
        const arr = new Int32Array(G);
        const mask = (1 << width) - 1;
        let acc = 0, nbits = 0, p = off, s = 0;
        for (let i = 0; i < G; i++) {
            while (nbits < width) { acc |= buf[p++] << nbits; nbits += 8; }
            const v = acc & mask; arr[i] = v; s += v; acc >>>= width; nbits -= width;
        }
        off += Math.ceil((G * width) / 8);
        raw[name] = arr; colSum[name] = s;
    }
    const colNames = cols.map((c) => c.name);

    if (mode === "headers") return { year, P, D, G, colSum };

    if (mode === "current") {
        const perPlayer = new Map();
        let g = 0;
        for (let pi = 0; pi < P; pi++) {
            const n = gameCounts[pi];
            const dateIdx = dateIdxAll.subarray(g, g + n);
            const cum = {};
            for (const name of colNames) {
                const src = raw[name]; const c = new Int32Array(n);
                let run = 0;
                for (let k = 0; k < n; k++) { run += src[g + k]; c[k] = run; }
                cum[name] = c;
            }
            perPlayer.set(names[pi], { dateIdx, cum });
            g += n;
        }
        return { year, dates, dateCount: D, cols: colNames, perPlayer, games: G, players: P };
    }

    // optimized: columnar cumulative, smallest int type per column
    const playerStart = new Uint32Array(P + 1);
    for (let i = 0; i < P; i++) playerStart[i + 1] = playerStart[i] + gameCounts[i];
    const col = {}, widths = {};
    for (const name of colNames) {
        const src = raw[name]; const cum = new Int32Array(G);
        let max = 0;
        for (let pi = 0; pi < P; pi++) {
            let run = 0;
            for (let k = playerStart[pi]; k < playerStart[pi + 1]; k++) { run += src[k]; cum[k] = run; if (run > max) max = run; }
        }
        const TA = max < 256 ? Uint8Array : max < 65536 ? Uint16Array : Int32Array;
        widths[name] = TA.BYTES_PER_ELEMENT;
        col[name] = TA.from(cum);
    }
    return { year, playerStart, names, col, dateIdxAll, games: G, players: P, widths };
}

const MB = (x) => (x / 1048576).toFixed(0);
const c = (x) => x.toLocaleString();

// ── §1 counts ────────────────────────────────────────────────────────────────
const T = {}; let G = 0, P = 0, C = 0;
const per = [];
for (const f of files) {
    const r = parse(zlib.gunzipSync(fs.readFileSync(path.join(PBP_DIR, f))), "headers");
    G += r.G; P += r.P; C = Object.keys(r.colSum).length;
    per.push(r);
    for (const k in r.colSum) T[k] = (T[k] || 0) + r.colSum[k];
}
const PA = T.AB + T.BB + (T.HBP || 0) + (T.SH || 0) + (T.SF || 0);
const big = per.reduce((a, b) => (b.G > a.G ? b : a));
const small = per.reduce((a, b) => (b.G < a.G ? b : a));
console.log("=== §1 dataset scale ===");
console.log(`seasons: ${per.length} (${per[0].year}-${per[per.length - 1].year}) | columns: ${C}`);
console.log(`player-game records (ΣG): ${c(G)} | player-season entries (ΣP): ${c(P)}`);
console.log(`plate appearances: ${c(PA)} | AB ${c(T.AB)} H ${c(T.H)} HR ${c(T.HR)} SB ${c(T.SB)} SO ${c(T.SO)} BB ${c(T.BB)} RBI ${c(T.RBI)}`);
console.log(`biggest: ${big.year} ${c(big.G)} records, ${big.P} players, ${big.D} dates | smallest: ${small.year} ${c(small.G)} records`);

// ── §2 memory ────────────────────────────────────────────────────────────────
function measure(mode) {
    if (global.gc) global.gc();
    const before = process.memoryUsage();
    const all = [];
    let widths = null;
    for (const f of files) {
        const d = parse(zlib.gunzipSync(fs.readFileSync(path.join(PBP_DIR, f))), mode);
        if (d.widths) widths = d.widths;
        all.push(d);
    }
    if (global.gc) global.gc();
    const after = process.memoryUsage();
    const managed = (after.heapUsed - before.heapUsed) + (after.external - before.external);
    return { managed, heap: after.heapUsed - before.heapUsed, ext: after.external - before.external, rss: after.rss - before.rss, widths, keep: all.length };
}
const mode = process.argv[2] === "optimized" ? "optimized" : "current";
console.log(`\n=== §2 full-corpus resident memory — layout: ${mode} ===`);
if (!global.gc) console.log("(run with --expose-gc for accurate deltas; one layout per process)");
const m = measure(mode);
console.log(`managed ~${MB(m.managed)} MB (heap ${MB(m.heap)} + external ${MB(m.ext)}) | rss ~${MB(m.rss)} MB`);
if (m.widths) {
    const bytes = Object.values(m.widths);
    console.log(`per-column bytes: avg ${(bytes.reduce((a, b) => a + b, 0) / bytes.length).toFixed(2)} (${JSON.stringify(m.widths)})`);
}
console.log(`\n(other layout: re-run with "${mode === "current" ? "optimized" : "current"}")`);
console.log("theoretical cum data: C*ΣG*4 (Int32) =", MB(C * G * 4), "MB");
