# Rendering — canonical reference

**Direction (decided 2026-06-12, binding):** the committed rendering destination is the
**G-track** — one full-GPU engine (WebGPU) that renders *and* computes the entire chart:
dots, frontier, HV shade, overlays, axes, and text. Canvas2D+SVG remains the shipped
default and the **permanent fallback** (no-WebGPU, device loss, headless, the offline
bundle) until the G-track reaches parity (G6 graduates the flag); even then Canvas2D is
kept, not deleted. The Phase-5 `gpustream` engine is a stepping stone that the G-track
absorbs at G5 (a streaming scene is just a scene whose `pos[]` is computed instead of
uploaded). Phase ordering and status live in [`ROADMAP.md`](ROADMAP.md).

## The render paths today

| Path | Gate | Where | Covers |
|---|---|---|---|
| **Canvas2D + SVG** (default) | always | `drawScatterPlot` + `Canvas2DRenderer`, `script.js` | everything: axes, staircase, HV shade, depth layers, era-vs-era, ghost frontier, labels w/ collision avoidance, hover rings, regret lines, FLIP, quadtree hit-test |
| **WebGPU point cloud + GPU accumulate** (Phases 3–4) | `?renderer=webgpu` | `WebGPURenderer`, `script.js:~3583–4297` | `.evt`-career cloud on GPU (compute-accumulate + instanced quads); JS incremental frontier stays authoritative; staircase/axes stay SVG |
| **gpustream** (Phase 5) | `?renderer=webgpu&gpustream=1` | spring/skyline/staircase WGSL in `script.js:~3325–3575` | full-GPU streaming: accumulate → spring → skyline → staircase (`drawIndirect`); zero per-frame readback; CPU only clocks the cursor |
| **G-track** (G0 shipped) | `?renderer=webgpu&gpugraph=1` | `webgpu-graph.js` (`GraphRenderer`) | retained-scene GPU dot renderer for static modes; data-space buffers + scale uniform; G1–G6 extend to frontier/HV/text/overlays/interaction |

The architecture splits work between two layers everywhere: **high-cardinality,
low-semantic** content (the point cloud, trails) on canvas/GPU; **low-cardinality,
high-semantic** content (axes, labels, legend, tooltip, cards) in SVG/DOM — until G3,
when the G-track moves chart-internal text onto a GPU glyph atlas (DOM tooltip, sidebar
cards, and spotlight stay DOM, fed by the readback contract).

## Why GPU at all (measured)

- The original SVG circle-join cost **80–105 ms/frame** at ~3.8k dots; the Canvas2D
  migration + static/dynamic split (bg = completed seasons, redrawn at year boundaries;
  fg = open cloud, per frame) took it to a few ms.
- Canvas2D render cost is ~linear (~0.2 ms/1k dots); the GPU compute-accumulate path is
  **flat ~1.0 ms regardless of cloud size** with tighter p95 tails. Both share the same
  CPU model cost (~4 ms `evtPointsAsOf` + frontier), which is exactly what gpustream and
  the G-track move off the CPU. (Full tables: `docs/renderer-performance.md` in git
  history; method = `__bl2d_pbpFrameMs` p50/p95 under headless Chrome/SwiftShader,
  measuring main-thread submit cost.)

## Shared GPU foundations (proven by the POCs, reused everywhere)

- **Incremental Pareto frontier** (CPU): port of `poc-webgpu/core.c`
  `frontier_apply_event` — O(1) amortized per monotone event; reset+replay on backward
  seek. `createIncrementalFrontier` (`script.js:~1264`); `core.c` stays the oracle;
  `?verifyFrontier=1` cross-checks vs a full sweep.
- **GPU skyline**: brute-force O(n²) domination test, one dispatch, exact — the right
  choice at n≈11–20k (sort+prefix-max is the documented ≥10⁵ scale-up; active-set the
  "exploit monotonicity" option; full trade-off analysis incl. the monotone-motion
  theorem in `docs/skyline-gpu-approaches.md`, git history). Sign-aware in the G-track
  (`xSign/ySign` folded into the compare) to cover lower-is-better axes.
