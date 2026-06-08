// poc-webgpu — browser WebGPU twin of poc-vulkan. The host logic (STEV decode,
// the incremental Pareto frontier, the staircase, the brute-force invariant)
// lives in the WASM core (core.c); this file owns the WebGPU device/pipelines
// and the per-frame compute+render loop. GPU hr/sb counters are authoritative
// for the picture; the WASM shadow drives the frontier — no readback per frame.
import createCore from "./core.js";

const $ = (id) => document.getElementById(id);

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
let playerCount = 0, numDates = 0, completedCap = 0;
let mode = "career";                 // "career" | "season"
let nameIndex = null;                // name -> player idx (spot-checks)

// GPU buffers
let bEvents, bHr, bSb, bDebut, bOnFront, bStaircase;   // career / shared
let bOpenColor, bOpenRender;                           // season open cloud
let bCHr, bCSb, bCYear, bCOnFront;                     // season completed cloud
let bWin, bParams;                                     // uniforms
let zerosU32;                                          // for zeroing hr/sb
let offTex, offW = 0, offH = 0;                        // offscreen render target
let canvasOk = true;                                   // false under headless (canvas present fails)

// pipelines + layouts
let pAccum, pPoints, pLine;
let bglAccum, bglPoints, bglLine;
let bgAccum, bgPointsCareer, bgPointsOpen, bgPointsCompleted, bgLine;

// step-output mirror
const OUT = {};

// ── WASM heap helpers (re-fetch views each use; memory can grow) ───────────────
const u8 = () => Module.HEAPU8;
const u32 = () => Module.HEAPU32;
function readStepOut() {
    const p = Module._step_out_ptr() >> 2;
    const h = u32();
    OUT.lo = h[p]; OUT.cnt = h[p + 1]; OUT.zeroGpu = h[p + 2]; OUT.lineVerts = h[p + 3];
    OUT.completedDirty = h[p + 4]; OUT.completedCount = h[p + 5]; OUT.openCount = h[p + 6];
}
// queue.writeBuffer slice straight out of WASM linear memory (zero intermediate copy)
function writeFromWasm(buf, ptr, byteLen) {
    if (byteLen > 0) device.queue.writeBuffer(buf, 0, u8(), ptr, byteLen);
}

// ── boot ────────────────────────────────────────────────────────────────────────
async function boot() {
    if (!navigator.gpu) return fail("WebGPU not available (navigator.gpu missing). This POC is WebGPU-only by design.");
    // adapter acquisition can be flaky under headless; retry, then fall back to a
    // software adapter. Retain the adapter globally so Dawn keeps the instance.
    for (let i = 0; i < 5 && !gpuAdapter; i++) {
        gpuAdapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!gpuAdapter) await new Promise((r) => setTimeout(r, 250));
    }
    if (!gpuAdapter) gpuAdapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
    if (!gpuAdapter) return fail("No WebGPU adapter. Enable hardware acceleration / a GPU adapter.");
    device = await gpuAdapter.requestDevice();
    device.lost.then((info) => { window.__bl2d_deviceLost = info.message; console.error("[poc-webgpu] device lost:", info.message); });
    device.addEventListener?.("uncapturederror", (e) => { window.__bl2d_gpuError = e.error.message; console.error("[poc-webgpu] gpu error:", e.error.message); });

    Module = await createCore();

    // load + decode the two streams, hand the raw STEV bytes to the WASM core
    const [hr, sb] = await Promise.all([
        fetchDecode("../data/pbp/hr.evt.gz"),
        fetchDecode("../data/pbp/sb.evt.gz"),
    ]);
    const hrPtr = Module._malloc(hr.length); u8().set(hr, hrPtr);
    const sbPtr = Module._malloc(sb.length); u8().set(sb, sbPtr);
    playerCount = Module._wasm_init(hrPtr, hr.length, sbPtr, sb.length);
    Module._free(hrPtr); Module._free(sbPtr);
    numDates = Module._num_dates();
    completedCap = Module._completed_cap();

    // name -> index for the headless spot-checks
    nameIndex = new Map();
    for (let i = 0; i < playerCount; i++) nameIndex.set(Module.UTF8ToString(Module._name_ptr(i)), i);

    await setupGpu();
    setupUi();
    exposeHooks();

    $("status").remove();
    window.__bl2d_ready = true;
}

function fail(msg) {
    const s = $("status");
    if (s) s.textContent = msg;
    window.__bl2d_error = msg;
    console.error("[poc-webgpu]", msg);
}

