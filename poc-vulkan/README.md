# `poc-vulkan` — GPU HR × SB replay (native Vulkan / MoltenVK)

A small, self-contained native C + **Vulkan** proof-of-concept that animates every
MLB batter as a point in **(HR, SB)** space, sweeping through history with the whole
computation on the GPU. It's the native port of the project's `.evt` HR×SB animation
idea (see the main D3 app's `evt-demo.html`).

## What it does

This is the README design's **Phase-1 model**: a CPU time engine *streams* events to the
GPU, which *accumulates* them into persistent per-player counters and renders those.

```
data/pbp/hr.evt.gz ┐  decode (CPU, once) →  one date-sorted event list
data/pbp/sb.evt.gz ┘  {player, stat, count} resident on the GPU
        │
        ▼   CPU time engine: cursor walks the events forward; each frame it
            dispatches the GPU over only the NEW [lo, lo+count) slice
        │
        ▼   accumulate.comp:  if HR: atomicAdd(hr[player], n)
        │                     if SB: atomicAdd(sb[player], n)   (persistent state)
        │
        ▼   pipeline barrier (compute write → vertex read)
        │
        └─▶ points.vert: x = hr[player], y = sb[player] straight from those buffers
            (no CPU readback), → NDC, era-colour by debut year
```

- **Real data, all of history.** Decodes the committed `hr.evt.gz` + `sb.evt.gz`
  (the STEV `.evt` format, spec in [`docs/data-formats.md`](../docs/data-formats.md) §Deprecated (full spec: `pbp-evt-format.md`, git history)):
  gzip → header → per-player varint event blocks. The per-event increments from both
  files are merged into one list, **sorted by game-date**, and unioned by player name
  (~11,131 batters, 520,200 events, 1871–2025).
- **GPU-driven, never scans full history.** The events live on the GPU once; each frame
  the compute shader touches only the events that just became due, `atomicAdd`-ing them
  into the persistent `hr[]`/`sb[]` counters. The graphics pipeline renders directly from
  those counters — no round-trip to the CPU.
- **Auto-play.** The cursor sweeps the full date range (~30 s) and loops. Accumulation is
  forward-only, so on wrap the counters are zeroed (`vkCmdFillBuffer`) and replayed. Bonds
  climbs the HR axis, Henderson runs out the SB axis, the cloud lights up by era.
- **Live Pareto frontier.** The non-dominated "limits" envelope (upper-right: maximise both
  HR and SB) is tracked and drawn — frontier players are highlighted (brighter + larger) and
  the **staircase** connecting them is drawn over the cloud, both evolving each frame.

## Tracking the frontier (incremental, exploiting monotone events)

Every event only *increases* one coordinate, so points move up/right, never down/left. That
makes the frontier cheap to maintain **incrementally on the CPU**, in lockstep with the event
cursor it already drives (it keeps a shadow `hr/sb` — one `+=` per event — so it knows each new
position with **no GPU readback**). For one event on player `p`:

- `p` is the only point that can **join** the frontier (≤ 1 insertion);
- `p`'s new position can **evict** a *contiguous run* of points it now dominates (the frontier
  is kept sorted by x-ascending / y-descending — a staircase);
- nothing else is ever **promoted** (no other point moved, and `p`'s new spot dominates its old
  one), so no global rescan is needed; and a domination test for `p` only needs the current
  frontier (domination is transitive).

So each event is `O(log K + evicted)` with `K` (frontier size) tiny — `frontier_apply_event` in
`main.c`. The CPU writes a per-player `onFront[]` flag buffer (highlight) and the staircase
line-strip vertices into host-visible buffers the GPU reads; the GPU still owns the cloud's
accumulate + render. (`make snapshot` cross-checks the incremental frontier against a
brute-force O(N²) computation — see below.)

> Aside: at *full career* the all-time HR×SB frontier is just **two** points — Henderson (1406
> SB) and Bonds (762 HR) — since nobody else has both >296 HR and >514 SB. It's far richer
> mid-history, which the live animation shows.

## Layout

```
main.c                  decode + the whole Vulkan app + the headless snapshot harness
shaders/accumulate.comp consume an event slice → atomicAdd into hr[]/sb[]
shaders/points.vert     vertex-pull from hr[]/sb[] + debut[], era colour + frontier highlight
shaders/points.frag     round point sprite
shaders/line.vert/frag  the frontier staircase (vertex-pull from the line-strip buffer)
Makefile                glslc the shaders, build/link, run/snapshot/validate targets
```

It's intentionally a single flat `main.c` (heavily commented, straight-line) — a
learning POC, not a layered renderer.

## Build & run

Dependencies (Homebrew):

```
brew install vulkan-headers vulkan-loader molten-vk glfw shaderc vulkan-validationlayers
```

From this directory:

```
make            # compile the shaders (glslc) and the binary (clang)
make run        # open the live auto-playing window
make snapshot   # headless: CPU-vs-GPU diff + write /tmp/poc-vulkan.{bmp,png}
make validate   # run one session with the Khronos validation layer on
make clean
```

## Verifying it works (headless)

This sandbox has no Screen Recording permission, so the live window can't be
screenshotted. `make snapshot` is the proof instead: it applies every event once
(full careers) and checks **two** invariants — GPU counters vs a CPU replay, and the
incremental frontier vs a brute-force O(N²) frontier:

```
decoded 11131 players  maxHR=762 maxSB=1406  events=520200  dates=18186
snapshot (all 520200 events): counter mismatches: 0 / 11131
frontier: incremental vs brute-force: 0 mismatches (frontier size 2)
  SB end: Rickey Henderson   HR=296 SB=1406
  HR end: Barry Bonds        HR=762 SB=514
wrote /tmp/poc-vulkan.bmp (2000x1600)   # retina: window is 1000x800
```

`counter mismatches: 0` means the GPU accumulation matches the reference CPU replay;
`frontier ... 0 mismatches` means the incrementally-maintained frontier equals the
ground-truth O(N²) Pareto set (as a coordinate set). The BMP shows the dimmed cloud with
the highlighted frontier points and the staircase envelope.

## macOS / MoltenVK notes (all handled in the code + Makefile)

- The instance enables `VK_KHR_portability_enumeration` **and** sets
  `VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR`, else zero devices are found.
- `glfwInitVulkanLoader(vkGetInstanceProcAddr)` is called so GLFW uses the Homebrew loader.
- The Makefile points `VK_ICD_FILENAMES`/`VK_DRIVER_FILES` at MoltenVK's ICD manifest, and
  `validate` adds `VK_LAYER_PATH` + `DYLD_LIBRARY_PATH` so the validation layer dylib loads.
- The render-finished semaphore is **per swapchain image** (not per frame-in-flight).

## Scope

Phase 1 only — exact cumulative replay of one stat pair. Batting, 1871–2025 (the corpus
extent; pre-1920 careers are truncated where the `.bl2p` source starts). The pitch-by-pitch
streaming/decay design sketched alongside this is future work.
