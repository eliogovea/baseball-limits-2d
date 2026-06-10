# Plan: GPU spring physics + per-frame GPU Pareto skyline (Vulkan + WebGPU twins)

## Context

`poc-vulkan/` is a working, committed native C/Vulkan (MoltenVK) POC that animates an
MLB HR×SB scatter (11,131 players, 520,200 monotone events, 1871–2025) with a 2-D Pareto
frontier. Today it is *partly* GPU-resident: a GPU `accumulate.comp` `atomicAdd`s event
counts into `hr[]`/`sb[]` and the vertex shader pulls straight from those, **but** (a) points
*teleport* between integer states each frame, and (b) the Pareto frontier is maintained
**incrementally on the CPU**.

A pasted architecture summary proposed a fully GPU-resident pipeline: critically-damped
**spring physics** so points glide smoothly, plus GPU frontier extraction via **spatial
tiling + dirty-tile** incremental recompute. We evaluated the summary against this problem:

- **The spring layer is the genuine win** — a clean, embarrassingly-parallel GPU compute
  pass that fits the existing vertex-pull architecture and gives smooth motion.
- **The tiling/dirty-tile layer is rejected.** Its load-bearing assumption — "a point update
  affects its tile + maybe one neighbor; influence is spatially local" — is **false for Pareto
  domination**: a single high point dominates an entire lower-left *quadrant* spanning
  arbitrarily many tiles. With n ≈ 11k, a per-frame **brute-force O(n²) GPU skyline** is exact,
  trivial on the Apple GPU, and dead simple. Tiling is documented as a "scale to millions" note
  only.
