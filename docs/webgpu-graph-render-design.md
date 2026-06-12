# Design: full-GPU chart rendering (the WebGPU graph engine, "G-track")

**Status: design only — implementation pending.** Phased; each phase is independently
shippable with its own headless verification gate. If resuming, read §"Resuming",
then the Progress trail, then jump to the first unticked `### [ ] Gx`.

This is the **G-track** (graph). It is orthogonal-but-adjacent to the **S-track**
([`webgpu-season-animation-design.md`](webgpu-season-animation-design.md)) and to
Phases 1–5 of [`webgpu-main-app-integration-design.md`](webgpu-main-app-integration-design.md).
Those tracks made the *streaming counter* engine smooth; the G-track makes the
*whole static chart* — dots, frontier, shades, overlays, axes, tick labels, player
labels, all text — render **and** compute on the GPU, with the existing `gpustream`
engine becoming a special case of the new general scene path.

Scope decisions (made explicitly, binding for this track):

1. **Full GPU including text.** Axes, tick labels, axis titles, and on-chart player
   labels are drawn by a glyph-atlas pipeline in WGSL. No SVG/DOM inside the chart
   canvas. The DOM tooltip (`#tooltip`), the sidebar frontier cards, and the
   draggable player-spotlight cards stay DOM — they live *outside* the canvas in
   `.chart-region` and are fed by a CPU-side mirror (§"Readback contract").
2. **GPU computes too.** The sign-aware Pareto skyline runs on the GPU for the
   static modes (season / career, any stat pair including rate stats and
   lower-is-better stats), and so do the hypervolume contributions. The CPU keeps
   its implementations as the *verification oracle* and as the data source for the
   DOM artifacts.
3. **Canvas2D + SVG stays.** It remains the default renderer and the permanent
   fallback (no WebGPU, device loss, headless default). The G-track is opt-in
   (`?renderer=webgpu&gpugraph=1`) until G6 graduates the flag.

---

## Context

Today two render paths coexist:

1. **Canvas2D + SVG** (`drawScatterPlot`, `script.js:5095–6414`): the production
   path. Full feature set — axes, staircase, HV gradient shade, depth layers,
   era-vs-era overlay, ghost (global-reference) frontier, on-chart labels with
   collision avoidance, hover isolation rings, regret lines, FLIP transitions,
   quadtree hit-testing. Rebuilds the SVG from scratch every refresh.
2. **WebGPU `gpustream`** (`WebGPURenderer`, `script.js:3583–4297`, behind
   `?renderer=webgpu&gpustream=1`): a *streaming counter accumulator*. It only
   covers the `.evt`-career monotone-counting-stat animation; everything else
   (axes, labels, shade, overlays — and every static chart) stays Canvas2D/SVG,
   and non-eligible combos fall back entirely (the `gpuCloud` gate,
   `script.js:5742`).

The G-track closes that gap: one GPU engine that renders any chart the app can
show, not just the animated streaming cloud.

## The key insight (why this is tractable)

The `gpustream` engine already proves every hard primitive on the GPU **for the
streaming case**:

- a resident data-space position buffer (`bPos`, written by the spring at
  `script.js:3384`),
- a brute-force O(n²) Pareto skyline (`WEBGPU_SKYLINE_WGSL`, `script.js:3397`),
- a fully-GPU staircase — `compact→ranksort→emit→drawIndirect`
  (`WEBGPU_STAIRCASE_WGSL`, `script.js:3428`),
- a vertex-pull cloud renderer (`WEBGPU_SPRINGCLOUD_WGSL`, `script.js:3493`) and a
  `drawIndirect` stairline (`script.js:3560`),
- a zero-per-frame-readback `present()` (`script.js:4149`) rendering into an
  offscreen texture and blitting only when the canvas is healthy
  (`script.js:4223–4226` — the HeadlessChrome configure-loses-device dodge),
- a one-shot `mapAsync` verify harness (`verifySpring`, `script.js:4088`).

The G-track does **not** reinvent these; it generalizes them:

- Where the streaming engine *computes* `pos[]` (accumulate → spring), the static
  engine *uploads* `pos[]` — the filtered point set in **data space** — once per
  refresh. Everything downstream (skyline, staircase, cloud render) operates on
  the same `pos[]` contract and is shared.
- The skyline shader already does the Pareto compare. The four lower-is-better
  orientations fold into it by multiplying coordinates by `xSign/ySign` *before*
  the compare — one uniform, no new shader family.
