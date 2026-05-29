# Pareto Depth (Onion Peeling) — Design

Tier: T3. Produced empirically by Pilot 3 of the methodology validation run
(Opus 4.8 with session-wide `--agent Plan`, session `c478e4a6`, cost $0.21).
Design only — implementation is a separate task.

## 1. Recursive sweep

Reuse the existing single-frontier sweep as a primitive. After `drawScatterPlot`
builds `unique` (sorted by `(x↑, y↑, year↓)`, exact-collision deduped), factor
the current Pareto pass into a pure helper:

```
function peelFrontier(points) → { frontier, rest }
```

It runs the same left-to-right stack sweep already in `drawScatterPlot`
(pop priors with `y < cur.y`, or `y == cur.y && x < cur.x`), returning
survivors plus the dominated remainder.

Onion peeling wraps it:

```
function paretoLayers(points, maxDepth) {
  const layers = []; let pool = points;
  for (let i = 0; i < maxDepth && pool.length; i++) {
    const { frontier, rest } = peelFrontier(pool);
    layers.push(frontier); pool = rest;
  }
  return layers;            // layers[0] = current red frontier
}
```

Cap at 5 (`maxDepth`). Each peel re-sweeps only the shrunk pool, so cost is
bounded by depth × N, not N². Layer 0 is identical to today's frontier —
onion peeling is strictly additive when depth = 1.

## 2. Layered rendering

Render layers **back-to-front** (deepest first) so layer 0 stays on top and
keeps its existing red styling, hover, click-to-highlight, and cards. For
layers 1…k:

- Opacity ramp: `op(i) = 0.85 * Math.pow(0.6, i)` (tunable), so each shell fades.
- Dots reuse the frontier marker but at reduced radius and a desaturated red
  (or interpolate red→grey via `d3.interpolateLab`).
- Each layer gets its own connecting polyline in a `<g class="depth-layer" data-depth="i">`,
  drawn in one D3 join keyed by depth so filter changes transition cleanly.
- Layer 0 alone feeds the frontier card list; deeper layers are visual context
  only (no cards, no tooltip ownership — tooltip still queries the full `filtered` array).

Keep deeper layers non-interactive (`pointer-events: none`) to avoid stealing
clicks from the real frontier.

## 3. UI toggle

Add a control in `.controls-inputs`: a "Pareto depth" stepper or `<select>`
(1–5), defaulting to 1 (today's behavior). Wire it into `refreshChart()`
state as `state.depth`. Disable/ignore in Career mode only if layering deep
career shells proves noisy — otherwise it works in both modes since it
operates on post-aggregation points.

## 4. URL-hash state

Serialize as `d=<n>` in the hash via `writeUrlState`, **omitting when `d === 1`**
(default) to keep links compact, matching the existing convention.
`applyUrlState()` reads `d`, clamps to 1–5, sets the stepper before first
render. Deep-links round-trip; `hl=` career highlight composes unchanged.

## 5. Invariants the implementer must assert

Expose `window.__bl2d_depthLayers = layers.map(l => l.length)` for headless
checks via `snap.js` evalJS:

1. **Recursive definition:** layer `i+1` equals `peelFrontier` of (all
   filtered points − ⋃ layers ≤ i). Assert by recomputing layer 1 from the
   leftover pool and diffing membership.
2. **Disjointness & coverage:** layers are pairwise disjoint; their union ⊆
   `unique`; no point appears twice.
3. **Domination ordering:** every point in layer `i+1` is dominated by ≥1
   point in layer `i` (else it would have surfaced earlier).
4. **Depth-1 identity:** with `d = 1`, output is byte-identical to the
   pre-change frontier (regression guard).
5. **Spot-check ≥2 records:** e.g. Henderson 1982 SB=130 on layer 0; a known
   runner-up season lands on layer 1.

Verification floor (T3): desktop+mobile snaps in `depth=1` and `depth=5`
states, hash round-trip, plus the five assertions above.
