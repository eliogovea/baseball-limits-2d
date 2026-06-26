// poc-webgpu-spring — the browser WebGPU twin of poc-vulkan-spring (and the spring
// evolution of poc-webgpu). It is CAREER-ONLY by design (season mode is out of scope
// for this POC — see ../docs/rendering.md (orig: gpu-spring-skyline-design.md, git history)).
//
// What moved onto the GPU vs the baseline poc-webgpu:
//   • spring.wgsl   — per-player critically-damped motion: pos[] glides toward (hr,sb).
//   • skyline.wgsl  — per-frame brute-force Pareto frontier over pos[] → onFront[].
//   • staircase.wgsl— the frontier step-line built ENTIRELY on the GPU (compact → rank-sort
//                     → emit → drawIndirect), because WebGPU GPU→CPU readback is async and the
//                     documented headless device-loss trigger; we keep ALL per-frame readback
//                     off the render loop.
// The WASM core (core.c) is UNCHANGED: it still decodes the streams and computes the per-frame
// event slice, and its CPU incremental frontier + verify_career() serve only as the headless
// verification ORACLE (never uploaded to the GPU anymore).
import createCore from "./core.js";

const $ = (id) => document.getElementById(id);

const SPRING_OMEGA = 12.0;   // spring stiffness (1/sec): ~0.3s settle
const MAX_FRONT = 2048;      // must match staircase.wgsl's MAX_FRONT

