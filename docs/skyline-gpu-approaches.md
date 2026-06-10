# Computing the 2-D Pareto frontier on the GPU — approaches & trade-offs

Reference notes for the `poc-*-spring` POCs (`spring.comp`/`skyline.comp` and their WGSL twins).
The live animation recomputes the **2-D Pareto frontier ("skyline")** every frame from the *smoothed*
point positions `pos[]` — maximize both axes; point *i* is on the frontier iff no other point *j*
has `pj.x ≥ pi.x && pj.y ≥ pi.y` with at least one strict. This doc records the options we
considered, how each behaves **on a GPU specifically**, and when to prefer which. The POCs currently
ship approach **(A)**; this is the map for if/when that should change.

> Why recompute at all? The baseline (`poc-vulkan`/`poc-webgpu`) maintained the frontier
> *incrementally* from **integer, monotone** events — O(1) amortized per event (see §C). The spring
> twins draw **smoothed float** positions that move every frame, so the integer-event shortcut no
> longer applies directly and we recompute from `pos[]`. The key facts that make the smarter
> approaches possible are spelled out in §C.

---

## The GPU cost model (why "fewer operations" ≠ "faster")

On a CPU you count operations. On a GPU you must weigh three different things:

1. **Total work** — the sum of all lane-operations. Asymptotics still matter at large n.
2. **Depth / parallelism** — a GPU has thousands of lanes; independent work with no data
   dependencies finishes in ~`work / lanes`. A *sequential* dependency chain of length *d* takes at
   least *d* steps no matter how much hardware you have.
3. **Pass/synchronization count** — each compute dispatch has launch overhead, and a barrier
   between passes flushes the pipeline. An algorithm that is `O(n log n)` work but needs `O(log²n)`
   synchronized passes can lose, at modest n, to an `O(n²)` algorithm that is **one dispatch** of
   fully-independent work.

For this dataset **n ≈ 11,131**. That number is the reason the simple approach wins here; the
crossovers below are all "as n grows".

---

## (A) Brute force — O(n²), one dispatch  ·  *what the POCs ship*

One thread per point; each scans all n points and early-outs as soon as one dominates it; writes
`onFront[i]`. (`skyline.comp` / `skyline.wgsl`.)

- **Work:** O(n²) ≈ 124M comparisons at n=11k.
- **Depth:** O(n) per thread, but all n threads are **independent** — no sync, no shared state.
- **Passes:** one.
- **GPU fit:** excellent. Embarrassingly parallel, trivial code, no sort, no scan, no compaction.
  On an Apple GPU the 124M comparisons land in well under a millisecond; the early-out makes the
  average far cheaper than the worst case.
- **When it wins:** small-to-medium n (roughly up to 10⁴–10⁵, hardware-dependent). **This is our
  regime.** It's the effort-proportional choice for the POC and is exact.
- **When it loses:** n² eventually dominates; by ~10⁵–10⁶ points it's hopeless.

---

## (B) Sort + parallel prefix-max — O(n log n) work  ·  *the scale-up path*

The classic skyline: **sort points by x descending, then a single pass keeping the running max of
y** — point *i* is on the frontier iff its y exceeds the max y of everything with larger x.

On a GPU this is two GPU primitives:

- **The sort.** There is no `qsort`. A **bitonic sort** is `O(n log²n)` work across **~`log²n`
  synchronized passes** (≈150–200 dispatches for n padded to 16k); a **radix sort** is a handful of
  passes, each a global prefix-sum (scan) over the keys. Either way: many dispatches + barriers, and
  real code (key/payload handling, padding to a power of two).
- **The "linear" scan is a parallel prefix-max.** A sequential running-max is a dependency chain of
  length n (depth n — bad on a GPU). The parallel form is a **scan** (Hillis–Steele or Blelloch):
  `O(n)` work in **`O(log n)` passes**. So "recalculate in linear time" on a GPU means a
  logarithmic-depth scan, not a serial loop.

- **Work:** `O(n log n)` (≈154k at n=11k) — ~800× less than (A).
- **Passes:** many (`~log²n` for the sort + `~log n` for the scan + a compaction). High constant
  and launch overhead.
- **Bonus:** sorting by x already yields the frontier points **in order**, so the **staircase falls
  out of the same pass** — the separate `compact → rank-sort → emit` stage in `staircase.wgsl`
  becomes unnecessary (its rank-sort is subsumed by the global sort). At scale, (B) is both faster
  *and* structurally simpler downstream.
- **When it wins:** large n (~10⁵–10⁶+), where (A)'s n² genuinely hurts and the sort's overhead is
  amortized.
- **When it loses:** at our n the many-pass overhead likely makes it **no faster, possibly slower**
  than (A), despite far less asymptotic work. Worth building for the scaling story, not for a
  speed-up at 11k.

---

## (C) Incremental / "active-set" — recompute from only the points that can change

The idea (correct, and worth understanding): after a step, **only a few points moved**, so only a
few points can change the frontier. Recompute from the *previous frontier* plus the *moved points*
rather than from all n. This rests on two facts:

### C.1 Motion here is monotone — even after smoothing

