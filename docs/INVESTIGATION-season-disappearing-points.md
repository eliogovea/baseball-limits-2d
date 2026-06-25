# INVESTIGATION — season animation "disappearing points" / near-origin holes

**Reported 2026-06-21** (branch `feat/event-level-pbp`). One concrete latent bug was found
and **fixed**; a second, perceptual/density question is **left open for a future
investigation** (this doc is the resumable trail).

---

## Part A — FIXED: completed-frontier phantom dots could vanish mid-glide

### Symptom hypothesis
During the **season** animation, a completed-season "phantom" frontier dot could blink out
when an open-season point Pareto-dominated it.

### Root cause (confirmed in code)
In a season frame the GPU draws points in two passes:
- **Cloud pass** drew only `instanceCount = e.players` instances (the open-season players).
- **Frontier pass** draws `frontInstanceCount = players + nCompleted` — open players **plus**
  the static completed-frontier phantoms (uploaded into the `pos[]`/`bColor[]` tail at
  `[players, players+nCompleted)` by `uploadCompletedFrontier`, script.js) — but only those
  with `onFront == 1`.
- The union skyline (`WEBGPU_SKYLINE_WGSL`) recomputes `onFront` over the whole union each frame.

A phantom (index `≥ players`) was therefore reachable **only** by the frontier pass. When an
open point dominated it, its `onFront` flipped to 0 → the frontier pass skipped it **and** it was
beyond the cloud pass's count → drawn by **neither pass → vanished**.

### Fix
Make the **season** cloud pass cover the **union** count (`players + nCompleted`) instead of just
`players`, so a dominated phantom demotes to a faint background cloud dot instead of disappearing.
On-front phantoms stay degenerate in the cloud pass (drawn red by the frontier pass) → no
double-draw. Career (`spring`) source keeps `instanceCount` (it has no phantoms).

Edits in **`script.js`** (both present paths must match — `LEGACY_PRESENT` defaults true):
- `present_unified()` cloud-pass draw: `const cloudCount = d.source === "season" ? d.frontInstanceCount : d.instanceCount;` (≈ line 4261).
- `present_legacy()` cloud-pass draw: `const cloudCount = seasonOn ? (evt.pending.frontInstanceCount || evt.pending.instanceCount) : evt.pending.instanceCount;` (≈ line 4368).

### Verification
- `__bl2d_verifySeasonFrontier([1998,2001,2002])` → **`allGreen, totalKernel 0, totalFront 0`**
  (the union skyline / frontier set is unchanged — the fix only adds off-front phantoms to the
  cloud render pass).
- Real-GPU frames render correctly (`snap-realgpu.js`), no regression.

### Caveat (why its *visible* impact is small for the default view)
Empirically, for **HR×SB** a single in-progress season almost never dominates a completed-season
frontier point on both axes — across ~200 live play frames, **0** phantoms went off-front. So this
fix is mostly latent for HR×SB; it matters for axis pairs / eras where an open season can surpass a
completed-frontier "elbow" point on both axes. It is a correct, safe fix regardless.

---

## Part B — OPEN: perceived "disappearing points" and near-origin holes

### What the user reported
1. "Some previous points disappear in the direction a new point is moving."
2. Happens **near the origin as well**, not only near the frontier.
3. **Season only** — does **not** happen in career mode.
4. During **steady playback**; the points **come back** (transient).
5. Default **HR×SB** batting view.
6. "Fixed x (HR), for a point advancing in y only, the position it moves onto has no point, even
   when there were points there before."
7. "By ~1995/1997 the near-origin region should be covered with points, but you still see plenty of
   holes."

