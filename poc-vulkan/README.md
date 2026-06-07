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
  (the STEV `.evt` format, spec in [`docs/pbp-evt-format.md`](../docs/pbp-evt-format.md)):
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

## Layout

```
main.c                  decode + the whole Vulkan app + the headless snapshot harness
shaders/accumulate.comp consume an event slice → atomicAdd into hr[]/sb[]
shaders/points.vert     vertex-pull from hr[]/sb[] + debut[], era colour
shaders/points.frag     round point sprite
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
(full careers), replays the same accumulation on the CPU, and diffs that against the
GPU's `hr[]`/`sb[]` counters:

```
decoded 11131 players  maxHR=762 maxSB=1406  events=520200  dates=18186
snapshot (all 520200 events): mismatches: 0 / 11131
  Barry Bonds        HR=762 SB=514
  Rickey Henderson   HR=296 SB=1406
wrote /tmp/poc-vulkan.bmp (2000x1600)   # retina: window is 1000x800
```

`mismatches: 0` means the GPU accumulation matches the reference CPU replay for every
player; the BMP is the rendered cloud.

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
