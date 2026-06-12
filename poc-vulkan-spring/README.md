# `poc-vulkan-spring` — GPU spring motion + GPU Pareto skyline (native Vulkan / MoltenVK)

The **spring twin** of [`../poc-vulkan`](../poc-vulkan). Same MLB **(HR, SB)** history sweep, but
two things move onto the GPU and become smooth:

1. **Critically-damped spring motion.** In the baseline a dot *teleports* one notch when a counter
   ticks. Here a GPU compute pass (`spring.comp`) keeps a continuous position `pos[]` + velocity
   `vel[]` per player and each frame glides `pos` toward the integer target `(hr, sb)` with **no
   overshoot**. The dots flow instead of jumping.
2. **Per-frame GPU Pareto frontier.** The baseline maintained the non-dominated "limits" set
   incrementally on the CPU (cheap, because integer events are monotone). Once positions are
   *smoothed floats* that shortcut no longer applies, so a GPU pass (`skyline.comp`) recomputes the
   frontier every frame by brute-force O(n²) domination over `pos[]`, writing `onFront[]`.

The CPU is left with just: advance the clock, compute the per-frame event slice, submit, and
assemble the (tiny) frontier staircase line from the GPU's output. Full design + rationale:
[`../docs/rendering.md`](../docs/rendering.md) (original full design: `docs/gpu-spring-skyline-design.md`, git history).

## The GPU frame graph

```
data/pbp/hr.evt.gz ┐ decode (CPU, once) → one date-sorted event list {player,stat,count}
data/pbp/sb.evt.gz ┘ resident on the GPU; ~11,131 batters, 520,200 events, 1871–2025
        │
        ▼  CPU time engine: cursor walks events forward; dispatch over the NEW [lo,count) slice
        │
   accumulate.comp   if HR: atomicAdd(hr[p], n);  if SB: atomicAdd(sb[p], n)   (UNCHANGED)
        │            hr[]/sb[] are now the spring TARGET, not the drawn position
        ▼  barrier (compute write → compute read)
   spring.comp       glide pos[] toward (hr,sb) with a critically-damped step; update vel[]
        │
        ▼  barrier (compute write → compute read)
   skyline.comp      onFront[i] = 1 iff no j dominates pos[i]   (O(n²), exact, no tiling)
        │
        ▼  barrier (compute write → vertex read)
   points.vert       vertex-pull x,y from pos[] (not the counters); era colour + frontier highlight
   line.vert         the staircase the CPU assembled from the GPU's pos[]/onFront[]
```

### Why a critically-damped spring (the math)

A dot chasing a moving target with no jitter is a damped harmonic oscillator. For the offset
`x − target` with natural frequency `ω`, the ODE is `x'' + 2ζω·x' + ω²(x−target) = 0`. At the
critical damping ratio `ζ = 1` you get the **fastest approach with zero overshoot** — the dot
rushes to its new `(hr,sb)` and stops dead. `spring.comp` uses the stable closed form (Game
Programming Gems 4 / "SmoothDamp"): it replaces the exact decay `e^{−ωΔt}` with a rational
approximation that stays in `(0,1]` for *any* `Δt`, so a frame-time spike can never make it blow
up or oscillate. Only `ω` is exposed (`omega = 12` ⇒ ~0.3 s settle).

### Why brute-force O(n²) for the frontier (and no tiling)

`n ≈ 11k` ⇒ ~124M comparisons/frame, sub-millisecond on an Apple GPU — simpler and exact versus a
sort-based skyline. We deliberately **rejected** the spatial-tiling / dirty-tile scheme that
general "GPU frontier" write-ups suggest: its premise that *a point's influence is spatially local*
is **false for Pareto domination** — one high point dominates an entire lower-left quadrant across
arbitrarily many tiles. Tiling only pays off at millions of points. See the design doc.

### Why the CPU still builds the staircase (here)

On Apple the buffers are host-coherent unified memory, so reading `pos[]`/`onFront[]` right after
the frame fence is essentially free; the frontier is tiny, so sorting it + emitting the step line is
nothing. (The **WebGPU twin can't** do this cheaply — its GPU→CPU readback is async and the
documented headless device-loss trigger — so it builds the staircase *fully on the GPU* via
compaction + rank-sort + `drawIndirect`. Same algorithm, different home.)