### What was RULED OUT (live-GPU instrumentation; real GPU via `scripts/snap-realgpu.js`)
- **No mid-season (0,0) clipping of open points.** A point is invisible only when its season value
  is exactly `(0,0)` (the shader's `(0,0)` guard). Tracking the open zero-set frame-to-frame at
  0.25× found **`deepMidSeasonClips = 0`** — no open point blinks to the origin and back within a
  season. The only mass-`(0,0)` event is the intended **season-boundary collapse** ("grow from the
  origin", `accumulateSeasonCloud` zeroes pos/vel on `first || baseChanged`).
- **No completed-phantom off-front for HR×SB** (Part A) — 0 across ~200 frames.
- **No render dropout.** Overlaying *every* GPU data point onto the rendered pixels (project via the
  scale `px = interceptX + slopeX·HR`, `py = interceptY + slopeY·SB`): **0 / 436** points (settled)
  and **0 / 245** (mid-glide) land on an empty pixel. Every data point is drawn.
- **No under-population.** GPU `pos` equals the true season value `max(career − baseline, 0)`
  exactly (`posVsTrueMismatch = 0` when settled). A **full season has only ~530 nonzero points**;
  only ~half of the near-origin integer cells `[0..15]²` are ever occupied. The empty cells are
  combinations like (0 HR, 10 SB), (1 HR, 7 SB), (3 HR, 11 SB) that **no player reached** that
  year — genuine data gaps.

### Leading explanations (perception / design — not a data or render bug)
1. **Single-season sparsity vs career density.** Career accumulates every year into one dense
   cloud; season shows one year (~530 players, clustered in the lowest cells, many integer combos
   empty). Season will always look holier near the origin. Explains "season only, not career".
2. **Mid-glide smearing.** During playback the cursor never lets the spring settle, so points glide
   *between* integer cells; a cell reads empty while its point is in transit. **Test: pause — the
   cells should crisp up** as points snap home. Explains "advancing point's destination looks empty"
   and "they come back".
3. **Season-boundary collapse-regrow pulse** (intended SA design) — a brief whole-cloud snap to the
   origin at each year tick.

### Open questions for the future investigation
- Is the user's expectation actually a **cumulative-through-year** semantic (a growing career-like
  cloud) rather than the isolated single-season snapshot the mode shows today? If so this is a
  **feature** (new season aggregation mode), not a bug fix.
- Is there a **machine-specific** visual artifact (compositor/driver) that the headless real-GPU
  harness cannot reproduce? Needs a **short screen recording** from the user, or a paused-frame
  counterexample: a cell that is empty **when paused** despite a player truly having that HR/SB that
  year (that would contradict the measurements above and be a real bug to chase).
- Would a presentation tweak help even if the data is faithful: higher season cloud opacity, a
  snappier/slower spring so points settle more between steps, or short motion trails?

### Resumable tooling (probes were used then removed — re-add to continue)
All driven on a **real GPU** via `scripts/snap-realgpu.js` with
`?webgpuHeadless=1&renderer=webgpu&gpuseason=1#m=season&ds=batting&x=HR&y=SB&smooth=1`.
Navigation gotchas: clicking `#anim-play-btn` to **play restarts the cursor at the window start**;
setting `#pbp-scrubber` directly **disengages the gpuSeason gate** (stale `__bl2d_*` data) — so to
reach a year, **play** (use `#pbp-speed-seg [data-speed="8"]`) and poll `__bl2d_evtCursorYear()`.
The `gpuSeason` gate is confirmed **on** for every live-play frame.

Temp `window.__bl2d_*` probes (read the live GPU buffers via `pointRenderer._readback`):
- **`openZeroLive`** — open-point `pos` zero-set + count, for transient-`(0,0)` detection.
- **`phantomLive`** — completed-phantom tail `onFront`/`pos`, for off-front detection.
- **`openPosScales`** — open `pos` + the GPU scale params, to project data→pixel and check coverage
  (set `window.__bl2d_lastScales` from `gpuScaleUniform(...)` in the `refreshChart` gpuSeason
  branch). Capture data + PNG in the same paused frame; in Python, check each point's pixel for ink.
- **`seasonCoverage`** — reads `bX/bY` (career counters) + `baseX/baseY` (baselines) + `pos`,
  computes the true season value, and reports `posVsTrueMismatch`, nonzero count, and near-origin
  cell occupancy / sample holes.

Helper capture scripts (throwaway, under `/tmp` during the session): a burst-capture that navigates
to a target year then grabs N consecutive offscreen readbacks; an overlay capture that pauses and
returns both the data positions and the PNG for a pixel-coverage check.
