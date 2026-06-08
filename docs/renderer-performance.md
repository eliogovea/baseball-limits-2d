# Renderer performance — Canvas 2D vs WebGPU compute-accumulate

Measured comparison of the two point-cloud renderers (`Canvas2DRenderer` — the
default/fallback; `WebGPURenderer` with the GPU compute-accumulate path) on the
`.evt` play-by-play **career** animation. This is the empirical backing for the
"WebGPU compute-accumulate" backlog item — it quantifies *where* the GPU path helps
and where it doesn't (yet).

## Method

- **Workload:** `.evt`-career playback (full history, 1871–2025), the cursor swept
  from the first date to the last. One `drawScatterPlot` call per rendered frame.
- **Metric:** main-thread frame time from the in-app `recordPbpFrameTiming` hook,
  read via `window.__bl2d_pbpFrameMs`. Each frame's total is split into:
  - **model** — shared CPU work *before* rendering: `evtPointsAsOf` (rebuild every
    player's cumulative point) + the incremental Pareto frontier. Identical for both
    renderers — the renderer swap does not touch it.
  - **render** — the renderer-owned part: Canvas 2D paints N arcs; WebGPU
    GPU-accumulate writes two uniforms + submits one compute dispatch + one instanced
    draw.
- **Sampling:** ~140 frames per run during playback, deduped by the samples-array
  growth; p50 / p95 / mean computed over the per-frame values.
- **Environment:** headless Chrome. **WebGPU ran on software SwiftShader**, and
  `present()` submits GPU work fire-and-forget, so the reported **render time is
  main-thread / CPU-submit cost, not GPU execution time** — which is exactly the
  responsiveness metric that matters (the whole point of offloading the per-point work
  is to free the main thread). GPU execution time would need timestamp queries; on real
  hardware the GPU has far more headroom than SwiftShader.

Reproduce: serve the app (`python3 -m http.server 8000`), then drive playback under
each renderer and read `window.__bl2d_pbpFrameMs` (the probe used lives in the
commit message / can be re-derived from the `recordPbpFrameTiming` hook). Canvas 2D
via `scripts/snap.js`; WebGPU via `poc-webgpu/snap-webgpu.js` +
`?renderer=webgpu&webgpuHeadless=1` (the headless guard otherwise keeps `snap.js` on
Canvas 2D).

## Results

| Workload | Renderer | cloud pts | total p50 | total p95 | model p50 | **render p50** |
|----------|----------|----------:|----------:|----------:|----------:|---------------:|
| HR × SB         | Canvas 2D            | 4,544 | 3.1 ms | 3.7 ms | 1.9 ms | **1.2 ms** |
| HR × SB         | WebGPU (GPU-accum)   | 4,544 | 2.9 ms | 3.4 ms | 1.9 ms | **1.0 ms** |
| G × AB (dense)  | Canvas 2D            | 9,312 | 6.0 ms | 8.1 ms | 4.0 ms | **2.0 ms** |
| G × AB (dense)  | WebGPU (GPU-accum)   | 9,259 | 5.0 ms | 5.9 ms | 4.0 ms | **1.0 ms** |

## Interpretation

- **Render cost is where WebGPU wins, and it scales as predicted.** Canvas 2D is
  ~linear in point count (≈0.2 ms per 1k dots: 1.2 ms → 2.0 ms as the cloud grew
  4.5k → 9.3k). The GPU-accumulate path is **flat at ~1.0 ms regardless of cloud
  size** — the per-point vertex work is on the GPU; the main thread only writes a
  couple of uniforms and submits one compute dispatch + one instanced draw (O(1) in
  point count). At 9.3k the render gap is already 2×; extrapolated to the 50k+ points
  the Canvas-migration item targets, Canvas 2D would be ~10–12 ms/frame while WebGPU
  stays ~1 ms.
- **WebGPU has tighter tails** (p95 5.9 vs 8.1 ms on the dense case) — no per-frame
  allocation / GC churn from rebuilding and uploading an instance array.
- **Total-frame benefit is currently capped** (6 → 5 ms), because the dominant cost is
  the **shared CPU `model` work** (~4 ms: `evtPointsAsOf` + the frontier sort), which
  both renderers pay equally. The renderer swap removes the render bottleneck but not
  the model one.

## Takeaway / next steps

The GPU-accumulate renderer is faster and — more importantly — its render cost **stops
growing with the cloud**, which is the scaling win the feature was built for. The
per-frame total is now bounded by the still-on-CPU frontier math. The remaining stretch
items target exactly that: a GPU frontier staircase + the deferred `core.wasm` path move
the `model` work off the main thread too, at which point the total-frame time should
track the (flat) render cost rather than the (linear) model cost.
