# Integrating the WASM/WebGPU approach into the main app — design

## Context

Two standalone POCs proved the GPU event-streaming architecture in the browser:

- **`poc-webgpu/`** — C→WASM host core (`core.c`: STEV decode, the incremental
  Pareto frontier, the brute-force invariant) + JS WebGPU glue. A compute shader
  `atomicAdd`s each frame's new event window into per-player `(HR, SB)` GPU
  counters; the vertex shader renders straight from them; the frontier is kept
  incrementally on the host.
- **`poc-webgpu-c/`** — the same `core.c`, but the WebGPU orchestration is in C
  too (emdawnwebgpu). Same invariants pass.

Both validate the architecture in isolation. This doc designs **bringing the two
reusable ideas into the deployed app** — *behind a flag, never as the default*:

1. **A WebGPU rendering backend** for the point cloud, selected by
   `?renderer=webgpu`, with a **mandatory Canvas-2D fallback** (the deployed
   multi-file app and offline `dist/` bundle stay on Canvas 2D).
2. **The incremental Pareto frontier** as the general Phase-2 fix — the still-open
   item from [`pbp-rendering-design.md`](pbp-rendering-design.md) §2 ("the Pareto
   sweep still runs full each frame"). This is **backend-agnostic** and lands
   first.

This continues [`pbp-rendering-design.md`](pbp-rendering-design.md) §2 (the
`PointRenderer` abstraction + the static/dynamic split, both partly built) and
[`poc-webgpu-design.md`](poc-webgpu-design.md) Phase 3 (main-app integration).

### What already exists in the main app (the integration surface)

- **Canvas cloud layers.** `chartCanvasLayers = { bg, fg }` (two `<canvas>` under
  the SVG overlay), `ensureChartCanvasLayers(w,h)`, `drawCanvasPointLayer(canvas,
  points, opts)`, `drawCanvasTrails(...)`. The cloud is drawn on these at
  `drawScatterPlot` (≈script.js:3982 background, :4055 foreground); the
  **static/dynamic split is already in place** (bg = completed-season cloud,
  redrawn on year boundary; fg = open season + trails, redrawn per frame).
- **Frontier in SVG.** The red staircase is an SVG `path.frontier-staircase` via
  `staircaseScreen(fr)` (≈:3746). Frontier math is `sweepFrontier` /
  `buildSmoothActiveFrontier` / `frontierFromSortedRows` (≈:3399–3526) — **run
  full (or completed-cache + per-frame merge) every frame.**
- **The `.evt` streaming model is already wired.** `decodeStev` (:936), fetch of
  `data/pbp/<prefix><stat>.evt.gz` (:965), the resident `pbpEvt` model, and
  `evtPointsAsOf(pbpEvt, cursor)` (:1244) — this is the exact data the POCs use,
  already in the app.
- **Hit-testing** is `d3.quadtree` (:4387), independent of the render backend.
- **`smoothLite`** (:294) already lightens frames during play (skips HV, cards,
  rings, quadtree) and fires a full interactive render when idle.

So the app is already Canvas-rendered with the layer split; this design adds an
**alternative GPU backend** under that same seam, and **upgrades the frontier
math** the streaming mode uses.

## Scope & non-goals

**In scope**
- A `PointRenderer` interface with two backends: `Canvas2DRenderer` (wraps the
  existing `drawCanvasPointLayer`, the default + fallback) and `WebGPURenderer`
  (instanced quads from `poc-webgpu`), chosen by capability + `?renderer=webgpu`.
- An `IncrementalFrontier` JS module (port of `core.c`'s `frontier_apply_event` +
  `build_staircase`) used by the **`.evt` streaming mode** in place of the
  per-frame sweep. Backend-agnostic.

**Non-goals (explicitly out)**
- Changing the default renderer. `navigator.gpu` absent / no flag → Canvas 2D,
  byte-for-byte as today.
- WebGPU in the offline `dist/` bundle. The bundle stays Canvas-2D only — no new
  CDN deps, no WASM blob in the single-file build (it must open from `file://`).
- Loading `core.wasm` into the app now. The frontier is small; a **JS port** is
  the integration path (one source of truth is preserved by *verifying* the port
  against `core.c`'s invariant, not by shipping the wasm). `core.wasm` is reserved
  for a future pitch-by-pitch (10⁶–10⁸ events) phase where JS decode/frontier
  would bottleneck — see §Phasing / deferred.
- Rate axes in the incremental path. The incremental frontier is valid only on
  monotone (counting) axes — exactly the `.evt` streaming case. Non-streaming
  scatter keeps the existing sweep.

## Architecture

### A. `PointRenderer` interface (formalize the existing seam)

Lift `drawCanvasPointLayer` into the small interface from
`pbp-rendering-design.md` §2, consumed by `drawScatterPlot`:

```
interface PointRenderer {
  resize(width, height, dpr)
  // points: typed arrays — xs, ys (screen px), rgba (u32), sizes (px)
  setBackground(points)   // completed-season cloud; uploaded on year boundary
  setForeground(points)   // open-season cloud (+ frontier flags); per frame
  setFrontier(staircaseXY)// optional: GPU-drawn staircase (else SVG keeps it)
  draw()                  // composite bg + fg (+ frontier) to its canvas
  toDataURL()             // for SVG/PNG export (Canvas2D: native; WebGPU: readback)
  destroy()
}
```

Two implementations:

- **`Canvas2DRenderer`** — thin wrapper over today's `chartCanvasLayers` +
  `drawCanvasPointLayer` / `drawCanvasTrails`. No behavior change; this is the
  default and the fallback. The bundle uses only this.
- **`WebGPURenderer`** — the `poc-webgpu` pipeline: instanced point quads
  (vertex-pull `xs/ys/rgba/sizes` from storage buffers, disc-test fragment),
  drawn into a `<canvas webgpu>` occupying the same layout slot as the bg/fg 2D
  canvases. Background (static) and foreground (dynamic) are **separate storage
  buffers**, mirroring the 2D split: bg re-uploaded only on year boundary, fg per
  frame. The frontier staircase can stay SVG (simplest, crisp) or move to the
  GPU `line.wgsl` strip (`setFrontier`) — **default: keep it SVG** (it's ≤~30
  segments and shares the axes/label layer).

`drawScatterPlot` calls the active renderer instead of `drawCanvasPointLayer`
directly. Axes, gridlines, frontier **labels**, legend, tooltip, and the frontier
staircase stay SVG regardless of backend (the `pbp-rendering-design.md` §2 split).

### B. Backend selection + fallback ladder

```
chooseRenderer():
  if !urlFlag("renderer=webgpu")      -> Canvas2DRenderer        // default
  if !navigator.gpu                   -> Canvas2DRenderer + notice
  adapter = await requestAdapter()
  if !adapter                         -> Canvas2DRenderer + notice
  device  = await adapter.requestDevice()
  try { webgpu = new WebGPURenderer(device); await webgpu.init() }
  catch                               -> Canvas2DRenderer + notice
  device.lost.then(()  => swapToCanvas2D())   // runtime fallback on device loss
  return webgpu
```

- **Async, non-blocking.** The first paint is Canvas 2D; if WebGPU init succeeds,
  swap the renderer and redraw. The app is never blocked on the GPU.
- **Runtime fallback** on `device.lost` (or an uncaptured-error budget) swaps back
  to Canvas 2D mid-session — the cloud just re-renders on the 2D layer.
- **Export forces Canvas 2D.** SVG/PNG export (`toDataURL` rasterize at
  ≈script.js:2558) uses the Canvas-2D layer: either always render an off-screen
  2D copy for export, or read back the WebGPU texture. Recommend the **off-screen
  Canvas-2D copy for export** — deterministic, matches the bundle, sidesteps the
  headless-readback quirks (below).

### C. `IncrementalFrontier` (the Phase-2 fix, backend-agnostic)

Port `core.c`'s `frontier_apply_event(p, x, y)` + `build_staircase()` to a small
JS module (parallel `Uint32Array` frX/frY/frP + `onFront`, sorted x-asc/y-desc;
monotone insert + contiguous eviction). Used **only by the `.evt` streaming mode**
(`pbpEvt`), where events are monotone:

- As the cursor advances `applied → target` over the date-sorted event window,
  call `applyEvent(player, hr[player], sb[player])` per event (exactly the POC's
  per-frame loop), instead of re-running `sweepFrontier` over all points.
- On backward seek / wrap / filter change: reset + replay forward (as in the POC).
- Produces `onFront[]` (drives the frontier-red dot colour the renderer reads) and
  the staircase vertices (SVG `staircaseScreen` or GPU `line.wgsl`).
- **Season open-year** reuses the existing `buildSmoothActiveFrontier` split:
  static completed-season frontier (cached per open year) **Pareto-merged** with
  the incrementally-maintained open-season frontier (the POC's season model).

This replaces the dominant per-frame cost in streaming mode (the full sweep over
~44 k rows) with an O(window + frontier) update — the "incremental frontier" row
of `pbp-rendering-design.md` §2. It helps **both** backends (it's math, not
pixels); the WebGPU backend then only has to *draw* the result.

**Correctness is anchored to the POC.** The JS port is verified to match
`core.c`'s `verify_career` / `verify_season` (incremental == brute-force) on the
same `.evt` data — so `core.c` stays the oracle even though the app ships the JS
port. A dev assert (`?verifyFrontier=1`) cross-checks the incremental frontier
against a full sweep each frame and logs divergence.

### D. Where WASM/`core.wasm` fits (deferred)

Not loaded by the app in this phase. It becomes the path when event volumes reach
pitch-by-pitch scale (10⁶–10⁸), where JS decode + per-frame replay bottleneck.
At that point the app would `fetch` `core.wasm` lazily (only for the streaming
mode, only multi-file — never the bundle) and call `step_*`/read the heap exactly
as `poc-webgpu/main.js` does. Until then, the JS port keeps the app build-step-
free and the bundle pure. Recorded as a follow-up, not built here.

## Layout, compositing, export

- The WebGPU `<canvas>` occupies the **same absolutely-positioned slot** as the
  current `chartCanvasLayers` (`ensureChartCanvasLayers` grows to manage either a
  2D or a WebGPU context per backend), under the SVG overlay. DPR handling matches
  the existing 2D path.
- **One WebGPU canvas** with bg+fg as two draws (static buffer + dynamic buffer)
  is simpler than two GPU canvases; the static/dynamic split lives in *buffer
  upload cadence*, not separate surfaces.
- **Export / bundle**: unchanged for Canvas 2D. For WebGPU sessions, export
  renders an off-screen Canvas-2D copy (the fallback renderer is always
  constructed and cheap), so share-images and `dist/` are identical to today.

## Capability & fallback matrix (incl. POC findings)

| Situation | Behaviour |
|---|---|
| No `?renderer=webgpu` | Canvas 2D (default, unchanged) |
| `navigator.gpu` absent | Canvas 2D + one-line notice |
| `requestAdapter()` null / init throws | Canvas 2D + notice |
| `device.lost` mid-session | Swap to Canvas 2D, redraw |
| Offline `dist/` bundle | Canvas 2D only (WebGPU code not bundled) |
| SVG / PNG export | Canvas-2D off-screen copy |
| **Headless automation (CI/snap)** | Canvas present loses the device under headless Dawn (POC finding). The app must **not** configure a WebGPU canvas when `/HeadlessChrome/` UA or `navigator.webdriver` — fall back to Canvas 2D so headless verification of the *default* app is unaffected. WebGPU-specific headless checks use the POC's offscreen-render path. |

The headless **`depthSlice = WGPU_DEPTH_SLICE_UNDEFINED`** and **+Y-up NDC** lessons
from the POCs carry into `WebGPURenderer` verbatim.

## Verification

- **Parity.** At a fixed cursor + filter set, the WebGPU cloud and the Canvas-2D
  cloud must be visually equivalent (same points, colours, frontier). Capture both
  via `scripts/snap.js` (Canvas 2D) and `poc-webgpu/snap-webgpu.js` (WebGPU
  offscreen) and diff structurally.
- **Frontier invariant.** `?verifyFrontier=1` asserts incremental == full-sweep
  each frame; plus the standing spot-checks (career all-time frontier = Bonds
  762/514 + Henderson 296/1406; single-season HR 73 / SB 138).
- **Fallback drills.** Force each ladder rung (`?renderer=webgpu` with
  `navigator.gpu` deleted; simulated `device.lost`) and confirm a clean Canvas-2D
  render, no console errors, identical hit-testing.
- **Bundle integrity.** `python3 scripts/build_bundle.py` + decode-count check
  unchanged; confirm no WebGPU/WASM symbols leak into `dist/index.html`.
- **Perf.** `snap.js` evalJS timing of the streaming sweep: incremental frontier
  drops per-frame frontier cost to O(window); WebGPU cloud draw vs Canvas-2D at
  the heaviest state (2025 open year, full window). Both should hold ≥ the current
  Canvas-2D frame budget.

## Phasing

1. ✅ **Incremental frontier (JS), backend-agnostic.** `IncrementalFrontier` in the
   `.evt` career streaming path; verified against `core.c`. *Shipped (Phase 1 + the
   filter-aware Slice 3).*
2. ✅ **`PointRenderer` seam.** `Canvas2DRenderer` owns the bg/fg layers behind a
   narrow interface; no-op refactor, byte-identical snapshots. *Shipped (Phase 2).*
3. ✅ **`WebGPURenderer` behind `?renderer=webgpu`.** Instanced cloud (bg/fg buffers),
   capability check + fallback ladder, export via texture readback. Frontier stays
   SVG. *Shipped (Phase 3).*
4. ✅ **GPU compute-accumulate cloud (hybrid).** The POC's `accumulate.wgsl` in the app:
   the `.evt`-career cloud is accumulated on the GPU and vertex-pulled (no per-frame
   `evtPointsAsOf`/readback), generalized to any monotone linear counting axis. **The JS
   incremental frontier stays authoritative** (frontier/staircase/tooltips/cards); the GPU
   only replaces the cloud. *Shipped (Phase 4) — see README.*
5. **Spring motion + two explicit streaming engines** (the POC `spring` + `skyline` + GPU
   `staircase`, dropping the CPU frontier from the GPU path). Builds on the shipped Phase-4
   accumulate; lands as a **second, explicit streaming engine** alongside the CPU one (see
   [§Phase 5](#phase-5--spring-motion--two-explicit-streaming-engines) below). The
   **deferred `core.wasm`** path (once pitch-by-pitch volumes land) is still a separate
   session. *T4 — new GPU compute/render pipeline contract. **Detailed design below.***

---

## Phase 3 — `WebGPURenderer`: detailed design & data flows

This is the first phase with real WebGPU code. It is **strictly a learning/headroom
track**: Canvas 2D already meets the frame budget after Phase 1, so WebGPU is never
the default and can never regress production. It plugs into the Phase-2 `PointRenderer`
seam — `drawScatterPlot` is unchanged except for one added `present()` call; swapping
the renderer is the whole integration.

### Where it plugs in (the Phase-2 seam, extended)

`drawScatterPlot` already drives a `pointRenderer` instance through:

```
pointRenderer.resize(w, h)
pointRenderer.clear()                      // empty-data early-out
pointRenderer.drawBackground(points, opts) // only when bgCacheKey changes
pointRenderer.drawTrails(trails, opts)     // group-career only
pointRenderer.drawForeground(points, opts)
pointRenderer.drawFrontierDots(points, opts)
pointRenderer.bgCanvas / .fgCanvas         // read by exportChartSVG
```

Phase 3 makes that surface a true **interface with two implementations** by adding
**two methods** (no-ops on `Canvas2DRenderer`, the active work on `WebGPURenderer`):

- **`present()`** — called once at the end of `drawScatterPlot`'s canvas section
  (after `drawFrontierDots`). Canvas 2D paints immediately per call, so `present()`
  is a no-op there. WebGPU **accumulates** the per-call geometry into resident GPU
  buffers and submits **one render pass** in `present()`.
- **`exportDataURLs()`** — returns the array of PNG data-URLs `exportChartSVG`
  embeds. Canvas 2D returns `[bgCanvas.toDataURL(), fgCanvas.toDataURL()]` (today's
  behavior). WebGPU returns `[<single composited readback PNG>]`. `exportChartSVG`
  switches to this method so it never touches a WebGPU canvas's `toDataURL`
  (unreliable) — it reads back the offscreen texture instead.

Everything else — axes, gridlines, the **frontier staircase** (`path.frontier-staircase`),
labels, legend, tooltip, the `d3.quadtree` hit-test — stays SVG / DOM, identical
across backends. The WebGPU canvas renders **only the point cloud + group-career
trails**.

### Renderer selection ladder (`chooseRenderer`)

Selection is **async and non-blocking**. The app *always* first constructs and renders
with `Canvas2DRenderer` (so first paint and the default path are byte-for-byte
unchanged). Only if every rung passes does it swap:

```
// at startup, after the first Canvas-2D render:
if (urlFlag("renderer") !== "webgpu")        return;                 // default → stay Canvas 2D
if (isHeadless())                            return;                 // see "Headless" below
if (!navigator.gpu)                          return notice("no navigator.gpu");
adapter = await navigator.gpu.requestAdapter();  if (!adapter) return notice("no adapter");
device  = await adapter.requestDevice();
const webgpu = new WebGPURenderer(device, adapter);
try { await webgpu.init(); } catch (e)       return notice("init failed: " + e), webgpu.destroy();
device.lost.then(() => swapToCanvas2D());                            // runtime fallback
device.addEventListener("uncapturederror", budgetedFallback);
swapRenderer(webgpu);                                                // destroy() the 2D layers, refreshChart()
```

`swapRenderer(next)` calls `current.destroy()` (removes its canvas(es) from
`.chart-region`), sets `pointRenderer = next`, copies over `bgCacheKey = null` (forces
a fresh background upload), and calls `refreshChart()`. `swapToCanvas2D()` is the same
in reverse, used on device loss / error budget — the cloud just re-renders on a fresh
`Canvas2DRenderer`. The app is **never blocked on the GPU**; a failed rung leaves the
fully-working Canvas-2D render in place plus a one-line notice.

### `WebGPURenderer` internals

**One canvas, one offscreen texture, two pipelines.** A single `<canvas>` in the same
absolutely-positioned `.plot-canvas` slot as the 2D layers (the static/dynamic split
lives in *buffer upload cadence*, not separate surfaces). All rendering targets an
**offscreen texture** first (valid even headless); a real browser then blits it to the
canvas via `copyTextureToTexture` (the POC's proven pattern, `poc-webgpu/main.js`).

Pipelines (WGSL inlined as JS template strings in `script.js`, *not* shader files — so
there is no extra `fetch` and the multi-file path needs no new assets):

- **Points pipeline** — instanced quads (6 verts/instance, `triangle-list`); WebGPU has
  no point primitive. Per-instance attributes are **vertex-pulled from a storage
  buffer**. Alpha blending on (`src-alpha / one-minus-src-alpha`). Fragment does the
  round-disc test + an optional white ring (frontier/highlight dots).
- **Lines pipeline** — group-career trails. Each trail segment is an instanced thin
  quad (2 triangles) with a per-segment color + alpha ramp, so it matches the Canvas-2D
  comet-tail. (A `line-strip` can't vary width/alpha per segment, so quads it is.)

**Resident buffers** (re-uploaded only when their source changes — the static/dynamic
split):

| Buffer | Holds | Re-uploaded |
|---|---|---|
| `bgInst` | completed-season cloud instances | on `drawBackground` (i.e. when `bgCacheKey` changes) |
| `fgInst` | open cloud + career-highlight head instances | every frame (`drawForeground`) |
| `frontierInst` | frontier (`special`) dot instances | every frame (`drawFrontierDots`) |
| `trailVerts` | group-career trail segment instances | every frame, group-career only (`drawTrails`) |
| `uViewport` | uniform: CSS width, height (px) | on `resize` |

Each `draw*` method **flattens** its `(points, opts)` into the matching instance buffer
and `queue.writeBuffer`s it; it does **not** draw. `present()` records the single pass.

### Data flow 1 — host point → GPU instance (the flatten)

`drawScatterPlot` hands each renderer **the same data**: arrays of point objects in
**data coordinates** (`d.x`, `d.y`) plus an `opts` bag of **callbacks** (`fillFor(d)`,
`alphaFor(d)`, `radius` (number|fn), `strokeFor(d)`/`radiusFor(d)`). Canvas 2D calls
these per point at draw time. WebGPU evaluates them **host-side, once per point**, into
a packed instance record:

```
struct Inst {                       // 24 bytes, std430 (4-byte aligned)
  px: f32, py: f32,                 // screen position, CSS px  = margin.left + xScale(d.x), margin.top + yScale(d.y)
  radius: f32,                      // disc radius, CSS px       = radius(d) (or the number)
  ring: f32,                        // white-ring width, CSS px  = strokeWidth if strokeFor(d) else 0
  fill: u32,                        // packed RGBA8              = packColor(fillFor(d), alphaFor(d))
  stroke: u32,                      // packed RGBA8 (ring)       = packColor(strokeFor(d) || "#fff", 1)
};
```

Building it: a reusable scratch `ArrayBuffer` grown to `count * 24`; a `DataView`
writes `px/py/radius/ring` (`setFloat32`, little-endian) and `fill/stroke`
(`setUint32`). Points with non-finite screen coords are skipped (same as Canvas 2D's
`isFinite` guard). The instance count is returned so `present()` knows how many to draw.

**Color packing** (`packColor(cssColor, alpha)`): the callbacks return CSS color
strings (hex, `rgb()`, named) via `colorOf()`. Parse once through a tiny cached parser —
a 1×1 scratch `CanvasRenderingContext2D` (`fillStyle = css; fillRect; getImageData`) or
`d3.color(css).rgb()` (d3 is already loaded) — memoized in a `Map<css → u32>` since the
palette is tiny (era ramp / league / handedness). Pack as `r | g<<8 | b<<16 | a<<24`
(little-endian RGBA8, matched in the shader by reading bytes).

### Data flow 2 — coordinate & DPR mapping (vertex shader)

Instance `px/py` are **CSS pixels, top-left origin** (exactly what Canvas 2D draws with
after its `setTransform(dpr,…)`). The offscreen texture is sized `width*dpr ×
height*dpr` (sharper on HiDPI) but NDC always spans the whole texture, so the mapping
uses **CSS** dimensions (`uViewport = [cssW, cssH]`); DPR only sets texture resolution,
never the math:

```
center_ndc = vec2( px/cssW * 2 - 1,  1 - py/cssH * 2 );   // note Y flip: pixel-down → NDC-up
half_ndc   = vec2( (radius+ring)/cssW * 2, (radius+ring)/cssH * 2 );
pos        = center_ndc + corner * half_ndc;              // corner ∈ {±1}² (the 6-vert quad)
```

The quad is grown to `radius + ring` so the white rim isn't clipped. The fragment
recovers the pixel distance from center, `dist = length(corner) * (radius+ring)`, and:

```
if (dist > radius + ring*0.5)  discard;                   // outside the stroked disc
if (ring > 0 && dist > radius - ring*0.5)  → stroke color // the rim (≈ Canvas 2D's centered stroke)
else                                        → fill color   // the disc
```

This reproduces Canvas 2D's "fill disc of radius R, then stroke a `ring`-px line
centered on R" to sub-pixel tolerance. Plain cloud dots pass `ring = 0` → a flat filled
disc with the fill's alpha.

### Data flow 3 — `present()` (the one render pass)

```
present():
  if no layers → return
  enc = device.createCommandEncoder()
  rp  = enc.beginRenderPass({ view: offscreen, clearValue: <page bg>, loadOp:'clear', storeOp:'store' })
  rp.setPipeline(points)
    rp.setBindGroup(0, bg(uViewport, bgInst));       rp.draw(6, bgCount)         // completed cloud
    if (trailCount)  { rp.setPipeline(lines); rp.setBindGroup(0, bg(uViewport, trailVerts)); rp.draw(6, trailCount); rp.setPipeline(points); }
    rp.setBindGroup(0, bg(uViewport, fgInst));       rp.draw(6, fgCount)         // open cloud + highlight heads
    rp.setBindGroup(0, bg(uViewport, frontierInst)); rp.draw(6, frontierCount)   // frontier dots (on top)
  rp.end()
  device.queue.submit([enc.finish()])
  if (canvasOk) copyTextureToTexture(offscreen → ctx.getCurrentTexture())
```

The draw **order** mirrors Canvas 2D's layer order exactly: completed cloud (bg canvas)
→ trails → open cloud + heads (fg canvas, `clear:false` over trails) → frontier dots on
top. Because `present()` always clears and redraws every resident buffer, the per-frame
"clear the fg" semantics of the 2D path are automatic; the `clear` opt is a Canvas-2D
concern WebGPU ignores. The clear color is the page background (read once from CSS so
light/dark themes match).

The bg cache still works: when `bgCacheKey` is unchanged, `drawScatterPlot` doesn't call
`drawBackground`, so `bgInst` is **retained** and `present()` redraws it anyway — same
"don't rebuild the static cloud" optimization, expressed as "don't re-upload the
buffer."

### Data flow 4 — export (texture readback)

`exportChartSVG` calls `pointRenderer.exportDataURLs()`. For WebGPU:
`copyTextureToBuffer(offscreen → staging, bytesPerRow = ceil(w*4/256)*256)`,
`mapAsync(READ)`, copy into a 2D `ImageData` (swizzling BGRA→RGBA when
`getPreferredCanvasFormat()` is `bgra8unorm`), `putImageData` to a scratch 2D canvas,
return `[canvas.toDataURL("image/png")]` — the POC's `captureDataUrl` verbatim. One
composited `<image>` is embedded instead of two layers; the resulting share-image is
**visually equivalent** (not byte-identical — different rasterizer). The **default and
bundle paths are unchanged and exact**, since they never construct a `WebGPURenderer`.

### Headless handling (the POC lesson, carried verbatim)

Configuring a WebGPU canvas under headless Dawn (CDP automation) errors and **loses the
device**. So:

- **`chooseRenderer` bails before WebGPU entirely** when `/HeadlessChrome/i` UA or
  `navigator.webdriver` — the *default app's* headless verification (every existing
  `snap.js` check) runs on Canvas 2D, unaffected.
- WebGPU-specific headless verification uses the **offscreen render + readback** path
  (never `ctx.configure`), exactly like `poc-webgpu/snap-webgpu.js`. A
  `?renderer=webgpu&webgpuHeadless=1` escape hatch (or a `window.__bl2d_webgpu*` hook)
  lets a dedicated harness construct the renderer, render offscreen, and read back the
  PNG for a structural parity diff — without ever configuring the canvas.

The POC's other lessons carry too: retain the adapter (Dawn GCs the instance otherwise),
`depthSlice` stays `UNDEFINED` (no depth attachment), **+Y-up NDC** (the Y flip above).

### Bundle exclusion

`build_bundle.py` is untouched. The WGSL lives in JS template strings and the
`WebGPURenderer` class rides along in the inlined `script.js`, but it is **inert** in the
bundle: `chooseRenderer` only runs under `?renderer=webgpu`, the bundle is opened from
`file://` with no such flag, and no shader-file `fetch` or WASM blob is added. The
bundle stays **functionally Canvas-2D-only**; the few KB of dormant WGSL text is not a
CDN/WASM dependency. (If even that is unwanted later, the bundler can strip the class by
regex — noted, not done.)

### Verification

- **Default path untouched.** Re-run the Phase-2 byte-identical snapshots **without**
  the flag — must still match (the ladder returns immediately when the flag is absent).
- **Headless guard.** `?renderer=webgpu` under `snap.js` must **not** configure a WebGPU
  canvas (assert `window.__bl2d_renderer === "canvas2d"` and no console error); the
  default render is identical to no-flag.
- **WebGPU parity (offscreen).** A dedicated harness (POC-style offscreen + readback)
  renders a fixed state under `WebGPURenderer` and diffs **structurally** against the
  Canvas-2D PNG of the same state: same frontier dots (count + positions), same cloud
  extent, same staircase (SVG, identical). Pixel-exact is not expected across
  rasterizers; assert the frontier dot screen positions match within ±1px and the
  on-frontier set is identical.
- **Fallback drills.** Force each rung: `?renderer=webgpu` with `navigator.gpu` deleted →
  Canvas 2D + notice; simulated `device.lost` → swap back, clean redraw, identical
  hit-testing (`__bl2d_renderer` flips to `canvas2d`).
- **Export.** Under WebGPU, `exportDataURLs()` returns a non-empty PNG that embeds the
  cloud; under Canvas 2D, still the two layers. Bundle integrity unchanged
  (`build_bundle.py` decode-count check; no WebGPU symbols *executed*).
- **Perf headroom (informational).** `snap.js` evalJS timing of `present()` vs the
  Canvas-2D draw at the heaviest state (2025 open year, full window) — the point of the
  exercise, recorded but not gating.

## Risks

- **Scope creep into the default path.** Mitigation: the flag + fallback ladder;
  the bundle and default render are untouched and snapshot-guarded.
- **Two code paths drift.** Mitigation: the `PointRenderer` interface is narrow;
  the frontier math is shared (not per-backend); parity tests in CI.
- **WebGPU support/headroom mismatch.** Our point counts don't *need* WebGPU
  (Canvas 2D already meets the budget post-Phase-1) — this is a learning/headroom
  track, justified as such, gated so it can never regress production.
- **Export divergence.** Mitigation: export always uses the Canvas-2D copy.
- **Bundle bloat.** Mitigation: WebGPU/WASM strictly excluded from `build_bundle.py`.

---

## Phase 5 — Spring motion + two explicit streaming engines

Phase 3 added a GPU backend for the **static** scatter cloud; Phase 4 (shipped, see README) put the
streaming **cloud** on the GPU via `accumulate.wgsl` while keeping the JS frontier authoritative.
Phase 5 brings in the rest of the [`poc-webgpu-spring`](../poc-webgpu-spring/) pipeline — **GPU spring
motion + a per-frame GPU Pareto skyline + a fully-GPU staircase**, dropping the CPU frontier from the
GPU path — for the **animated `.evt` streaming** path. The POC's frame graph is:

```
accumulate.wgsl  atomicAdd the new [lo,count) event slice into per-player counters  (the spring TARGET)
      │
spring.wgsl      glide pos[] toward the counters, critically damped (no overshoot); update vel[]
      │
skyline.wgsl     onFront[i] = 1 iff no j dominates pos[i]   (brute-force O(n²), exact at n≈11k)
      │
staircase.wgsl   compact on-front ids → rank-sort by x → emit step verts + a GPU draw count
      ▼
points.wgsl  instanced-quad cloud, vertex-pull from pos[]   ·   line.wgsl  staircase via drawIndirect
```

In the POC the CPU does **almost nothing per frame** (only the event-slice `[lo,count)` and a wrap
flag) and there is **zero GPU→CPU readback in the live loop** — readback only happens once, in the
verify/capture hooks, because configuring/reading a WebGPU canvas under headless Chrome is the
documented device-loss trigger. Phase 4 brings that property into the app.

### Architecture decision: two engines, not a hybrid

The streaming path is built as **two explicit, self-contained engines**, selected once when the
streaming model becomes active — **not** one engine with a "use GPU" flag, and **not** the Phase-3
`PointRenderer` seam extended:

```
chooseStreamingEngine(model):
  if ?renderer=webgpu AND evtGpuMonotone(model).ok AND navigator.gpu AND !isHeadless()
      AND (await tryInitGpu())          -> gpuStreaming   // full GPU
  else                                  -> cpuStreaming   // full CPU (default + fallback)
```

**Why two engines instead of a shared abstraction:**

- The GPU engine receives **events + uniforms**, never screen-space points. A shared
  `setForeground(points)`-style seam (Phase 3's `PointRenderer`) would be a *lie* for the GPU path —
  it would force the GPU to pretend it consumes the same per-point screen data the CPU draws. The two
  data flows are genuinely different, so the interfaces are too.
- The GPU frontier is the GPU `skyline` kernel; the CPU frontier is `createIncrementalFrontier`. These
  are **two different implementations of the same math**, not one engine with the other disabled. Keeping
  them separate means each can be read, reasoned about, and verified on its own, and the CPU path is the
  always-present fallback the rest of this doc guarantees.
- Reuse is deliberately minimal (table below): share the *data* (model load, the event stream both
  consume, metadata, SVG chrome), separate the *behavior* (frontier, cloud, staircase, motion, loop).

On `device.lost` the GPU engine tears down and `chooseStreamingEngine` re-resolves to `cpuStreaming`
with a clean redraw. The non-streaming **static** scatter is untouched — it keeps its Phase-2/3
Canvas-2D / `PointRenderer` path. This split is **only** for the animated `.evt` streaming path.

#### `cpuStreaming` — full CPU (default + fallback)

The path that exists today, made explicit and self-owned:

- **Frontier** — `createIncrementalFrontier` (script.js:1264), replayed over `buildEvtEventStream` as
  the cursor advances; reset+replay on backward seek.
- **Cloud** — Canvas 2D (`drawCanvasPointLayer`, bg/fg split).
- **Staircase** — SVG `path.frontier-staircase`.
- **Interaction** — live CPU `d3.quadtree`, cards, hypervolume, labels, maintained as today; `smoothLite`
  defers the heavy parts to idle.
- No GPU, no readback, no WGSL. This is the **mandatory fallback** and what the offline `dist/` bundle
  uses.

#### `gpuStreaming` — full GPU (the POC pipeline)

One command encoder per frame:

```
accumulate (if count>0)  →  spring  →  skyline  →  reset/compact/ranksort/emit  →  render(points + line.drawIndirect)
```

- **Frontier is the GPU `skyline` → `onFront`**; the staircase is the GPU `drawIndirect` line (vertex
  count written by the `emit` pass, never plumbed through JS). **No CPU frontier runs in this engine.**
- **Interaction** (SVG labels, cards, HV, quadtree, click-to-highlight) is rebuilt by this engine's own
  **throttled idle readback** — see [§Reconciliation](#reconciliation--idle-readback-not-per-frame).
- POC lessons carried verbatim: `depthSlice = UNDEFINED`, **+Y-up NDC** (no flip), retain the adapter,
  render to an **offscreen texture** then `copyTextureToTexture` blit, and keep **all** per-frame
  readback off the loop.

#### Shared vs. separate — only what's genuinely needed

| Shared (one copy, both engines use it) | Separate (each engine owns its own) |
|---|---|
| `.evt` decode + model (`decodeStev`, `loadEvtStat`, `buildEvtModel`) | frontier computation (CPU `IncrementalFrontier` vs GPU `skyline`) |
| `buildEvtEventStream(model)` — the event stream both consume | cloud rendering (Canvas 2D vs instanced quads) |
| `evtGpuMonotone` / `gpuScaleUniform` (gate + coeffs/scale; GPU-only consumer) | staircase (SVG path vs GPU `drawIndirect`) |
| player metadata (names, debut, era key) | motion (CPU step vs GPU spring) |
| SVG chrome: axes, gridlines, legend, tooltip shell | the per-frame loop (`refreshChart`/`smoothLite` vs GPU encoder submit) |
| leaf DOM builders (card-from-`{set,pos,meta}`, label emit) *where identical* | interaction-data maintenance (live CPU vs idle GPU readback) |

### The integration surface already exists

The app already built the CPU side of this pipeline (all in `script.js`), so Phase 4 is largely
**wiring existing feeds to the POC's GPU passes**:

- **`buildEvtEventStream(model)` (:1182)** → a flat, **date-sorted** struct-of-arrays event stream
  `{date, player, dep, delta, n}` — this *is* the events buffer `accumulate.wgsl` reads.
- **`evtGpuMonotone(model)` (:1223)** → gates GPU-accumulability (counting axes only, no rate stats,
  integer ≥0 coefficients) **and** derives per-component coefficients `cx[]/cy[]`, so one accumulate
  pass maps a streamed `delta` to its X and Y contributions.
- **`gpuScaleUniform(...)` (:1250)** → packs the D3 linear scales as slope+intercept + viewport +
  radius/alpha for the cloud vertex shader (matches the CSS-px mapping Canvas 2D uses).
- **`smoothLite` (:294)** → already skips HV/cards/rings/quadtree during play and fires a full
  interactive render when idle — the exact hook the throttled readback rides.

### Communication design — minimize CPU↔GPU traffic

The central question: **copy the events once, or stream them as time passes?** → **Copy once.**

Upload the full date-sorted event stream to a **resident** GPU storage buffer **once per axis
selection**. Per frame the CPU sends only a tiny window uniform. Streaming events per frame is
rejected because:

- Events are **static** for a given filter+axis — re-sending them is pure waste.
- Backward seek / scrub / wrap is **free** with resident events: zero the counters and re-accumulate
  `[lo, cursor)` entirely on the GPU (the POC's `zeroGpu` path), no upload.
- Per-frame CPU→GPU traffic collapses to ~32 bytes (two uniforms).

#### What crosses the bus, and how often

| Data | Direction | Cadence | Size | Mechanism |
|---|---|---|---|---|
| events buffer (date-sorted SoA stream) | CPU→GPU | **once per axis change** | ~MBs | `buildEvtEventStream` → `writeBuffer` |
| static per-player meta (`debut`, era key, size stat) | CPU→GPU | once per axis change | ~tens KB | `writeBuffer` |
| per-player **filter mask** (league/bats/country/include) | CPU→GPU | **on filter change only** | ~`playerCount` B | `writeBuffer` |
| `bWin` `{lo,count}` (this frame's new slice) | CPU→GPU | **per frame** | 16 B | uniform |
| `bSpring` `{dt,omega}` | CPU→GPU | per frame | 16 B | uniform |
| `bParams` (scales slope/intercept + viewport, from `gpuScaleUniform`) | CPU→GPU | on resize / extent change | 16–32 B | uniform |
| `onFront[]` + integer counters (X,Y per player) | **GPU→CPU** | **idle only** (smoothLite settle) | ~`playerCount`×3×4 B | one `mapAsync` |
| anything | GPU→CPU | **per frame** | **0** | — (avoids headless device-loss) |

#### Filters & scales — "same for all other information"

- **Year-range** is **not** a re-upload and **not** a mask: events are date-sorted, so a year boundary
  maps to an **index range** in the resident stream. Narrowing the range = change `lo` and re-accumulate
  `[lo, cursor)` on the GPU. Pure GPU work, zero bytes uploaded.
- **Player-attribute filters** (league / bats / country) → a small **per-player mask buffer**
  (~`playerCount` bytes), rewritten only on filter change. `skyline` excludes masked players from the
  frontier; `points`/`line` skip (alpha 0 / discard) masked instances. The big events buffer stays
  resident — only the tiny mask moves. Counters for masked players are simply ignored downstream, so no
  counter recompute is needed on an attribute-filter change.
- **Axis change** is the only event that re-uploads the events buffer (a different stat = a different
  stream), zeroes counters, and replays from the cursor.
- **Scales / viewport** — `gpuScaleUniform` already exists; send `bParams` on resize / data-extent
  change (the POC re-sends it per frame at `main.js:318` — fine, it's 32 bytes).

### GPU frame graph & resident buffers

Buffers mirror `poc-webgpu-spring/main.js`, generalized from the POC's hard-wired HR/SB to the active
axis pair via `evtGpuMonotone`'s `cx/cy` coefficients:

| Buffer | Holds | Re-uploaded / written |
|---|---|---|
| `bEvents` | date-sorted `{date, player, delta}` stream | once per axis change (CPU) |
| `bX` / `bY` | per-player integer counters (the spring target) | GPU `accumulate`; zeroed on wrap/scrub |
| `bPos` / `bVel` | smoothed positions / velocities | GPU `spring`; zeroed on wrap |
| `bDebut` | per-player debut (era colour) | once per axis change (CPU) |
| `bMask` | per-player include flag (attribute filters) | on filter change (CPU) |
| `bOnFront` | per-player frontier flag | GPU `skyline` |
| `bFrontIdx`/`bFrontSorted`/`bCount` | staircase scratch (compact + rank-sort) | GPU, reset each frame |
| `bStaircase`/`bIndirect` | step verts + GPU-written draw count | GPU `emit`; drawn via `drawIndirect` |
| `bWin`/`bSpring`/`bParams` | uniforms (window / spring / scales+viewport) | per frame / on change (CPU) |

Per-frame host loop (`gpuStreaming.renderAt(cursor)`): compute `{lo,count}` + wrap from the model;
write `bWin`/`bSpring` (and `bParams` if dirty); if wrap, zero `bX/bY/bPos/bVel` and reset `bCount`;
record one encoder — `accumulate` (if `count>0`) → `spring` → `skyline` → reset/compact/ranksort/emit
→ render (`points` `draw(6, playerCount)` + `line.drawIndirect`); submit; blit offscreen→canvas only
when `canvasOk` (the `!isHeadless()` gate). **No per-frame `onFront`/`staircase` upload** — both are
produced on the GPU.

The **math** (carried from `gpu-spring-skyline-design.md`, to be re-derived inline in the WGSL):
the critically-damped spring uses the stable polynomial-`e` integrator (`e = 1/(1+wd+½wd²+…)`,
`wd = ω·dt`) — unconditionally stable, never overshoots; the skyline is the exact O(n²) domination
test with the strict tie-break (`pj≥pi` componentwise and `pj≠pi`); brute force is correct at n≈11k
because **tiling fails for Pareto domination** (one high point dominates an entire lower-left quadrant
spanning arbitrarily many tiles).

### Reconciliation — idle readback, not per-frame

The GPU shows smoothed float positions; the DOM/interaction layer needs the semantic (integer)
frontier. They are reconciled by the `gpuStreaming` engine's **own** throttled readback:

- On `smoothLite` settle/idle, one `mapAsync` reads back `onFront[]` + the integer counters.
- From that + the resident `.evt` metadata (names, debut), the engine rebuilds the quadtree, cards,
  HV, and frontier labels — exactly the work `smoothLite` already defers to idle.
- **Never per frame** — a per-frame `mapAsync` is the documented headless device-loss trigger. During
  active play, interaction is already suppressed by `smoothLite`, so there is nothing to keep live.

The CPU `IncrementalFrontier` stays in the codebase as the `cpuStreaming` engine and as the
verification oracle alongside `core.c`'s `verify_career()`.

**Implementation status (shipped behind `?renderer=webgpu&gpustream=1`).** The GPU compute+render
pipeline is built and verified: spring (`WEBGPU_SPRING_WGSL`), skyline (`WEBGPU_SKYLINE_WGSL`), the
fully-GPU staircase (`WEBGPU_STAIRCASE_WGSL`, three entry points + `drawIndirect`), the spring cloud
(`WEBGPU_SPRINGCLOUD_WGSL`, two-pass so frontier dots sit on top), and the staircase line
(`WEBGPU_STAIRLINE_WGSL`) — all in `WebGPURenderer` (`_initSpring`/`_initSpringBuffers`/`present`),
gated by `gpuSpring` in `drawScatterPlot`. Verified by `__bl2d_verifySpring` (springMis 0, skylineMis
0, frontier = Bonds 762/514 + Henderson 296/1406). **Deviation from the above:** the *render* drops
the CPU frontier (GPU `onFront`/staircase own the picture), but the cheap JS `IncrementalFrontier`
still **runs live** to feed DOM/interaction (cards, quadtree, labels) — the throttled idle `onFront`
readback that would *replace* it is not yet wired (a follow-up). So today: GPU owns the picture, CPU
still owns the interaction data; the two agree at settled state. Other follow-ups: a crisper
quad-based staircase line (the 1px `line-strip` aliases under SwiftShader at high DPR) and honouring
the bats/country mask on the GPU.

### File separation (evaluated; deferred)

Keep both engines in `script.js` for this pass (single-file-by-design; the bundler inlines `script.js`
verbatim). Write each engine as a contiguous, clearly-headed block with a narrow seam to the shared
code, so a later split is mechanical:

- **When to split** — once `gpuStreaming` (WGSL strings + buffer setup + frame graph + idle readback)
  dominates `script.js` diffs, lift it to `streaming_gpu.js` and `cpuStreaming` to `streaming_cpu.js`,
  leaving the shared model/chrome in `script.js`.
- **Bundle impact** — `build_bundle.py` inlines only `script.js`. On a split, either concatenate the
  new files or (preferred) keep `streaming_gpu.js` out of the bundle entirely, since the bundle is
  Canvas-2D-only. **Do not change the bundler in this pass.**

### Commenting standard (hard requirement)

All new code carries **pedagogical, learning-resource comments** matching this repo's standard (the
`gpu-spring-skyline-design.md` "Code commenting standard" and the recent pedagogical-pass commits):
explain the *why* of every non-obvious mechanic (copy-once events; year-range-as-index-bounds; the
filter mask vs re-upload; no per-frame readback; two engines vs a flag); derive the spring/skyline/
staircase math inline; block headers per engine and per GPU pass; WGSL at POC comment density; and
comment the engine-selection branch and the shared-vs-separate seam so the future file split is obvious.

### Verification

- **Default path untouched.** Phase-2 byte-identical snapshots with no flag still match.
- **Headless guard.** `?renderer=webgpu` under `snap.js` must not configure a WebGPU canvas
  (`__bl2d_renderer === "canvas2d"`, no console error).
- **Frontier == oracle.** A POC-style offscreen harness drives to a fixed cursor, settles springs,
  reads back `onFront` **once**, and asserts it equals `core.c`'s `verify_career()` brute force
  (`frontierMis 0`); plus the standing spot-checks: career all-time frontier = Bonds 762/514 +
  Henderson 296/1406; single-season HR 73 / SB 138.
- **Spring convergence.** Settled `pos` within ½ unit of the integer counters (`springMis 0`).
- **Idle reconciliation.** After playback settles, cards/HV/labels/quadtree match the GPU `onFront`
  readback; click-to-highlight and tooltips work on settled state.
- **Engine selection / fallback drills.** `chooseStreamingEngine` resolves to `gpuStreaming` only when
  every gate passes; `navigator.gpu` deleted → `cpuStreaming` (full CPU engine), identical hit-testing;
  simulated `device.lost` → re-resolves to `cpuStreaming` mid-session, clean redraw.
- **Engine independence.** With `?renderer=webgpu`, confirm the CPU frontier code is **not** on the live
  path (instrument `createIncrementalFrontier` to assert it isn't called during GPU playback) — proving
  the two implementations are genuinely separate, not a shared engine with a flag.
- **Bundle integrity.** `python3 scripts/build_bundle.py` decode-count unchanged; no WebGPU/WASM
  symbols *executed* in `dist/index.html`.

### Risks

- **Two streaming engines drift.** Mitigation: the shared surface is *data only* (model + event stream
  + metadata + chrome); both are pinned to the same `core.c` oracle; the engine-independence assert
  keeps the boundary honest.
- **SwiftShader O(n²) snapshot cost.** Use the one-dispatch settle (huge `dt`) so verification stays
  accumulate + 1 spring + 1 skyline. Real Apple GPU: trivial at 60 fps.
- **Headless device-loss.** Keep **all** per-frame readback off the loop; the only `mapAsync` calls are
  the one-shot verify/capture hooks and the idle reconciliation. The `!isHeadless()` canvas gate stays.
- **Frontier-size bound** (`MAX_FRONT`, GPU staircase). Clamp the compact `atomicAdd`; assert in the
  verify hook.