- The staircase emit already produces line vertices; the HV shade is the same
  vertices fanned to the anti-ideal corner. Ghost / era-B / depth layers are
  *re-runs of the same pipelines* over different inputs.

So the genuinely new work is: (1) the **scale-uniform coordinate model** so
zoom/resize never re-uploads, (2) **text** (glyph atlas), (3) a single
**render-loop owner** with damage flags, (4) the **readback contract** feeding the
DOM, (5) GPU **HV contributions**.

---

## Architecture

### Coordinate model: data-space positions + scale uniform

`WEBGPU_SPRINGCLOUD_WGSL` already maps data units → pixels with
`slopeX/interceptX/slopeY/interceptY` from a uniform (`script.js:3493` and the
scale writes near `script.js:4030`). **The G-track keeps every GPU buffer in DATA
space and never re-uploads on zoom, pan, or resize.** Those events recompute the
D3 scale CPU-side and write only the scene uniform (`uScene`, ~64 B). `bScenePos`,
`bSceneColor`, `bSceneSize` are untouched.

This is the load-bearing decision: zoom/resize becomes a sub-microsecond uniform
write + re-present, and the *same* buffers serve the skyline (data-space compare),
the staircase (data-space vertices), and the render (data→pixel in the shader).

### Buffer layout: SoA, reusing the streaming names

Keep the streaming engine's structure-of-arrays convention. SoA wins because
(a) the skyline reads only `pos` (cache-dense), (b) a re-color or re-size rewrites
one small buffer, not interleaved records, and (c) it makes the streaming
unification literal buffer-sharing.

```
Scene buffers (resident, data space; grown on demand):
  bScenePos    : array<vec2<f32>>  // data-space (x,y) per point — uploaded (static)
                                   //   OR aliased to the spring's bPos (stream mode)
  bSceneColor  : array<u32>        // packed RGBA8 (era/bats/league/highlight)
  bSceneSize   : array<f32>        // dot radius px (frontier: HV-derived, G2)
  bSceneFlags  : array<u32>        // bit0 onFront · bit1 pinned · bit2 ghost · …
  bOnFront     : array<u32>        // skyline output (name reused from streaming)
  bFrontIdx, bFrontSorted, bCount(atomic), bStaircase, bIndirect
                                   // staircase scratch, reused from streaming
  bHv          : array<f32>        // per-frontier-slot HV contribution (G2)
  bArcLen      : array<f32>        // per-staircase-vertex cumulative arc length (G4)
  bGlyphInstances : array<GlyphInst> // pos/uv/color per glyph quad (G3)

Uniforms (the only steady-state bus traffic):
  uScene  (~64 B): slopeX, interceptX, slopeY, interceptY, vpX, vpY, dpr, originDrop,
                   xSign, ySign, antiX, antiY, idealX, idealY, gradFlags, _pad
  uText   (~16 B): atlasW, atlasH, dpr, _pad
  uOverlay(~16 B): alphaA, alphaB, layerFade, dashPx
```

### Pass graph (one encoder per present; zero readback in the steady state)

```
                      ┌────────────── COMPUTE (only when scene dirty) ──────────────┐
upload pos/col/size → │ sceneSkyline(pos, sign) → bOnFront                           │
(static; OR spring    │ stairCompact            → bFrontIdx, bCount                  │
 writes pos in stream │ stairRanksort           → bFrontSorted (sorted by xSign·x)   │
 mode)                │ stairEmit               → bStaircase + bArcLen + bIndirect   │
                      │ hvContrib (G2)          → bHv[rank]                          │
                      └──────────────────────────────────────────────────────────────┘
                      ┌────────────────── RENDER (into offTex) ─────────────────────┐
every present:        │ clear                                                        │
                      │ pHvShade      strip: staircase→anti-ideal, frag gradient  G2 │
                      │ pDepthLayers  ×K faded shade+line+dots per onion layer    G4 │
                      │ pSceneCloud   pass0: non-front dots (pull pos/col/size)   G0 │
                      │ pStairGhost   dashed: global-ref / era-B second buffer    G4 │
                      │ pStairLine    drawIndirect: solid red staircase        reuse │
                      │ pSceneCloud   pass1: front dots, HV radius, white ring G0/G2 │
                      │ pHoverRing + pRegretLine  tiny dynamic instances          G5 │
                      │ pAxes         tick marks + axis rules                     G3 │
                      │ pGlyphs       instanced quads: ticks, titles, labels      G3 │
                      └──────────────────────────────────────────────────────────────┘
blit offTex → canvas  (existing copyTextureToTexture, script.js:4223–4226)
```