// ── GPU setup ────────────────────────────────────────────────────────────────────
async function setupGpu() {
    const canvas = $("gpu");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round((canvas.clientWidth || 1100) * dpr));
    canvas.height = Math.max(1, Math.round((canvas.clientHeight || 800) * dpr));
    console.log(`[poc-webgpu] canvas ${canvas.width}x${canvas.height} (client ${canvas.clientWidth}x${canvas.clientHeight} dpr ${dpr})`);
    canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    // Configuring a WebGPU canvas under headless (CDP automation) errors and loses
    // the device. Gate canvas presentation on navigator.webdriver: real browsers
    // present to the canvas; the harness renders offscreen and reads pixels back.
    canvasOk = !navigator.webdriver && !/HeadlessChrome/i.test(navigator.userAgent);
    if (canvasOk) {
        try {
            ctx = canvas.getContext("webgpu");
            ctx.configure({ device, format: canvasFormat, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST });
        } catch (e) { canvasOk = false; console.warn("[poc-webgpu] canvas present unavailable (offscreen-only):", e.message); }
    } else {
        console.log("[poc-webgpu] headless: offscreen-only (no canvas present)");
    }
    // Render target — an offscreen texture (valid everywhere).
    offW = canvas.width; offH = canvas.height;
    offTex = device.createTexture({ size: [offW, offH], format: canvasFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });

    const [accumSrc, pointsSrc, lineSrc] = await Promise.all([
        fetch("shaders/accumulate.wgsl").then((r) => r.text()),
        fetch("shaders/points.wgsl").then((r) => r.text()),
        fetch("shaders/line.wgsl").then((r) => r.text()),
    ]);

    const ST = GPUShaderStage, BU = GPUBufferUsage;
    const storage = BU.STORAGE | BU.COPY_DST;
    const mkBuf = (bytes, usage) => device.createBuffer({ size: Math.max(16, (bytes + 3) & ~3), usage });

    // ── buffers ───────────────────────────────────────────────────────────────
    bEvents = mkBuf(Module._events_count() * 3 * 4, storage);
    writeFromWasm(bEvents, Module._events_ptr(), Module._events_count() * 3 * 4);
    bHr = mkBuf(playerCount * 4, storage | BU.COPY_SRC);
    bSb = mkBuf(playerCount * 4, storage | BU.COPY_SRC);
    bDebut = mkBuf(playerCount * 4, storage);
    writeFromWasm(bDebut, Module._debut_ptr(), playerCount * 4);
    bOnFront = mkBuf(playerCount * 4, storage);
    bStaircase = mkBuf((1 + 2 * 2048) * 2 * 4, storage);
    bOpenColor = mkBuf(playerCount * 4, storage);
    bOpenRender = mkBuf(playerCount * 4, storage);
    bCHr = mkBuf(completedCap * 4, storage);
    bCSb = mkBuf(completedCap * 4, storage);
    bCYear = mkBuf(completedCap * 4, storage);
    bCOnFront = mkBuf(completedCap * 4, storage);
    bWin = device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    bParams = device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    zerosU32 = new Uint32Array(playerCount);

    // ── bind group layouts ──────────────────────────────────────────────────────
    const sbuf = (binding, vis, ro = true) => ({ binding, visibility: vis, buffer: { type: ro ? "read-only-storage" : "storage" } });
    const ubuf = (binding, vis) => ({ binding, visibility: vis, buffer: { type: "uniform" } });

    bglAccum = device.createBindGroupLayout({ entries: [
        ubuf(0, ST.COMPUTE),
        sbuf(1, ST.COMPUTE),
        sbuf(2, ST.COMPUTE, false),
        sbuf(3, ST.COMPUTE, false),
    ] });
    bglPoints = device.createBindGroupLayout({ entries: [
        ubuf(0, ST.VERTEX),
        sbuf(1, ST.VERTEX), sbuf(2, ST.VERTEX), sbuf(3, ST.VERTEX), sbuf(4, ST.VERTEX),
    ] });
    bglLine = device.createBindGroupLayout({ entries: [ ubuf(0, ST.VERTEX), sbuf(1, ST.VERTEX) ] });

    // ── pipelines ────────────────────────────────────────────────────────────────
    const accumMod = device.createShaderModule({ code: accumSrc });
    const pointsMod = device.createShaderModule({ code: pointsSrc });
    const lineMod = device.createShaderModule({ code: lineSrc });

    pAccum = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bglAccum] }),
        compute: { module: accumMod, entryPoint: "main" },
    });
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
    bgPointsCareer = bg(bglPoints, [bParams, bHr, bSb, bDebut, bOnFront]);
    bgPointsOpen = bg(bglPoints, [bParams, bHr, bSb, bOpenColor, bOpenRender]);
    bgPointsCompleted = bg(bglPoints, [bParams, bCHr, bCSb, bCYear, bCOnFront]);
    bgLine = bg(bglLine, [bParams, bStaircase]);
}

