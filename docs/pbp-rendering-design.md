# PBP rendering & group-career animation — design

Design for two related pieces of the play-by-play (PBP) work:

1. **A rendering/data system that scales** — the multi-year smooth animation works
   but bogs down after several accumulated years (Phase 4 "rendering-perf gate"
   in [`pbp-next-steps.md`](pbp-next-steps.md)).
2. **A new feature** — let the user pick a group of players and watch their
   *career progress* unfold in one animation.

Both are driven by the same cursor/timeline already built (`pbpTimeline`), so
they share an engine; the design unifies them.

## 1. The problem, measured

The smooth cursor re-runs the full `drawScatterPlot` pipeline every frame:
dedup → Pareto sweep → **SVG circle data-join** → frontier-label layout →
overlays. With the accumulating multi-year frontier, the point cloud grows as the
cursor sweeps forward.

Measured at the heaviest state (open year = 2025, full 1920–2025 window, HR×SB):

| metric | value |
|---|---|
| Full draw (scrubber input → painted) | **80–105 ms / frame** (~10 fps) |
| SVG circles rendered each frame | **3,795** |
| text nodes / paths | 41 / 26 |

The Phase-2 perf fixes (cache the completed-season slice, throttle to ~15 fps,
cap the sweep at 45 s) keep the **main thread responsive** (timer drift ~27 ms),
but they don't lower the *per-draw* cost — and ~90 ms/draw means the throttle
can't actually hit 15 fps late in a wide sweep. The dominant cost is re-binding
and mutating ~3.8 k DOM circles every frame. **SVG is the ceiling.**

(Note: HR×SB collide onto integer lattice points, so ~44 k raw seasons dedup to
~3.8 k unique dots. Float axes like AVG×OBP would dedup far less and be worse.)

## 2. Goal A — render the point cloud ourselves (Canvas 2D)

Move the **high-cardinality, low-semantic** layers to a Canvas; keep SVG for the
**low-cardinality, high-semantic** layers that need crisp text, accessibility, and
per-element interaction.

