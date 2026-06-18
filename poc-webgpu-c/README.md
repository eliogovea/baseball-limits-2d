# poc-webgpu-c — the "full WASM" POC (all-C WebGPU twin of poc-vulkan)

> **Historical note (S3d):** this POC bundles the `.evt`/STEV stat files
> (`../data/pbp/{hr,sb}.evt.gz`) into `app.data`; those files were **removed** when the main
> app migrated to the BL2S stat layer (see `docs/ROADMAP.md` §S3). The POC was intentionally
> not ported; recover the `.evt.gz` files (and `scripts/build_stat_streams.js`) from git
> history to rebuild it.

**Option 2** from [`docs/rendering.md`](../docs/rendering.md) (original POC design: `poc-webgpu-design.md`, git history): the
**whole app, including the WebGPU orchestration, written in C** against
`<webgpu/webgpu.h>` and compiled to WASM via emcc + the **emdawnwebgpu** port.
The all-C counterpart to [`poc-webgpu/`](../poc-webgpu) (which keeps WebGPU in JS).

It **reuses [`../poc-webgpu/core.c`](../poc-webgpu/core.c) verbatim** — the same
host core (STEV decode, the incremental Pareto frontier, the brute-force
invariant). So the only new code here is the C WebGPU layer (`app.c`): the part
poc-vulkan wrote in Vulkan, here written against `webgpu.h`. Same `core.c` powers
both POCs — one source of truth for the algorithm.

```
gunzip (zlib, in C) ─► core.c decode ─► resident event buffer + frontier shadow
  per frame: step_career/step_season(cursor)  [core.c, reads straight from WASM mem]
    ├─ accumulate.wgsl: atomicAdd the new [lo,cnt) event window into GPU hr/sb
    ├─ points.wgsl: instanced quads vertex-pulled from hr/sb (era colour, frontier red)
    └─ line.wgsl: the frontier staircase
```

Career **and** season open-year, both verified against the same invariants as the
JS twin. Live runs render to the canvas surface; headless renders to an offscreen
texture (canvas present loses the device under headless Dawn, as in the JS twin).

## Build & run

Needs **emscripten 4.0.10+**. `emdawnwebgpu` is a *remote port* — emcc downloads a
pinned Dawn build on the first compile (network required once). The two `.evt.gz`
streams are bundled into MEMFS via `--preload-file` and gunzipped in C with zlib.

```sh
make                          # emcc app.c + core.c + emdawnwebgpu -> app.{html,js,wasm,data}
cd .. && python3 -m http.server 8000
# open http://localhost:8000/poc-webgpu-c/app.html   (WebGPU needs a secure
# context: localhost is fine; over LAN use HTTPS or the chrome insecure-origin flag)
```

Build artifacts are gitignored (the port download is required to build anyway,
and `app.data` duplicates `../data/pbp`).

## Verify (headless)

Reuses [`../poc-webgpu/snap-webgpu.js`](../poc-webgpu/snap-webgpu.js) (WebGPU-enabled
headless Chrome). On boot the app renders end-of-history and prints the invariant
gate; `Module._capture(mode, cursor)` renders offscreen and stashes a PNG on
`window.__bl2dc_png`.

```sh
# invariant gate (printed to console): GPU counters == WASM shadow, frontier == brute-force
node ../poc-webgpu/snap-webgpu.js "http://localhost:8000/poc-webgpu-c/app.html" /tmp/c.png 900 700 5000 '"x"'
#   -> [poc-webgpu-c] RESULT PASS counterMis=0 frontierMis=0 frontierSize=2

# season frontier == independent full Pareto sweep
node ../poc-webgpu/snap-webgpu.js "…/app.html" /tmp/c.png 900 700 4500 \
  '(()=>{ Module._capture(1,18185); return JSON.stringify({mis:Module._verify_season(),size:Module._verify_frontier_size()}); })()'
#   -> {"mis":0,"size":9}

# visual capture (mode 0=career, 1=season)
node ../poc-webgpu/snap-webgpu.js "…/app.html" /tmp/career.png 900 700 4500 \
  '(async()=>{ Module._capture(0,18185); await new Promise(r=>setTimeout(r,1000)); return window.__bl2dc_png; })()'
```

## Notes

- emdawnwebgpu uses the modern `webgpu.h` (string-views, callback-info structs);
  device/adapter requests are async callbacks (no Asyncify; `emscripten_exit_with_live_runtime`).
- Gotcha that cost time: `WGPURenderPassColorAttachment.depthSlice` must be
  `WGPU_DEPTH_SLICE_UNDEFINED` for a 2D attachment (default 0 fails validation and
  invalidates the whole command buffer — compute *and* render silently no-op).
- WebGPU NDC is +Y up (no Vulkan Y-flip); no push constants (uniform buffers); no
  point primitive (instanced quads + disc test) — same as the JS twin.
