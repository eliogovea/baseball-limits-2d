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

WebGPU is the **default, non-optional** renderer (2026-06-13); the paths below are no longer
opt-in flags but the live default, with Canvas2D as the automatic fallback.

| Path | Gate | Where | Covers |
|---|---|---|---|
| **Canvas2D + SVG** (fallback) | WebGPU unavailable / lost / headless / `?renderer=canvas` | `drawScatterPlot` + `Canvas2DRenderer`, `script.js` | everything: axes, staircase, HV shade, depth layers, era-vs-era, ghost frontier, labels w/ collision avoidance, hover rings, regret lines, FLIP, quadtree hit-test |
| **WebGPU point cloud + GPU accumulate** (Phases 3–4) | default (WebGPU available) | `WebGPURenderer`, `script.js:~3583–4297` | `.evt`-career cloud on GPU (compute-accumulate + instanced quads); JS incremental frontier stays authoritative |
| **gpustream** (Phase 5) | default-on when eligible (`?gpustream!=0`) | spring/skyline/staircase WGSL in `script.js:~3325–3575` | full-GPU streaming: accumulate → spring → skyline → staircase (`drawIndirect`); zero per-frame readback; CPU only clocks the cursor |
| **G-track** (G0–G5h shipped) | default (`?gpugraph!=0`) | `webgpu-graph.js` (`GraphRenderer`) | retained-scene GPU chart: dots, sign-aware frontier, staircase, HV shade+contributions, depth layers, era-B/ghost, glyph text, hover/pin interaction overlays; data-space buffers + scale uniform |

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

**Rendering is NON-OPTIONAL (decided 2026-06-13): WebGPU is the renderer, with Canvas2D
as the automatic, SILENT fallback** only when WebGPU is genuinely unavailable. There is
no user-facing renderer toggle anymore — the header carries a **read-only `#renderer-status`
indicator** ("GPU" when WebGPU is live, "CPU" on the Canvas2D fallback) so a visitor can
see which backend is active without being able to switch it. The old "GPU"/"spring"
header pills + the `?renderer=webgpu` opt-in are gone.

```
chooseRenderer():  auto-enable WebGPU. first paint is ALWAYS Canvas2D; WebGPU swaps in async.
  no navigator.gpu | no adapter | init throws | device.lost
                   → graceful SILENT Canvas2D fallback (indicator flips to "CPU"); NO banner
  headless (HeadlessChrome / webdriver) && !?webgpuHeadless
                   → stay Canvas2D (keeps the default-app snap.js checks on CPU)
  ?renderer=canvas → stay Canvas2D (hidden dev hatch, unsupported-browser smoke test)
  ?gpuonly=1       → DEV opt-in: refuse the fallback, show the red #gpuonly-banner instead
                     (so you can prove a frame is genuinely GPU output)
streaming engine (springMode, now DEFAULT-ON):
  evtGpuMonotone(model).ok && navigator.gpu && !isHeadless() && ?gpustream!=0
                   → gpuStreaming (spring), else the hybrid/CPU cloud (auto by eligibility)
```

