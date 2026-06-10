# `poc-webgpu-spring` — GPU spring motion + GPU Pareto skyline + fully-GPU staircase (WebGPU)

The browser **WebGPU twin** of [`../poc-vulkan-spring`](../poc-vulkan-spring), and the spring
evolution of [`../poc-webgpu`](../poc-webgpu). Same MLB **(HR, SB)** history sweep, but the motion
and the frontier are now computed on the GPU — and, unlike the Vulkan twin, **the frontier staircase
is built entirely on the GPU too**. Full design: [`../docs/gpu-spring-skyline-design.md`](../docs/gpu-spring-skyline-design.md).

**Career-only** by design (the baseline `poc-webgpu`'s season mode is out of scope here).

## The GPU frame graph (one command encoder; separate passes serialize)

```
accumulate.wgsl  atomicAdd the new [lo,count) event slice into hr/sb   (UNCHANGED from baseline)
      │                                                                 hr/sb are the spring TARGET
spring.wgsl      glide pos[] toward (hr,sb), critically damped (no overshoot); update vel[]
      │
skyline.wgsl     onFront[i] = 1 iff no j dominates pos[i]   (brute-force O(n²), exact, no tiling)
      │
staircase.wgsl   compact on-front ids → rank-sort by x (O(K²)) → emit step verts + an indirect
      │          draw count — the whole frontier line, built ON THE GPU
      ▼
points.wgsl  instanced-quad cloud, vertex-pull from pos[] (+Y up, disc test), era colour + highlight
line.wgsl    the staircase, drawn via drawIndirect(bIndirect) — vertex count came from the GPU
```

The CPU/WASM core (`core.c`) now does almost nothing per frame: `step_career` only computes the
event slice `[lo,count)` and the wrap/scrub-back flag — **the CPU incremental frontier was dropped
from the live path** (the GPU owns the picture). That frontier survives only inside `verify_career()`,
which does a self-contained full replay on demand as the headless verification oracle. Even the name
labels are sourced from a GPU read-back of `onFront`/`pos` (see below), not from any CPU frontier.

### Why the staircase is fully-GPU here (the key difference from the Vulkan twin)

`poc-vulkan-spring` reads `pos[]`/`onFront[]` back over Apple's host-coherent unified memory and
builds the staircase on the CPU — essentially free. **WebGPU can't**: a per-frame GPU→CPU readback is
async (`mapAsync`) and, under headless Chrome, the documented trigger that *loses the device*. So we
keep **all per-frame readback off the render loop** and build the staircase with three tiny compute
passes:

1. **compact** — one thread/player; append on-front player ids into `frontIdx[0..K)` via an atomic
   counter (`K` = frontier size).
2. **ranksort** — one thread/frontier-slot; O(K²) rank (count how many others have a smaller x, ties
   broken by index), scatter each position into `frontSorted[rank]`. Trivial at K ≈ tens.
3. **emit** — one thread/sorted-slot; write the two step vertices (corner + vertical drop); thread 0
   writes the cap vertex and `indirect.vertexCount = 1 + 2K`. The line is then drawn with
   `drawIndirect` — the count never touches JS.

`onFront` (the dot highlight) is pure-GPU on both twins; only the ordered staircase needed this.

### WGSL-vs-Vulkan/GLSL deltas (all mechanical)

- No push constants → `{lo,count}`, `{maxX,maxY,…}`, `{dt,omega,n}` ride in **uniform buffers**.
- No point primitive / `gl_PointSize` → **instanced quads** (`draw(6, N)`) + a fragment disc test.
- WebGPU NDC is **+Y up** → no y-flip (Vulkan's clip space is +Y down and flips).
- `atomicAdd` → WGSL `atomic<u32>` storage; the spring reads those same buffers through a non-atomic
  read-only view (a plain read with no concurrent writers).
- `'target'` is a **reserved word** in WGSL — the spring uses `tgt`.

## Layout

```
core.c                  WASM core: STEV decode + per-frame slice; verify_career = self-contained replay oracle
main.js                 WebGPU device/buffers/pipelines + the frame graph above + verify hooks
shaders/accumulate.wgsl event slice → atomicAdd into hr/sb     (UNCHANGED)
shaders/spring.wgsl     NEW: critically-damped glide of pos[]/vel[] toward (hr,sb)
shaders/skyline.wgsl    NEW: per-frame brute-force Pareto frontier over pos[] → onFront[]
shaders/staircase.wgsl  NEW: compact → ranksort → emit, the fully-GPU staircase (3 entry points)
shaders/points.wgsl     vertex-pull from pos[] (was hr/sb) + debut + onFront; instanced quad + disc
shaders/line.wgsl       the staircase line-strip (drawn via drawIndirect)
index.html, Makefile, snap-webgpu.js
```

## Build & run

```
brew install emscripten        # provides emcc
make                           # compile core.c → core.js + core.wasm (the WebGPU layer is JS)
make serve                     # python3 -m http.server 8000, from the repo root
# open http://localhost:8000/poc-webgpu-spring/  — press ▶ to watch the dots GLIDE
```

Serve from the **repo root** so `../data/pbp/*.evt.gz` resolves.

## Verifying it works (headless)

Headless Chrome can't present a WebGPU canvas (configuring one loses the device), so the harness
renders **offscreen** and reads pixels back, and the invariants read GPU buffers back **once** in a
hook — never in the render loop. `snap-webgpu.js` launches Chrome with WebGPU enabled and runs an
`evalJS` payload:

```
# four invariants (drive to end of history, settle the springs, read the GPU buffers back once):
node snap-webgpu.js "http://localhost:8000/poc-webgpu-spring/" /tmp/v.png 1100 820 5000 \
  '(async () => JSON.stringify(await window.__bl2d_verifyCareer()))()'
# → {"frontierMis":0,"frontierSize":2,"counterMis":0,"springMis":0,"skylineMis":0,
#    "maxHR":762,"maxSB":1406,"bonds":{...onFront:true},"henderson":{...onFront:true}}

# offscreen visual capture (writes the returned data:image/png to the out path):
node snap-webgpu.js "http://localhost:8000/poc-webgpu-spring/" /tmp/img.png 1100 820 5000 \
  '(async () => await window.__bl2d_capture(window.__bl2d_numDates()-1))()'
```

- `counterMis 0` — GPU `hr/sb` == the WASM shadow (accumulate correct).
- `springMis 0` — settled `pos` == integer `(hr,sb)` within ½ unit (the spring converges; the
  *gliding path* is the live-only effect, the *end-state* is what's verified).
- `skylineMis 0` — the GPU `onFront` == the CPU oracle `onFront`.
- `frontierMis 0` — the CPU oracle frontier == a brute-force O(n²) Pareto set (gates the oracle).

A mid-history capture (e.g. `__bl2d_capture(12200)`) shows a multi-step staircase — proof the
fully-GPU compact→rank-sort→emit→`drawIndirect` path handles K > 2 correctly.

## Scope

Phase-1 career replay, now with GPU spring motion + a per-frame GPU frontier + a fully-GPU staircase.
The same GPU-staircase kernels could be back-ported to `poc-vulkan-spring` (`vkCmdDrawIndirect`) for
full parity; the Vulkan twin currently uses a CPU staircase by choice. See the design doc.