- **Critically-damped spring** motion: stable polynomial-`e` integrator
  (`e = 1/(1+wd+½wd²+…)`, `wd = ω·dt`) — unconditionally stable, never overshoots, so
  positions stay monotone for monotone targets. Derivation in the WGSL comments
  (`WEBGPU_SPRING_WGSL`) and `docs/gpu-spring-skyline-design.md` (git history).
- **Fully-GPU staircase**: compact (atomic counter) → rank-sort → emit step verts →
  `drawIndirect` — the frontier size never round-trips to the CPU.
- **Communication discipline**: events uploaded **once per axis change** (resident
  buffer); per frame only ~32 B of uniforms; year-range = an index range into the
  date-sorted stream (no upload); attribute filters = a tiny per-player mask buffer;
  **zero GPU→CPU readback in the live loop** — readback is one-shot (verify hooks) or
  idle-throttled (interaction reconciliation).
- **Headless lessons** (carried verbatim everywhere): configuring a WebGPU canvas under
  HeadlessChrome loses the device → render to an offscreen texture, blit only when the
  canvas is healthy, gate on `/HeadlessChrome/` UA / `navigator.webdriver`
  (`?webgpuHeadless=1` escape hatch); retain the adapter; `depthSlice = UNDEFINED`;
  +Y-up NDC.

## Engine selection & fallback

```
chooseRenderer():  no flag | no navigator.gpu | no adapter | init throws | headless
                   → Canvas2D (first paint is ALWAYS Canvas2D; WebGPU swaps in async)
device.lost        → swapToCanvas2D() mid-session, clean redraw
chooseStreamingEngine(model):
  ?renderer=webgpu && evtGpuMonotone(model).ok && navigator.gpu && !isHeadless()
                   → gpuStreaming, else cpuStreaming
```

The streaming path is **two explicit self-contained engines, not a hybrid** (the GPU
engine consumes events+uniforms, the CPU engine screen-space points — a shared
`setForeground(points)` seam would be a lie for the GPU path). Shared between them:
data only (model load, event stream, metadata, SVG chrome). Separate: frontier
(CPU `IncrementalFrontier` vs GPU skyline), cloud, staircase, motion, loop. The offline
`dist/` bundle is Canvas2D-only (the WGSL rides along inert; no WASM, no shader fetch).

Export (SVG/PNG) reads back the offscreen texture under WebGPU
(`exportDataURLs()`); Canvas2D returns its layer canvases natively.

## Phase status

### Shipped

- **Canvas migration phases 1–4** — Canvas cloud + quadtree hit-test; static/dynamic
  bg/fg split; incremental frontier; group-career animation (trails + heads,
  `pbpBuildGroupCareer`). Frame p95 ≈ 2 ms.
- **WebGPU integration Phases 1–5** —
  1. `IncrementalFrontier` (JS, backend-agnostic);
  2. `PointRenderer` seam (`Canvas2DRenderer` behind a narrow interface;
     `resize/clear/drawBackground/drawTrails/drawForeground/drawFrontierDots/present/exportDataURLs`);
  3. `WebGPURenderer` behind `?renderer=webgpu` (instanced 6-vert quads, vertex-pull
     SoA instance buffers, disc+ring fragment matching Canvas2D to sub-pixel, fallback
     ladder);
  4. GPU compute-accumulate cloud (`accumulate.wgsl` generalized to any monotone
     counting axis via `evtGpuMonotone` coefficients; JS frontier authoritative);
  5. gpustream (`&gpustream=1`): accumulate → spring → skyline →
     compact/ranksort/emit → `drawIndirect`. Verified `__bl2d_verifySpring`
     (springMis 0, skylineMis 0, frontier = Bonds 762/514 + Henderson 296/1406).
     **Known deviation:** the cheap JS frontier still runs live to feed
     DOM/interaction; the throttled idle `onFront` readback that replaces it is a
     pending follow-up (absorbed by the G-track readback contract, G1/G5).
