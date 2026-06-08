# poc-webgpu — browser WebGPU twin of poc-vulkan

A standalone page that runs the same GPU event-streaming architecture as
[`poc-vulkan/`](../poc-vulkan), but in the browser via **WebGPU + WASM**:

- a **compute shader accumulates** each frame's new event window into persistent
  per-player `(HR, SB)` counters on the GPU (`atomicAdd`);
- the **vertex shader renders straight from those buffers** (no CPU readback) —
  each point is an instanced quad (WebGPU has no point primitive);
- the **Pareto frontier is maintained incrementally in a WASM core** (`core.c`),
  which is `poc-vulkan/main.c`'s host logic reused almost verbatim.

Two modes: **Career** (cumulative totals sweeping all of history) and **Season**
(open-year: completed seasons are static points, the open season streams in, the
frontier is the Pareto merge of the two — mirrors the web app's
`buildSmoothActiveFrontier`).

## Architecture

```
hr/sb.evt.gz ──JS fetchDecode (DecompressionStream gunzip)──► raw STEV bytes
        │  → WASM core decodes/merges/sorts → date-sorted event list + debut[]
        ▼  JS uploads packed events + debut ONCE to GPU storage buffers
  per frame (JS scrubber advances a global cursor date d):
    JS calls WASM step_career(d) / step_season(d):
      └─ replays the new [lo,target) window into the shadow counters, runs the
         incremental frontier, builds the staircase → writes onFront[] +
         staircase[] into WASM heap; returns {lo, cnt, zeroGpu, lineVerts, …}
    JS (WebGPU):
      ├─ uploads onFront[] / staircase[] (zero-copy HEAP views) to the GPU
      ├─ if zeroGpu: zeroes GPU hr/sb (wrap / season year boundary)
      ├─ compute dispatch `accumulate` over events[lo, lo+cnt)
      └─ render: instanced point quads + the frontier staircase line strip
```

GPU `hr`/`sb` are authoritative for the picture; the WASM shadow drives the
frontier + invariant — exactly poc-vulkan's split, no per-frame readback.

## Build & run

Needs **emscripten** (`brew install emscripten`, or emsdk). The built
`core.js` / `core.wasm` are committed, so you only rebuild after editing `core.c`.

```sh
make                          # emcc core.c -> core.js + core.wasm
cd .. && python3 -m http.server 8000
# open http://localhost:8000/poc-webgpu/
```

Serve from the **repo root** (not this folder) so `../data/pbp/*.evt.gz` resolves.
WebGPU-only by design: a browser without `navigator.gpu` shows a clear message;
the deployed multi-file app and offline `dist/` bundle stay on Canvas 2D.

## Verify (headless)

`snap-webgpu.js` is a POC-local clone of `scripts/snap.js` that launches Chrome
with WebGPU enabled (the shared snap.js uses `--disable-gpu`, which kills it).

```sh
# career invariant + spot-checks + a screenshot
node snap-webgpu.js "http://localhost:8000/poc-webgpu/" /tmp/career.png 1100 820 4000 \
  '(async () => JSON.stringify(await window.__bl2d_verifyCareer()))()'

# season invariant
node snap-webgpu.js "http://localhost:8000/poc-webgpu/" /tmp/season.png 1100 820 4000 \
  'JSON.stringify(window.__bl2d_verifySeason())'
```

The invariant gate (the T3 check) — both run in the WASM core, no GPU needed:

1. **GPU counters == WASM shadow** — element-wise `hr`/`sb` (GPU readback) vs the
   C replay at end-of-history. Expect `counterMis: 0`. (Skipped if no adapter.)
2. **Career: incremental frontier == brute-force O(N²)** — `frontierMis: 0`.
3. **Season: combined frontier == an independent full Pareto sweep** —
   `frontierMis: 0`.

Spot-checks: career end-of-history is **Bonds HR=762** and **Henderson SB=1406**,
the all-time career frontier is just those two. Season endpoints are the
single-season HR / SB record holders.

## Notes

- WebGPU has no push constants → `{lo,count}` and `{maxX,maxY,ptSize,aspect}`
  ride in uniform buffers. No point primitive → instanced quads + a disc test.
- The WASM core is **GPU-agnostic** on purpose, so a future all-C spike
  (Emscripten `<webgpu/webgpu.h>`) can reuse it.
- Flat POC style, no abstraction layers: `core.c` + `main.js` + WGSL + a thin
  HTML shell.