| Layer | Today | Proposed | Why |
|---|---|---|---|
| Background point cloud (~3.8 k–50 k dots) | SVG `<circle>` join | **Canvas 2D** | One `arc` loop redraws everything in <5 ms; no DOM. |
| Frontier staircase + frontier dots (≤ ~30) | SVG | Canvas (or keep SVG — it's tiny) | Small; either works. Canvas keeps it on the same surface as the cloud. |
| Axes, gridlines, frontier **labels**, era legend, tooltip | SVG | **stay SVG** | Few nodes, need crisp text + a11y; cheap. |
| Career trails / highlights | SVG paths | Canvas | Part of the animated layer (see §3, §4). |
| Hit-testing (hover/click → which player) | per-circle DOM listeners | **`d3-quadtree`** | Build once per point-set change, query O(log n) on mousemove. d3-quadtree ships in the d3 v7 bundle already loaded. |

### Backend: Canvas 2D vs WebGL vs WebGPU

Our actual workload is modest — **a few thousand to ~50 k points**, redrawn on
cursor motion. That sits comfortably inside Canvas 2D's budget, so the backend
choice is about *learning value and future headroom*, not raw necessity.

| Backend | Fit for this app | Effort / risk | Learning value |
|---|---|---|---|
| **Canvas 2D** | Draws ~50 k filled arcs at 60 fps with the static/dynamic split below. Covers every realistic case here. | Low — one `arc` loop, no shaders, works in every browser incl. the offline bundle. | Modest. |
| **WebGL** | Handles 100 k–1 M points via instancing, but the API is verbose (buffers, attributes, GLSL, context-loss handling). | Medium-high — a lot of boilerplate for a gain we don't need yet. | Good, but dated relative to WebGPU. |
| **WebGPU** | Overkill for our point counts, *but* the natural modern path: instanced point rendering, and **GPU compute** could even run the Pareto sweep / dedup in a shader. | High — WGSL shaders, async device init, bind groups, pipelines; **browser support is broad in 2026 but not universal**, so a fallback is mandatory; the offline `dist/` bundle must still work. | **High** — current GPU programming model, transferable skills. |

**Recommendation (honoring WebGPU as a learning goal).** Don't bet the deployed
site on it, but don't avoid it either — structure the renderer as a **backend
abstraction** so WebGPU is a learning track that can't break production:

1. Define a small `PointRenderer` interface — `setPoints(xs, ys, colors, sizes)`,
   `draw(transform)`, `resize(w, h, dpr)` — consumed by `drawScatterPlot`.
2. Ship the **Canvas 2D backend first** (Phase 1 below). It's the baseline, the
   fallback, and what the offline bundle uses. This alone fixes the ~90 ms/frame.
3. Add a **WebGPU backend behind a capability check + feature flag**
   (`?renderer=webgpu`), falling back to Canvas 2D when `navigator.gpu` is absent
   or init fails. Start with instanced point rendering of the cloud; as a stretch,
   move dedup/Pareto to a compute shader and compare against the JS path.
4. Keep axes/labels/legend/tooltip in SVG regardless of backend (§ table above).

This way the perf problem is solved immediately on Canvas 2D, the deployed site
and offline bundle stay safe, and WebGPU becomes a self-contained, low-risk
playground that's swapped in only where supported. If the WebGPU track stalls,
nothing regresses. (Plain WebGL isn't worth it here — if we're investing in GPU
learning, WebGPU is the better target; if we're not, Canvas 2D already suffices.)

### The real unlock: static vs. dynamic layer split

During the accumulating sweep, the **completed-year cloud doesn't change**
frame-to-frame — only the open season's dots move and the frontier updates. So
split the canvas work by what actually changes per frame:

- **Background canvas** — the completed-season cloud (`yearID < openYear`).
  Redrawn **only when `openYear` changes** (~once per season boundary), reusing
  the existing `pbpCompletedCache`.
- **Foreground canvas** — the open season's as-of dots + the live frontier
  staircase. Redrawn **every frame**, but it's only ~1–2 k dots + a tiny frontier.

Per-frame cost collapses from O(whole accumulated cloud) to O(open season). This,
not Canvas alone, is what makes a 100-year sweep run at 60 fps. (The same trick
helps even at SVG sizes, but Canvas makes the static-layer redraw on a year
boundary essentially free too.)

### Incremental frontier

Mirror the layer split in the math: the frontier of the completed years is static
between season boundaries (compute once, cache). Each frame, Pareto-merge only the
open season's as-of points against that cached completed-frontier — a small-set
merge instead of a full sweep over ~44 k rows.

## 3. Goal B — group-career animation (new feature)

**Interaction.** The player search/typeahead already exists; extend it to a
multi-select "group" (chips), or reuse the franchise/era filters as a group
selector. Hitting play animates the selected group's **careers** over calendar
time.

**What animates.** Each selected player is a dot moving through (X, Y) stat-space,
tracing the path of their **cumulative career** as games accrue, with a short
fading trail so you see the trajectory. E.g. on HR×SB you'd watch Bonds climb
steeply in HR while Henderson runs right along SB, Mays arc through the middle —
all racing through their careers on the same clock.

**Point builder.** For player *p* at cursor (year Y, day D):
`career(p) = aggregateCareer(p's completed seasons < Y) ⊕ pbpPointsAsOf(p, Y, D)`
— i.e. the existing season-cumulative as-of logic (§Phase 3 of `pbp-next-steps`)
summed over prior full seasons plus the open season's partial, run through the
shared `parseBattingRows`/`parsePitchingRows` derive path so rate stats are
correct (career rate as-of-date). Years a player lacks PBP contribute their full
season total as a step (smooth within PBP years, steps across gaps).

**Why it's cheap.** A group is small (≤ a few dozen players). Per frame we build
~N career points (N = group size), not thousands — so this mode is light
regardless of era. It renders as N trails + N head-dots on the Canvas foreground
layer; the background cloud is hidden or dimmed (the focus is the group).

**Timeline.** The virtual timeline spans the union of the group's career years
(min debut → max final season). Reuse `buildPbpTimeline` over that range; the
cursor sweeps calendar time exactly as today. Lazy-load each season the group
spans as the cursor reaches it (only the selected players' games are needed, but
loading the season file and filtering to the group is simplest and reuses the
corpus — no new data format).

**Axes.** Lock to the group's career-end envelope (the max career totals across
the group), so every trajectory fits and grows into a fixed frame.

## 4. Unify into one animation engine

Today's `pbpTimeline` + cursor already is the engine. Generalize the per-frame
**point-builder** behind a small strategy so all three modes share the cursor,
scrubber, play loop, deep-link, and Canvas renderer:

| Mode | Filter | Per-frame point builder | Render |
|---|---|---|---|
| **Season accumulating** (today) | all players | completed seasons (full) + open season as-of | cloud + frontier |
| **Group career** (new) | selected group | per player: career-cumulative as-of | trails + heads |
| **Single career trail** (exists: `careerHighlight`) | one player | that player's seasons | one gold trail |

The renderer takes "points + optional trails + frontier" and paints them; the
builder decides what those are. This keeps the scrubber/play/deep-link logic in
one place and makes the group-career feature mostly a new builder + a multi-select
UI, not a parallel system.

## 5. Phasing

> **Status (group-career session).** Phases 1, 2 (render side), and 4 are
> **implemented** on branch `pbp-animation`:
> - **Phase 1 — done.** The point cloud is drawn on a Canvas (`chartCanvasLayers`
>   {bg,fg}, `drawCanvasPointLayer`); hit-testing moved to `d3-quadtree`; SVG/PNG
>   export rasterizes the canvas. (Pragmatic: a direct `drawCanvasPointLayer` rather
>   than the formal `PointRenderer` interface — the abstraction can be lifted later
>   if/when the WebGPU track happens.) Wide-window draw fell from ~90 ms to a few ms.
> - **Phase 2 — render-side split done; incremental-frontier math pending.** The
>   background canvas is cached by `bgKey` and only redrawn when the open year/filters
>   change; `pbpCompletedCache` caches completed-season points. The Pareto sweep still
>   runs full each frame (cheap at current N), so the incremental-frontier merge is the
>   remaining Phase-2 item.
> - **Phase 4 — done.** Group-career mode ships: `groupCareerMode` + a "Group careers"
>   toggle, the per-frame builder `pbpBuildGroupCareer` (career = `aggregateCareer`(prior
>   full seasons + open PBP partial)), `groupTrailHistory` fading trails on the fg canvas,
>   and a group-aware `pbpComputeExtent`. Frame p95 ≈ 2 ms. Phase 3 (the formal
>   point-builder strategy refactor) was done **inline** rather than as a standalone
>   pass — `refreshChart` branches between the accumulating and group-career builders.
> - **Phase 5 (WebGPU)** — not started; still optional/learning-track.

0. **(Shipped) Persistent selected-player highlight + name label** in the smooth
   sweep — a selected player (e.g. Ohtani) is highlighted and named from the moment
   their season opens, even before they reach the frontier, using the live as-of
   point. This is the lightweight precursor to group-career and validates the
   "track selected players through the animation" interaction on the current SVG
   renderer. (Plus a fix so the career-mode smooth sweep locks axes to *career*
   totals, not season maxima.)
1. **`PointRenderer` abstraction + Canvas 2D backend** behind the existing SVG for
   axes/labels/frontier. Swap the background point-cloud join for a Canvas draw;
   build a `d3-quadtree` on the rendered points for tooltips. *Ship + measure
   first* — this alone should take the wide-window draw from ~90 ms to a few ms.
2. **Static/dynamic layer split** for the smooth sweep (background canvas redrawn
   on year boundary; foreground every frame) + **incremental frontier**. The 60 fps
   unlock.
3. **Animation-engine refactor** to the point-builder strategy (no behavior change
   — pure refactor enabling mode 3).
4. **Group-career mode**: multi-select UI + career-cumulative builder + trail
   rendering on the foreground layer. (Also delivers the Phase-3 career-cumulative
   sweep as the single-player case.)
5. **(Optional, learning track) WebGPU backend** behind `?renderer=webgpu` +
   capability check, falling back to Canvas 2D. Instanced point rendering first;
   GPU-compute dedup/Pareto as a stretch. Never the only backend — the offline
   bundle and unsupported browsers stay on Canvas 2D.

Steps 1–2 are the perf fix (Phase 4). Steps 3–4 are the group feature (Phase 5).
Step 5 is the WebGPU learning detour, decoupled so it can't regress the site.

## 6. Verification & perf gate

- Instrument per-frame draw time to `window.__bl2d_pbpFrameMs` (record p50/p95
  over a sweep) across viewports and the worst axis pair (a float×float like
  AVG×OBP, which dedups least). **Budget: p95 < 16 ms (60 fps); < 33 ms (30 fps)
  acceptable.** Capture before/after numbers against today's ~90 ms baseline.
- Correctness must not regress: the existing invariants still hold under Canvas —
  season-final cursor frontier == Lahman season frontier (HR×SB); accumulating
  multi-year final == static multi-year frontier. Quadtree hover must return the
  same player the SVG hit-test did (spot-check a few points).
- Group-career spot-checks: a selected player's career-end dot == their Lahman
  career total on a counting axis; a 20-year career's trail is monotonic in
  counting stats.
- `scripts/snap.js` viewport suite (1440×900, 1600×900, 390×844 panel open) in
  mid-sweep + final states; send before/after via `SendUserFile`.

## 7. Risks & notes

- **Text/a11y:** keep labels, axis ticks, and the legend in SVG — don't render
  text on Canvas (blurry, inaccessible). The frontier *labels* stay SVG and are
  few, so their layout cost (`layoutFrontierLabels`) is unaffected.
- **HiDPI:** size the canvas backing store to `devicePixelRatio` and scale the
  context, or dots look soft on retina. Redraw on the existing `ResizeObserver`.
- **Bundle:** the offline `dist/index.html` shares `script.js`; the Canvas path
  must work there too (no new CDN deps — d3-quadtree is already in the d3 bundle).
- **Memory:** season-accumulating mode needs no PBP for completed years (uses
  Lahman `data.points`), so memory stays bounded to the open season. Group-career
  mode holds the spanned seasons' decoded data; for big year spans, drop
  non-group players from the decoded structure to cap memory.
- **Zoom/pan:** the existing `viewDomain` zoom must re-scale the Canvas draw too;
  the Canvas render reads the same `xScale`/`yScale` so this is a redraw, not new
  logic.