The compute block runs **only on scene-dirty frames** (filter/mode/data change).
Pointer-move and zoom re-presents skip compute entirely — uniform/small-buffer
write + render. That economy is formalized in the damage-flag loop (§Frame loop).

### Unifying the streaming engine

The streaming spring engine *is* a scene whose `bScenePos` is produced by
`accumulate→spring` rather than by upload:

- G0 introduces `bScenePos`. In stream mode the scene pipelines **bind the spring
  engine's existing `bPos` (`script.js:3939`) directly** — it already holds
  data-space positions. One bind-group entry differs; the render code is shared.
- The streaming `present()` (`script.js:4149`) and the scene `present()` converge
  into one method taking a scene descriptor
  (`{ posBuf, colorBuf, sizeBuf, n, source: "upload" | "spring" }`). When
  `source === "spring"` it prepends the accumulate/spring compute passes; when
  `"upload"` it skips them.
- **Staging:** G0–G4 build the upload path *beside* the streaming path (zero
  shared code, streaming untouched); the convergence refactor lands in **G5**,
  behind a `legacyPresent` switch, once the scene path is proven. Early phases
  carry zero regression risk to `gpustream` by construction.

### GPU frontier for static modes (sign-aware)

`WEBGPU_SKYLINE_WGSL` (`script.js:3397`) compares raw `pos`. The static path needs
all four orientations (HR↑×SB↑, ERA↓×K/9↑, …). **Fold sign into the compare:**
read `xSign, ySign` from `uScene`, compute `si = vec2(pi.x * xSign, pi.y * ySign)`
and test dominance on `si/sj` — matching the CPU sweep's `p.x * xSign` convention
(`computeHvContributions`, `script.js:6767` and the sweep it mirrors). One shader,
four cases.

The streaming shader's `(0,0)` origin-drop guard (`script.js:3407` — players with
no events yet) is wrong for static data, where `(0,0)` can be a legitimate point.
Gate it behind `uScene.originDrop` so stream mode keeps the drop and static mode
doesn't.

**Dedup of exact (x,y) collisions:** `stairRanksort` already tie-breaks by index
(`script.js:3460`), so coincident points get distinct ranks and the emit produces
a single correct staircase. Card-level dedup (don't show five identical rows) is a
CPU concern on the readback set, as it is today on the `unique` array.

**Cost:** O(n²) over ~20k season points ≈ 400M compares — but only on scene-dirty
frames, never per display refresh (static scenes don't animate). The streaming
engine's measured headroom (11k points per *frame* at sub-ms,
[`renderer-performance.md`](renderer-performance.md)) says a one-shot 20k dispatch
per refresh is comfortably fine.

**Career-mode aggregation stays CPU.** Grouping seasons → careers and recomputing
rate stats from summed components (`aggregateCareer`) is *data preparation*, not
rendering: a one-time-per-refresh transform over the CPU-resident `points[]` that
touches string playerIDs and the people map, with no parallelism worth a GPU
round-trip. It produces the point set G0 uploads.

### GPU HV contributions

After `stairRanksort` the frontier is sorted by `xSign·x` ascending. The
leave-one-out contribution of frontier point `r` is **local**: removing `r` merges
its neighbors' strips, so

```
contrib[r] = (x[r] − x[r−1]) · (y[r] − y[r+1])      (in signed space,
              with the reference corner from uScene at the ends)
```

One thread per frontier slot, one workgroup pass (`hvContrib`), writing
`bHv[rank]`. The frontier dot radius (sqrt-scaled 4–11 px, today computed CPU-side
in `drawScatterPlot`) derives from `bHv` on the GPU; the CPU receives the same
`bHv` in the per-refresh readback for the cards.

The CPU oracle is `computeHvContributions` (`script.js:6767`). Note it is
O(K) per point (`sweepExcluding`, O(K²) total) while the GPU neighbor-merge is
O(1) per point — same strip-decomposition math, so they must agree to 1e-6
relative. Watch the reference-corner epsilon and sign handling
(`script.js:6778–6790`); verify a sign-inverted (ERA↓) case early.

### GPU geometry: shade / depth / overlays / ghost

- **HV shade:** a triangle strip from each staircase vertex to the anti-ideal
  corner. The gradient (today an SVG `linearGradient` toward the anti-ideal
  corner, `script.js:5777–5799`) moves into the **fragment shader**: project the
  fragment's data-space position onto the ideal→anti-ideal axis (both corners in
  `uScene`), `mix` color/alpha along it (0.10 → ~0). Sign-aware corner selection
  fills the correct quadrant for lower-is-better stats.