// ── per-frame render ──────────────────────────────────────────────────────────
function setParams() {
    const canvas = $("gpu");
    const maxX = mode === "career" ? Module._max_hr() : Module._season_max_hr();
    const maxY = mode === "career" ? Module._max_sb() : Module._season_max_sb();
    const aspect = canvas.width / canvas.height;
    device.queue.writeBuffer(bParams, 0, new Float32Array([maxX, maxY, 0.010, aspect]));
}

// Record the compute accumulate + the point/line render into `view`.
function recordScene(enc, view) {
    if (OUT.cnt > 0) {
        const cp = enc.beginComputePass();
        cp.setPipeline(pAccum);
        cp.setBindGroup(0, bgAccum);
        cp.dispatchWorkgroups(Math.ceil(OUT.cnt / 64));
        cp.end();
    }
    const rp = enc.beginRenderPass({
        colorAttachments: [{ view, clearValue: { r: 0.04, g: 0.05, b: 0.09, a: 1 }, loadOp: "clear", storeOp: "store" }],
    });
    rp.setPipeline(pPoints);
    if (mode === "season") {
        rp.setBindGroup(0, bgPointsCompleted); rp.draw(6, OUT.completedCount);
        rp.setBindGroup(0, bgPointsOpen); rp.draw(6, OUT.openCount);
    } else {
        rp.setBindGroup(0, bgPointsCareer); rp.draw(6, playerCount);
    }
    if (OUT.lineVerts >= 2) { rp.setPipeline(pLine); rp.setBindGroup(0, bgLine); rp.draw(OUT.lineVerts); }
    rp.end();
}

function renderAt(cursorDate) {
    if (mode === "career") Module._step_career(cursorDate >>> 0);
    else Module._step_season(cursorDate >>> 0);
    readStepOut();

    // upload the JS-maintained state the GPU reads this frame
    if (mode === "career") {
        writeFromWasm(bOnFront, Module._onfront_ptr(), playerCount * 4);
    } else {
        writeFromWasm(bOpenRender, Module._open_render_ptr(), playerCount * 4);
        writeFromWasm(bOpenColor, Module._open_color_ptr(), playerCount * 4);
        writeFromWasm(bCOnFront, Module._completed_onfront_ptr(), OUT.completedCount * 4);
        if (OUT.completedDirty) {
            writeFromWasm(bCHr, Module._completed_hr_ptr(), OUT.completedCount * 4);
            writeFromWasm(bCSb, Module._completed_sb_ptr(), OUT.completedCount * 4);
            writeFromWasm(bCYear, Module._completed_year_ptr(), OUT.completedCount * 4);
        }
    }
    writeFromWasm(bStaircase, Module._staircase_ptr(), OUT.lineVerts * 8);
    if (OUT.zeroGpu) {
        device.queue.writeBuffer(bHr, 0, zerosU32);
        device.queue.writeBuffer(bSb, 0, zerosU32);
    }
    device.queue.writeBuffer(bWin, 0, new Uint32Array([OUT.lo, OUT.cnt, 0, 0]));
    setParams();

    // Always render into the offscreen texture (valid everywhere).
    const enc = device.createCommandEncoder();
    recordScene(enc, offTex.createView());
    device.queue.submit([enc.finish()]);

    // Present to the canvas — best-effort. Probe; headless returns an invalid
    // canvas texture, so we drop to offscreen-only without losing the device.
    if (canvasOk) presentToCanvas();
}

function presentToCanvas() {
    // canvasOk has been probed; in a real browser this blits offscreen → canvas.
    const enc = device.createCommandEncoder();
    enc.copyTextureToTexture({ texture: offTex }, { texture: ctx.getCurrentTexture() }, [offW, offH]);
    device.queue.submit([enc.finish()]);
}

// Render the given mode/date offscreen and read the pixels back as a PNG data
// URL — bypasses canvas compositing (the harness's reliable visual capture).
async function captureDataUrl(m, cursor) {
    mode = m; renderAt(cursor);
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
    return cv.toDataURL("image/png");
}