// ── STEV gunzip (reused verbatim from evt-demo.js) ─────────────────────────────
async function fetchDecode(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${url} → ${resp.status}`);
    const ds = resp.body.pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(ds).arrayBuffer());
}

// ── module state ───────────────────────────────────────────────────────────────
let Module = null;
let gpuAdapter = null;               // retained: headless Dawn GC's the instance otherwise
let device = null, ctx = null, canvasFormat = null;
let playerCount = 0, numDates = 0;
let nameIndex = null;                // name -> player idx (spot-checks)
let lastT = 0;                       // wall-clock of the previous frame (for the spring dt)

// GPU buffers
let bEvents, bHr, bSb, bDebut, bOnFront;          // event history + counters + frontier flags
let bPos, bVel;                                   // spring state (NEW)
let bFrontIdx, bFrontSorted, bCount, bStaircase, bIndirect;  // GPU staircase scratch + output (NEW)
let bWin, bParams, bSpring;                       // uniforms ({lo,count} / {maxX,maxY,..} / {dt,omega,n})
let zerosU32, zerosVec2;                          // for zeroing counters / spring state on wrap
let offTex, offW = 0, offH = 0;                   // offscreen render target
let canvasOk = true;                              // false under headless (canvas present fails)
let labelCtx = null;                              // 2D overlay context for frontier name labels

// pipelines + layouts + bind groups
let pAccum, pSpring, pSkyline, pCompact, pRanksort, pEmit, pPoints, pLine;
let bglAccum, bglSpring, bglSkyline, bglStair, bglPoints, bglLine;
let bgAccum, bgSpring, bgSkyline, bgStair, bgPoints, bgLine;

const OUT = {};                      // step-output mirror

// ── WASM heap helpers (re-fetch views each use; memory can grow) ───────────────
const u8 = () => Module.HEAPU8;
const u32 = () => Module.HEAPU32;
function readStepOut() {
    const p = Module._step_out_ptr() >> 2;
    const h = u32();
    OUT.lo = h[p]; OUT.cnt = h[p + 1]; OUT.zeroGpu = h[p + 2]; OUT.lineVerts = h[p + 3];
}
function writeFromWasm(buf, ptr, byteLen) {
    if (byteLen > 0) device.queue.writeBuffer(buf, 0, u8(), ptr, byteLen);
}
// Pack the spring uniform {dt: f32, omega: f32, n: u32, _pad: u32} (16 bytes, mixed types).
function writeSpring(dt) {
    const ab = new ArrayBuffer(16);
    new Float32Array(ab, 0, 2).set([dt, SPRING_OMEGA]);
    new Uint32Array(ab, 8, 2).set([playerCount, 0]);
    device.queue.writeBuffer(bSpring, 0, ab);
}
// Reset the GPU-staircase scratch each frame: K counter → 0, indirect draw → 0 vertices
// (so when there's no frontier yet the indirect draw renders nothing; emit overwrites when K≥1).
function resetStaircaseScratch() {
    device.queue.writeBuffer(bCount, 0, new Uint32Array([0]));
    device.queue.writeBuffer(bIndirect, 0, new Uint32Array([0, 1, 0, 0]));
}

// ── boot ────────────────────────────────────────────────────────────────────────
async function boot() {
    if (!navigator.gpu) return fail("WebGPU not available (navigator.gpu missing). This POC is WebGPU-only by design.");
    for (let i = 0; i < 5 && !gpuAdapter; i++) {
        gpuAdapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!gpuAdapter) await new Promise((r) => setTimeout(r, 250));
    }
    if (!gpuAdapter) gpuAdapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
    if (!gpuAdapter) return fail("No WebGPU adapter. Enable hardware acceleration / a GPU adapter.");
    device = await gpuAdapter.requestDevice();
    device.lost.then((info) => { window.__bl2d_deviceLost = info.message; console.error("[poc-webgpu-spring] device lost:", info.message); });
    device.addEventListener?.("uncapturederror", (e) => { window.__bl2d_gpuError = e.error.message; console.error("[poc-webgpu-spring] gpu error:", e.error.message); });

    Module = await createCore();

    const [hr, sb] = await Promise.all([
        fetchDecode("../data/pbp/hr.evt.gz"),
        fetchDecode("../data/pbp/sb.evt.gz"),
    ]);
    const hrPtr = Module._malloc(hr.length); u8().set(hr, hrPtr);
    const sbPtr = Module._malloc(sb.length); u8().set(sb, sbPtr);
    playerCount = Module._wasm_init(hrPtr, hr.length, sbPtr, sb.length);
    Module._free(hrPtr); Module._free(sbPtr);
    numDates = Module._num_dates();

    nameIndex = new Map();
    for (let i = 0; i < playerCount; i++) nameIndex.set(Module.UTF8ToString(Module._name_ptr(i)), i);

    await setupGpu();
    setupUi();
    exposeHooks();
    lastT = performance.now();

    $("status").remove();
    window.__bl2d_ready = true;
}

function fail(msg) {
    const s = $("status");
    if (s) s.textContent = msg;
    window.__bl2d_error = msg;
    console.error("[poc-webgpu-spring]", msg);
}

// ── GPU setup ────────────────────────────────────────────────────────────────────
async function setupGpu() {
    const canvas = $("gpu");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round((canvas.clientWidth || 1100) * dpr));
    canvas.height = Math.max(1, Math.round((canvas.clientHeight || 800) * dpr));
    canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    // Configuring a WebGPU canvas under headless (CDP automation) errors and loses the device.
    // Gate canvas presentation on the headless UA: real browsers present; the harness renders
    // offscreen and reads pixels back.
    canvasOk = !navigator.webdriver && !/HeadlessChrome/i.test(navigator.userAgent);
    if (canvasOk) {
        try {
            ctx = canvas.getContext("webgpu");
            ctx.configure({ device, format: canvasFormat, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST });
        } catch (e) { canvasOk = false; console.warn("[poc-webgpu-spring] canvas present unavailable (offscreen-only):", e.message); }
    } else {
        console.log("[poc-webgpu-spring] headless: offscreen-only (no canvas present)");
    }
    offW = canvas.width; offH = canvas.height;
    offTex = device.createTexture({ size: [offW, offH], format: canvasFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });

    // Frontier name labels are drawn with the 2D Canvas API on a transparent overlay sized to the
    // same backing resolution as #gpu (so the two align when CSS-stretched). WebGPU/WGSL has no
    // text, and a glyph-atlas pass would dwarf this POC — a DOM/2D-canvas overlay is the idiomatic
    // web answer, and the same routine re-labels the offscreen PNG capture.
    const labels = $("labels");
    labels.width = offW; labels.height = offH;
    labelCtx = labels.getContext("2d");

    const [accumSrc, springSrc, skylineSrc, stairSrc, pointsSrc, lineSrc] = await Promise.all([
        fetch("shaders/accumulate.wgsl").then((r) => r.text()),
        fetch("shaders/spring.wgsl").then((r) => r.text()),
        fetch("shaders/skyline.wgsl").then((r) => r.text()),
        fetch("shaders/staircase.wgsl").then((r) => r.text()),
        fetch("shaders/points.wgsl").then((r) => r.text()),
        fetch("shaders/line.wgsl").then((r) => r.text()),
    ]);

    const ST = GPUShaderStage, BU = GPUBufferUsage;
    const storage = BU.STORAGE | BU.COPY_DST;
    const mkBuf = (bytes, usage) => device.createBuffer({ size: Math.max(16, (bytes + 3) & ~3), usage });

    // ── buffers ───────────────────────────────────────────────────────────────
    bEvents = mkBuf(Module._events_count() * 3 * 4, storage);
    writeFromWasm(bEvents, Module._events_ptr(), Module._events_count() * 3 * 4);
    bHr = mkBuf(playerCount * 4, storage | BU.COPY_SRC);          // COPY_SRC → counter readback (verify)
    bSb = mkBuf(playerCount * 4, storage | BU.COPY_SRC);
    bDebut = mkBuf(playerCount * 4, storage);
    writeFromWasm(bDebut, Module._debut_ptr(), playerCount * 4);
    bOnFront = mkBuf(playerCount * 4, storage | BU.COPY_SRC);     // skyline writes; COPY_SRC for verify
    bPos = mkBuf(playerCount * 8, storage | BU.COPY_SRC);         // vec2; COPY_SRC for spring-convergence verify
    bVel = mkBuf(playerCount * 8, storage);
    bFrontIdx = mkBuf(MAX_FRONT * 4, storage);
    bFrontSorted = mkBuf(MAX_FRONT * 8, storage);
    bCount = mkBuf(4, storage);                                   // atomic K counter (reset each frame)
    bStaircase = mkBuf((1 + 2 * MAX_FRONT) * 2 * 4, storage);     // line-strip vertices
    bIndirect = device.createBuffer({ size: 16, usage: BU.INDIRECT | BU.STORAGE | BU.COPY_DST });
    bWin = device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    bParams = device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    bSpring = device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    zerosU32 = new Uint32Array(playerCount);
    zerosVec2 = new Float32Array(playerCount * 2);

    // ── bind-group layouts ───────────────────────────────────────────────────────
    // A layout is the contract; a bind group (below) is the actual buffer→slot binding. Storage
    // type read-only vs writable MUST match each shader's access (e.g. skyline WRITES onFront, so
    // it's a writable storage entry there, but points only READS it). The staircase layout is the
    // UNION of all three staircase entry points' bindings — a superset layout is legal, each entry
    // uses a subset.
    const sbuf = (binding, vis, ro = true) => ({ binding, visibility: vis, buffer: { type: ro ? "read-only-storage" : "storage" } });
    const ubuf = (binding, vis) => ({ binding, visibility: vis, buffer: { type: "uniform" } });

    bglAccum = device.createBindGroupLayout({ entries: [
        ubuf(0, ST.COMPUTE), sbuf(1, ST.COMPUTE), sbuf(2, ST.COMPUTE, false), sbuf(3, ST.COMPUTE, false),
    ] });
    bglSpring = device.createBindGroupLayout({ entries: [
        ubuf(0, ST.COMPUTE), sbuf(1, ST.COMPUTE), sbuf(2, ST.COMPUTE),       // Spring, hr(ro), sb(ro)
        sbuf(3, ST.COMPUTE, false), sbuf(4, ST.COMPUTE, false),             // pos(rw), vel(rw)
    ] });
    bglSkyline = device.createBindGroupLayout({ entries: [
        ubuf(0, ST.COMPUTE), sbuf(1, ST.COMPUTE, false), sbuf(2, ST.COMPUTE),  // Spring, onFront(rw), pos(ro)
    ] });
    bglStair = device.createBindGroupLayout({ entries: [
        ubuf(0, ST.COMPUTE),                       // Spring (n)
        sbuf(1, ST.COMPUTE), sbuf(2, ST.COMPUTE),  // onFront(ro), pos(ro)
        sbuf(3, ST.COMPUTE, false), sbuf(4, ST.COMPUTE, false), sbuf(5, ST.COMPUTE, false),  // frontIdx, frontSorted, count
        sbuf(6, ST.COMPUTE, false), sbuf(7, ST.COMPUTE, false),  // staircase, indirect
    ] });
    bglPoints = device.createBindGroupLayout({ entries: [
        ubuf(0, ST.VERTEX), sbuf(1, ST.VERTEX), sbuf(2, ST.VERTEX), sbuf(3, ST.VERTEX),  // Params, pos, debut, onFront
    ] });
    bglLine = device.createBindGroupLayout({ entries: [ ubuf(0, ST.VERTEX), sbuf(1, ST.VERTEX) ] });

    // ── pipelines ────────────────────────────────────────────────────────────────
    const accumMod = device.createShaderModule({ code: accumSrc });
    const springMod = device.createShaderModule({ code: springSrc });
    const skylineMod = device.createShaderModule({ code: skylineSrc });
    const stairMod = device.createShaderModule({ code: stairSrc });
    const pointsMod = device.createShaderModule({ code: pointsSrc });
    const lineMod = device.createShaderModule({ code: lineSrc });
    const comp = (bgl, mod, entry) => device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        compute: { module: mod, entryPoint: entry },
    });
    pAccum = comp(bglAccum, accumMod, "main");
    pSpring = comp(bglSpring, springMod, "main");
    pSkyline = comp(bglSkyline, skylineMod, "main");
    pCompact = comp(bglStair, stairMod, "compact");     // three pipelines, one module, three entry points
    pRanksort = comp(bglStair, stairMod, "ranksort");
    pEmit = comp(bglStair, stairMod, "emit");
    pPoints = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bglPoints] }),
        vertex: { module: pointsMod, entryPoint: "vs" },
        fragment: { module: pointsMod, entryPoint: "fs", targets: [{ format: canvasFormat }] },
        primitive: { topology: "triangle-list" },
    });
    pLine = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bglLine] }),
        vertex: { module: lineMod, entryPoint: "vs" },
        fragment: { module: lineMod, entryPoint: "fs", targets: [{ format: canvasFormat }] },
        primitive: { topology: "line-strip" },
    });

    // ── bind groups ──────────────────────────────────────────────────────────────
    const bg = (layout, bufs) => device.createBindGroup({ layout, entries: bufs.map((b, i) => ({ binding: i, resource: { buffer: b } })) });
    bgAccum = bg(bglAccum, [bWin, bEvents, bHr, bSb]);
    bgSpring = bg(bglSpring, [bSpring, bHr, bSb, bPos, bVel]);
    bgSkyline = bg(bglSkyline, [bSpring, bOnFront, bPos]);
    bgStair = bg(bglStair, [bSpring, bOnFront, bPos, bFrontIdx, bFrontSorted, bCount, bStaircase, bIndirect]);
    bgPoints = bg(bglPoints, [bParams, bPos, bDebut, bOnFront]);
    bgLine = bg(bglLine, [bParams, bStaircase]);
}

// ── frontier name labels (2D overlay; WGSL has no text) ───────────────────────────
// Display the last name, mirroring the D3 app's lastNameOf: drop the "(b.YYYY)" disambiguation
// suffix, take the final token, and skip a generational suffix (Jr./Sr./II…).
function lastNameOf(name) {
    const s = name.replace(/\s*\(b\.\d+\)\s*$/, "");
    const parts = s.split(" ");
    let last = parts[parts.length - 1];
    if (parts.length > 1 && /^(Jr\.?|Sr\.?|I{2,}|IV|V)$/.test(last)) last = parts[parts.length - 2];
    return last;
}
// Draw the labels onto a 2D context of size W×H, FROM GPU-read-back buffers: `onF` (the skyline's
// per-player flag) and `pos` (the smoothed positions). The CPU no longer knows the frontier — the
// GPU does — so the only CPU input is whatever we read back for this text overlay. Maps the data
// position to pixels (NDC is +Y up → invert for the top-down 2D canvas), nudges the text off the dot
// (to the LEFT near the right edge so it isn't clipped), strokes a dark halo for legibility, and
// returns the number of labels drawn. Does NOT clear — the live overlay clears first; the PNG
// capture draws over the rendered image.
function drawFrontierLabelsFrom(c2d, W, H, onF, pos) {
    const maxX = Math.max(Module._max_hr(), 1), maxY = Math.max(Module._max_sb(), 1);
    c2d.save();
    c2d.font = `${Math.max(11, Math.round(H * 0.022))}px -apple-system, system-ui, sans-serif`;
    c2d.textBaseline = "middle";
    c2d.lineWidth = 3; c2d.strokeStyle = "rgba(8,10,18,0.85)"; c2d.fillStyle = "#eef1f7";
    let n = 0;
    for (let i = 0; i < playerCount; i++) if (onF[i]) {
        const px = ((pos[2*i] / maxX) * 1.9 - 0.95) * 0.5 + 0.5;        // → [0,1] in x
        const pyN = (pos[2*i + 1] / maxY) * 1.9 - 0.95;                 // NDC y (+Y up)
        const X = px * W, Y = (1 - (pyN * 0.5 + 0.5)) * H;             // flip y for the 2D canvas
        const right = X > W * 0.72;
        c2d.textAlign = right ? "right" : "left";
        const text = lastNameOf(Module.UTF8ToString(Module._name_ptr(i)));
        c2d.strokeText(text, right ? X - 8 : X + 8, Y);
        c2d.fillText(text, right ? X - 8 : X + 8, Y);
        n++;
    }
    c2d.restore();
    return n;
}

// Live label refresh: read the GPU onFront + pos back and redraw the overlay. REAL BROWSERS ONLY
// (gated by canvasOk) — a per-frame GPU→CPU readback under headless is the documented device-loss
// trigger, and headless has no visible overlay anyway. Single-flight (skip if one is in flight) so
// fast playback can't queue them up; the labels lag the cloud by a frame or two, which is invisible.
let labelBusy = false;
async function updateLiveLabels() {
    if (labelBusy) return;
    labelBusy = true;
    try {
        const onF = await readbackU32(bOnFront, playerCount);
        const pos = await readbackF32(bPos, playerCount * 2);
        labelCtx.clearRect(0, 0, offW, offH);
        const n = drawFrontierLabelsFrom(labelCtx, offW, offH, onF, pos);
        $("subLabel").textContent = `${n} on the frontier · career`;
    } catch (e) { /* a transient readback failure just skips one overlay refresh */ }
    finally { labelBusy = false; }
}

// ── per-frame work ──────────────────────────────────────────────────────────────
function setParams() {
    const canvas = $("gpu");
    device.queue.writeBuffer(bParams, 0, new Float32Array([Module._max_hr(), Module._max_sb(), 0.010, canvas.width / canvas.height]));
}

// Record the GPU frame graph's COMPUTE half into `enc`. Each pass is its own compute pass, so
// WebGPU serializes them (one pass's writes are visible to the next — the implicit barriers).
//   accumulate (new events) → spring (glide pos) → skyline (frontier) → compact/ranksort/emit
// `doAccum=false` is used by settle() (counters are already final; re-accumulating would double-add).
function recordCompute(enc, doAccum) {
    let cp;
    if (doAccum && OUT.cnt > 0) {
        cp = enc.beginComputePass(); cp.setPipeline(pAccum); cp.setBindGroup(0, bgAccum);
        cp.dispatchWorkgroups(Math.ceil(OUT.cnt / 64)); cp.end();
    }
    cp = enc.beginComputePass(); cp.setPipeline(pSpring); cp.setBindGroup(0, bgSpring);
    cp.dispatchWorkgroups(Math.ceil(playerCount / 64)); cp.end();
    cp = enc.beginComputePass(); cp.setPipeline(pSkyline); cp.setBindGroup(0, bgSkyline);
    cp.dispatchWorkgroups(Math.ceil(playerCount / 64)); cp.end();
    // staircase: compact (per player) → ranksort + emit (per frontier slot, over-dispatch + guard)
    cp = enc.beginComputePass(); cp.setPipeline(pCompact); cp.setBindGroup(0, bgStair);
    cp.dispatchWorkgroups(Math.ceil(playerCount / 64)); cp.end();
    cp = enc.beginComputePass(); cp.setPipeline(pRanksort); cp.setBindGroup(0, bgStair);
    cp.dispatchWorkgroups(Math.ceil(MAX_FRONT / 64)); cp.end();
    cp = enc.beginComputePass(); cp.setPipeline(pEmit); cp.setBindGroup(0, bgStair);
    cp.dispatchWorkgroups(Math.ceil(MAX_FRONT / 64)); cp.end();
}

// Record the render half: the point cloud (vertex-pull from pos[]), then the staircase via an
// INDIRECT draw whose vertex count the emit pass wrote on the GPU (no count plumbed through JS).
function recordRender(enc, view) {
    const rp = enc.beginRenderPass({
        colorAttachments: [{ view, clearValue: { r: 0.04, g: 0.05, b: 0.09, a: 1 }, loadOp: "clear", storeOp: "store" }],
    });
    rp.setPipeline(pPoints); rp.setBindGroup(0, bgPoints); rp.draw(6, playerCount);
    rp.setPipeline(pLine); rp.setBindGroup(0, bgLine); rp.drawIndirect(bIndirect, 0);
    rp.end();
}

function renderAt(cursorDate) {
    Module._step_career(cursorDate >>> 0);
    readStepOut();
    if (OUT.zeroGpu) {   // wrap / scrub-back: zero counters AND spring motion state
        device.queue.writeBuffer(bHr, 0, zerosU32);
        device.queue.writeBuffer(bSb, 0, zerosU32);
        device.queue.writeBuffer(bPos, 0, zerosVec2);
        device.queue.writeBuffer(bVel, 0, zerosVec2);
    }
    device.queue.writeBuffer(bWin, 0, new Uint32Array([OUT.lo, OUT.cnt, 0, 0]));
    const now = performance.now();
    let dt = (now - lastT) / 1000; lastT = now;
    if (!(dt > 0)) dt = 1 / 60; if (dt > 0.05) dt = 0.05;   // clamp hitches; sane first-frame dt
    writeSpring(dt);
    resetStaircaseScratch();
    setParams();

    const enc = device.createCommandEncoder();
    recordCompute(enc, true);
    recordRender(enc, offTex.createView());
    device.queue.submit([enc.finish()]);
    if (canvasOk) {
        presentToCanvas();
        updateLiveLabels();                            // async GPU readback → redraw the overlay (real browsers)
    }
}

// Drive the springs to rest in ONE step (huge dt → decay factor ≈ 0 → pos = target), then rebuild
// the skyline + staircase from the settled pos. Used only by the headless verify/capture hooks so
// they observe the exact end-state (the gliding path is the live-only effect). No render here.
function settle() {
    writeSpring(1e6);
    resetStaircaseScratch();
    const enc = device.createCommandEncoder();
    recordCompute(enc, false);     // spring + skyline + staircase, NO accumulate
    device.queue.submit([enc.finish()]);
}

function presentToCanvas() {
    const enc = device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: offTex }, { texture: ctx.getCurrentTexture() }, [offW, offH]);
    device.queue.submit([enc.finish()]);
}

// ── one-shot GPU→CPU readbacks (verify/capture ONLY — never in the render loop) ────
async function readbackU32(buf, count) {
    const bytes = count * 4;
    const st = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(buf, 0, st, 0, bytes); device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(st.getMappedRange().slice(0)); st.unmap(); st.destroy(); return out;
}
async function readbackF32(buf, count) {
    const bytes = count * 4;
    const st = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(buf, 0, st, 0, bytes); device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(st.getMappedRange().slice(0)); st.unmap(); st.destroy(); return out;
}

// Render the settled end-state offscreen and read the pixels back as a PNG data URL.
async function captureDataUrl(cursor) {
    setDate(cursor);            // applies events, draws the (possibly mid-glide) frame
    settle();                   // drive springs to rest + rebuild frontier/staircase
    const enc0 = device.createCommandEncoder(); recordRender(enc0, offTex.createView()); device.queue.submit([enc0.finish()]);
    // read the settled GPU frontier back ONCE (off the render loop) to label the players
    const lblOnF = await readbackU32(bOnFront, playerCount);
    const lblPos = await readbackF32(bPos, playerCount * 2);

    const bpr = Math.ceil(offW * 4 / 256) * 256;        // 256-byte row alignment
    const staging = device.createBuffer({ size: bpr * offH, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: offTex }, { buffer: staging, bytesPerRow: bpr }, [offW, offH]);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(staging.getMappedRange());
    const cv = document.createElement("canvas"); cv.width = offW; cv.height = offH;
    const c2d = cv.getContext("2d"); const img = c2d.createImageData(offW, offH);
    const bgra = canvasFormat.startsWith("bgra");
    for (let y = 0; y < offH; y++) for (let x = 0; x < offW; x++) {
        const s = y * bpr + x * 4, d = (y * offW + x) * 4;
        if (bgra) { img.data[d] = src[s+2]; img.data[d+1] = src[s+1]; img.data[d+2] = src[s]; }
        else      { img.data[d] = src[s];   img.data[d+1] = src[s+1]; img.data[d+2] = src[s+2]; }
        img.data[d+3] = 255;
    }
    staging.unmap(); staging.destroy();
    c2d.putImageData(img, 0, 0);
    drawFrontierLabelsFrom(c2d, offW, offH, lblOnF, lblPos);   // label the frontier players over the image
    return cv.toDataURL("image/png");
}

// ── UI: scrubber / play ──────────────────────────────────────────────────────────
let playing = false, raf = null;
function setDate(d) {
    d = Math.max(0, Math.min(numDates - 1, Math.round(d)));
    $("scrubber").value = String(d);
    renderAt(d);
    const year = Module._year_of_date(d);
    const dt = new Date(Date.UTC(year, 0, Module._doy_of_date(d)));
    $("dateLabel").textContent = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    // the "N on the frontier" count comes from updateLiveLabels() now (it has the GPU read-back set)
}
function tick() {
    if (!playing) return;
    let d = +$("scrubber").value + (+$("speed").value);
    if (d >= numDates - 1) { d = numDates - 1; setDate(d); stop(); return; }
    setDate(d);
    raf = requestAnimationFrame(tick);
}
function play() { if (+$("scrubber").value >= numDates - 1) $("scrubber").value = "0"; playing = true; $("play").textContent = "❚❚"; lastT = performance.now(); raf = requestAnimationFrame(tick); }
function stop() { playing = false; $("play").textContent = "▶"; if (raf) cancelAnimationFrame(raf); }

function setupUi() {
    $("scrubber").max = String(numDates - 1);
    $("play").addEventListener("click", () => (playing ? stop() : play()));
    $("scrubber").addEventListener("input", () => { stop(); setDate(+$("scrubber").value); });
    setDate(numDates - 1);                 // open on the present-day frontier
}

// ── headless verification hooks (read by snap-webgpu.js via evalJS) ────────────
function spot(name) {
    const i = nameIndex.get(name);
    if (i === undefined) return null;
    return { hr: Module._player_hr(i), sb: Module._player_sb(i), onFront: !!Module._player_onfront(i) };
}

function exposeHooks() {
    window.__bl2d_setDate = (d) => setDate(d);
    window.__bl2d_numDates = () => numDates;
    window.__bl2d_capture = (cursor) => captureDataUrl(cursor == null ? numDates - 1 : cursor);

    // Career invariants — drive to end of history, SETTLE the springs, then read the GPU buffers
    // back ONCE (off the render loop, so the headless device-loss risk doesn't apply) and check:
    //   (i)   counterMis  : GPU hr/sb == WASM shadow (accumulate correct)
    //   (ii)  springMis   : settled |pos - (hr,sb)| ≤ 0.5 (spring converged)
    //   (iii) skylineMis  : GPU onFront == CPU oracle onFront (GPU skyline correct)
    //   (iv)  frontierMis : CPU oracle frontier == brute-force O(n²) (gates iii's oracle)
    window.__bl2d_verifyCareer = async () => {
        stop();
        setDate(numDates - 1);     // apply all events → counters final on the GPU
        settle();                  // pos → target; rebuild skyline + staircase from settled pos
        // Build the CPU oracle FIRST (replays into g_hr/g_sb/g_onFront) — the live path no longer
        // maintains it, so the readback comparisons below have something to compare against.
        const frontierMis = Module._verify_career();
        let counterMis = -1, springMis = -1, skylineMis = -1;
        try {
            const gHr = await readbackU32(bHr, playerCount);
            const gSb = await readbackU32(bSb, playerCount);
            const gPos = await readbackF32(bPos, playerCount * 2);
            const gOnF = await readbackU32(bOnFront, playerCount);
            const h = u32();
            const sp = Module._hr_shadow_ptr() >> 2, sq = Module._sb_shadow_ptr() >> 2, op = Module._onfront_ptr() >> 2;
            counterMis = 0; springMis = 0; skylineMis = 0;
            for (let i = 0; i < playerCount; i++) {
                const shr = h[sp + i], ssb = h[sq + i];
                if (gHr[i] !== shr || gSb[i] !== ssb) counterMis++;
                if (Math.abs(gPos[2*i] - shr) > 0.5 || Math.abs(gPos[2*i + 1] - ssb) > 0.5) springMis++;
                if ((gOnF[i] ? 1 : 0) !== (h[op + i] ? 1 : 0)) skylineMis++;
            }
        } catch (e) { console.warn("readback skipped:", e.message); }
        return {
            frontierMis, frontierSize: Module._verify_frontier_size(),
            counterMis, springMis, skylineMis,
            maxHR: Module._max_hr(), maxSB: Module._max_sb(),
            bonds: spot("Barry Bonds"), henderson: spot("Rickey Henderson"),
        };
    };
}

boot().catch((e) => fail("boot failed: " + (e && e.message ? e.message : e)));