Events only ever *increase* a counter, and the **critically-damped spring never overshoots**: a
point's `pos` approaches its (rising) target from below with velocity ≥ 0, so **`pos` is monotone
non-decreasing per axis over frames** (points only ever move up/right). The lone exception is a
wrap/scrub-back, which is a hard reset (`zeroGpu`) handled by a full recompute, not an incremental
step.

### C.2 Monotonic moves can't promote a non-mover (the key theorem)

> Under monotone motion, the new frontier ⊆ (previous frontier) ∪ (points that moved this frame).
> Every interior point that did **not** move stays interior.

*Why:* a non-mover can't rise, so it can only newly join if some frontier point leaves. A frontier
point P only "leaves" by being **dominated** by a moved point A (it can't fall). But if A dominates
P and P dominated an interior point Q, then by **transitivity A dominates Q** — so Q stays interior.
No interior non-mover is ever promoted. ∎

So the **candidate set** for the new frontier is exactly `prevFrontier ∪ movedThisFrame`, and the new
frontier is the skyline of just that set — **one pass over a much smaller input**. This is precisely
your intuition, and it is provably correct here.

### C.3 Two realizations, and why the GPU likes one and not the other

- **Pure incremental (per-event splice) — O(1) amortized, CPU-only.** Keep the frontier as a sorted
  array; for each moved point do ≤1 insertion + evict a contiguous dominated run. This is exactly
  what the baseline's `frontier_apply_event` does, and it's optimal on a CPU. **But it's a serial,
  stateful, pointer-shifting data structure** (array splices / `memmove`) — the opposite of a GPU's
  strength. Parallelizing concurrent insert/evict into one shared sorted set needs locking or a
  subtle lock-free design, and the splices serialize. Poor GPU fit; this is a major reason the GPU
  twins recompute statelessly instead.
- **Active-set recompute — GPU-friendly.** Each frame: (1) scan all n points in parallel and mark
  the **movers** (`pos != target`, i.e. not yet settled) — O(n) work, O(1) depth, one pass; compact
  them with an atomic counter (M points). (2) Run a *small* skyline — (A) or (B) — over the
  `K + M` candidates (previous frontier ∪ movers). No serial data structure; the only state carried
  across frames is the previous frontier (a small buffer).
  - **Win:** the expensive skyline shrinks from `n` to `K + M`. When most points are **settled**
    (interior, at their target), they're provably irrelevant (§C.2) and excluded for free.
  - **Unavoidable floor:** you still pay **O(n)** every frame just to find the movers (one
    comparison per point) — so you don't beat O(n) per frame, you beat the *skyline term*.
  - **Spring caveat:** a spring keeps a point "moving" for ~0.3 s (~18 frames at 60 Hz) after each
    event, so mid-history (many events per frame) **M can be large** — hundreds to low thousands —
    shrinking the benefit. It pays off most in sparse eras and once the cloud is mostly settled. Note
    most movers are deep interior and get rejected immediately by the candidate skyline; the cost is
    in *enumerating* them, not in the skyline itself.

---

## Recommendation matrix

| Situation | Best approach | Why |
|---|---|---|
| n ≲ 10⁴–10⁵, GPU, POC (**us**) | **(A) brute force** | one dispatch, sub-ms, trivial & exact; sort overhead not worth it |
| n ≳ 10⁵–10⁶, GPU | **(B) sort + prefix-max** | n² is hopeless; sort amortizes; unifies the staircase |
| Few movers/frame, want to exploit it, GPU | **(C) active-set** over (A)/(B) | skyline over K+M ≪ n; correct by §C.2; still O(n) to find movers |
| CPU, integer monotone events | **(C) pure incremental** | O(1) amortized/event; the baseline's choice; serial is fine on CPU |

**Current POC choice: (A).** At 11k it's already sub-millisecond on real hardware, it's one
dispatch of independent work, and it's the simplest thing that's exact. (B) is the documented
scale-up; (C) is the documented "exploit monotonicity" path if profiling ever shows the per-frame
skyline dominating. None of these change the spring or the rendering — only how `onFront[]` is
produced.

---

## GPU primitives referenced (for whoever implements B or C)

- **Parallel prefix scan** (Hillis–Steele inclusive / Blelloch work-efficient): turns a serial
  running-max/sum (depth n) into `O(n)` work in `O(log n)` passes. The backbone of (B)'s scan and of
  radix-sort's digit counts.
- **Bitonic sort:** data-oblivious GPU sort, `O(n log²n)` work / `O(log²n)` passes, pad to a power of
  two. Simple to write; not work-optimal.
- **Stream compaction:** "keep the elements matching a predicate, densely" — a scan of 0/1 flags →
  exclusive prefix sum gives each kept element its output slot; or an `atomicAdd` counter for an
  unordered compaction (what `staircase.wgsl`'s `compact` pass already does for the frontier).
- **Indirect draw** (`drawIndirect` / `vkCmdDrawIndirect`): the GPU writes the vertex count into a
  buffer the draw reads, so a GPU-computed frontier size never round-trips to the CPU — see the
  fully-GPU staircase in `poc-webgpu-spring/shaders/staircase.wgsl`.