- **Depth layers (onion-peel, ≤5):** iterative skyline peeling — run
  `sceneSkyline` K times with a peeled mask (points on prior layers excluded),
  capturing each layer's `bOnFront`/staircase into a small scratch ring, drawn at
  decreasing `uOverlay.layerFade`. 5 × O(n²) on a dirty frame is acceptable
  (one-shot); if 20k × 5 proves heavy, cap layer-N's input to the prior layer's
  complement (already far smaller). Oracle:
  [`pareto-onion-peeling-design.md`](pareto-onion-peeling-design.md) /
  `window.__bl2d_depthLayers`.
- **Era-B overlay:** a second instance set (the era-B filtered points), a second
  `sceneSkyline`→staircase run into a second staircase buffer, drawn via the same
  `pStairLine`/`pHvShade` at `uOverlay.alphaB`. The coverage label is a glyph
  instance set (G3).
- **Ghost (global-reference) frontier, dashed:** the unfiltered-global frontier
  through the same staircase pipeline into `bStaircaseGhost`. **Dashes need arc
  length:** extend `stairEmit` to write per-vertex cumulative `bArcLen`; the ghost
  fragment shader discards where `fract(arcLenPx / uOverlay.dashPx) > 0.5`. This
  is the one emit-pass extension the G-track adds.

### GPU text: pre-rasterized glyph atlas

**Decision: pre-rasterized atlas, not SDF.** Rationale: (1) it matches the
project's pedagogical style and the existing "Canvas2D-rasterize, upload as
texture" idiom (the bg-cloud cache is exactly that); (2) static charts don't zoom
text continuously — labels re-rasterize on the rare dpr/scale change, so SDF's
zoom-crispness advantage is marginal here; (3) far less shader work (textured quad
vs. SDF median + AA). SDF is the documented upgrade if continuous-zoom sharpness
ever matters.

**Two-tier atlas:**

- **Static atlas** (built once at init; rebuilt on dpr change): digits, ASCII
  punctuation, the symbols `▾ ↓ ·`, and Latin-1 + common diacritics for player
  surnames. Rasterized via an offscreen Canvas2D at `devicePixelRatio`, uploaded
  as a single texture; a CPU `Map<char, {u,v,w,h,advance}>` drives quad emission.
  Covers tick labels, axis titles, and ~99% of names.
- **Overflow page** (rare codepoints): rasterize-on-demand per refresh — the
  per-refresh label set is tiny (≤ a few hundred glyphs), so start with
  "re-rasterize the overflow set each refresh" and add an LRU page only if
  profiling shows churn.

**What stays CPU (justified):** tick-string formatting (`d3-format`, already
produces the strings — trivial cost) and label collision layout
(`layoutFrontierLabels`, `script.js:6448` — a *sequential greedy* algorithm over a
tiny N with leader-line placement; no parallelism to exploit, and its output
rectangles double as the CPU-side hit-rects). The CPU emits per-glyph quads into
`bGlyphInstances`; the GPU just draws them, plus `pAxes` for tick marks and axis
rules.

### Interaction without SVG

- **Hit-testing: keep the CPU quadtree** (`script.js:6349`). For static scenes the
  CPU knows every position pre-upload, so the quadtree is exact and free. For
  spring-animated clouds, positions are GPU-only mid-glide; hit-test against
  **target** positions (the settled values) — acceptable because the spring is
  sub-pixel-converging and hover during a fast glide is forgiving. Documented
  upgrade if that ever mis-picks: a **picking pass** (R32Uint ID render target,
  read back **on click only**, never on move) so it can't stall the render loop.
- **Hover ring + regret line:** one-instance dynamic buffers written on
  pointer-move, then re-present. No scene recompute, no full refresh. The regret
  target comes from `computeDistToFrontier` (`script.js:6859`) CPU-side — it needs
  the frontier the cards already hold.
- **Axis-title click zones + glossary (`▾`):** CPU rectangles. The CPU laid out
  every glyph quad, so the clickable rects are those same rects, tested in the
  canvas pointer handler. No DOM.

### Readback contract (GPU → DOM, never blocking)

The DOM artifacts (cards, tooltip rows, spotlight) need the frontier + HV. After
the compute block on a scene-dirty frame: `copyBufferToBuffer` of
`bFrontSorted` + `bHv` + `bCount` into a **double-buffered staging pair**, then a
fire-and-forget `mapAsync`. K ≤ ~200 so the copy is tiny; the frame that issued it
has already presented, and the *next* refresh maps the other buffer — render never
waits on a map. When the map resolves, the CPU mirror updates cards/quadtree/
tooltip data. (The CPU sweep remains available as the oracle and the
non-`gpugraph` path.)