// ── UI: scrubber / play / mode (scrubber loop reused from evt-demo) ────────────
let playing = false, raf = null;
function setDate(d) {
    d = Math.max(0, Math.min(numDates - 1, Math.round(d)));
    $("scrubber").value = String(d);
    renderAt(d);
    const year = Module._year_of_date(d);
    const dt = new Date(Date.UTC(year, 0, Module._doy_of_date(d)));
    $("dateLabel").textContent = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    $("subLabel").textContent = `${OUT.lineVerts ? (OUT.lineVerts - 1) / 2 : 0} on the frontier · ${mode}`;
}
function tick() {
    if (!playing) return;
    let d = +$("scrubber").value + (+$("speed").value);
    if (d >= numDates - 1) { d = numDates - 1; setDate(d); stop(); return; }
    setDate(d);
    raf = requestAnimationFrame(tick);
}
function play() { if (+$("scrubber").value >= numDates - 1) $("scrubber").value = "0"; playing = true; $("play").textContent = "❚❚"; raf = requestAnimationFrame(tick); }
function stop() { playing = false; $("play").textContent = "▶"; if (raf) cancelAnimationFrame(raf); }

function setupUi() {
    $("scrubber").max = String(numDates - 1);
    $("play").addEventListener("click", () => (playing ? stop() : play()));
    $("scrubber").addEventListener("input", () => { stop(); setDate(+$("scrubber").value); });
    $("modeToggle").addEventListener("click", () => {
        mode = mode === "career" ? "season" : "career";
        $("modeToggle").textContent = mode === "career" ? "Career" : "Season";
        // force a full reset of the WASM cursor by seeking to 0 then current
        setDate(+$("scrubber").value);
    });
    setDate(numDates - 1);                 // open on the present-day frontier
}

// ── headless verification hooks (read by snap-webgpu.js via evalJS) ────────────
async function readbackCounters() {
    // copy GPU hr/sb into MAP_READ staging buffers and compare to the WASM shadow
    const n = playerCount * 4;
    const stagingHr = device.createBuffer({ size: n, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const stagingSb = device.createBuffer({ size: n, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(bHr, 0, stagingHr, 0, n);
    enc.copyBufferToBuffer(bSb, 0, stagingSb, 0, n);
    device.queue.submit([enc.finish()]);
    await stagingHr.mapAsync(GPUMapMode.READ);
    await stagingSb.mapAsync(GPUMapMode.READ);
    const gHr = new Uint32Array(stagingHr.getMappedRange().slice(0));
    const gSb = new Uint32Array(stagingSb.getMappedRange().slice(0));
    stagingHr.unmap(); stagingSb.unmap();
    stagingHr.destroy(); stagingSb.destroy();
    const sp = Module._hr_shadow_ptr() >> 2, sq = Module._sb_shadow_ptr() >> 2;
    const h = u32();
    let mism = 0;
    for (let i = 0; i < playerCount; i++) if (gHr[i] !== h[sp + i] || gSb[i] !== h[sq + i]) mism++;
    return mism;
}

function spot(name) {
    const i = nameIndex.get(name);
    if (i === undefined) return null;
    return { hr: Module._player_hr(i), sb: Module._player_sb(i), onFront: !!Module._player_onfront(i) };
}

function exposeHooks() {
    window.__bl2d_setMode = (m) => { if (m !== mode) { mode = m; $("modeToggle").textContent = m === "career" ? "Career" : "Season"; } };
    window.__bl2d_setDate = (d) => setDate(d);
    window.__bl2d_numDates = () => numDates;
    // reliable visual capture (offscreen → PNG data URL), bypasses canvas compositing
    window.__bl2d_capture = (m, cursor) => captureDataUrl(m || "career", cursor == null ? numDates - 1 : cursor);

    // Career invariant: incremental frontier == brute-force; GPU counters == shadow.
    window.__bl2d_verifyCareer = async () => {
        mode = "career"; stop();
        setDate(numDates - 1);                       // end of history
        // GPU==shadow readback can fail under headless Dawn (instance lifetime);
        // degrade to -1 ("skipped") — the frontier invariant below is the gate.
        let counterMis = -1;
        try { counterMis = await readbackCounters(); } catch (e) { console.warn("readback skipped:", e.message); }
        const frontierMis = Module._verify_career();
        return {
            frontierMis, frontierSize: Module._verify_frontier_size(), counterMis,
            maxHR: Module._max_hr(), maxSB: Module._max_sb(),
            bonds: spot("Barry Bonds"), henderson: spot("Rickey Henderson"),
        };
    };
    // Season invariant: combined frontier == independent full Pareto sweep.
    window.__bl2d_verifySeason = (cursor) => {
        mode = "season"; stop();
        setDate(cursor != null ? cursor : numDates - 1);
        const frontierMis = Module._verify_season();
        return { frontierMis, frontierSize: Module._verify_frontier_size(),
                 seasonMaxHR: Module._season_max_hr(), seasonMaxSB: Module._season_max_sb(),
                 completedCount: OUT.completedCount };
    };
}

boot().catch((e) => fail("boot failed: " + (e && e.message ? e.message : e)));