- Once positions are spring-smoothed *floats*, the integer-event incremental CPU trick no
  longer applies, which is exactly what *justifies* recomputing the frontier on the GPU each
  frame **from the smoothed positions** (the summary's correct insight).

> **Skyline complexity / scale-up:** brute-force O(n²) is the right call at n≈11k, but the
> alternatives — sort + parallel prefix-max for large n, and an "active-set" recompute that
> exploits monotonicity to rebuild from only `prevFrontier ∪ movedPoints` — and their GPU
> trade-offs are written up in [`skyline-gpu-approaches.md`](skyline-gpu-approaches.md).

**Decisions (confirmed with the user):**
- Spring physics + per-frame GPU brute-force skyline (no tiling); frontier from **smoothed
  positions**.
- **Two targets, sequenced:** land **`poc-vulkan-spring/`** first (native, cheap `make snapshot`
  correctness oracle), then port to a **`poc-webgpu-spring/`** twin (the path that feeds the real
  web app). Mirrors the existing `poc-vulkan` → `poc-webgpu` lineage.
- **Vulkan staircase: tiny CPU pass** (host-coherent read, free). **WebGPU staircase: fully on the
  GPU** (compaction + rank-sort + `drawIndirect`) — WebGPU's GPU→CPU readback is async and the
  documented headless device-loss trigger, so no per-frame readback. The `onFront` highlight is
  pure-GPU on both. (The GPU-staircase kernel is platform-agnostic and can be back-ported to
  Vulkan later for parity — see §"Parity note".)
- New sibling directories; leave `poc-vulkan/` and `poc-webgpu/` untouched as baselines to diff.

**Tier: T4** — new GPU compute/render pipeline contract (spring integrator + GPU skyline
kernel), the top-tier "rewrites a layer's render pipeline" signal. Plan agent ran on Opus.

## Approach

Copy `poc-vulkan/` → `poc-vulkan-spring/` and evolve it. Everything stays in one flat
`main.c` (no abstraction layers, per the project's flat-POC philosophy). `accumulate.comp`
stays **byte-for-byte unchanged**: `hr[]`/`sb[]` remain uint atomic counters and become the
spring **target**. Two new compute passes (`spring`, `skyline`) run every frame; the vertex
shader reads smoothed `pos[]` instead of the raw counters.

Spring is integrated in **data units** (HR/SB counts) so the constants stay window-independent
and the snapshot can compare `pos` against integer `(hr,sb)` directly. Use the **stable
semi-implicit (SmoothDamp / Game-Gems) critically-damped integrator** — unconditionally stable
for any `dt`, never overshoots.

## Code commenting standard (applies to ALL new files, both parts)

Every new source file (`main.c`, `core.c`, all `.comp`/`.wgsl` shaders, `main.js`, the Makefiles,
the snapshot scripts) must carry **verbose, pedagogical comments written as a learning resource** —
matching this repo's recent "pedagogical pass" commits. This is a hard requirement, not optional
polish. Specifically:

- **Explain the *why*, not just the *what*** — for every non-obvious GPU mechanic: why a pipeline
  barrier sits between two passes (which write feeds which read), why `hr/sb` stay `uint` (no float
  atomics on MoltenVK / atomic-typed in WGSL), why FIF=1, why host-coherent unified memory lets the
  CPU read `pos[]` for free on Vulkan but WebGPU must avoid `mapAsync` in the loop.
- **Derive the math inline** — the critically-damped spring: state the ODE, why critical damping
  (no overshoot), why the polynomial `e ≈ e^{-ωΔt}` form is unconditionally stable vs naive explicit
  Euler. The skyline: define Pareto domination, the strict tie-break, why O(n²) is fine at n≈11k and
  why tiling's locality assumption fails. The GPU staircase: the compact→rank-sort→emit pipeline and
  the step-function vertex layout.
- **Teach the platform deltas** — at each Vulkan→WebGPU difference, comment the reason
  (push-constants→uniform buffers, point sprites→instanced quads + disc test, Vulkan −Y flip vs
  WebGPU +Y up, GLSL `atomicAdd` vs WGSL `atomic<u32>`).
- **Block headers per phase/function** explaining its role in the frame graph; inline comments on
  the tricky lines (descriptor layout, barrier masks, indirect-draw args, atomic compaction).
- Keep the existing baselines' comment density and voice as the reference bar; the snapshot/verify
  harness comments should explain *what invariant is being proven and why it's sufficient*.

# Part 1 — `poc-vulkan-spring` (native Vulkan / GLSL)

## Files

New directory `/Users/eliogovea/Project/baseball-limits-2d/poc-vulkan-spring/`:

| File | Change vs copied baseline |
|---|---|
| `main.c` | +2 buffers (`pos`,`vel`); descriptor layout 6→8 bindings; +2 compute pipelines (`spring`,`skyline`) each with its own push-constant range; **delete** the CPU incremental frontier (`frontier_apply_event`, `hrCpu/sbCpu` shadow) from the live path; per-frame loop adds spring+skyline dispatches with barriers; CPU staircase now built from GPU `pos[]`+`onFront[]`; snapshot reworked to settle springs + validate the GPU skyline. |
| `shaders/spring.comp` | **New** — one thread/player, critically-damped step of `pos`/`vel` toward `(float(hr),float(sb))`. |
| `shaders/skyline.comp` | **New** — one thread/player, O(n²) domination test over `pos[]`, writes `onFront[]`. |
| `shaders/points.vert` | **Changed** — read `pos[idx]` (vec2) instead of `hr[idx]`/`sb[idx]`; NDC map, 5% margin, `-y` flip, era colour, `onFront` highlight all unchanged. |
| `shaders/{accumulate.comp,points.frag,line.vert,line.frag}` | Copied unchanged. |
| `Makefile` | Add `spring.comp.spv`,`skyline.comp.spv` to `SHADERS`; binary → `poc-vulkan-spring`; BMP → `/tmp/poc-vulkan-spring.bmp`; data paths stay `../data/pbp/...`. |
| `README.md`, `.gitignore`, `compile_flags.txt` | Copy; README rewrite the frontier/physics sections; `.gitignore` rename binary path. |

## Buffer + descriptor binding table (shared set, all HOST_VISIBLE|COHERENT)

`stageFlags = COMPUTE | VERTEX` on all bindings (shared layout bound to every pipeline).
Grow `binds[]`/`bsize[]`/`buf[]`/`bmem[]`/`writes[]` and the pool size from 6 → 8.

| Bind | Name | Element | Size | Written by | Read by |
|---|---|---|---|---|---|
| 0 | events | 3×uint | `g_evN*3*4` | (upload) | accumulate |
| 1 | hr | uint | `pc*4` | accumulate(atomicAdd), fill-on-wrap | spring (as float target) |
| 2 | sb | uint | `pc*4` | accumulate(atomicAdd), fill-on-wrap | spring (as float target) |
| 3 | debut | uint | `pc*4` | (upload) | points.vert |
| 4 | onFront | uint | `pc*4` | **skyline** (was CPU) | points.vert; CPU staircase |
| 5 | staircase | vec2 | `MAX_FRONT*2*2*8` | CPU (mapped) | line.vert |
| **6** | **pos** | **vec2** | `pc*8` | **spring** | points.vert; CPU staircase |
| **7** | **vel** | **vec2** | `pc*8` | **spring** (RW) | spring |

`pc` = playerCount. Buffers 1,2,6,7 get `TRANSFER_DST` usage (zeroed on wrap via
`vkCmdFillBuffer`). Persistently host-map `pos` (`posMap`) and reuse `g_onFront` for the CPU
staircase + snapshot reads. `MAX_FRONT=2048`, assert-guard the collected frontier size.

## Shaders (key math)

**`spring.comp`** — push `{float dt; float omega; uint count;}` (16B). Default `omega=12`
(~0.3 s settle). Stable integrator:
```
wd = omega*dt
e  = 1/(1 + wd + 0.5*wd² + wd³/6 + wd⁴/24)     // stable approx of e^{-wd}, ∈(0,1]
change = pos - target;  temp = (vel + omega*change)*dt
pos = target + (change+temp)*e;  vel = (vel - omega*temp)*e
```
Guarantees monotone decay, no overshoot, no blow-up at large `dt`.

**`skyline.comp`** — push `{uint count;}`. One thread/player; loop all `j`; `onFront[i]=1`
iff no `j` strictly dominates: `pj.x>=pi.x && pj.y>=pi.y && (pj.x>pi.x || pj.y>pi.y)`. Same
strict tie-break the baseline snapshot already uses. **Float-tie caveat:** coincident counters
may flicker on-front mid-glide (cosmetic); leave it — the snapshot validates at settled state
where `pos≈integer` and the test matches the integer brute-force exactly.

**`points.vert`** — read `vec2 p = pos[idx]`; rest identical. (Bindings 1/2 unused by vertex
now but stay in the shared layout — legal.)

## Per-frame host loop (live)

Pipelines: `accum`(push 8B `{lo,count}`), `spring`(16B), `skyline`(8B `{count}`),
`graphics`(8B `{maxX,maxY}`), `line`. Reuse a generic `storageRW` barrier
(COMPUTE→COMPUTE, SHADER_WRITE→SHADER_READ|WRITE) between compute passes and the existing
`compToVert` before render.

1. Poll; `dt = min(now-prev, 0.05)`; advance cursor; detect `wrapped`.
2. Compute event slice `[lo, lo+cnt)` (as baseline). **No CPU frontier work.**
3. `vkWaitForFences`; reset.
4. **Build staircase from the PREVIOUS frame's GPU output** (`posMap`+`g_onFront`, valid post-fence): collect `onFront!=0`, sort by x asc, emit step verts (adapt `build_staircase` to floats) → `staircaseMap`, set `lineVerts`. One-frame lag (~16 ms) avoids a mid-frame GPU↔CPU stall.
5. Acquire image; begin cmd.
6. **If wrapped:** `vkCmdFillBuffer` zero hr/sb/pos/vel; barrier `TRANSFER→COMPUTE|VERTEX`.
7. **Accumulate** (if `cnt>0`): push `{lo,cnt}`, dispatch `(cnt+63)/64`; barrier `storageRW`.
8. **Spring** (every frame): push `{dt,omega,pc}`, dispatch `(pc+63)/64`; barrier `storageRW`.
9. **Skyline** (every frame): push `{pc}`, dispatch `(pc+63)/64`; barrier `compToVert`.
10. **Render:** points `vkCmdDraw(pc)` POINT_LIST; if `lineVerts>=2`, line LINE_STRIP.
11. End; `applied=target`; submit; present.

Spring + skyline run every frame even with `cnt==0` (points keep gliding; `pos` changes each
frame). On wrap, zeroing pos/vel snaps the cloud to origin for a crisp replay.

## Staircase decision

CPU pass, built from the **previous** frame's settled `pos`/`onFront`. The frontier subset is
tiny (≤ few hundred) so `O(K log K)` sort + step emission is trivial; a fully-GPU staircase
(compaction + sort + `vkCmdDrawIndirect` with GPU count) is materially more code, not worth it
for a POC. **Tradeoff:** keeps a cheap per-frame host read (~132 KB) over Apple unified memory
— so not 100% "GPU-resident"; documented as the simplicity/residency trade, with the GPU path
noted as the future upgrade (reuses the skyline's `onFront`).

## Verification

`make` (clang + glslc), `make validate` (Khronos layers — run once to confirm new
barriers/descriptor writes are clean), `make run` (live; can't screenshot in this env — no
Screen Recording perm, so the snapshot diff + BMP is the proof).

**`make snapshot` (BL2D_SNAPSHOT=1):** apply ALL events once → **settle springs** (single
huge-`dt` spring dispatch, e.g. `dt=1000` → `e≈0` → `pos→target` in one step; keeps snapshot
cheap on SwiftShader) → skyline once → render offscreen → `/tmp/poc-vulkan-spring.bmp` → png
via `sips`. Invariants (all expect 0; nonzero → exit 1):

- **(i) Spring convergence:** `|posMap[i] - (hr[i],sb[i])| <= 0.5` for all players.
- **(ii) GPU skyline == brute-force Pareto:** reuse baseline's O(n²) `dom[]` over the CPU
  replay counters; assert `(g_onFront[i]!=0) == !dom[i]` for every player. Validates the GPU
  skyline kernel (the property baseline checked, now on the GPU path).
- **(iii) Spot checks:** Bonds HR=762/SB=514 `[frontier]`; Henderson HR=296/SB=1406
  `[frontier]`; settled all-time frontier == exactly those two (size 2).

Send the resulting BMP→PNG to the user with `SendUserFile` in the same turn it's produced.

---

# Part 2 — `poc-webgpu-spring` (browser WebGPU / WGSL + WASM core)

Port the Vulkan track to a new sibling `poc-webgpu-spring/`, copied from `poc-webgpu/`
(C→WASM core `core.c` + JS WebGPU glue `main.js` + WGSL shaders). The port is mostly
mechanical; the **one substantive difference is the staircase, which goes fully on the GPU**.

## What changes vs the `poc-webgpu` baseline

- **C/WASM core (`core.c`): the career path no longer computes the frontier.** Today `core.c`
  owns `frontier_apply_event` + `build_staircase` and JS uploads `onFront[]`/`staircase[]` from
  the WASM heap each frame. In the spring twin, the GPU owns the frontier (skyline → onFront,
  and the GPU staircase). The WASM core keeps: event decode, the `[lo,cnt)` slice computation
  (`step_career` still returns `StepOut{lo,cnt,zeroGpu,...}`), and — kept only as the **headless
  verification oracle** — the existing `verify_career()` O(n²) brute force. `build_staircase` and
  the per-frame `onFront` upload are dropped from the live path. (Season mode out of scope for the
  POC; keep it on the baseline path or stub it.)
- **New GPUBuffers** (STORAGE | COPY_DST): `bPos` (vec2/player), `bVel` (vec2/player); plus the
  GPU-staircase scratch (below). `bHr`/`bSb` stay (atomic counters = spring target).
- **points.wgsl** reads `bPos` (vec2) instead of `hr/sb`; instanced-quad pull, +Y up (no flip),
  disc test, era colour, `onFront` highlight all unchanged.
- **Uniforms** (no push constants): extend with a spring uniform `{dt, omega}` and reuse the
  `Win{lo,count}` / `Params{maxX,maxY,ptSize,aspect}` buffers as today.

## New WGSL compute passes (translate the GLSL 1:1)

- `spring.wgsl` — `@workgroup_size(64)`; identical stable critically-damped math as §3a; reads
  `hr/sb` as float target, RW `pos`/`vel`. WGSL note: `hr/sb` are declared `array<atomic<u32>>`
  for the accumulate pass — read them here with `atomicLoad(&hr[i])` (or bind the same buffer
  through a second non-atomic `array<u32>` view in a read-only bind group; simplest is
  `atomicLoad`). `dt` clamped host-side, passed via the spring uniform.
- `skyline.wgsl` — `@workgroup_size(64)`; O(n²) domination test over `pos[]`; writes `onFront`.
  Same strict tie-break as §3b.

## Fully-GPU staircase (the new algorithm; WebGPU uses it, Vulkan optionally back-ports)

After `skyline` has written `onFront[]`, build the ordered step-line entirely on the GPU. The
frontier subset K is small (tens to a few hundred; cap `MAX_FRONT`, e.g. 1024). Buffers:
`bFrontIdx` (u32 × MAX_FRONT), `bFrontSorted` (vec2 × MAX_FRONT), `bCount` (atomic<u32>, 1 elem),
`bStaircase` (vec2 × (1+2·MAX_FRONT)), `bIndirect` (draw-args: `{vertexCount, instanceCount=1,
firstVertex=0, firstInstance=0}`, usage INDIRECT | STORAGE | COPY_DST). Three tiny dispatches
per frame, barriers between (separate compute passes in the same encoder serialize):

1. **Reset** — `queue.writeBuffer(bCount, 0, [0])` (or a 1-thread clear).
2. **Compact** (`@workgroup_size(64)`, n threads): if `onFront[i]!=0`, `let k = atomicAdd(&count, 1u);
   frontIdx[k] = i;`. Produces an unordered frontier index list + `count = K`.
3. **Rank-sort + emit** (one pass, K threads via an over-dispatch guarded by `k < count`):
   for thread `k` (a frontier slot), compute `rank = Σ_j [ pos[frontIdx[j]].x < pos[frontIdx[k]].x
   || (== && frontIdx[j] < frontIdx[k]) ]` over all `j < count` (O(K²) total, trivial at K≤few
   hundred — mirrors the brute-force skyline). Scatter `sorted[rank] = pos[frontIdx[k]]`. **Barrier**,
   then emit: thread `r` (rank slot) writes the two step vertices at deterministic offsets — cap at
   slot 0 `(0, sorted[0].y)` (written by `r==0`), then `staircase[1 + 2r] = (sorted[r].x,
   sorted[r].y)` and `staircase[1 + 2r + 1] = (sorted[r].x, (r+1<K ? sorted[r+1].y : 0))`. This
   reproduces the baseline `build_staircase` geometry. Thread 0 writes
   `bIndirect.vertexCount = 1 + 2*K`.
   (Implementable as two dispatches — rank/scatter then emit — to get a clean barrier; or one
   dispatch with the emit reading a second buffer. Two is simplest.)
4. **Render** — `pLine` pipeline, `rp.drawIndirect(bIndirect, 0)`. No CPU readback, no count plumbed
   through JS.

## Per-frame JS loop (`renderAt`)

`step_career(cursor)` → read `StepOut{lo,cnt,zeroGpu}` from the heap (as today). Update `Win`,
`Params`, spring uniform. If `zeroGpu`: `writeBuffer` zero `hr,sb,pos,vel` and reset `bCount`.
One encoder: accumulate pass (if `cnt>0`) → spring pass → skyline pass → reset/compact/sort/emit
passes → render pass (points `draw(6, playerCount)` + `pLine.drawIndirect`). Submit. Blit
offscreen→canvas only when `canvasOk` (the `!HeadlessChrome` gate, unchanged). **No per-frame
`onFront`/`staircase` upload from WASM** — both now produced on the GPU.

## WebGPU verification

`snap-webgpu.js` clone → `snap-webgpu-spring.js`; same Chrome flags + offscreen-texture →
`copyTextureToBuffer` → `mapAsync` PNG capture (one-shot, not per-frame). Invariants via
`window.__bl2d_verify*` hooks:
- **(i) skyline correctness:** drive to end-of-history, settle springs (set spring uniform to a
  huge `dt` for one frame, or step a few frames at the end state), then **read back `onFront` once**
  (`copyBufferToBuffer`→`mapAsync`) and compare to `core.c`'s `verify_career()` brute force →
  `frontierMis == 0`. This is a one-shot readback in the verify hook (not the render loop), so the
  device-loss risk doesn't apply to the live path.
- **(ii) counter parity:** `readbackCounters()` (existing) — GPU `hr/sb` vs WASM shadow → `counterMis 0`
  (degrades to −1 if headless Dawn drops it, as documented).
- **(iii) spring convergence:** read back `pos` once at settled state; `|pos - (hr,sb)| ≤ 0.5`.
- **(iv) spot checks:** Bonds 762/514, Henderson 296/1406 on-front; settled all-time frontier size 2.
- **(v) visual:** the captured PNG shows the red staircase + gold/era cloud; send via `SendUserFile`.

## Parity note

The Vulkan track (Part 1) uses the simple CPU staircase by the user's choice. The GPU-staircase
kernels above are plain compute + `vkCmdDrawIndirect` and can be back-ported to `poc-vulkan-spring`
for full Vulkan/WebGPU parity if desired — not required for this plan, noted so the two twins can be
reconciled later.

## Risks / unknowns

1. **SwiftShader O(n²) snapshot cost** — 124M comparisons single-shot; use the 1-dispatch
   settle to keep it to accumulate+1 spring+1 skyline. Real Apple GPU: trivial at 60fps (why
   brute-force is chosen over a sort-based skyline).
2. **Spring stability** — handled by the polynomial-`e` integrator + `dt` clamp; eyeball that
   points never overshoot.
3. **Float tie flicker mid-glide** — cosmetic; settled snapshot exact. Optional deterministic
   index tie-break if objectionable (then make the snapshot brute-force index-aware).
4. **Frontier size bound** — keep `MAX_FRONT=2048`, assert-guard; raise if it ever fires.
5. **One-frame staircase lag** (Vulkan only) — imperceptible; cost of avoiding the stall. (The
   WebGPU GPU-staircase has no lag — it's computed from the current frame's `pos`.)
6. **WebGPU `atomic<u32>` read in spring** — `hr/sb` are atomic-typed for accumulate; read them in
   `spring.wgsl` via `atomicLoad` (or a second non-atomic read-only bind-group view). Pick one and
   keep it consistent.
7. **WebGPU `drawIndirect` + GPU-written count** — `bIndirect` needs `INDIRECT | STORAGE | COPY_DST`;
   ensure the compute pass writing `vertexCount` and the render pass reading it are ordered (same
   encoder, separate passes). Reset `bCount` every frame.
8. **GPU-staircase `MAX_FRONT` bound** — the compact pass `atomicAdd` can overflow if K exceeds the
   buffer; clamp `k < MAX_FRONT` before writing. Cap 1024 is safe for this dataset; assert in the
   verify hook.
9. **Headless device-loss** — keep ALL per-frame readback off the WebGPU render loop; the only
   `mapAsync` calls are in the one-shot `__bl2d_verify*` hooks and the PNG capture, never in
   `renderAt`. The `!HeadlessChrome` canvas gate stays.