### Motion: one spring for everything

**Reuse the critically-damped spring (`WEBGPU_SPRING_WGSL`, `script.js:3366`) for
ALL dot motion, including the static-mode filter-change FLIP** (today a D3
transition, `FLIP_DURATION` at `script.js:5105`). On a filter change, write the
new data-space targets and let the spring glide `bScenePos`; the loop runs while
velocity is non-negligible, then parks. Rationale: it's already on the GPU,
unconditionally stable (polynomial-`e`, no overshoot), already drives the
streaming cloud — one motion system instead of two. The eased-`t` prev/next
alternative is rejected as a second system to maintain. **Staircase cross-fade:**
draw old + new staircase buffers (`bStaircasePrev`/`bStaircase`) with
`uOverlay.alphaA` ramping — the existing stairline pipeline, twice.

### Frame loop: one owner, damage flags

Today `present()` is called from `drawScatterPlot` and from the `springLoop` rAF
(`script.js:1842`). The G-track installs **one render-loop owner**:

```
dirty = {
  scene:   filter/mode/data/sign change  → run compute block (skyline/stair/hv)
  scale:   zoom/pan/resize               → uScene write, re-render only
  overlay: hover/pin/era-B/depth toggle  → small-buffer write, re-render only
  motion:  spring vel non-negligible OR cross-fade active → keep presenting
}
needsPresent = scene || scale || overlay || motion
```

A single rAF (`graphLoop`) presents iff `needsPresent`, clears the one-shot bits,
and re-arms only while `motion` persists. **Idle = no rAF scheduled** (battery).
This subsumes `springLoop`/`lastGpuSpringFrame`: the spring's "keep gliding"
becomes `dirty.motion`. The invalidation contract is the public seam — every
handler sets the narrowest bit and requests the loop instead of calling
`present()`.

### Fallback, gating, headless

- WebGPU unavailable / device lost → the Canvas2D+SVG path is untouched and fully
  functional (`swapToCanvas2D` ladder, `script.js:4318–4346`; `device.lost`
  handler, `script.js:4337`). The G-track adds no regression surface there.
- Opt-in: `?renderer=webgpu` **and** `?gpugraph=1` (read once at renderer
  construction, like `springMode` at `script.js:3606`; persisted in the URL like
  `writeGpustreamParam`). At G6 the flag graduates: `?renderer=webgpu` alone
  enables the graph path; `?gpugraph=0` becomes the escape hatch.
- **Headless:** `context.configure()` loses the device under HeadlessChrome. The
  G-track extends the existing offscreen + one-shot-readback pattern
  (`script.js:4116, 4223`) to the whole graph: all compute outputs are
  `COPY_SRC`, and `__bl2d_verifyGraph` reads them once. The `chooseRenderer`
  headless guard (`script.js:4350–4356`, requires `?webgpuHeadless`) gates
  identically. Real-GPU visual checks ride the per-branch Pages previews
  ([`pages-preview-deploys.md`](pages-preview-deploys.md)).

### Where the code lives: new file `webgpu-graph.js`

`script.js` is ~6,900 lines; the G-track plausibly adds 1,500–2,500 more (WGSL +
renderer + atlas + loop). **Split into `webgpu-graph.js`**, loaded by `index.html`
after `script.js`. The bundler already inlines a second JS file — `tour.js`
(`scripts/build_bundle.py:41, 483, 520–521`) — so this is the same three-line
pattern: read the file, add one `html.replace` swap, keep the order after
`script.js` so it sees `WebGPURenderer`. The dataset regex swaps are unaffected.
Done in G0 so every later phase ships through the bundle. All GPU code carries the
project's verbose pedagogical comments (the `script.js:3357–3575` standard).

---

## Phase table

