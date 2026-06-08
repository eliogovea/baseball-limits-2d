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

1. **Incremental frontier (JS), backend-agnostic.** Land `IncrementalFrontier` in
   the `.evt` streaming path; verify against `core.c`. Ships value on the *current*
   Canvas-2D renderer immediately (no WebGPU needed). *T3 — algorithmic.*
2. **`PointRenderer` seam.** Refactor `drawCanvasPointLayer` call sites behind the
   interface; `Canvas2DRenderer` is a no-op wrapper. Pure refactor, fully covered
   by existing snapshots. *T2.*
3. **`WebGPURenderer` behind `?renderer=webgpu`.** Instanced cloud (bg/fg buffers),
   capability check + fallback ladder, export via Canvas-2D copy. Frontier stays
   SVG. *T3/T4 — new rendering backend.*
4. **Stretch: GPU frontier staircase + (later) GPU compute-accumulate** for the
   streaming mode (the POC's `accumulate.wgsl`), and the **deferred `core.wasm`**
   path once pitch-by-pitch volumes land. *Separate session.*

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
