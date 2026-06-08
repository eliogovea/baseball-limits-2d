# `poc-webgpu` — browser WebGPU twin of the native Vulkan POC (design)

## Context

`poc-vulkan/` proved a GPU event-streaming architecture natively (C/Vulkan/MoltenVK): a merged
date-sorted event stream resident on the GPU → a **compute shader accumulates** each frame's new
event window into persistent per-player `(HR, SB)` counters → the **vertex shader renders straight
from that buffer** (no CPU readback), with the **Pareto frontier maintained incrementally on the
CPU** (monotone events ⇒ ≤1 insert + a contiguous eviction run per event) and drawn as a staircase.

The goal here is to **adopt that architecture in the browser via WebGPU**, as the path toward
**pitch-by-pitch event volumes** (10⁶–10⁹ events; see `README.md` Phase 2 and
[`pbp-rendering-design.md`](pbp-rendering-design.md) §Backend). It also delivers the still-pending
web **incremental-frontier** math (`pbp-rendering-design.md` §5 Phase 2: "the Pareto sweep still
runs full each frame").

Decisions locked with the user:
- **Standalone `poc-webgpu/`** (a new page), *not* the main app — the browser twin of `poc-vulkan`,
  so it can't touch or risk the deployed site. Main-app integration is a later phase.
- **GPU does compute-accumulate + render** (the scalable pitch-by-pitch model), **frontier stays
  incremental in JS** (proven in `poc-vulkan`, tiny).
- **Scope: career + season open-year** semantics.

This mirrors `pbp-rendering-design.md`'s stance: WebGPU is a self-contained learning/scaling track
behind a capability check, never the deployed site's only renderer.

## What exists to reuse

- **`evt-demo.js`** — standalone full-history HR×SB animation already does the STEV decode
  (`fetchDecode` via `DecompressionStream("gzip")`, `decodeStev` at evt-demo.js:9–86) and a Canvas-2D
  draw + scrubber/play loop. The WebGPU POC reuses `fetchDecode`/`decodeStev` verbatim and replaces
  the Canvas-2D render with the WebGPU pipeline.
- **`data/pbp/hr.evt.gz`, `sb.evt.gz`** — committed STEV streams (~11,131 batters, 520,200 events,
  1871–2025); the same data `poc-vulkan` uses. Spec: [`pbp-evt-format.md`](pbp-evt-format.md).
- **`poc-vulkan/`** — the reference for buffer layout, the `accumulate.comp` logic, the incremental
  frontier (`frontier_apply_event`, `build_staircase`), and the headless snapshot/invariant harness.

## Architecture (standalone `poc-webgpu/`)

```
hr/sb.evt.gz ──fetchDecode/decodeStev (reused)──► per-player (date,cum) series
        │  merge both files' per-event increments → ONE date-sorted event list
        │  {player, stat(0=HR,1=SB), count}; union players by name
        ▼  upload once to a GPU storage buffer (resident)
  per frame (cursor at global date d):
    JS advances applied → target over the date-sorted events (forward scan)
    ├─ GPU compute (WGSL): for the new [applied,target) slice, atomicAdd into
    │     persistent hr[], sb[] storage buffers (reset+replay on backward seek)
    ├─ JS incremental frontier: apply the same event window to a shadow hr/sb +
    │     the sorted staircase (monotone insert/evict); write onFront[] + the
    │     staircase line vertices to small buffers (mirror poc-vulkan exactly)
    └─ GPU render: vertex-pull points from hr[]/sb[] (era-coloured, frontier red),
          then the frontier staircase as a line strip. No CPU readback of state.
```

- **Event model.** Counting/monotone axes only (HR, SB, and sums like TB/PA) — exactly where the
  incremental frontier is valid. Rate axes are out of scope for the POC (they break monotonicity).
- **Buffers** (WebGPU storage buffers, `std`-packed): `events` (player,stat,count ×3 u32, resident),
  `hr`/`sb` (u32 per player, GPU compute target via `atomicAdd`, vertex reads), `debut` (u32 per
  player, era colour), `onFront` (u32 per player, JS writes), `staircase` (vec2 line strip, JS
  writes). `hr`/`sb` zeroed (and re-zeroed on wrap) with a clear pass or `writeBuffer`.
- **WGSL shaders** (inline strings or `poc-webgpu/shaders/*.wgsl`): `accumulate` (compute,
  workgroup 64, atomicAdd — WGSL `atomic<u32>`), `points` (vertex-pull + frag, era colour / red
  highlight, round point via the same disc test), `line` (staircase strip).
- **Cursor / wrap.** Career: cursor sweeps all of history; on loop or backward seek, zero `hr`/`sb`
  and reset the JS frontier + shadow, then replay forward (forward-only accumulation, as in
  `poc-vulkan`). **Season open-year:** completed seasons contribute static totals (one upload at the
  year boundary, like the main app's cached completed-season slice); only the open season's events
  stream per frame — the frontier merges the static completed-season frontier with the incrementally
  maintained open-season points (mirrors `buildSmoothActiveFrontier`).
- **Frontier in JS.** Port `frontier_apply_event` + `build_staircase` from `poc-vulkan/main.c`
  (sorted-by-x staircase, vertical-first steps, caps to both axes). Write `onFront[]` and the
  staircase vertices to the GPU buffers each frame.

## Files (new, flat — mirrors poc-vulkan / evt-demo)

- `poc-webgpu/index.html` — canvas + scrubber/play (copy evt-demo's shell).
- `poc-webgpu/main.js` — decode (reuse evt-demo's functions, or import), WebGPU device/pipeline
  setup, the per-frame compute+render+frontier loop.
- `poc-webgpu/shaders/{accumulate,points,line}.wgsl` (or inline) — WGSL.
- `poc-webgpu/README.md` — what it is, how to run, the architecture, browser/WebGPU notes.

## Verification

- **Correctness invariant (the T3 gate):** like `poc-vulkan`, assert the **incremental frontier ==
  brute-force O(N²) frontier** (as a coordinate set) at a fixed cursor, and **GPU `hr`/`sb` == a JS
  replay** — expose both on `window.__bl2d_*` and read via `scripts/snap.js` evalJS. Spot-check
  end-of-history: maxHR=762 (Bonds), maxSB=1406 (Henderson); the all-time frontier is just those two.
- **Headless render.** `scripts/snap.js` drives Chrome (CDP); WebGPU in headless Chrome needs the
  right flags (`--enable-unsafe-webgpu` / ANGLE) — verify availability first and, if the sandbox's
  headless Chrome can't get a GPU adapter, fall back to reading back the GPU `hr`/`sb` buffer +
  asserting the invariant (the render image is secondary; the architecture is the point). Capture a
  mid-sweep + end-of-history screenshot when a device is available.
- **Capability check.** `navigator.gpu`/`requestAdapter()` absent → show a clear message (the POC is
  WebGPU-only by design; the deployed app keeps its Canvas-2D path untouched).

## Phasing

1. **Standalone `poc-webgpu` (this design):** WebGPU compute-accumulate + render + JS incremental
   frontier over HR/SB `.evt`, career + open-season, with the correctness invariant. Proves the
   architecture in-browser.
2. **Scale test toward pitch-by-pitch:** stress with synthetic high-volume event streams (or a
   denser `.evt`) to validate the event-window compute at 10⁶–10⁸ events; revisit the README Phase-2
   state model (sliding window / decay) if accumulation-forever becomes the bottleneck.
3. **Main-app integration (later):** lift the proven pipeline into `script.js` as a flagged
   `?renderer=webgpu` `PointRenderer` backend with **mandatory Canvas-2D fallback**
   (`pbp-rendering-design.md` §2, Phase 5) — and land the JS incremental frontier as the general
   Phase-2 fix regardless of backend.

## Notes / risks

- **WebGPU support / fallback:** broad in 2026 but not universal; the POC is explicitly WebGPU-only,
  the deployed multi-file app and offline `dist/` bundle stay on Canvas 2D (no new CDN deps).
- **Atomics:** WGSL core `atomic<u32>` add — same constraint as `poc-vulkan` (uint atomics, no float
  atomics needed).
- **Data extent:** batting, 1871–2025; pitch-by-pitch needs a non-Lahman source (Retrosheet;
  licensing — see `project_future_enhancements`), so Phase 2 uses synthetic/derived volumes until
  real PBP data lands.
- Keep the flat POC style (see `poc-vulkan`): one `main.js` + WGSL + a thin HTML shell, no
  abstraction layers.