| Phase | Goal | New WGSL entry points | Verify gate (headless) |
|---|---|---|---|
| **G0** | Retained-scene dot renderer for static modes; data-space coord model; bundler split | `sceneCloud` vs/fs | dot count == filtered N; readback pos == uploaded pos |
| **G1** | GPU sign-aware frontier + readback contract | `sceneSkyline` (sign-folded) | GPU `onFront` == CPU sweep, 20 random combos incl. ERA↓; readback set == cards |
| **G2** | Staircase + HV shade + HV contributions | `hvContrib`; `hvShade` vs/fs | `bHv` == `computeHvContributions` ≤ 1e-6 rel; radii match |
| **G3** | GPU text: atlas, axes, tick labels, titles, on-chart labels | `glyphs` vs/fs; `axes` vs/fs | glyph count == Σ string lengths; ticks == d3-format |
| **G4** | Overlays: depth layers, era-B, ghost (dashed), cross-fade | `depthLayers`; `stairGhost`; `stairEmit`+arcLen | layers == CPU onion-peel; ghost == CPU global-ref |
| **G5** | Interaction + spring-FLIP + loop owner + **stream convergence** | `hoverRing`, `regretLine` vs/fs | picks == CPU quadtree; idle parks rAF; `verifySpring` still green |
| **G6** | Graduate flag; Canvas2D-retirement decision (keep it) | — | full parity matrix in one headless run |

---

## Per-phase detail

### [ ] G0 — Retained-scene dot renderer for static modes

- **Files:** new `webgpu-graph.js` (`GraphRenderer`); `index.html` (script tag
  after `script.js`); `scripts/build_bundle.py` (tour.js-style inline swap);
  `script.js` (a `gpuGraph` gate parallel to `gpuCloud` at `~5742`; `?gpugraph`
  flag read like `springMode` at `3606`).
- **What:** On a static refresh under `?renderer=webgpu&gpugraph=1`, take the
  filtered point set the CPU path already computes, upload
  `bScenePos`/`bSceneColor`/`bSceneSize`, write `uScene` from the D3 scale, draw
  via `sceneCloud` into the offscreen texture, blit. Zoom/resize → `uScene` write
  + re-present only. Axes/labels stay SVG for now (layered above, current
  z-order); frontier dots/staircase stay on their current path.
- **New WGSL:** `sceneCloud` vs/fs — generalize `WEBGPU_SPRINGCLOUD_WGSL`
  (`script.js:3493`) to read `bSceneSize` + all color encodings; identical
  data→pixel map so it registers with the SVG axes.
- **Verify gate:**
  `node scripts/snap.js "http://localhost:8000/?renderer=webgpu&gpugraph=1&webgpuHeadless=1#…" /tmp/g0.png 1440 900 2500 'window.__bl2d_verifyGraph()'`
  → `dotCount === filteredN`, `maxAbs(readback(bScenePos) − uploaded) === 0`.
- **Rollback:** `gpuGraph` gate falsy → today's paths exactly. Streaming
  `present()` untouched.

### [ ] G1 — GPU sign-aware frontier + readback contract

- **Files:** `webgpu-graph.js` (skyline pass, double-buffered staging);
  `script.js` (cards/quadtree/tooltip consume the readback mirror under
  `gpuGraph`).
- **What:** Run `sceneSkyline` on scene-dirty frames (sign folded, origin-drop
  gated off for static). Establish the readback contract (§above): tiny
  fire-and-forget `mapAsync` on a staging pair; never blocks render. Frontier dots
  now drawn by `sceneCloud` pass 1 from `bOnFront`.
- **New WGSL:** `sceneSkyline`.
- **Verify gate:** `__bl2d_verifyGraph` drives 20 random
  (xDim, yDim, sign, filter) combos; GPU `onFront` vs CPU brute sweep →
  `skylineMis === 0`; readback frontier set == card set. Spot-checks:
  **Henderson 1982 SB=130 on the season HR×SB frontier**; **lowest ERA on the
  ERA↓ frontier** (orientation correct).
- **Rollback:** compute disabled → CPU frontier feeds both cards and dots (G0
  cloud still GPU).

### [ ] G2 — Staircase + HV shade + HV contributions

- **Files:** `webgpu-graph.js`.
- **What:** Reuse `stairCompact/ranksort/emit` on the scene frontier; add
  `hvContrib` (neighbor-merge strip areas → `bHv`); draw `pHvShade` (strip +
  fragment gradient) under the cloud; frontier radii from `bHv`; suppress the SVG
  staircase/shade under `gpuGraph` (widening the existing `!gpuSpring` guard at
  `script.js:5774`).
- **New WGSL:** `hvContrib`; `hvShade` vs/fs.
- **Verify gate:** GPU `bHv` per-point and total vs `computeHvContributions`
  (`script.js:6767`) ≤ 1e-6 relative; radii == CPU sqrt-scaled radii; shade
  quadrant correct on an ERA↓ case.
- **Rollback:** GPU shade/HV off → SVG shade returns via the widened guard.

### [ ] G3 — GPU text: atlas, axes, labels