> Aside: at *full career* the all-time HR×SB frontier is just **two** points — Henderson (1406 SB)
> and Bonds (762 HR) — since nobody else has both >296 HR and >514 SB. It's far richer mid-history,
> which the live animation shows.

## Layout

```
main.c                  decode + the whole Vulkan app (3 compute + 2 graphics pipelines) + snapshot
shaders/accumulate.comp event slice → atomicAdd into hr[]/sb[]   (UNCHANGED from baseline)
shaders/spring.comp     NEW: critically-damped glide of pos[]/vel[] toward (hr,sb)
shaders/skyline.comp    NEW: per-frame brute-force Pareto frontier over pos[] → onFront[]
shaders/points.vert     vertex-pull from pos[] (was hr[]/sb[]) + debut[], era colour + highlight
shaders/points.frag     round point sprite
shaders/line.vert/frag  the frontier staircase (vertex-pull from the line-strip buffer)
Makefile                glslc the shaders, build/link, run/snapshot/validate targets
```

Single flat `main.c` (heavily commented, straight-line) — a learning POC, not a layered renderer.

## Build & run

```
brew install vulkan-headers vulkan-loader molten-vk glfw shaderc vulkan-validationlayers
make            # compile the shaders (glslc) and the binary (clang)
make run        # open the live auto-playing window — watch the dots GLIDE and the frontier flow
make snapshot   # headless: settle springs + verify, write /tmp/poc-vulkan-spring.{bmp,png}
make validate   # run one session with the Khronos validation layer on
make clean
```

## Verifying it works (headless)

This sandbox has no Screen Recording permission, so the live window (where the gliding is visible)
can't be screenshotted. `make snapshot` is the proof: it applies every event once, **settles the
springs** (one spring dispatch with a huge `dt` drives `pos → target` in a single step), runs the
skyline once, and checks **three** invariants:

```
decoded 11131 players  maxHR=762 maxSB=1406  events=520200  dates=18186
snapshot (all 520200 events): counter mismatches: 0 / 11131
spring: |pos - (hr,sb)| > 0.5 mismatches: 0 / 11131
skyline: GPU onFront vs brute-force: 0 mismatches (frontier size 2)
  SB end: Rickey Henderson   HR=296 SB=1406
  HR end: Barry Bonds        HR=762 SB=514
wrote /tmp/poc-vulkan-spring.bmp (2000x1600)   # retina: window is 1000x800
```

- `counter mismatches: 0` — the GPU accumulation matches a reference CPU replay (accumulate.comp).
- `spring ... 0` — the settled positions equal the integer `(hr,sb)` within ½ a unit (spring.comp
  converges; the *exact* settle point is the verification, the *gliding path* is the live-only win).
- `skyline ... 0` — the GPU frontier equals the ground-truth O(n²) Pareto set (skyline.comp).

The BMP shows the era-coloured cloud with the highlighted frontier points and the staircase
envelope — at the settled end-state it's the two-point all-time frontier (Henderson → Bonds).

## macOS / MoltenVK notes (all handled in the code + Makefile)

- The instance enables `VK_KHR_portability_enumeration` **and** sets
  `VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR`, else zero devices are found.
- `glfwInitVulkanLoader(vkGetInstanceProcAddr)` so GLFW uses the Homebrew loader.
- The Makefile points `VK_ICD_FILENAMES`/`VK_DRIVER_FILES` at MoltenVK's ICD manifest; `validate`
  adds `VK_LAYER_PATH` + `DYLD_LIBRARY_PATH` so the validation-layer dylib loads.
- The render-finished semaphore is **per swapchain image** (not per frame-in-flight).
- `hr/sb` stay `uint` (atomicAdd) because MoltenVK has no float-atomics extension; the spring reads
  them as float. FIF=1 (one frame in flight) keeps the CPU's staircase write race-free.

## Scope

Phase 1 only — exact cumulative replay of one stat pair, now with GPU spring motion + a per-frame
GPU frontier. Batting, 1871–2025. The fully-GPU staircase (compaction + rank-sort + indirect draw)
lives in the WebGPU twin and could be back-ported here for parity; see the design doc.