The streaming path is **two explicit self-contained engines, not a hybrid** (the GPU
engine consumes events+uniforms, the CPU engine screen-space points — a shared
`setForeground(points)` seam would be a lie for the GPU path). Shared between them:
data only (model load, event stream, metadata, SVG chrome). Separate: frontier
(CPU `IncrementalFrontier` vs GPU skyline), cloud, staircase, motion, loop. The offline
`dist/` bundle is a *generated* artifact (build_bundle.py inlines the same JS/CSS/WGSL +
data); it now tries WebGPU like the live site and falls back to Canvas2D gracefully if the
opening browser lacks it — so opening it `file://` on a no-WebGPU machine still shows a
working chart, never the banner.

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
- **G2** — the GPU now owns the whole static envelope: a sign-aware staircase
  (`ranksort`→`emit`, caps at the canonical domain edges, vertices un-folded to data
  space so zoom stays a uniform write), a gradient HV shade (triangle fan from the
  anti-ideal apex; fragment projects onto `uScene.corn`'s ideal→anti axis), HV-sized
  white-ringed frontier dots (`sceneFront`), and HV contributions ported as the EXACT
  leave-one-out-with-fill oracle (one GPU thread per frontier slot re-sweeps the cloud
  excluding that point — NOT the cheap exclusive-corner formula, which would change the
  visible dot radii). CPU SVG shade/staircase/`drawFrontierDots` suppressed under
  `gpuGraph`. Gate green on the bundle across HR×SB, ERA↓×SO, WHIP↓×SO + worst toggle:
  `radiusMis 0` (the authoritative visual gate), `stairVertMis 0`, `shadeQuadrant`
  flips with signs; `hvMis 0` at a maxContrib-normalized f32 tolerance (raw 1e-6 is
  unreachable — a contribution is total−alt of two large HV areas; the radius's sqrt
  compresses it away); `verifySpring` regression green.

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
| **G2** ✅ | staircase + HV shade + HV contributions | `hvContrib`, `hvShade` | bHv == `computeHvContributions` ≤1e-6 rel; radii match; ERA↓ shade quadrant |
| **G3** ✅ | GPU text: atlas, axes, ticks, labels (rotated Y-title → G6e) | `glyphs`, `axes` | glyph count == Σ string lengths; ticks == d3-format; atlas covers every codepoint |
| **G4** ✅ | overlays: depth layers, era-B, ghost (dashed); cross-fade → G5i | `depthLayers`, `stairGhost`, emit+arcLen | layers == CPU onion-peel (`__bl2d_depthLayers`); ghost == CPU global-ref; dash stable under zoom |
| **G5** ✅ | interaction overlays + loop owner + stream convergence (G5d→SVG, G5i deferred) | `regret`, `rings` | picks == CPU quadtree + `computeDistToFrontier`; idle parks rAF; `verifySpring` green on converged path |
| **G6** ◑ | graduate flag (GPU-default shipped); keep Canvas2D fallback | — | **detailed resumable plan below** (§"G6"): MANUALs → flip `legacyPresent` → parity matrix + device-loss + rotated Y-title |

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

### G0–G4 status (shipped on `feat/event-level-pbp`)

G0 `4f1f11b` · G1 `740b1de` · G2 `7fe0aa0` · G3 `ae03fa2` (glyph text) · G4a `5947acd`
(depth peel compute) · G4b `561dd56` (depth dots+staircases) · G4c `d53acc4` (depth
shade) · G4d `94c2fe5` (era-B + ghost overlays). Headless harness fix `0b0b1fa`
(ANGLE Metal on macOS). **Everything in `present()`'s G-track hooks today is retained-
buffer + scale-uniform; a standalone `present()` re-call under gpuGraph redraws the whole
scene from retained state (verified: `gpuCloud`/`springOn` false, `count.bg=0`).** This
is the property G5 builds on.

### G5 implementation plan (resumable)

G5 is the convergence phase. It has **two independent workstreams** — do them in either
order, but **G5-INT (interaction) is lower-risk and ships first**; **G5-LOOP (present
convergence) edits the proven path and ships last behind `legacyPresent`.** Each sub-phase
is independently shippable with a verify gate + a manual-test line. Resume at the first
unchecked box.

**Hard constraint (why this is a plan, not a commit):** hover/click are *interactive*; the
methodology's UI verification floor requires "one manual browser interaction." Headless can
verify pick-math + instance-buffer geometry (offscreen readback), **not** live-cursor feel
(tracking, lag, flicker from re-presenting on mousemove). Every G5-INT sub-phase therefore
ends with a **MANUAL** checkpoint the implementer must run in a real browser (or a Pages
preview) before ticking it.

**The full hover/interaction visual set today (all SVG, all over the canvas — `script.js`):**
- `isolation ring` (frontier-point hover): `ringGroup` circle, `isolationMap` (built ~6299,
  nearest-other-frontier-point radius), colour `isoRingColor` (~6297). Drawn ~6379.
- `HV-contribution overlay polygon` (frontier-point hover + pinned): `drawHvOverlay`
  (~5901) over `sweepExcluding` (~5921) — a per-hover **re-sweep**; this is the heaviest
  hover visual and the one the design's "ring + regret line" shorthand omits.
- `regret line` + `regret ring` (non-frontier hover): `regretGroup`, geometry from
  `computeDistToFrontier` (~7071). Drawn ~6392/6405.
- Tooltip (`#tooltip`, HTML) and frontier cards (`renderFrontierCards` ~6780) — **stay
  DOM**, not canvas. Only the on-canvas vector overlays move to GPU.
- Hit-testing: `hitTree` d3-quadtree (~6487), `mousemove` handler (~6503). **Quadtree stays
  CPU** (exact; the design confirms this). G5 changes only what the pick *draws*, not how it
  picks.

#### G5-INT — interaction overlays on the GPU

Each overlay becomes a tiny dynamic instance buffer; a hover/pin writes it and triggers a
**coalesced** re-present (one `requestAnimationFrame`, not per-mousemove). New WGSL:
`hoverRing` (one ringed circle), `regretLine` (one segment), reuse `pPlainDots`/`pDepthShade`
where possible. New draw hook `_drawGraphInteraction(rp)` called LAST in `present()` (above
text, or just under it). New buffers on `this.graph`: `bHover{Ring,Line,Poly}` + uniforms.

- [x] **G5a — coalesced re-present plumbing.** Add `pointRenderer.presentInteraction()` =
  set a dirty flag + `requestAnimationFrame` that calls `present()` once (coalesce multiple
  mousemoves into one frame). NO new visuals yet. Gate all of it on `gpuGraph`. *Verify:*
  headless — rapid simulated `presentInteraction()` calls cause exactly one `present()` per
  rAF, no GPU errors / device loss across 100 calls (`__bl2d_gpuError`/`deviceLost` null).
  *MANUAL:* none (no visual change). **Shipped:** `WebGPURenderer.presentInteraction()`
  (one-shot `_interactRaf`, gated on `graphMode`) + `__bl2d_presentCount`; gate green
  (burst1 100→1 present, burst2 over 3 frames→3, raf set/cleared, no GPU error).
- [x] **G5b — GPU regret line + regret ring** (non-frontier hover). `WEBGPU_REGRET_WGSL`
  (segment + ring, data-space endpoints from `computeDistToFrontier`). mousemove (gpuGraph):
  write the buffer, `presentInteraction()`; suppress the SVG `regret-line--hover`. *Verify:*
  headless — inject a known non-frontier point, assert the GPU regret instance endpoints ==
  `computeDistToFrontier(d).{targetX,targetY}` mapped through the scale (new
  `__bl2d_verifyGraph.regretMis`); offscreen-readback visual. *MANUAL:* hover non-frontier
  dots in a browser — line tracks the cursor to the nearest limit, no lag/flicker.
  **Shipped:** one pipeline `pRegret` drawn `draw(6,2)` (instance 0 = ribbon line, 1 = ring),
  both DATA-space + screen-space dashed (matches `.regret-line` #5a6478 dasharray 4 3);
  `uploadInteraction`/`_drawGraphInteraction`/`pushGpuRegret` + `__bl2d_simHover` seam.
  Gate (file:// bundle, smooth-off): `regretMis 0`, regret on/off toggles with non/frontier
  hover, `svgRegretCount 0`, no GPU error; prior invariants (posMis/skyline/front/stairVert/
  radius/glyph/overlay/cardPids) unchanged. **MANUAL pending** real-browser/Pages-preview
  live-cursor confirmation (headless can't script the live cursor; offscreen visual green).
- [x] **G5c — GPU isolation ring** (frontier hover). `WEBGPU_HOVERRING_WGSL` (one ringed
  circle, radius from `isolationMap`). Suppress SVG `isolation-ring--hover`. *Verify:*
  headless — GPU ring centre/radius == `isolationMap.get(d)` (`ringMis`); visual. *MANUAL:*
  hover frontier dots — ring matches the SVG version. **Shipped (generalized):** instead of a
  one-off ring shader, added `WEBGPU_RINGS_WGSL` + `pRings` — an instanced dashed-ring buffer
  that serves the isolation ring, the regret distance ring, and (G5e) pinned rings uniformly
  (`draw(6, ringCount)`). `uploadInteraction` reworked to `{line, rings}`. Gate (file:// bundle):
  `ringMis 0` (centre+radius vs `isolationMap`), no leader on frontier hover, `svgIso 0`;
  G5b `regretMis 0` still green; clear resets line+rings; prior invariants unchanged.
  **MANUAL pending** real-browser confirmation.
- [x] **G5d — GPU HV-contribution hover polygon** — **CUT to SVG (deliberate, per the
  documented escape hatch).** The exclusive-contribution shape is the ribbon between TWO
  staircases — the live frontier and the alt-frontier from `sweepExcluding` (a full-cloud
  re-sweep excluding the point, *with fill* from points the hovered dot previously dominated).
  Emitting the alt-staircase on the GPU and triangulating a variable-step ribbon robustly
  across all four sign orientations is disproportionate for a hover/pinned-only overlay that
  is never in a hot path. It stays as the SVG `drawHvOverlay`, which renders over the GPU
  canvas (only `.axis text` is hidden under `.gpugraph`; the HV poly/alt/label are not).
  Verified under gpuGraph: frontier hover still emits `.hv-contrib-poly/--alt-frontier/--label`
  (1 each). No `hvPolyMis` (N/A). If continuous-zoom sharpness ever demands it, the port is a
  future follow-on alongside the SDF-text upgrade.
- [x] **G5e — pinned-state overlays** (click-to-pin uses the same buffers, persisted across
  refresh via the `hl=` hash). Ensure the pinned ring/regret/poly ride the normal `present()`
  (no mousemove needed — pinned state is in the scene identity). *Verify:* deep-link a pinned
  `hl=` URL, headless readback shows the overlay. *MANUAL:* click-pin, change a filter, the
  pin persists. **Shipped:** the design's "pinned ring/regret" turned out **moot** — the only
  persistent on-canvas pin overlay is the career-HV polygon (`drawHvOverlay "pinned"`, SVG,
  cut in G5d), which already redraws from `careerHighlights` and rides the `hl=` hash; pinned
  state suppresses hover rings/leaders by design, so there is no pinned GPU ring to migrate.
  The real fix was lifecycle: the GraphRenderer's interaction buffers are RETAINED, so each
  render now resets them to empty (`uploadInteraction({line:null,rings:[]})`) — a hover ring
  can't linger after a refresh/zoom. Gate (bundle): hover→`ringCount 1`, dispatch refresh→
  `ringCount 0`; deep-link `hl=Barry Bonds`→`careerHighlights=["Barry Bonds"]` + pinned poly/
  alt render under gpuGraph; G5-INT regression (static invariants + `verifySpring` springMis/
  skylineMis) all 0.

#### G5-LOOP — present() convergence + single loop owner (RISKY; ships last)

- [x] **G5f — `legacyPresent` switch.** Extract the current `present()` body into
  `present_legacy()`; add `present()` that dispatches to it (default) or the new unified path
  (flag off by default). NO behaviour change yet. *Verify:* `__bl2d_verifyGraph` + `verifySpring`
  byte-identical to pre-change (both green); default app unchanged. **Shipped:** `LEGACY_PRESENT`
  (`?legacyPresent=0` opts out), `present()` dispatcher, `present_legacy()` (verbatim old body),
  `present_unified()` stub = legacy. Gate: identical `verifyGraph` invariants in BOTH flag
  states (posMis/skyline/front/stairVert/radius/glyph/overlay 0, cardPids true).
- [x] **G5g — unified scene descriptor.** One render method taking
  `{posBuf, colBuf, onFrontBuf, staircase…, source: "upload"|"spring"}` so the static-upload
  path (G0–G4) and the spring path (`gpustream`) share ONE `present()` body. Behind
  `legacyPresent`. *Verify:* with the flag ON, `verifyGraph` (static) AND `verifySpring`
  (`gpustream`, dev server — `.evt` is stubbed null in the bundle) BOTH stay green; offscreen
  readbacks match the legacy path. *MANUAL:* toggle `gpustream` + play the career animation —
  spring still smooth; toggle `gpugraph` static — identical. **Shipped:** `_buildSceneDescriptor()`
  lifts the implicit spring/upload/hybrid selection into one explicit `{source, gpuCloud,
  springOn, runAccumulate, instanceCount}`; `present_unified()` drives the identical pass
  sequence/z-order from it (shares no code with `present_legacy` → flag is a clean rollback).
  Note of record: `present_legacy` already interleaved both paths in one body (the G-track was
  built *inside* present beside the spring branches), so this formalizes the seam rather than
  merging two methods. Gate (`?legacyPresent=0`): static `verifyGraph` (all 0, cardPids true,
  retention 1) AND `verifySpring` (springMis/skylineMis 0) byte-identical to legacy.
- [x] **G5h — single damage-flag `graphLoop`.** One rAF owner with flags
  `{scene, scale, overlay, motion}`; idle = no rAF scheduled (assert via a frame counter).
  Subsumes `springLoop`/`presentGlide` (~1842) and the G5a coalescer. *Verify:* idle parks
  rAF (`__bl2d_rafScheduled === false` after settle); `verifySpring` green; no busy-loop.
  *MANUAL:* animation smooth at 60/120 Hz; CPU idle when nothing moves. **Shipped on the
  CONVERGED path (`?legacyPresent=0`)** — default keeps the proven `springLoop`+`_interactRaf`
  (zero production risk). `graphLoop` + `requestPresent(kind)` own one rAF for `motion`
  (presentGlide under springLoop's exact alive-condition — cadence untouched) and `overlay`
  (coalesced hover/pin present); `requestGraphPresent` bridges the renderer method to the
  loop closure; `stopSpringLoop(hard)` cancels `graphRaf`. Gate (`?legacyPresent=0`):
  `__bl2d_rafScheduled` false at rest AND after each frame (idle-park), 100 overlay calls →
  1 present (coalesced), hover `ringMis 0`, `verifySpring` springMis/skylineMis 0 + parks
  idle; default path regression green. **MANUAL pending** real-browser 60/120 Hz cadence.
- [ ] **G5i — spring-FLIP cross-fade for static filter changes.** *(DEFERRED — designed,
  not shipped. Rationale below.)* On a filter change under gpuGraph, write new targets and
  glide (the spring becomes the single motion system); the staircase cross-fades via prev/new
  buffers. *Verify:* `verifyGraph` green at the settled state; FLIP is monotone (no overshoot —
  the critically-damped integrator). *MANUAL:* change year range under gpuGraph — dots glide,
  staircase cross-fades, no snap.

  **Why deferred (honest scope call):** G5a–G5h shipped the entire interaction migration +
  the present-convergence seam + the unified loop. G5i is a different beast — it is a *motion
  feature on the static cloud*, not loop plumbing — and it is feature-sized, not a quick add:
  - The static scene (`bPos`) has **no velocity/target/prev buffers** (verified: only `bPos`
    exists; the spring integrator lives solely on the streaming path). G5i must add a spring
    pass over the scene cloud (vel + target + a `seasonMode`-style uniform), then re-run
    skyline→staircase→HV every glide frame — i.e. bring the streaming engine's motion to the
    upload path. This is the same machinery the **S-track** (SA1–SA2) builds; G5i should land
    *with or after* that work, not duplicate it.
  - A filter change SWAPS the point set (e.g. a year-range change adds/drops player-seasons),
    so a correct FLIP needs **identity matching** (old point → new point by playerID/key);
    appeared/disappeared points need enter/exit (fade), not a glide. That matcher is a
    feature unto itself.
  - The only meaningful verification is a **real-browser MANUAL** (dots glide, staircase
    cross-fades, no snap, monotone — no overshoot); headless can confirm only the *settled*
    state (which already equals a normal upload — i.e. nothing to prove that G0–G2 don't).
  - Deferring is **regression-free**: static filter changes keep today's instant-swap. The
    converged path (G5g/h) and all GPU interactions (G5a–e) are shipped and verified.

  **Resume spec (concrete):** (1) extend the scene object with `bSceneVel`, `bSceneTarget`,
  `bScenePrev` + a `uSceneSpring` (dt, ω, mode); (2) on `uploadScene` with a *matching* key
  family (same axes/mode, changed filter), instead of overwriting `bPos`, write the new
  positions into `bSceneTarget` and let a new `pSceneSpring` compute pass glide `bPos` toward
  it (critically-damped, monotone) driven by `graphLoop`'s `motion` flag; (3) match identities
  by the per-point key the scene already carries (`cpuMeta`) — unmatched new points enter at
  their target (alpha 0→1), unmatched old points exit (alpha 1→0); (4) recompute
  skyline/staircase/HV each glide frame (dirty-frames already supported); (5) cross-fade the
  staircase by keeping `bStaircase`(prev) + the new one and lerping a `uStair` alpha over the
  glide; (6) gate all of it on `?legacyPresent=0` + a new `?gpuflip=1` until the MANUAL passes.
  Folds naturally into **S-track SA2** (the sprung open-season cloud uses the same buffers).

**Verify hooks added to `__bl2d_verifyGraph`:** `regretMis`, `ringMis` (G5b/c); `interLineOn`,
`ringCount` (overlay state); `__bl2d_rafScheduled` idle assertion (G5h); `__bl2d_presentCount`
(G5a coalescer). `hvPolyMis` was **not** added — G5d cut to SVG. `cardPidsMatch` stays green
(cards remain CPU-fed; the design's authoritative-`g.front` card rewire was not needed since
G5d/e left the card feed untouched). Sim seam: `__bl2d_simHover("front"|"non")` /
`__bl2d_simHoverOut()` drive hovers headlessly (the live cursor can't be scripted via CDP).

**Rollback:** every G5-LOOP step is behind `legacyPresent` (default = legacy). If `verifySpring`
or `verifyGraph` regress, flip the default back to legacy and the app is unchanged. G5-INT
steps are gated on `gpuGraph` and suppress their SVG counterpart only when their GPU draw is
in place — partial migration keeps the SVG overlay, so a half-done G5-INT never loses a visual.

**Resume pointer:** **G5a–G5h shipped + verified** (G5d cut to SVG; details in each box
above). The only open item is **G5i** (deferred — full resume spec in its box; folds into
S-track SA2). All G5-INT overlays draw on the GPU under the default flags (gpuGraph is the
default); G5-LOOP (G5f–h) ships on the converged `?legacyPresent=0` path with the proven
springLoop/present_legacy as the default until the real-browser cadence MANUALs pass and the
default is flipped in a dedicated commit. **MANUAL checkpoints still owed** (headless can't
script the live cursor / judge animation cadence): G5b/c live-cursor tracking, G5h 60/120 Hz
smoothness — run them in a real browser or a per-branch Pages preview before flipping the
`legacyPresent` default.

---

## G6 — graduate the G-track (finish + sign-off) — RESUMABLE PLAN

**Where this stands:** the renderer-selection half of G6 already shipped (commit `6eb276c`):
WebGPU is the non-optional default, Canvas2D is the silent automatic fallback, a read-only
`#renderer-status` indicator shows GPU/CPU, spring is default-on, and the "GPU"/"spring"
header toggles are gone. What remains is the *sign-off* of the GPU path as production-grade
and retiring the last seams. Six sub-phases; **resume at the first unchecked box.** Each is
independently shippable with its own verify gate. Re-grep line numbers (they drift).

**Two classes of work** — important for resuming in an unattended session:
- **Human/browser-gated:** G6a (the G5 MANUALs) and the G6b flip depend on a real browser
  (headless SwiftShader can't judge live-cursor feel or animation cadence). An agent can
  *prepare* them but a human must run the MANUAL and confirm before the flip lands.
- **Agent-doable headless:** G6c (parity matrix), G6d (device-loss recovery), G6e (rotated
  Y-title), G6f (hatch cleanup) need no human — they verify via `snap-webgpu.js` invariants
  + offscreen readback. Do these in any order; they don't depend on the MANUAL.

### [ ] G6a — run the owed G5 MANUAL checkpoints (human/browser)
Run on the branch's Pages preview (`…/experimental/feat-event-level-pbp/`) or a local
browser with WebGPU. Record pass/fail in the commit that lands G6b. Checklist:
- **Indicator:** header shows **"GPU"** (blue) on a WebGPU machine; force a no-WebGPU
  browser (or `?renderer=canvas`) → shows **"CPU"**, chart still renders, no red banner.
- **G5b/c (default flags):** hover non-frontier dots → the dashed regret leader + distance
  ring track the cursor with no lag/flicker; hover frontier dots → the isolation ring
  matches the old SVG. Move between dots quickly → no stale overlay lingers.
- **G5h (`?legacyPresent=0`):** play the career animation → spring smooth at 60/120 Hz; when
  it settles, the tab goes idle (no busy rAF — check DevTools Performance / CPU).
- **`?gpuonly=1`:** on a no-WebGPU browser shows the red banner (the dev stance still works).

### [ ] G6b — flip the `legacyPresent` default → converged (human-gated on G6a)
Once G6a passes: make `present_unified()` + `graphLoop` the LIVE path for everyone.
- `script.js` `LEGACY_PRESENT` (~4523): invert the default so the converged path is on
  unless `?legacyPresent=1` (keep that as the rollback hatch for one release).
- Verify headless: `__bl2d_verifyGraph` (static, bundle) AND `__bl2d_verifySpring`
  (gpustream, dev server) green with the NEW default; `__bl2d_rafScheduled` idle-parks; the
  G5b/c overlay gates (`regretMis`/`ringMis 0`) still green.
- **Soak, then a SEPARATE later commit** removes the now-dead `present_legacy()`, the
  `_interactRaf` legacy coalescer, and `springLoop`/`startSpringLoop`/`stopSpringLoop`
  (subsumed by `graphLoop`) — only after a release with no regressions. Until then keep them
  for the `?legacyPresent=1` rollback.

### [ ] G6c — one-run full parity matrix (agent-doable)
Replace the ad-hoc per-phase gates with ONE headless sweep. New `window.__bl2d_verifyGraphMatrix()`
(or a snap-webgpu driver) that, by driving the real selectors, loops every combo and asserts
all invariants 0, emitting a pass/fail table:
- modes: season × career; datasets: batting × pitching;
- axis classes: counting×counting, **lower-is-better** (ERA↓/WHIP↓/BB9↓), rate (AVG/OBP/SLG),
  composite (TB/PA); the **Best/Worst** toggle; **depth** d=1..5; **era-B** compare; **ghost**
  (a bats/country filter); HV contributions (`radiusMis`).
- Assert: `posMis/skylineMis/frontMis/stairVertMis/radiusMis/glyphMis/tickMis/atlasMissing/`
  `depthMis/depthStairMis/overlayMis/regretMis/ringMis` all 0, `cardPidsMatch true`,
  `shadeQuadrant` correct, retention (`uploads`/`frontReads` stay 1 on identity-preserving redraws).
- **Negative control:** deliberately perturb one oracle and confirm the matrix FAILS (so a
  green run means something). Gate: all-green matrix + the negative control catches a break.

### [ ] G6d — device-loss recovery test (agent-doable)
The `device.lost → swapToCanvas2D` path (script.js ~4558 / ~4538) exists but is untested.
Headless: bring up WebGPU (`?webgpuHeadless=1`), then trigger a loss (call the GPUDevice's
loss path / `device.destroy()` via an exposed `window.__bl2d_forceDeviceLoss()` hook to add)
and assert: `window.__bl2d_renderer` flips `webgpu→canvas2d`, the indicator flips to **"CPU"**,
**no banner** (graceful, since not `?gpuonly`), the chart cleanly redraws on Canvas2D, and a
subsequent `?verifyFrontier=1` is `mis 0` on the CPU path. Add the `__bl2d_forceDeviceLoss`
test hook (gated to a flag so it can't fire in prod).

### [ ] G6e — rotated Y-axis title on the GPU (agent-doable + offscreen visual)
The one chart text still on SVG (G3 deliberately deferred the rotated Y-title). Options: a
per-instance rotation angle in `WEBGPU_GLYPH_WGSL` (webgpu-graph.js ~809) applied to the
glyph quad, or pre-rotated cells. Lay the title out CPU-side (reuse the axis-title text +
position), emit rotated glyph instances, suppress the SVG Y-title under `gpuGraph` (it keeps
its glossary-hover hit-rect as an invisible DOM element if needed). Verify: `glyphMis` still 0
with the Y-title codepoints included; offscreen readback shows the rotated title; `tickMis 0`.
(Then the chart is 100% GPU text — the SDF upgrade stays a documented future option.)

### [ ] G6f — dev-hatch cleanup + docs (agent-doable)
Audit the surviving URL hatches and document them in ONE place (a short table in this file):
keep the verification/debug ones — `?renderer=canvas`, `?gpugraph=0`, `?gpustream=0`,
`?gpuonly=1`, `?webgpuHeadless`, `?verifyFrontier`, `?legacyPresent=1` (until the G6b soak) —
remove anything now dead. Update CLAUDE.md §"Running locally"/verification if the snap
recipes changed. After G6f the G-track is **shipped**; Canvas2D remains the permanent
fallback (never deleted).

**G6 done ⇒** the full-GPU chart is the production renderer end-to-end (cloud → frontier →
HV → overlays → text → interaction), one loop owner, one present body, with Canvas2D as the
permanent silent fallback. Then the roadmap returns to the data tracks (S3 → S4) and the
S-track (which folds in **G5i**).

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