- **Files:** `webgpu-graph.js` (atlas builder, `pGlyphs`, `pAxes`); `script.js`
  (emit glyph quads from tick strings, axis titles, `layoutFrontierLabels`
  output + leader lines).
- **What:** Build the static atlas at init (offscreen Canvas2D @ dpr → texture +
  metrics map; overflow page on demand). Per refresh the CPU formats ticks
  (d3-format), lays out labels (`layoutFrontierLabels`, `script.js:6448`,
  unchanged), fills `bGlyphInstances`; GPU draws `pAxes` + `pGlyphs` last. Axis
  titles get CPU hit-rects (click → stat picker; hover → glossary), `▾ ↓ ·`
  included. SVG axes/labels now suppressed under `gpuGraph`.
- **New WGSL:** `glyphs` vs/fs; `axes` vs/fs.
- **Verify gate:** `glyphInstanceCount === Σ label string lengths` (ticks + titles
  + frontier labels); tick strings == d3-format output for the active scale;
  every emitted codepoint present in atlas metrics.
- **Rollback:** `pGlyphs`/`pAxes` off → SVG axes/labels layer back over the GPU
  canvas (current z-order) — a clean intermediate that still ships.

### [ ] G4 — Overlays: depth layers, era-B, ghost, cross-fade

- **Files:** `webgpu-graph.js`.
- **What:** Depth layers via iterative `sceneSkyline` peeling (≤5, faded by
  `uOverlay.layerFade`); era-B as a second instance set + second frontier run;
  ghost frontier dashed via `bArcLen` written by the extended `stairEmit`;
  staircase cross-fade via prev/new buffers + `uOverlay.alphaA`.
- **New WGSL:** `depthLayers` draw; `stairGhost` vs/fs (dashed); `stairEmit`
  extended.
- **Verify gate:** per-layer GPU `onFront` == CPU onion-peel
  (`__bl2d_depthLayers` oracle); ghost == CPU global-reference frontier; era-B
  coverage value == CPU; dash period stable under zoom (arc length in px space).
- **Rollback:** overlays off → base scene (G0–G3) still complete.

### [ ] G5 — Interaction + motion + stream-engine convergence

- **Files:** `webgpu-graph.js` (hover/regret pipelines, `graphLoop` owner);
  `script.js` (handlers route through dirty flags; `present()` convergence).
- **What:** Quadtree hit-test on the scene set (target positions during glides;
  click-only picking pass documented as the upgrade); hover ring + regret line as
  dynamic instances; spring-FLIP replaces the D3 dot transition under `gpuGraph`;
  single `graphLoop` with damage flags, idle parks; **converge** streaming and
  scene `present()` into the scene-descriptor method, aliasing spring `bPos` as
  `bScenePos`, behind a `legacyPresent` switch.
- **New WGSL:** `hoverRing` vs/fs; `regretLine` vs/fs.
- **Verify gate:** scripted pointer events → hover/regret targets == CPU quadtree
  + `computeDistToFrontier` (`script.js:6859`); frame counter flat after settle
  (idle parks); **`__bl2d_verifySpring` still passes on the converged path**.
- **Rollback:** the convergence is the riskiest edit — `legacyPresent` flips the
  streaming engine back to its own `present()`; scene path keeps its own.

### [ ] G6 — Graduate the flag; Canvas2D-retirement decision

- **Files:** `script.js` (gate graduation; `?gpugraph=0` escape hatch);
  `README.md`, `CLAUDE.md` cross-links.
- **What:** Full snap.js parity bake across (mode × stat pair × sign × filter ×
  viewport). Decision: **keep Canvas2D+SVG as the permanent fallback** — do not
  delete `drawScatterPlot`'s SVG path; it is the no-WebGPU/device-loss/headless
  default. Graduate only with all G0–G5 gates green together.
- **Verify gate:** all `__bl2d_verifyGraph` invariants in one headless matrix
  run; no console errors; simulated device loss still recovers via
  `swapToCanvas2D`.
- **Rollback:** default back to Canvas2D for bare `?renderer=webgpu`; graph path
  stays reachable via `?gpugraph=1`.

---

## Verification plan (invariant hooks, not pixel-diff)

Pixel-diffing GPU vs SVG output is brittle (AA, sub-pixel, font raster). Instead
**`window.__bl2d_verifyGraph(opts)`** mirrors `verifySpring` (`script.js:4088`):
run the compute block once, one-shot `mapAsync` the outputs, compare to CPU
oracles:

