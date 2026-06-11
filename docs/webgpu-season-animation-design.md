# Design: GPU season-mode animation (Phase 6)

**Status: design only — implementation pending.** This doc is written to be implemented
**incrementally across sessions**. Each phase below is independently shippable and has its own
verification gate. If you're resuming, read **§"Resuming"** first, then the **Progress trail**,
then jump to the first phase whose checkbox is unticked.

## Context & goal

Today the GPU spring engine (`?renderer=webgpu&gpustream=1`) only smooths **career** mode. In
the `.evt` play-by-play path, `refreshChart` sets `evtCareer`/`evtSeason` (`script.js:1493-1515`):

- **Career** (`mode==="career"`): one point per player = career-cumulative `(x,y)`, *all moving*
  each frame → `filters.evt=true` → the `gpuCloud`/`gpuSpring` gate passes → 60 fps glide loop.
- **Season** (`mode==="season"`): completed seasons sit **static** at full Lahman totals (cached
  on the bg canvas); only the **open** season's points grow game-by-game → `filters.evt=false`
  → CPU cloud at the ~15 fps `PBP_PLAY_FRAME_MS` throttle. **Choppy.**

Goal: make season mode animate as smoothly as career, reusing the existing GPU pipeline
(accumulate → spring → skyline → staircase, `WebGPURenderer` in `script.js`).

## The key insight (why this is tractable)

A **season value is the career-cumulative counter differenced against the season's start**
(`evtOpenSeasonPoints`, `script.js:1144-1160`):

```
seasonValue(player, dep, d, O) = cum(dep, d) − cum(dep, seasonStart(O) − 1)
```

The GPU accumulate path already maintains per-player **career-cumulative** counters (`bX`,`bY`).
So season mode needs only: a per-player **season baseline** (the counter as of the open season's
start) and a **spring target of `counter − base`**. ~90% of the career pipeline is reused.

Two ways to get the within-season value on the GPU (decide in S1):

