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
3. **`WebGPURenderer` behind `?renderer=webgpu`.** Instanced cloud (bg/fg buffers),
   capability check + fallback ladder, export via texture readback. Frontier stays
   SVG. *T3/T4 — new rendering backend. **Detailed design below.***
4. **Stretch: GPU frontier staircase + (later) GPU compute-accumulate** for the
   streaming mode (the POC's `accumulate.wgsl`), and the **deferred `core.wasm`**
   path once pitch-by-pitch volumes land. *Separate session.*

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