- **Frontier:** GPU `bOnFront` == CPU sign-aware sweep, N random filter combos →
  `skylineMis === 0`.
- **HV:** GPU `bHv` per-point + total == `computeHvContributions` ≤ 1e-6 rel.
- **Text:** glyph instance count == Σ string lengths; ticks == d3-format; atlas
  covers every emitted codepoint.
- **Readback ↔ DOM:** deduped readback frontier == the card list shown.
- **Overlays:** depth layers == CPU onion-peel; ghost == CPU global-ref.
- **Interaction:** scripted pointer → GPU hover/regret == CPU quadtree +
  `computeDistToFrontier`.
- **Spot-checks:** Henderson 1982 SB=130 on-frontier; lowest-ERA-on-front
  orientation; all-time HR×SB = Bonds 762/514 + Henderson 296/1406.
- **Streaming regression:** `__bl2d_verifySpring` green through G5.

Each gate is one headless command:

```
node scripts/snap.js "http://localhost:8000/?renderer=webgpu&gpugraph=1&webgpuHeadless=1#<view>" \
  /tmp/gN.png 1440 900 2500 'window.__bl2d_verifyGraph({...})'
```

The offscreen + one-shot-readback pattern (`script.js:4116, 4223`) is what keeps
these alive under HeadlessChrome's configure-loses-device behavior; real-GPU
visual passes ride the per-branch Pages previews.

## Risks / open questions

- **Stream-engine convergence (G5)** is the highest-risk change — it edits the
  proven `present()`. Mitigation: zero shared code through G4; converge last,
  behind `legacyPresent`, gated on `verifySpring`.
- **Text quality / atlas coverage (G3):** pre-rasterized is soft under heavy
  zoom; names need diacritics. Mitigation: two-tier atlas; SDF documented as the
  upgrade path.
- **Depth-layer cost (G4):** 5 × O(n²). Mitigation: dirty-frames only; cap
  layer-N input to the prior complement; measure on full-history season HR×SB
  before committing.
- **HV parity (G2):** the GPU O(1) neighbor-merge must match the CPU
  `sweepExcluding` within tolerance — same math, but reference-corner epsilon and
  signs must line up; test ERA↓ early.
- **Picking vs target hit-testing (G5):** target positions may mis-pick during a
  fast glide. Upgrade documented (click-only R32Uint picking). Decide empirically.
- **Career data prep stays CPU:** a per-refresh aggregation cost before upload —
  acceptable (static; no per-frame cost), but worth re-checking if career mode
  ever animates.

## Resuming

If picking this up cold:

1. Read §"The key insight" and §"Architecture" — the unification (the streaming
   engine is a scene whose `pos[]` comes from compute instead of upload) and
   data-space-coords + scale-uniform are the whole model.
2. Check the Progress trail for the first unticked `### [ ] Gx`; the heading
   checkbox mirrors the table.
3. Do not advance a phase until its `__bl2d_verifyGraph` gate passes headless.
4. Crib the skyline/staircase/`drawIndirect` mechanics and the one-shot-readback
   harness from the shipped streaming engine (`script.js:3357–4297`) and its docs
   ([`webgpu-main-app-integration-design.md`](webgpu-main-app-integration-design.md)
   §Phase 5, [`webgpu-season-animation-design.md`](webgpu-season-animation-design.md)).
5. The G-track never edits the streaming `present()` before G5 and never edits
   the Canvas2D/SVG fallback at all — early phases are regression-free by
   construction.

## Progress trail

| Phase | What | Status | Notes / commit |
|---|---|---|---|
| G0 | retained-scene dots + coord model + bundler split | ☐ not started | data-space pos + uScene; new `webgpu-graph.js` |
| G1 | GPU sign-aware frontier + readback contract | ☐ not started | sign folded into skyline; double-buffered readback feeds cards |
| G2 | staircase + HV shade + HV contributions | ☐ not started | `hvContrib` neighbor-merge; frag-shader gradient |
| G3 | GPU text (atlas, axes, labels) | ☐ not started | pre-rasterized two-tier atlas; layout stays CPU |
| G4 | overlays: depth, era-B, ghost (dashed), cross-fade | ☐ not started | arc length from emit; iterative peeling |
| G5 | interaction + spring-FLIP + loop owner + stream convergence | ☐ not started | riskiest: `present()` convergence behind `legacyPresent` |
| G6 | graduate flag + keep Canvas2D fallback | ☐ not started | full parity matrix bake |

_Update this table (and the `### [ ] Gx` heading checkboxes) at the end of every
working session._
