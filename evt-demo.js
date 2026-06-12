// Standalone full-history HR×SB animation driven by the .evt (STEV) stat streams.
// Dependency-free: decodes data/pbp/{hr,sb}.evt.gz, holds every player's cumulative
// timeline resident (~2 MB), and animates the cloud + Pareto frontier across all of
// MLB history. See docs/data-formats.md §Deprecated and docs/pbp-data-experiments.md §5.

const $ = (id) => document.getElementById(id);

// ── STEV decode ───────────────────────────────────────────────────────────────
async function fetchDecode(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${url} → ${resp.status}`);
    const ds = resp.body.pipeThrough(new DecompressionStream("gzip"));
    const buf = new Uint8Array(await new Response(ds).arrayBuffer());
    return { buf, transferred: +resp.headers.get("content-length") || 0 };
}

function decodeStev(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dec = new TextDecoder();
    let off = 0;
    if (dec.decode(buf.subarray(0, 4)) !== "STEV") throw new Error("bad STEV magic");
    off = 4;
    const version = buf[off++];
    const snLen = buf[off++];
    const stat = dec.decode(buf.subarray(off, off + snLen)); off += snLen;
    const numDates = dv.getUint16(off, true); off += 2;
    const numSeasons = dv.getUint16(off, true); off += 2;
    const seasons = [];
    for (let i = 0; i < numSeasons; i++) { const year = dv.getUint16(off, true); off += 2; const nDates = dv.getUint16(off, true); off += 2; seasons.push({ year, nDates }); }
    const doy = new Uint16Array(numDates);
    for (let i = 0; i < numDates; i++) { doy[i] = dv.getUint16(off, true); off += 2; }
    const P = dv.getUint32(off, true); off += 4;
    const names = new Array(P);
    for (let i = 0; i < P; i++) { const nl = buf[off++]; names[i] = dec.decode(buf.subarray(off, off + nl)); off += nl; }
    const rv = () => { let v = 0, s = 0, b; do { b = buf[off++]; v |= (b & 127) << s; s += 7; } while (b & 128); return v >>> 0; };
    const players = new Array(P);
    for (let i = 0; i < P; i++) {
        const n = rv();
        const dates = new Uint16Array(n);
        const cum = new Uint16Array(n);
        let gd = 0, run = 0;
        for (let k = 0; k < n; k++) { gd += rv(); run += rv(); dates[k] = gd; cum[k] = run; }
        players[i] = { name: names[i], dates, cum };
    }
    return { stat, version, numDates, seasons, doy, players };
}

// cumulative value of a player's stat as of global date `d` (last event with date<=d).
function asOf(p, d) {
    const a = p.dates; let lo = 0, hi = a.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] <= d) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans < 0 ? 0 : p.cum[ans];
}

// ── load both streams, merge into a union player set ────────────────────────────
let MODEL = null;   // { numDates, players:[{name,hrD,hrC,sbD,sbC}], yearOf:Int16Array, doy, xMax, yMax }

async function load() {
    const [hr, sb] = await Promise.all([fetchDecode("data/pbp/hr.evt.gz"), fetchDecode("data/pbp/sb.evt.gz")]);
    $("size").textContent = `${(hr.transferred / 1024).toFixed(0)}+${(sb.transferred / 1024).toFixed(0)} KB`;
    const H = decodeStev(hr.buf), S = decodeStev(sb.buf);
    const numDates = H.numDates;

    // union of players across both stats
    const byName = new Map();
    const grab = (m, key) => (p) => { let e = byName.get(p.name); if (!e) { e = { name: p.name }; byName.set(p.name, e); } e[key] = p; };
    H.players.forEach(grab(H, "hr"));
    S.players.forEach(grab(S, "sb"));
    const players = [...byName.values()].map((e) => ({
        name: e.name,
        hr: e.hr || { dates: new Uint16Array(0), cum: new Uint16Array(0) },
        sb: e.sb || { dates: new Uint16Array(0), cum: new Uint16Array(0) },
    }));

    // global date → calendar year + the all-time axis maxima (lock the frame)
    const yearOf = new Int16Array(numDates);
    let g = 0;
    for (const s of H.seasons) { for (let i = 0; i < s.nDates && g < numDates; i++) yearOf[g++] = s.year; }
    let xMax = 0, yMax = 0;
    for (const p of players) { if (p.hr.cum.length) xMax = Math.max(xMax, p.hr.cum[p.hr.cum.length - 1]); if (p.sb.cum.length) yMax = Math.max(yMax, p.sb.cum[p.sb.cum.length - 1]); }

    MODEL = { numDates, players, yearOf, doy: H.doy, xMax, yMax };
    return players.length;
}

// ── rendering ──────────────────────────────────────────────────────────────────
const canvas = $("chart"); const ctx = canvas.getContext("2d");
const M = { l: 52, r: 18, t: 16, b: 36 };
let W = 0, Hh = 0, dpr = 1;

function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; Hh = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(Hh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (MODEL) draw(currentDate);
}
window.addEventListener("resize", resize);

function frontier(pts) {
    // upper-right Pareto envelope of (hr, sb): sort by hr asc, sweep from the right
    // keeping the running max sb.
    const a = pts.slice().sort((p, q) => p.x - q.x || p.y - q.y);
    const fr = []; let best = -1;
    for (let i = a.length - 1; i >= 0; i--) if (a[i].y > best) { best = a[i].y; fr.push(a[i]); }
    fr.reverse();
    return fr;
}

let currentDate = 0;
function draw(d) {
    currentDate = d;
    const { players, xMax, yMax } = MODEL;
    const plotW = W - M.l - M.r, plotH = Hh - M.t - M.b;
    const x0 = 0, x1 = xMax * 1.02 || 1, y0 = 0, y1 = yMax * 1.02 || 1;
    const sx = (v) => M.l + (v - x0) / (x1 - x0) * plotW;
    const sy = (v) => M.t + plotH - (v - y0) / (y1 - y0) * plotH;

    ctx.clearRect(0, 0, W, Hh);
    // grid + axes
    ctx.strokeStyle = "#272d42"; ctx.fillStyle = "#8b95ad"; ctx.lineWidth = 1;
    ctx.font = "11px system-ui"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    const yticks = 6, xticks = 8;
    for (let i = 0; i <= yticks; i++) { const v = y1 * i / yticks, yy = sy(v); ctx.globalAlpha = .5; ctx.beginPath(); ctx.moveTo(M.l, yy); ctx.lineTo(W - M.r, yy); ctx.stroke(); ctx.globalAlpha = 1; ctx.fillText(Math.round(v), M.l - 6, yy); }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let i = 0; i <= xticks; i++) { const v = x1 * i / xticks; ctx.fillText(Math.round(v), sx(v), Hh - M.b + 6); }
    ctx.fillStyle = "#aab2c5"; ctx.font = "12px system-ui";
    ctx.fillText("Home Runs (career, as of date)", M.l + plotW / 2, Hh - 16);
    ctx.save(); ctx.translate(14, M.t + plotH / 2); ctx.rotate(-Math.PI / 2); ctx.fillText("Stolen Bases (career)", 0, 0); ctx.restore();

    // points (cloud) + collect for frontier
    const pts = [];
    for (const p of players) {
        const hr = asOf(p.hr, d), sb = asOf(p.sb, d);
        if (hr === 0 && sb === 0) continue;
        pts.push({ x: hr, y: sb, name: p.name });
    }
    ctx.fillStyle = "rgba(120,150,210,0.35)";
    for (const pt of pts) { ctx.beginPath(); ctx.arc(sx(pt.x), sy(pt.y), 2.2, 0, 6.2832); ctx.fill(); }

    // frontier staircase + dots + labels
    const fr = frontier(pts);
    if (fr.length) {
        ctx.strokeStyle = "#e23b3b"; ctx.lineWidth = 2; ctx.beginPath();
        ctx.moveTo(sx(fr[0].x), sy(y0));
        for (let i = 0; i < fr.length; i++) {
            ctx.lineTo(sx(fr[i].x), sy(fr[i].y));
            if (i < fr.length - 1) ctx.lineTo(sx(fr[i + 1].x), sy(fr[i].y));
        }
        ctx.lineTo(sx(x1), sy(fr[fr.length - 1].y)); ctx.stroke();
        ctx.fillStyle = "#e23b3b";
        for (const pt of fr) { ctx.beginPath(); ctx.arc(sx(pt.x), sy(pt.y), 4, 0, 6.2832); ctx.fill(); }
        // label the most extreme few so it stays readable
        ctx.fillStyle = "#e7ecf5"; ctx.font = "11px system-ui"; ctx.textBaseline = "middle";
        const labeled = fr.slice().sort((a, b) => (b.x + b.y) - (a.x + a.y)).slice(0, 8);
        for (const pt of labeled) {
            const last = pt.name.replace(/\s*\(b\.\d+\)/, "").split(" ").slice(-1)[0];
            const px = sx(pt.x), nearRight = px > W - M.r - 70;
            ctx.textAlign = nearRight ? "right" : "left";
            ctx.fillText(last, px + (nearRight ? -7 : 7), sy(pt.y));
        }
    }
}

// ── playback ───────────────────────────────────────────────────────────────────
let playing = false, raf = null;
const scrubber = $("scrubber"), playBtn = $("play"), speed = $("speed");

function setDate(d) {
    d = Math.max(0, Math.min(MODEL.numDates - 1, Math.round(d)));
    scrubber.value = String(d);
    draw(d);
    const year = MODEL.yearOf[d];
    const dt = new Date(Date.UTC(year, 0, MODEL.doy[d]));
    $("dateLabel").textContent = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    const fr = frontierCountAt(d);
    $("subLabel").textContent = `${fr} on the frontier`;
}
function frontierCountAt(d) {
    const pts = [];
    for (const p of MODEL.players) { const hr = asOf(p.hr, d), sb = asOf(p.sb, d); if (hr || sb) pts.push({ x: hr, y: sb }); }
    return frontier(pts).length;
}
function tick() {
    if (!playing) return;
    let d = +scrubber.value + (+speed.value);   // game-dates per frame
    if (d >= MODEL.numDates - 1) { d = MODEL.numDates - 1; setDate(d); stop(); return; }
    setDate(d);
    raf = requestAnimationFrame(tick);
}
function play() { if (+scrubber.value >= MODEL.numDates - 1) scrubber.value = "0"; playing = true; playBtn.textContent = "❚❚"; raf = requestAnimationFrame(tick); }
function stop() { playing = false; playBtn.textContent = "▶"; if (raf) cancelAnimationFrame(raf); }
playBtn.addEventListener("click", () => playing ? stop() : play());
scrubber.addEventListener("input", () => { stop(); setDate(+scrubber.value); });

// ── boot ────────────────────────────────────────────────────────────────────────
(async () => {
    try {
        const t0 = performance.now();
        const n = await load();
        scrubber.max = String(MODEL.numDates - 1);
        $("status").remove();
        resize();
        setDate(MODEL.numDates - 1);   // open on the present-day frontier
        console.log(`[evt-demo] ${n} players, ${MODEL.numDates} game-dates, decoded in ${(performance.now() - t0).toFixed(0)} ms`);
        window.__evt = MODEL;          // for headless verification
    } catch (e) {
        $("status").textContent = "Failed to load: " + e.message + " — serve over HTTP (python3 -m http.server).";
        throw e;
    }
})();