- **G0** — retained-scene GPU dot renderer (`webgpu-graph.js`, bundler split, 4
  optional-chained hooks in `script.js`). Gate green on the bundle: dotCount==N,
  posMis 0, zoom/resize re-uploads nothing. Finding: smooth is the default view on
  this branch, so the `file://` bundle is the G0 verification vehicle for static frames.
- **G1** — sign-aware GPU frontier over the retained scene (`sceneSkyline` + `compact`
  in `webgpu-graph.js`) + the readback contract's mechanism (double-buffered
  fire-and-forget `mapAsync` of `bCount`+`bFrontIdx` → `g.front`; cards stay CPU-fed
  until G5). The scene now uploads the FULL deduped cloud — the cloud shader
  degenerates on-front instances, so the render is unchanged until G2. Gate green on
  the bundle: skylineMis 0 / frontMis 0 / cardPidsMatch across 20 random axis combos
  incl. ERA↓, BB/9↓ and the worst-frontier toggle; uploads & frontReads stay 1 across
  identity-preserving redraws; Henderson on-frontier; `verifySpring` regression green.

### Pending (ordering in ROADMAP.md)

- **G1–G6** (the G-track, the committed destination) — see the full design below.
- **Season GPU animation (S-track)** — extend the spring engine to season mode;
  folded in as a G-track follow-on. Design below.
- **Deferred:** `core.wasm` in the app (only if pitch-by-pitch volumes, 10⁶–10⁸
  events, ever land — JS decode/frontier bottleneck threshold); SDF text upgrade
  (if continuous-zoom sharpness ever matters); click-only R32Uint picking pass (if
  target-position hit-testing mis-picks during glides).

---

## G-track design (G1–G6)

**The key insight:** gpustream already proves every hard primitive (resident data-space
`bPos`, GPU skyline, fully-GPU staircase, vertex-pull cloud, zero-readback `present()`,
one-shot verify harness). The G-track generalizes: where the streaming engine *computes*
`pos[]` (accumulate → spring), the static engine *uploads* `pos[]` once per refresh;
everything downstream (skyline, staircase, render) shares the same `pos[]` contract.

**Load-bearing decision — data-space buffers + scale uniform:** every GPU buffer stays
in DATA space; zoom/pan/resize writes only `uScene` (~64 B: slope/intercept ×2,
viewport, dpr, originDrop, xSign/ySign, anti/ideal corners, gradFlags) and re-presents.
Never re-upload on a view change.

