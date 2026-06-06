#!/usr/bin/env node
// Event-level PBP packing experiment (see docs/pbp-data-experiments.md §3).
//
// Parses real Retrosheet event files (`play,` records) and measures how small a
// true event-level play-by-play corpus could be: outcome entropy, pitch entropy,
// and real bit-packed-then-gzip sizes per event.
//
// Usage:
//   1. Download a season's events (CC BY-SA, same source as the existing PBP data):
//        cd /tmp && curl -sL -o 2023eve.zip https://www.retrosheet.org/events/2023eve.zip
//        unzip -q 2023eve.zip -d 2023eve
//   2. node scripts/pbp_event_experiment.js /tmp/2023eve
//
// Compare a modern season (2023, full pitch data) with a pre-1988 one (e.g. 1955,
// ~0 pitches/PA) to see the entropy range and that pitch sequences are modern-only.
// No deps; uses Node's built-in zlib.

const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const dir = process.argv[2];
if (!dir) { console.error("usage: node scripts/pbp_event_experiment.js <dir-with-.EVN/.EVA-files>"); process.exit(1); }
const files = fs.readdirSync(dir).filter((f) => /\.EV[NA]$/.test(f));
if (!files.length) { console.error("no .EVN/.EVA event files in " + dir); process.exit(1); }

// Retrosheet pitch symbols that count as actual pitches (exclude runner/pickoff marks).
const PITCH_CHARS = "BCSFTXLMOPQRIHKVY";
const CLS = ["1B", "2B", "3B", "HR", "BB", "HBP", "SO", "ROE", "FC", "BIPout", "SH", "SF", "OTH"];
const cidx = Object.fromEntries(CLS.map((x, i) => [x, i]));

// Classify a Retrosheet event string into a plate-appearance outcome class, or null
// for non-PA continuation events (steals, pickoffs, wild pitches, no-plays, …).
function classify(ev) {
    let s = ev.split(".")[0].replace(/[#!?]/g, "");  // drop explicit advances + annotations
    const base = s.split("/")[0];                     // batter result before modifiers
    const mods = s.slice(base.length);
    if (base === "" || /^(SB|CS|PO|POCS|WP|PB|BK|DI|OA|FLE|NP)/.test(base)) return null;
    if (/^S(?!B)/.test(base)) return "1B";
    if (/^D(?!I)/.test(base)) return "2B";
    if (/^T(?!H)/.test(base)) return "3B";
    if (/^HR?$/.test(base) || /^HR/.test(base)) return "HR";
    if (/^I?W/.test(base)) return "BB";
    if (/^HP/.test(base)) return "HBP";
    if (/^K/.test(base)) return "SO";
    if (/SH/.test(mods)) return "SH";
    if (/SF/.test(mods)) return "SF";
    if (/^E/.test(base)) return "ROE";
    if (/^FC/.test(base)) return "FC";
    if (/^[0-9]/.test(base)) return "BIPout";
    return "OTH";
}

let plays = 0, PA = 0, nonPA = 0, pitchTotal = 0;
const outClass = new Map(), pitchSym = new Map();
const outcomeBytes = [], eventPack = [], pitchBytes = [];

for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), "latin1").split("\n");
    let bmap = null;
    for (const ln of lines) {
        if (ln.startsWith("id,")) bmap = new Map();           // reset within-game batter dictionary
        if (!ln.startsWith("play,")) continue;
        const p = ln.split(",");
        const inning = +p[1], side = +p[2], batter = p[3], pitches = p[5] || "", ev = (p[6] || "").trim();
        plays++;
        for (const ch of pitches) {
            if (PITCH_CHARS.includes(ch)) { pitchTotal++; pitchSym.set(ch, (pitchSym.get(ch) || 0) + 1); pitchBytes.push(ch.charCodeAt(0)); }
        }
        const cls = classify(ev);
        if (cls === null) { nonPA++; continue; }
        PA++;
        outClass.set(cls, (outClass.get(cls) || 0) + 1);
        outcomeBytes.push(cidx[cls] ?? cidx.OTH);
        // self-contained event record: inning(5)+half(1)+batterIdx(5)+outcome(5)+pitchCount(4) = 20 bits,
        // stored in 24-bit (3-byte) slots; gzip reclaims the slack + cross-event redundancy.
        if (!bmap.has(batter)) bmap.set(batter, bmap.size & 31);
        const bi = bmap.get(batter);
        const np = Math.min(15, (pitches.match(new RegExp("[" + PITCH_CHARS + "]", "g")) || []).length);
        const v = ((inning & 31) << 15) | ((side & 1) << 14) | ((bi & 31) << 9) | ((cidx[cls] & 31) << 4) | (np & 15);
        eventPack.push(v >>> 16, (v >>> 8) & 255, v & 255);
    }
}

const ent = (map, total) => { let h = 0; for (const v of map.values()) { const p = v / total; if (p > 0) h -= p * Math.log2(p); } return h; };
const gz = (b) => zlib.gzipSync(Buffer.from(b), { level: 9 }).length;
const Hout = ent(outClass, PA), Hpitch = ent(pitchSym, pitchTotal);
const ocGz = gz(outcomeBytes), evGz = gz(eventPack), pGz = pitchTotal ? gz(pitchBytes) : 0;

console.log(`=== ${path.basename(dir)} (measured) ===`);
console.log(`play records: ${plays.toLocaleString()} | PA: ${PA.toLocaleString()} | non-PA: ${nonPA.toLocaleString()} | pitches: ${pitchTotal.toLocaleString()} (${(pitchTotal / PA).toFixed(2)}/PA)`);
console.log("\n-- outcome distribution --");
for (const k of CLS) if (outClass.get(k)) console.log("  " + k.padEnd(7), (100 * outClass.get(k) / PA).toFixed(1) + "%");
console.log(`outcome entropy:      ${Hout.toFixed(3)} bits/PA`);
if (pitchTotal) console.log(`pitch-symbol entropy: ${Hpitch.toFixed(3)} bits/pitch`);
console.log("\n-- real packed + gzip --");
console.log(`outcome-only (1 B/PA -> gzip): ${(ocGz * 8 / PA).toFixed(2)} bits/PA`);
console.log(`event record (24b/ev -> gzip): ${(evGz * 8 / PA).toFixed(2)} bits/event`);
if (pitchTotal) console.log(`pitch stream (1 B/pitch -> gzip): ${(pGz * 8 / pitchTotal).toFixed(2)} bits/pitch`);

// Full-corpus projection (scale the measured per-unit bits to the whole PBP corpus).
const EVENTS = 16_443_368, PITCHES = 55_790_000;
const mb = (bits) => (bits / 8 / 1048576).toFixed(1);
console.log("\n=== full-corpus projection (scaling these measured bits) ===");
console.log(`outcome-only: ${mb(ocGz * 8 / PA * EVENTS)} MB | event records: ${mb(evGz * 8 / PA * EVENTS)} MB` +
    (pitchTotal ? ` | + pitches: ${mb(pGz * 8 / pitchTotal * PITCHES)} MB | event+pitches: ${mb(evGz * 8 / PA * EVENTS + pGz * 8 / pitchTotal * PITCHES)} MB` : ""));