- **(A) Snapshot/difference (recommended):** keep `bX/bY` (career, untouched). Add `baseX/baseY`
  buffers; when the cursor crosses into a new open year `O`, copy `bX→baseX`, `bY→baseY` *at the
  season boundary*. Spring target = `bX − baseX`. Minimal change to the proven accumulate path
  (the subtraction lives in the spring shader's target read).
- **(B) Dual accumulator:** the accumulate shader writes the event delta into *both* `bX` (never
  reset) and `seasonX` (zeroed at each year boundary). Target = `seasonX`. Cleaner target read,
  but edits the accumulate shader and needs a per-year zero.

Both must handle the **boundary correctly**: a single frame's event window can straddle a
year boundary, and backward seeks/scrubs jump arbitrarily. See S1.

## Three sub-problems

1. **Open-season moving cloud** — the active players in `O`, spring-glided. Small set (a few
   hundred active players), so cheap. *This is the visible win.*
2. **Completed seasons (static)** — one point per player per completed season, `year ∈ [winStart, O)`.
   Static between year boundaries. **Keep on the existing CPU bg cache / bg buffer** — no spring
   needed; only rebuild when `O` advances.
3. **Frontier over the union** — the Pareto staircase spans completed ∪ open points. The naive
   GPU skyline is O((Nc+No)²) and `Nc` (completed) can be tens of thousands. Use a **hybrid**:
   CPU keeps the *completed* frontier (static between years, ≤ few hundred points) and the GPU
   skyline runs only over (completed-frontier ∪ open points) — a bounded set ≤ `WEBGPU_MAX_FRONT`.

## Phased plan

Each phase is shippable; later phases degrade gracefully to the CPU path if unbuilt.

### [ ] S0 — Gating & active set (scaffolding, no GPU render yet)
- Add `evtSeason`-aware flags parallel to career: a `gpuSeasonCloud` gate mirroring the
  `gpuCloud` gate (`script.js:5728-5740`) but for `evtSeason` (drop the `filters.evt` requirement;
  add `filters.evtSeason`), and `gpuSeasonSpring = gpuSeasonCloud && springMode`.
- Pass the open year `O` and the active-player set (active in `O`: `O>=debutYear && O<=lastYear`)
  to the renderer (a per-player `activeMask` uint8 buffer or an instance list).
- **Checkpoint:** `window.__bl2d_evtGpuSeason` reflects the gate; nothing renders on GPU yet
  (still CPU cloud). No visual change.

### [ ] S1 — Season targeting on the GPU (correctness core)
- Implement approach (A): `baseX/baseY` buffers + a `seasonOpenYear` the renderer tracks.
- **Boundary logic:** when `uploadEvtStream`/`accumulateCloud` advances and `O` changes, snapshot
  at the boundary. Concretely, split the applied window at `seasonStart(O)`: apply up to the
  boundary, `copyBufferToBuffer(bX→baseX, bY→baseY)`, then apply the rest. On a **backward seek**
  into year `O` (or `win.zero`), recompute: zero, replay `[0, seasonStart(O)-1)` to set the base,
  snapshot, then replay `[seasonStart(O), d]`. Reuse the career zero+replay machinery
  (`accumulateCloud` `didZero`, `gpuApplied`).
- Spring target read becomes `target = bX − baseX` (in `WEBGPU_SPRING_WGSL`, gated by a uniform
  `seasonMode` flag so the same shader serves both modes).
- **Verify (headless, no render needed):** add `window.__bl2d_verifySeason(O)` that drives the
  GPU to a few dates in `O`, reads back `bX−baseX`, and compares to `evtOpenSeasonPoints(model, d, O)`
  for the same players → `seasonMis === 0`. Mirror the `__bl2d_verifySpring` one-shot readback
  pattern (`script.js` ~4233). Test a year boundary crossing and a backward scrub.
- **Checkpoint:** season targets exact on the GPU; still drawn by CPU. Ship-safe.

### [ ] S2 — Render the open-season sprung cloud
- Draw the active-in-`O` players via the existing spring-cloud pipeline (`pSpringCloud`),
  vertex-pulling `pos[]` (now gliding toward the season target). Non-active players: cull
  (instanceCount = active count, compacted) or alpha 0.
- Completed seasons stay on the **bg layer** (existing `data.points` cache, drawn by `drawPts("bg")`
  in `present()`), rebuilt only when `O` advances.
- Extend the **glide loop** (`springLoop`/`presentGlide`, `script.js`) to fire when
  `gpuSeasonSpring` (set `lastGpuSpringFrame` from `gpuSpring || gpuSeasonSpring`).
- Suppress the SVG HV-shade + staircase under `gpuSeasonSpring` too (same reason as career —
  the CPU frontier would lead the gliding cloud); reuse the `!gpuSpring` guard, widen to
  `!(gpuSpring || gpuSeasonSpring)` (`script.js:5754`).
- **Checkpoint:** open-season cloud glides at display refresh; completed cloud static; frontier
  still CPU (drawn only when paused, like career today). Visible smoothness win.

### [ ] S3 — GPU frontier for season (hybrid skyline + staircase)
- CPU maintains the **completed-season frontier** (Pareto of `year ∈ [winStart, O)`), recomputed
  only when `O` advances (cheap, static between years). Upload it as ≤ few-hundred static points.
- GPU skyline runs over (completed-frontier ∪ open-season points) → `onFront[]` → the existing
  `compact→ranksort→emit→drawIndirect` staircase. Bounded by `WEBGPU_MAX_FRONT`.
- **Verify:** `verifySeason` also checks the GPU staircase == a CPU brute-force Pareto over the
  same union (`skylineMis === 0`); spot-check a known season record (e.g. single-season SB).
- **Checkpoint:** the red staircase is GPU-drawn and matches; the SVG staircase stays suppressed
  during play. Full parity with the career path.

### [ ] S4 — Polish & edge cases
- Backward-seek/scrub correctness across many year boundaries; the year-boundary "freeze" (open
  season's points becoming static completed points when `O` advances) should be visually clean.
- Rate axes (AVG/OBP/…) excluded exactly as career (non-monotone → CPU fallback); bats/country
  filter still forces CPU (the eligibility-mask desync caveat, `script.js:5736`).
- Perf: confirm the per-frame season skyline (union set) stays within budget; if `Nc`-frontier
  ever exceeds `WEBGPU_MAX_FRONT`, cap + document.
- **Checkpoint:** season parity shipped; update README backlog `- [x] *(shipped <sha>)*` and
  CLAUDE.md notes; add a `docs/webgpu-main-app-integration-design.md` §"Phase 6" cross-link.

## Invariants (assert per phase, headless via `window.__bl2d_*`)
- **Season exactness:** GPU `bX−baseX` (or `seasonX`) == `evtOpenSeasonPoints` value, ½-unit
  tolerance, across a forward sweep, a year-boundary crossing, and a backward scrub. (`seasonMis 0`)
- **Skyline:** GPU `onFront` over the union == CPU brute-force Pareto. (`skylineMis 0`)
- **No desync:** career counters `bX/bY` are never mutated by the season path (season uses
  `baseX/baseY` or a separate `seasonX/seasonY`), so switching career↔season mid-play stays exact.
- **Frontier longevity / records:** a known single-season record sits on the season frontier at
  the right cursor date.

## Risks / open questions
- **Boundary-straddling windows** (S1) are the main correctness risk — the snapshot must land
  exactly at `seasonStart(O)`. Splitting the window is the safe route; verify both directions.
- **Skyline cost** (S3): if a wide window's completed-frontier + active set approaches
  `WEBGPU_MAX_FRONT`, the O(K²) ranksort cost grows. The hybrid keeps `K` small in practice;
  measure on a full-history HR×SB sweep before committing.
- **Approach A vs B** (S1): A is less invasive (recommended); revisit if the boundary split
  proves fiddlier than a dual accumulator with a per-year zero.

## Key seams (where to work)
- `script.js:1144-1166` `evtOpenSeasonPoints` / `evtAsOf` — the CPU source of truth for season values.
- `script.js:1100-1106,1131` `seasonStartByYear` / `seasonEndByYear` / `yearOf` — boundary indices.
- `script.js:1493-1515` `refreshChart` evtCareer/evtSeason branch — add `gpuSeasonCloud`/`gpuSeasonSpring`.
- `script.js:5728-5754` the `gpuCloud`/`gpuSpring` gate + HV-shade/staircase suppression — widen to season.
- `WebGPURenderer` (`script.js` ~3499+): `accumulateCloud` (boundary snapshot), `_initSpringBuffers`
  (add `baseX/baseY`), `WEBGPU_SPRING_WGSL` (target = counter − base, `seasonMode` uniform),
  `present`/`presentGlide` (season cloud draw), the staircase passes (union skyline).
- Glide loop: `springLoop`/`presentGlide`/`lastGpuSpringFrame` — extend to `gpuSeasonSpring`.

## Resuming

If you are picking this up cold:
1. Read **§"The key insight"** and **§"Three sub-problems"** — that's the whole model.
2. Check the **Progress trail** below for the first unticked phase; its checkbox `[ ]`/`[x]`
   mirrors the `### [ ] Sx` headings above (keep them in sync).
3. Each phase has a **Checkpoint** that is independently shippable and a **Verify** gate — do not
   advance until its invariant passes headless.
4. The career analogue is already shipped (`docs/webgpu-main-app-integration-design.md` §"Phase 5");
   crib the accumulate/spring/skyline/staircase mechanics + the `__bl2d_verifySpring` harness from there.

## Progress trail

| Phase | What | Status | Notes / commit |
|-------|------|--------|----------------|
| S0 | gating + active set | ☐ not started | |
| S1 | GPU season targeting + `verifySeason` | ☐ not started | correctness core; do boundary split + backward-seek tests |
| S2 | open-season sprung cloud render + glide-loop hookup | ☐ not started | first visible smoothness win |
| S3 | hybrid GPU frontier (skyline + staircase) | ☐ not started | |
| S4 | polish, edge cases, README/CLAUDE.md updates | ☐ not started | |

_Update this table (and the `### [ ] Sx` checkboxes) at the end of every working session so the
next one resumes cleanly._