**Scene buffers (SoA, reusing streaming names):** `bScenePos` (vec2 data-space — uploaded
static, OR aliased to the spring's `bPos` in stream mode), `bSceneColor` (packed RGBA8),
`bSceneSize`, `bSceneFlags`, `bOnFront`, staircase scratch
(`bFrontIdx/bFrontSorted/bCount/bStaircase/bIndirect`), `bHv` (G2), `bArcLen` (G4,
dashed ghost), `bGlyphInstances` (G3).

**Pass graph:** compute block (skyline → compact → ranksort → emit → hvContrib) runs
**only on scene-dirty frames**; every present renders hvShade → depth layers → cloud
pass 0 (non-front) → ghost → stairline → cloud pass 1 (front, HV radii, ring) →
hover/regret → axes → glyphs, into the offscreen texture, then blit.

**Frame loop:** one owner (`graphLoop`) with damage flags
`{scene, scale, overlay, motion}`; idle = no rAF scheduled. Subsumes `springLoop`. The
spring becomes the single motion system — including the static-mode filter-change FLIP
(write new targets, glide; staircase cross-fades via prev/new buffers).

**Text:** pre-rasterized two-tier glyph atlas (static page: digits/punctuation/Latin-1 +
diacritics, rebuilt on dpr change; overflow page on demand), Canvas2D-rasterized,
instanced textured quads. Tick formatting (d3-format) and label collision layout
(`layoutFrontierLabels`) stay CPU — sequential greedy over tiny N, and the rects double
as hit-rects. Not SDF (documented upgrade).

**Compute:** sign-aware skyline (one shader, four orientations; `originDrop` gated for
stream-vs-static); GPU HV contributions via O(1) neighbor-merge
(`contrib[r] = (x[r]−x[r−1])·(y[r]−y[r+1])` in signed space) vs the CPU
`computeHvContributions` oracle ≤1e-6 rel; depth layers = iterative skyline peeling
(≤5, dirty-frames only); era-B = second instance set + second frontier run; ghost
dashed via per-vertex arc length from the extended emit pass. **Career-mode aggregation
stays CPU** (data prep, string keys, no parallelism worth the round-trip).

**Interaction:** CPU quadtree stays (exact for static; target positions during glides);
hover ring + regret line are one-instance dynamic buffers; axis-title click zones are
the CPU-laid-out glyph rects. **Readback contract:** on scene-dirty frames, tiny
double-buffered fire-and-forget `mapAsync` of `bFrontSorted+bHv+bCount` feeds
cards/tooltip/quadtree — render never waits on a map.

**Convergence staging:** G0–G4 build the upload path *beside* the streaming path (zero
shared code, regression-free by construction); G5 converges both `present()`s into one
scene-descriptor method (`{posBuf, …, source: "upload"|"spring"}`) behind a
`legacyPresent` switch, gated on `verifySpring` staying green. G6 graduates the flag
(`?renderer=webgpu` alone enables the graph; `?gpugraph=0` is the escape hatch) and
keeps Canvas2D as the permanent fallback.

### Phase table

| Phase | Goal | New WGSL | Verify gate (headless, `__bl2d_verifyGraph`) |
|---|---|---|---|
| **G0** ✅ | retained-scene dots; data-space coord model; bundler split | `sceneCloud` | dotCount == filtered N; readback pos == uploaded |
| **G1** ✅ | sign-aware GPU frontier + readback contract | `sceneSkyline` (+`compact`) | GPU onFront == CPU sweep, 20 random combos incl. ERA↓; readback set == cards; Henderson 1982 SB=130 on-frontier |
| **G2** | staircase + HV shade + HV contributions | `hvContrib`, `hvShade` | bHv == `computeHvContributions` ≤1e-6 rel; radii match; ERA↓ shade quadrant |
| **G3** | GPU text: atlas, axes, ticks, titles, labels | `glyphs`, `axes` | glyph count == Σ string lengths; ticks == d3-format; atlas covers every codepoint |
| **G4** | overlays: depth layers, era-B, ghost (dashed), cross-fade | `depthLayers`, `stairGhost`, emit+arcLen | layers == CPU onion-peel (`__bl2d_depthLayers`); ghost == CPU global-ref; dash stable under zoom |
| **G5** | interaction + spring-FLIP + loop owner + **stream convergence** | `hoverRing`, `regretLine` | picks == CPU quadtree + `computeDistToFrontier`; idle parks rAF; `verifySpring` green on converged path |
| **G6** | graduate flag; keep Canvas2D fallback | — | full parity matrix in one headless run; device-loss recovery |

Each gate is one headless command:
```
node scripts/snap.js "http://localhost:8000/?renderer=webgpu&gpugraph=1&webgpuHeadless=1#<view>" \
  /tmp/gN.png 1440 900 2500 'window.__bl2d_verifyGraph({...})'
```
Verification is **invariant hooks, not pixel-diff** (AA/font raster make pixel-diffing
GPU vs SVG brittle). Real-GPU visual checks ride the per-branch Pages previews
(ROADMAP §Infrastructure).

**Risks:** G5 convergence edits the proven `present()` (mitigated: zero shared code
through G4, `legacyPresent` rollback); atlas coverage/quality (two-tier + SDF upgrade
path); 5×O(n²) depth-layer cost (dirty-frames only; cap input to prior complement);
HV reference-corner epsilon/sign parity (test ERA↓ early).

---

## Season GPU animation (S-track; folded in after the G-track foundation)

Today the spring engine smooths only **career** mode; season mode runs the CPU cloud at
~15 fps. **Key insight:** a season value is the career counter differenced against the
season start — `seasonValue = cum(d) − cum(seasonStart(O)−1)` — and the GPU already
maintains career counters `bX/bY`. So season mode needs only per-player **baseline
buffers** (`baseX/baseY`, snapshotted by `copyBufferToBuffer` when the cursor crosses a
season boundary; split a straddling window at the boundary; backward seeks replay
`[0, seasonStart)` → snapshot → replay rest) and a spring target of `bX − baseX`
(a `seasonMode` uniform in the spring shader).

Three sub-problems: (1) the open-season moving cloud (small, spring-glided — the
visible win); (2) completed seasons stay on the static bg layer, rebuilt only when the
open year advances; (3) frontier over the union via a **hybrid skyline** — CPU keeps the
completed-season frontier (static between years, ≤ few hundred points), GPU skyline runs
over (completed-frontier ∪ open points), bounded by `WEBGPU_MAX_FRONT`.

Phases (each shippable, with `__bl2d_verifySeason` gates): **SA0** gating + active set →
**SA1** GPU season targeting (correctness core; `seasonMis 0` incl. boundary crossing +
backward scrub) → **SA2** render the sprung open cloud + glide loop → **SA3** hybrid GPU
frontier (`skylineMis 0`, season-record spot-check) → **SA4** polish (rate axes excluded
as in career; bats/country mask still forces CPU; README/CLAUDE updates). Invariant:
career counters are never mutated by the season path, so career↔season mid-play stays
exact. Key seams: `evtOpenSeasonPoints`/`evtAsOf`, `seasonStartByYear`/`yearOf`,
the `gpuCloud`/`gpuSpring` gates, `accumulateCloud`, `WEBGPU_SPRING_WGSL`,
`springLoop`/`presentGlide`.

---

## Shipped analytics on the render path (one-line records)

- **Pareto depth (onion peeling)** — recursive frontier peeling ≤5 layers, faded
  staircases, `__bl2d_depthLayers` oracle (shipped a54bd6a; design in git history,
  `docs/pareto-onion-peeling-design.md`). The G4 GPU peeling must match it.
- **HV contributions** (frontier dot radius = sqrt of leave-one-out hypervolume),
  **distance-to-frontier (regret)**, **era-vs-era overlay**, **ghost frontier**,
  **FLIP transitions**, **frontier leaderboard / spotlight / search** — all CPU/SVG
  features the G-track phases reproduce on the GPU; their CPU implementations are the
  oracles.

## POCs (reference implementations; no runtime linkage to the app)

| POC | Proves |
|---|---|
| `poc-vulkan` | native Vulkan/MoltenVK event-streaming + CPU incremental frontier |
| `poc-vulkan-spring` | native GPU spring + GPU skyline (CPU staircase via unified memory) |
| `poc-webgpu` | browser twin: C→WASM core + JS WebGPU; compute-accumulate; headless offscreen+readback capture |
| `poc-webgpu-spring` | GPU spring + skyline + **fully-GPU staircase** (compact→ranksort→emit→drawIndirect) |
| `poc-webgpu-c` | all-C WebGPU app (emcc + emdawnwebgpu), reusing `poc-webgpu/core.c` |

They consume `.evt` and are deliberately **not ported** to BL2S (their READMEs get a
one-line note at S3d; data stays in git history). All POC and GPU code carries the
project's verbose pedagogical comments — that standard is a hard requirement for new
GPU code (`script.js:3357–3575` is the reference density).
