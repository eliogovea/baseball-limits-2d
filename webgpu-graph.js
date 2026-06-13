// ─────────────────────────────────────────────────────────────────────────────
// webgpu-graph.js — the G-track: full-GPU rendering of the STATIC chart.
// Phase G0: a retained-scene dot renderer (docs/rendering.md).
//
// WHY A SECOND FILE. script.js already carries the streaming WebGPU engine
// (Phases 1–5: accumulate → spring → skyline → staircase) and is ~6,900 lines.
// The G-track adds a *general* GPU path for every static season/career view, and
// it grows through G6 (frontier compute, HV, glyph-atlas text, overlays). Keeping
// it in its own file keeps script.js reviewable and keeps the G-track's blast
// radius visible: script.js only gains tiny optional-chained hooks
// (`this._drawGraphScene?.(rp)` etc.) that are no-ops when this file is absent.
// The bundler inlines this file exactly like tour.js (scripts/build_bundle.py).
//
// THE BIG IDEA — A RETAINED SCENE IN DATA SPACE. The shipped Phase-3 point path
// re-flattens every visible point into a PIXEL-space instance buffer on every
// refresh (`_uploadPoints`: px = margin.left + xScale(d.x) on the CPU, 24 bytes
// per point, re-uploaded each time). That couples the upload to the current
// scale: any zoom, pan, or resize must re-upload the whole cloud. The G-track
// inverts the contract:
//
//   • the point set is uploaded ONCE per *identity* change (filters/mode/axes/
//     colors changed → different points → re-upload), in DATA units — a season's
//     (HR, SB) goes up as (73.0, 138.0), not as pixels;
//   • the data→pixel mapping lives in a tiny uniform (`uScene`, 64 bytes) written
//     every refresh: px = slopeX·x + interceptX (the affine form of the D3 linear
//     scale, margin folded into the intercept — same trick as gpuScaleUniform);
//   • so a zoom/resize/pan is a 64-byte uniform write + re-present. The position
//     buffer never crosses the bus again.
//
// This is also the unification seam with the streaming engine: the spring engine
// already keeps its positions in data space on the GPU (`bPos`, written by the
// spring integrator). A "scene" is just {pos, color, size, n} + uScene — whether
// pos was UPLOADED (static, this file) or COMPUTED (streaming, script.js) is a
// detail the downstream passes don't care about. The G5 convergence makes that
// literal; until then the two paths share zero code on purpose (the design's
// "never edits the streaming present() before G5" guarantee).
//
// BUFFER LAYOUT — SoA (structure-of-arrays), not interleaved. Three parallel
// buffers instead of one 24-byte record stream:
//     bPos  : array<vec2<f32>>  data-space (x, y)        8 B/point
//     bCol  : array<u32>        packed RGBA8 fill        4 B/point
//     bSize : array<f32>        dot radius in CSS px     4 B/point
// Why SoA: the G1 skyline pass will read ONLY positions (a dominance compare
// touches no colors — SoA keeps it cache-dense and lets the same bPos feed both
// compute and render); a re-color (theme/encoding change) rewrites 4 B/point
// without touching positions; and it matches the streaming engine's layout so
// the G5 aliasing (spring bPos ⇒ scene bPos) is a bind-group swap, not a repack.
//
// WHAT G0 COVERS. The static background cloud (the non-frontier points) under
// ?renderer=webgpu&gpugraph=1. Frontier dots, highlight heads, axes, labels,
// staircase, shade all stay on their current (Phase-3 instances + SVG) paths —
// they migrate in G1–G4. The visual output must be indistinguishable from the
// Phase-3 path; what changes is WHERE the positions live and WHEN they upload.
// ─────────────────────────────────────────────────────────────────────────────

// WGSL: the scene cloud. Vertex-pulled instanced quads like WEBGPU_POINTS_WGSL,
// but positions arrive in DATA units and are mapped to pixels HERE, per vertex,
// from the uScene uniform — the GPU-side half of the retained-scene contract.
//
// uScene layout (64 B = 4 × vec4<f32>; uniform buffers round to 16-byte rows):
//   ab   = (slopeX, interceptX, slopeY, interceptY)   data → CSS px, margin folded in
//   vp   = (vpW, vpH, dpr, 0)                         CSS-px viewport (dpr is texture-
//                                                     resolution only; NDC math is CSS px,
//                                                     matching uViewport in script.js)
//   sgn  = (xSign, ySign, 0, 0)                       reserved for G1's sign-aware skyline
//   corn = (antiX, antiY, idealX, idealY)             reserved for G2's HV shade corners
// G0 writes ab+vp and zeroes the reserved rows; declaring the full 64 B NOW means
// G1/G2 only ADD fields the shaders start reading — no layout migration later.
const WEBGPU_SCENECLOUD_WGSL = `
struct Scene {
  ab:   vec4<f32>,
  vp:   vec4<f32>,
  sgn:  vec4<f32>,
  corn: vec4<f32>,
};
@group(0) @binding(0) var<uniform> sc: Scene;
@group(0) @binding(1) var<storage, read> pos:  array<vec2<f32>>;  // DATA space
@group(0) @binding(2) var<storage, read> col:  array<u32>;        // packed RGBA8
@group(0) @binding(3) var<storage, read> size: array<f32>;        // radius, CSS px
@group(0) @binding(4) var<storage, read> onFront: array<u32>;     // G1: skyline verdicts

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) off: vec2<f32>,                    // px offset from dot centre
  @location(1) @interpolate(flat) fill: u32,
  @location(2) @interpolate(flat) radius: f32,
};
// Two CCW triangles covering the [-1,1]² quad (same table as the points shader).
const C = array<vec2<f32>, 6>(
  vec2<f32>(-1.0,-1.0), vec2<f32>(1.0,-1.0), vec2<f32>(-1.0,1.0),
  vec2<f32>(-1.0, 1.0), vec2<f32>(1.0,-1.0), vec2<f32>( 1.0,1.0));
fn unpack(c: u32) -> vec4<f32> {
  return vec4<f32>(f32(c & 0xffu), f32((c >> 8u) & 0xffu),
                   f32((c >> 16u) & 0xffu), f32((c >> 24u) & 0xffu)) / 255.0;
}
// A degenerate (off-clip, zero-area) vertex: the rasterizer culls the whole quad.
// The same trick the streaming spring-cloud uses for its two-pass front/non-front
// split: skipping instances in the SHADER keeps one draw call and one buffer —
// no CPU-side partitioning, no index buffer, no second upload.
fn degenerate() -> VSOut {
  var o: VSOut;
  o.clip = vec4<f32>(2.0, 2.0, 0.0, 1.0);
  o.off = vec2<f32>(0.0, 0.0);
  o.fill = 0u;
  o.radius = 0.0;
  return o;
}
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  // G1: the scene now holds the FULL deduped cloud (frontier included) so the
  // skyline pass can judge every point, but visually the frontier dots are still
  // drawn by the CPU path (drawFrontierDots) until G2 — so on-front instances
  // degenerate here and the visible output stays exactly G0's non-front cloud.
  if (onFront[ii] != 0u) { return degenerate(); }
  let p = pos[ii];
  // DATA → CSS px, the affine map the CPU used to do per point per refresh.
  // This one multiply-add is why zoom/resize no longer re-uploads the cloud.
  let px = sc.ab.x * p.x + sc.ab.y;
  let py = sc.ab.z * p.y + sc.ab.w;
  let r = size[ii];
  let corner = C[vi];
  // CSS px → NDC: x/vp*2-1, and a Y flip (pixel y grows DOWN, NDC y grows UP).
  let cx = px / sc.vp.x * 2.0 - 1.0;
  let cy = 1.0 - py / sc.vp.y * 2.0;
  var o: VSOut;
  o.clip = vec4<f32>(cx + corner.x * r / sc.vp.x * 2.0,
                     cy + corner.y * r / sc.vp.y * 2.0, 0.0, 1.0);
  o.off = corner * r;
  o.fill = col[ii];
  o.radius = r;
  return o;
}
@fragment
fn fs(i: VSOut) -> @location(0) vec4<f32> {
  // Round-disc test with a ~1px anti-aliased edge — identical look to the
  // Phase-3 cloud (no ring here: the background cloud has no stroke; ringed
  // frontier dots arrive on this pipeline in G2 with HV-derived radii).
  let dist = length(i.off);
  let aa = 1.0 - smoothstep(i.radius - 0.75, i.radius + 0.75, dist);
  if (aa <= 0.0) { discard; }
  let c = unpack(i.fill);
  return vec4<f32>(c.rgb, c.a * aa);
}`;

// ── G1: the scene skyline ────────────────────────────────────────────────────
// Frontier-size bound for the compact pass + readback staging. Same value as the
// streaming engine's WEBGPU_MAX_FRONT but a SEPARATE constant on purpose — the
// G-track shares no code with the streaming path until G5. Real frontiers in this
// dataset are ≤ ~30 points; the verify hook asserts we never approach the bound.
const WEBGPU_GRAPH_MAX_FRONT = 2048;

// WGSL (compute): sign-aware GPU Pareto frontier over the retained scene, plus a
// compaction pass that shrinks the result to "count + indices" for readback.
//
// WHY BRUTE FORCE O(n²). Identical rationale to the streaming skyline
// (script.js WEBGPU_SKYLINE_WGSL): spatial tiling's "influence is local" premise
// is FALSE for Pareto domination — one extreme point dominates an entire quadrant
// spanning arbitrarily many tiles. At n≈4–20k that is ≤ ~400M f32 compares in one
// dispatch, sub-ms on real hardware; sort+prefix-max is the documented ≥10⁵
// scale-up (docs/rendering.md §"Shared GPU foundations").
//
// WHY THIS EQUALS THE CPU SWEEP. The CPU frontier (sweepFrontier, script.js) is a
// stack sweep over the SIGNED, exact-(x,y)-DEDUPED cloud: sort by x·xSign asc and
// pop anything with a smaller signed y (or equal y, smaller signed x). On a set
// with no duplicate coordinates those pop rules remove exactly the points that
// are STRICTLY dominated in signed space (∃j: Xj≥Xi ∧ Yj≥Yi with one strict), so
// per-point strict-dominance brute force reproduces the sweep's survivor set
// point-for-point. The dedup precondition is load-bearing: with duplicates, the
// sweep keeps one survivor per coordinate while dominance logic would keep all —
// script.js guarantees it by uploading the `unique` array.
//
// SIGN-AWARENESS. Multiplying by xSign/ySign ∈ {±1} maps "lower is better" axes
// (ERA, WHIP…) and the worst-frontier toggle into one canonical "higher is
// better" space — the same trick the CPU uses (X = x·xSign). The multiply is
// EXACT in f32 (sign-bit flip), so GPU compares see bit-identical magnitudes to
// the uploaded values and the only CPU/GPU divergence risk is the f64→f32
// narrowing at upload (the verify hook's reference therefore compares against the
// f32 cpuPos copy, not the f64 originals).
//
// originDrop: the streaming skyline force-drops (0,0) ("no events yet" players,
// matching its cloud's (0,0) cull). The STATIC scene has no such phantom points —
// an uploaded (0,0) is a real season — so the branch is compiled in but gated off
// by the uniform (0.0); the G5 convergence flips it to 1.0 on the streaming path.
//
// uSky is a SEPARATE uniform from uScene: signs are part of the scene IDENTITY
// (they change which points survive), not the view, and the compute submit
// happens inside uploadScene — a shared uniform would race writeSceneScale's
// later per-refresh write.
const WEBGPU_SCENESKYLINE_WGSL = `
const MAX_FRONT : u32 = ${WEBGPU_GRAPH_MAX_FRONT}u;
struct Sky { n: u32, xSign: f32, ySign: f32, originDrop: f32 };
@group(0) @binding(0) var<uniform>             U:        Sky;
@group(0) @binding(1) var<storage, read>       pos:      array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> onFront:  array<u32>;
@group(0) @binding(3) var<storage, read_write> frontIdx: array<u32>;
@group(0) @binding(4) var<storage, read_write> count:    array<atomic<u32>>;

// onFront[i] = 1 iff no j strictly dominates i in SIGNED space.
@compute @workgroup_size(64)
fn skyline(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= U.n) { return; }
  let sgn = vec2<f32>(U.xSign, U.ySign);
  let pi = pos[i] * sgn;
  if (U.originDrop > 0.5 && pos[i].x == 0.0 && pos[i].y == 0.0) {
    onFront[i] = 0u;                       // streaming-only: phantom (0,0) players
    return;
  }
  var dom = 0u;
  for (var j = 0u; j < U.n; j = j + 1u) {
    let pj = pos[j] * sgn;
    if (pj.x >= pi.x && pj.y >= pi.y && (pj.x > pi.x || pj.y > pi.y)) { dom = 1u; break; }
  }
  onFront[i] = select(1u, 0u, dom == 1u);
}

// Append on-front indices into frontIdx[0..K), K via atomicAdd — turns the n-word
// verdict array into a tiny "count + ≤MAX_FRONT indices" payload so the readback
// contract maps ~8 KB, not the whole cloud. Order is nondeterministic (atomic
// append); the consumer treats it as a SET. Rank-sorting arrives with the G2
// staircase, which is the first pass that needs x-order.
@compute @workgroup_size(64)
fn compact(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= U.n) { return; }
  if (onFront[i] != 0u) {
    let k = atomicAdd(&count[0], 1u);
    if (k < MAX_FRONT) { frontIdx[k] = i; }
  }
}`;

// ── G4: depth layers (Pareto onion-peeling) ──────────────────────────────────
// Iterative skyline peeling on the GPU (docs/rendering.md §"G-track design":
// "depth layers = iterative skyline peeling (≤5, dirty-frames only)"). Layer 0 is
// the live frontier (already produced by the G1 skyline); each subsequent layer is
// the frontier of the cloud with all shallower layers removed. The CPU oracle is
// `paretoLayers`/`__bl2d_depthLayers` (script.js) — same peel, same sign rules.
//
// Mechanism: `peeled[]` marks already-claimed points, `layerOf[]` records each
// point's layer index (BIG = deeper than the requested depth, or never on any
// layer within it). One peel iteration = peelSky (this layer's frontier over the
// non-peeled set, into onTmp) → peelMark (fold onTmp into layerOf + peeled). The
// two-pass split is a read-after-write guard: every thread's dominance test in a
// pass must see the SAME peeled[] snapshot, so the mark can't run inline. The CPU
// encodes `peelInit` then `depth` (peelSky, peelMark) pairs in one serialized
// encoder. Pure parallel re-sweep — the verify gate is the per-layer point count.
const WEBGPU_GRAPH_MAX_DEPTH = 5;            // matches the CPU peelDepth clamp [1,5]
const WEBGPU_DEPTH_BIG = 0xffffffff;
const WEBGPU_DEPTH_WGSL = `
const BIG : u32 = ${WEBGPU_DEPTH_BIG}u;
struct Dp { n: u32, xSign: f32, ySign: f32, layer: u32 };
@group(0) @binding(0) var<uniform>             U:       Dp;
@group(0) @binding(1) var<storage, read>       pos:     array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> peeled:  array<u32>;
@group(0) @binding(3) var<storage, read_write> layerOf: array<u32>;
@group(0) @binding(4) var<storage, read_write> onTmp:   array<u32>;

@compute @workgroup_size(64)
fn peelInit(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= U.n) { return; }
  peeled[i] = 0u;
  layerOf[i] = BIG;
  onTmp[i] = 0u;
}

// This layer's frontier: not yet peeled, and not strictly dominated (in SIGNED
// space) by any other NON-peeled point. Identical compare to the WEBGPU_SCENESKYLINE
// skyline pass, with the peel mask gating both the candidate and the dominators.
@compute @workgroup_size(64)
fn peelSky(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= U.n) { return; }
  if (peeled[i] != 0u) { onTmp[i] = 0u; return; }
  let sgn = vec2<f32>(U.xSign, U.ySign);
  let pi = pos[i] * sgn;
  var dom = 0u;
  for (var j = 0u; j < U.n; j = j + 1u) {
    if (peeled[j] != 0u) { continue; }
    let pj = pos[j] * sgn;
    if (pj.x >= pi.x && pj.y >= pi.y && (pj.x > pi.x || pj.y > pi.y)) { dom = 1u; break; }
  }
  onTmp[i] = select(1u, 0u, dom == 1u);
}

// Fold this layer's frontier (onTmp) into the running result: tag the layer index
// and remove the points from the next iteration's pool.
@compute @workgroup_size(64)
fn peelMark(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= U.n) { return; }
  if (onTmp[i] != 0u) { layerOf[i] = U.layer; peeled[i] = 1u; }
}`;

// ── G2: staircase, hypervolume contributions, shade ──────────────────────────
// Frontier-dot radius range — the on-screen size encodes a point's HV contribution,
// matching the CPU's radiusFor (script.js: FRONTIER_R_MIN/MAX + sqrt(contrib/max)).
const WEBGPU_GRAPH_R_MIN = 4.0, WEBGPU_GRAPH_R_MAX = 11.0, WEBGPU_GRAPH_FRONT_RING = 1.5;

// WGSL (compute): the sign-aware GPU staircase — ranksort + emit. G1's `compact`
// already produced bFrontIdx[0..K)+bCount, so this module only SORTS that set by
// canonical x and EMITS the step polyline. It is a port of the streaming staircase
// (script.js WEBGPU_STAIRCASE_WGSL) with two sign-aware divergences:
//   • rank by CANONICAL x (pos.x·xSign), and scatter the original index alongside
//     the sorted position (frontSortedIdx) so the HV pass can skip-by-index;
//   • the caps land on the canonical DOMAIN EDGES (XantiC, YantiC), not value 0 —
//     reproducing the CPU staircaseScreen, whose left cap sits at screen-x 0
//     (= the worst-x domain edge) and bottom cap at screen-y plotH (= worst-y edge).
// frontSorted holds CANONICAL (X,Y); emit un-folds (·sgn) back to DATA space so the
// staircase[] vertices ride the same affine uScene.ab map as the cloud — a zoom is a
// uniform write, the staircase never recomputes. Vertex count = 1 + 2K (== 2K+1, the
// CPU R sequence: left-cap + K points + K drops where the last drop is the bottom cap).
const WEBGPU_SCENESTAIR_WGSL = `
const MAX_FRONT : u32 = ${WEBGPU_GRAPH_MAX_FRONT}u;
struct Stair { n: u32, xSign: f32, ySign: f32, antiX: f32, antiY: f32 };  // antiX/Y are CANONICAL
struct DrawArgs { vertexCount: u32, instanceCount: u32, firstVertex: u32, firstInstance: u32 };
@group(0) @binding(0) var<uniform>             U:           Stair;
@group(0) @binding(1) var<storage, read>       pos:         array<vec2<f32>>;   // DATA space
@group(0) @binding(2) var<storage, read>       frontIdx:    array<u32>;          // G1 compact output
@group(0) @binding(3) var<storage, read_write> count:       array<atomic<u32>>;  // K (G1)
@group(0) @binding(4) var<storage, read_write> frontSorted: array<vec2<f32>>;    // CANONICAL, x-asc
@group(0) @binding(5) var<storage, read_write> frontSortedIdx: array<u32>;       // → original index
@group(0) @binding(6) var<storage, read_write> staircase:   array<vec2<f32>>;    // DATA space
@group(0) @binding(7) var<storage, read_write> indirect:    DrawArgs;            // stair line-strip
@group(0) @binding(8) var<storage, read_write> shadeIndirect: DrawArgs;          // HV-shade fan

@compute @workgroup_size(64)
fn ranksort(@builtin(global_invocation_id) gid: vec3<u32>) {
  let kk = gid.x;
  let K = atomicLoad(&count[0]);
  if (kk >= K) { return; }
  let sgn = vec2<f32>(U.xSign, U.ySign);
  let p  = frontIdx[kk];
  let pc = pos[p] * sgn;                                   // canonical
  var rank = 0u;
  for (var j = 0u; j < K; j = j + 1u) {
    let q  = frontIdx[j];
    let qx = pos[q].x * U.xSign;                           // canonical x
    if (qx < pc.x || (qx == pc.x && q < p)) { rank = rank + 1u; }
  }
  frontSorted[rank] = pc;
  frontSortedIdx[rank] = p;
}

@compute @workgroup_size(64)
fn emit(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  let K = atomicLoad(&count[0]);
  if (r >= K) { return; }
  let sgn = vec2<f32>(U.xSign, U.ySign);
  if (r == 0u) {
    // Left cap: canonical (antiX, firstY), un-folded to data space.
    staircase[0] = vec2<f32>(U.antiX, frontSorted[0].y) * sgn;
    let M = 1u + 2u * K;
    indirect.vertexCount = M;       indirect.instanceCount = 1u;
    indirect.firstVertex = 0u;      indirect.firstInstance = 0u;
    shadeIndirect.vertexCount = 3u * (M - 1u);  shadeIndirect.instanceCount = 1u;
    shadeIndirect.firstVertex = 0u; shadeIndirect.firstInstance = 0u;
  }
  let here = frontSorted[r];                               // canonical
  let next = r + 1u;
  // Drop to the next point's y, or — for the last point — to the canonical worst-y
  // domain edge (the CPU's plotH bottom cap), not value 0.
  let dropY = select(U.antiY, frontSorted[next].y, next < K);
  staircase[1u + 2u*r]      = here * sgn;
  staircase[1u + 2u*r + 1u] = vec2<f32>(here.x, dropY) * sgn;
}`;

// WGSL (compute): hypervolume contributions — the EXACT leave-one-out-with-fill
// oracle (script.js computeHvContributions) ported to the GPU, NOT the cheap
// exclusive-corner formula. CPU sweepExcluding(p) re-sweeps ALL of `unique`, so
// removing a frontier member lets cloud points behind it fill in; ΔHV = totalHv −
// altHv is the real loss, and that is what sizes the visible dot radius. One thread
// per frontier slot re-sweeps the whole cloud in canonical space with a per-thread
// monotone stack — O(F·N), F≤~30, N≤~20k → sub-ms. All compares are canonical so the
// four sign quadrants share one body. RxC/RyC are the canonical reference point
// (universe min corner − eps), computed on the CPU to match the oracle's eps math.
const WEBGPU_HVCONTRIB_WGSL = `
const MAX_FRONT : u32 = ${WEBGPU_GRAPH_MAX_FRONT}u;
const R_MIN : f32 = ${WEBGPU_GRAPH_R_MIN};
const R_MAX : f32 = ${WEBGPU_GRAPH_R_MAX};
const HV_STACK : u32 = 64u;                 // per-thread stack cap; real frontiers ≪ this
struct Hv { n: u32, xSign: f32, ySign: f32, Rx: f32, Ry: f32 };   // Rx/Ry are CANONICAL
@group(0) @binding(0) var<uniform>             U:           Hv;
@group(0) @binding(1) var<storage, read>       pos:         array<vec2<f32>>;   // DATA space
@group(0) @binding(2) var<storage, read>       frontSorted: array<vec2<f32>>;   // CANONICAL, x-asc
@group(0) @binding(3) var<storage, read>       frontSortedIdx: array<u32>;
@group(0) @binding(4) var<storage, read_write> count:       array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> hv:          array<f32>;         // contrib per rank
@group(0) @binding(6) var<storage, read_write> frontRadius: array<f32>;         // radius per INSTANCE
@group(0) @binding(7) var<storage, read_write> scalar:      array<f32>;         // [0]=totalHv [1]=maxContrib

// hvOf over the canonical, x-ascending frontSorted[0..K): vertical-strip decomposition.
fn hvTotal_(K: u32) -> f32 {
  var acc = 0.0;
  var xPrev = U.Rx;
  for (var r = 0u; r < K; r = r + 1u) {
    let p = frontSorted[r];
    acc = acc + (p.x - xPrev) * (p.y - U.Ry);
    xPrev = p.x;
  }
  return acc;
}

@compute @workgroup_size(1)
fn hvTotal() {
  let K = atomicLoad(&count[0]);
  scalar[0] = hvTotal_(K);
}

@compute @workgroup_size(64)
fn hvContrib(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  let K = atomicLoad(&count[0]);
  if (r >= K) { return; }
  let sgn = vec2<f32>(U.xSign, U.ySign);
  let skip = frontSortedIdx[r];
  // Re-sweep the whole cloud excluding 'skip', in CANONICAL space, with a monotone
  // stack — identical pop rules to CPU sweepExcluding (pop while top.Y < pY; then the
  // equal-Y / smaller-X tiebreak), walked in upload order so the survivor set matches.
  var stk: array<vec2<f32>, 64>;
  var top: i32 = -1;
  for (var i = 0u; i < U.n; i = i + 1u) {
    if (i == skip) { continue; }
    let pc = pos[i] * sgn;
    loop {
      if (top < 0) { break; }
      if (stk[top].y < pc.y) { top = top - 1; } else { break; }
    }
    if (top >= 0 && stk[top].y == pc.y && stk[top].x < pc.x) { top = top - 1; }
    top = top + 1;
    if (u32(top) < HV_STACK) { stk[top] = pc; }
  }
  var alt = 0.0;
  var xPrev = U.Rx;
  for (var s = 0; s <= top; s = s + 1) {
    alt = alt + (stk[s].x - xPrev) * (stk[s].y - U.Ry);
    xPrev = stk[s].x;
  }
  let contrib = scalar[0] - alt;
  hv[r] = max(contrib, 0.0);
}

@compute @workgroup_size(1)
fn hvMax() {
  let K = atomicLoad(&count[0]);
  var m = 0.0;
  for (var r = 0u; r < K; r = r + 1u) { m = max(m, hv[r]); }
  scalar[1] = select(m, 1.0, m <= 0.0);          // CPU's "maxContrib || 1"
}

@compute @workgroup_size(64)
fn hvRadius(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  let K = atomicLoad(&count[0]);
  if (r >= K) { return; }
  let idx = frontSortedIdx[r];
  let maxC = scalar[1];
  frontRadius[idx] = R_MIN + (R_MAX - R_MIN) * sqrt(hv[r] / maxC);
}`;

// WGSL (render): the GPU staircase line. Vertex-pulls the DATA-space staircase[] the
// emit pass wrote, maps with the same affine uScene.ab as the cloud, draws a line-
// strip via drawIndirect (vertex count came from the GPU). Colour + opacity arrive in
// uGraphCol[0] (the CPU --frontier-color / worst-mode purple, with its 0.55 opacity).
const WEBGPU_STAIRLINE_GRAPH_WGSL = `
struct Scene { ab: vec4<f32>, vp: vec4<f32>, sgn: vec4<f32>, corn: vec4<f32> };
struct Col { stair: vec4<f32>, shade: vec4<f32>, front: vec4<f32> };
@group(0) @binding(0) var<uniform> sc: Scene;
@group(0) @binding(1) var<storage, read> staircase: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> gc: Col;
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let p = staircase[vi];
  let px = sc.ab.x * p.x + sc.ab.y;
  let py = sc.ab.z * p.y + sc.ab.w;
  return vec4<f32>(px / sc.vp.x * 2.0 - 1.0, 1.0 - py / sc.vp.y * 2.0, 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> { return vec4<f32>(gc.stair.rgb, gc.stair.a); }`;

// WGSL (render): the hypervolume SHADE — a gradient fill of the dominated region
// under the staircase, fading from the ideal corner (opacity 0.10) toward the
// anti-ideal corner (0.01), reproducing the SVG linearGradient (script.js #hv-shade-
// grad). Geometry: a triangle FAN from the anti-ideal apex over the staircase
// polyline (the dominated region is star-shaped from that corner). drawIndirect's
// vertex count = 3·(M−1) was written by emit. The fragment projects its pixel position
// onto the ideal→anti axis (uScene.corn = (antiX,antiY,idealX,idealY) in pixels) for t.
const WEBGPU_HVSHADE_GRAPH_WGSL = `
struct Scene { ab: vec4<f32>, vp: vec4<f32>, sgn: vec4<f32>, corn: vec4<f32> };
struct Col { stair: vec4<f32>, shade: vec4<f32>, front: vec4<f32> };
struct Stair { n: u32, xSign: f32, ySign: f32, antiX: f32, antiY: f32 };
@group(0) @binding(0) var<uniform> sc: Scene;
@group(0) @binding(1) var<storage, read> staircase: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> gc: Col;
@group(0) @binding(3) var<uniform> st: Stair;
struct VSOut { @builtin(position) clip: vec4<f32>, @location(0) frag: vec2<f32> };
fn toPx(p: vec2<f32>) -> vec2<f32> { return vec2<f32>(sc.ab.x * p.x + sc.ab.y, sc.ab.z * p.y + sc.ab.w); }
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  let t = vi / 3u;            // triangle index
  let c = vi % 3u;            // corner within the fan triangle (anti, v[t], v[t+1])
  let antiData = vec2<f32>(st.antiX * st.xSign, st.antiY * st.ySign);  // un-fold to data
  var p: vec2<f32>;
  if (c == 0u) { p = antiData; }
  else if (c == 1u) { p = staircase[t]; }
  else { p = staircase[t + 1u]; }
  let px = toPx(p);
  var o: VSOut;
  o.clip = vec4<f32>(px.x / sc.vp.x * 2.0 - 1.0, 1.0 - px.y / sc.vp.y * 2.0, 0.0, 1.0);
  o.frag = px;
  return o;
}
@fragment
fn fs(i: VSOut) -> @location(0) vec4<f32> {
  let ideal = sc.corn.zw;
  let anti  = sc.corn.xy;
  let axis  = anti - ideal;
  let denom = max(dot(axis, axis), 1e-6);
  let t = clamp(dot(i.frag - ideal, axis) / denom, 0.0, 1.0);
  let a = mix(0.10, 0.01, t);
  return vec4<f32>(gc.shade.rgb, a);
}`;

// WGSL (render): GPU frontier DOTS with HV-derived radii + white ring — a port of the
// streaming spring-cloud's front pass (script.js WEBGPU_SPRINGCLOUD_WGSL). Degenerates
// every non-front instance (one draw over the full cloud), pulls its radius from
// frontRadius[ii] (written by hvRadius), and either keeps the era colour (col[ii], best
// mode) or the worst-mode override (uGraphCol.front, .w = use-override). Drawn ON TOP.
const WEBGPU_SCENEFRONT_WGSL = `
struct Scene { ab: vec4<f32>, vp: vec4<f32>, sgn: vec4<f32>, corn: vec4<f32> };
struct Col { stair: vec4<f32>, shade: vec4<f32>, front: vec4<f32> };
@group(0) @binding(0) var<uniform> sc: Scene;
@group(0) @binding(1) var<storage, read> pos: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> col: array<u32>;
@group(0) @binding(3) var<storage, read> onFront: array<u32>;
@group(0) @binding(4) var<storage, read> frontRadius: array<f32>;
@group(0) @binding(5) var<uniform> gc: Col;
struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) off: vec2<f32>,
  @location(1) @interpolate(flat) fill: vec4<f32>,
  @location(2) @interpolate(flat) radius: f32,
  @location(3) @interpolate(flat) ring: f32,
};
const C = array<vec2<f32>, 6>(
  vec2<f32>(-1.0,-1.0), vec2<f32>(1.0,-1.0), vec2<f32>(-1.0,1.0),
  vec2<f32>(-1.0, 1.0), vec2<f32>(1.0,-1.0), vec2<f32>( 1.0,1.0));
fn unpack(c: u32) -> vec4<f32> {
  return vec4<f32>(f32(c & 0xffu), f32((c >> 8u) & 0xffu),
                   f32((c >> 16u) & 0xffu), f32((c >> 24u) & 0xffu)) / 255.0;
}
fn degenerate() -> VSOut {
  var o: VSOut; o.clip = vec4<f32>(2.0, 2.0, 0.0, 1.0);
  o.off = vec2<f32>(0.0); o.fill = vec4<f32>(0.0); o.radius = 0.0; o.ring = 0.0; return o;
}
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  if (onFront[ii] == 0u) { return degenerate(); }
  let p = pos[ii];
  let r = frontRadius[ii];
  let ring = ${WEBGPU_GRAPH_FRONT_RING};
  let ext = r + ring;
  let px = sc.ab.x * p.x + sc.ab.y;
  let py = sc.ab.z * p.y + sc.ab.w;
  let cx = px / sc.vp.x * 2.0 - 1.0;
  let cy = 1.0 - py / sc.vp.y * 2.0;
  let corner = C[vi];
  var o: VSOut;
  o.clip = vec4<f32>(cx + corner.x * ext / sc.vp.x * 2.0, cy + corner.y * ext / sc.vp.y * 2.0, 0.0, 1.0);
  o.off = corner * ext;
  o.radius = r; o.ring = ring;
  let era = unpack(col[ii]).rgb;
  let fillrgb = select(era, gc.front.rgb, gc.front.w > 0.5);
  o.fill = vec4<f32>(fillrgb, 1.0);                 // frontier dots are opaque
  return o;
}
@fragment
fn fs(i: VSOut) -> @location(0) vec4<f32> {
  let dist = length(i.off);
  let outer = i.radius + i.ring * 0.5;
  let aa = 1.0 - smoothstep(outer - 0.75, outer + 0.75, dist);
  if (aa <= 0.0) { discard; }
  var col: vec3<f32>;
  if (dist > i.radius - i.ring * 0.5) { col = vec3<f32>(1.0, 1.0, 1.0); }  // white ring
  else { col = i.fill.rgb; }
  return vec4<f32>(col, aa);
}`;

// ── G3: glyph-atlas text ─────────────────────────────────────────────────────
// The chart's axis tick labels + frontier player names render from a pre-rasterized
// Canvas2D glyph atlas (NOT SDF — docs/rendering.md §"G-track design"): tick generation
// (d3 .ticks()/.tickFormat()) and label collision layout (layoutFrontierLabels) stay
// CPU; the GPU just draws the CPU-laid-out glyph quads. This is the renderer's first
// sampled texture. Axis TITLES stay SVG (they keep click/glossary interaction, and the
// rotated Y-title defers to G5) — the pragmatic G3 cut.

// Base charset: digits, ASCII letters, the punctuation ticks/labels emit, and the whole
// Latin-1 letter block (À–ÿ) so player-name diacritics (Martínez/Pérez/Peña) are covered
// without enumerating 24k names. uploadText lazy-rebuilds if a string needs a codepoint
// outside this set (e.g. an exotic name), so coverage is guaranteed, not guessed.
const GRAPH_GLYPH_BASE_CHARSET = (() => {
    let s = " .,-+%/()0123456789";
    for (let c = 0x41; c <= 0x5a; c++) s += String.fromCharCode(c);   // A–Z
    for (let c = 0x61; c <= 0x7a; c++) s += String.fromCharCode(c);   // a–z
    for (let c = 0xc0; c <= 0xff; c++) s += String.fromCharCode(c);   // Latin-1 À–ÿ
    return s;
})();
// Text variants: [id] = {px, weight}. 0 ticks, 1 labels-desktop, 2 labels-mobile.
const GRAPH_GLYPH_VARIANTS = [
    { px: 11, weight: 400 },   // 0: axis tick labels (.axis text)
    { px: 11, weight: 600 },   // 1: frontier labels desktop (.frontier-label)
    { px: 9,  weight: 600 },   // 2: frontier labels mobile (.frontier-label--mobile)
];
const GRAPH_GLYPH_HALO_VARIANTS = new Set([1, 2]);   // label variants get a white halo cell
const GRAPH_GLYPH_ATLAS_MAX = 2048;

// WGSL (render): instanced textured quads. Each instance is a glyph quad in PIXEL space
// (margin already folded in by the CPU), vertex-pulled like WEBGPU_SCENEFRONT_WGSL; the
// fragment samples the atlas's alpha coverage and tints by the per-instance colour. The
// output is PREMULTIPLIED to match the G-track src-over blend, so the white halo and the
// coloured fill (two instances per label glyph) composite exactly like SVG paint-order.
const WEBGPU_GLYPH_WGSL = `
struct Scene { ab: vec4<f32>, vp: vec4<f32>, sgn: vec4<f32>, corn: vec4<f32> };
@group(0) @binding(0) var<uniform> sc: Scene;
@group(0) @binding(1) var<storage, read> inst: array<vec4<f32>>;   // 3 vec4 per glyph (stride 48 B)
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) @interpolate(flat) rgba: u32,
};
// Glyph record = 48 B = 3 × vec4<f32>:
//   [0] rect = (x, y, w, h)  CSS px (margin folded in)
//   [1] uv   = (u0, v0, u1, v1)  atlas UV
//   [2] col  = (colourBits, _, _, _)  packed RGBA8 in float[0]'s bit pattern
const C = array<vec2<f32>, 6>(
  vec2<f32>(0.0,0.0), vec2<f32>(1.0,0.0), vec2<f32>(0.0,1.0),
  vec2<f32>(0.0,1.0), vec2<f32>(1.0,0.0), vec2<f32>(1.0,1.0));
fn unpack(c: u32) -> vec4<f32> {
  return vec4<f32>(f32(c & 0xffu), f32((c >> 8u) & 0xffu),
                   f32((c >> 16u) & 0xffu), f32((c >> 24u) & 0xffu)) / 255.0;
}
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let rect = inst[ii * 3u];          // x, y, w, h  (CSS px)
  let uvr  = inst[ii * 3u + 1u];     // u0, v0, u1, v1
  let col  = inst[ii * 3u + 2u];     // colourBits in .x
  let corner = C[vi];
  let px = rect.x + corner.x * rect.z;
  let py = rect.y + corner.y * rect.w;
  var o: VSOut;
  o.clip = vec4<f32>(px / sc.vp.x * 2.0 - 1.0, 1.0 - py / sc.vp.y * 2.0, 0.0, 1.0);
  o.uv = vec2<f32>(mix(uvr.x, uvr.z, corner.x), mix(uvr.y, uvr.w, corner.y));
  o.rgba = bitcast<u32>(col.x);
  return o;
}
@fragment
fn fs(i: VSOut) -> @location(0) vec4<f32> {
  let cov = textureSample(atlas, samp, i.uv).a;
  if (cov <= 0.0) { discard; }
  let c = unpack(i.rgba);
  let a = c.a * cov;
  return vec4<f32>(c.rgb * a, a);    // premultiplied
}`;

// ── GraphRenderer methods, attached to WebGPURenderer ────────────────────────
// Deferred scripts run in document order, so WebGPURenderer (script.js) exists by
// the time this file executes — and chooseRenderer() hasn't run yet (it waits on
// DOMContentLoaded), so every instance ever constructed gets these methods.
// Attaching to the prototype (rather than subclassing) keeps the renderer
// selection ladder in script.js untouched: the same WebGPURenderer instance
// serves Phase-3/4/5 AND the G-track, switched per frame by the gpuGraph gate.
(function attachGraphEngine() {
    if (typeof WebGPURenderer === "undefined") return;   // ultra-defensive: bundler reorder
    const P = WebGPURenderer.prototype;

    // Lazily build the scene pipeline on first use, so the G-track costs nothing
    // (no shader compile, no layout) for everyone not running ?gpugraph=1.
    P._initGraphPipelines = function () {
        if (this.pSceneCloud) return;
        const dev = this.device;
        // Same premultiplied src-over blend as init() — duplicated by design: the
        // G-track shares no objects with the streaming path until the G5
        // convergence, so a G0–G4 change can't disturb the shipped pipelines.
        const blend = {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        };
        this.sceneBgl = dev.createBindGroupLayout({ entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        ] });
        const mod = dev.createShaderModule({ code: WEBGPU_SCENECLOUD_WGSL });
        this.pSceneCloud = dev.createRenderPipeline({
            layout: dev.createPipelineLayout({ bindGroupLayouts: [this.sceneBgl] }),
            vertex: { module: mod, entryPoint: "vs" },
            fragment: { module: mod, entryPoint: "fs", targets: [{ format: this.format, blend }] },
            primitive: { topology: "triangle-list" } });

        // G1: skyline + compact share one module and one (superset) layout —
        // the same packaging as the streaming staircase module. Both entry
        // points get their own compute pipeline.
        this.skyBgl = dev.createBindGroupLayout({ entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ] });
        const skyMod = dev.createShaderModule({ code: WEBGPU_SCENESKYLINE_WGSL });
        const skyLayout = dev.createPipelineLayout({ bindGroupLayouts: [this.skyBgl] });
        this.pSceneSkyline = dev.createComputePipeline({
            layout: skyLayout, compute: { module: skyMod, entryPoint: "skyline" } });
        this.pSceneCompact = dev.createComputePipeline({
            layout: skyLayout, compute: { module: skyMod, entryPoint: "compact" } });

        // ── G4 compute: depth-layer peeling (peelInit/peelSky/peelMark) ──
        this.depthBgl = dev.createBindGroupLayout({ entries: [
            // Dynamic offset: one uDepth buffer holds a 256-aligned slot per peel layer
            // (a shared uniform written between passes in one encoder would lose all but
            // the last value — every pass in a submit reads the final queue write).
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ] });
        const depthMod = dev.createShaderModule({ code: WEBGPU_DEPTH_WGSL });
        const depthLayout = dev.createPipelineLayout({ bindGroupLayouts: [this.depthBgl] });
        this.pDepthInit = dev.createComputePipeline({ layout: depthLayout, compute: { module: depthMod, entryPoint: "peelInit" } });
        this.pDepthSky  = dev.createComputePipeline({ layout: depthLayout, compute: { module: depthMod, entryPoint: "peelSky" } });
        this.pDepthMark = dev.createComputePipeline({ layout: depthLayout, compute: { module: depthMod, entryPoint: "peelMark" } });

        // ── G2 compute: staircase (ranksort/emit) + HV (total/contrib/max/radius) ──
        const un = (b) => ({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } });
        const ro = (b) => ({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } });
        const rw = (b) => ({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } });
        this.stairBgl = dev.createBindGroupLayout({ entries: [
            un(0), ro(1), ro(2), rw(3), rw(4), rw(5), rw(6), rw(7), rw(8) ] });
        const stairMod = dev.createShaderModule({ code: WEBGPU_SCENESTAIR_WGSL });
        const stairLayout = dev.createPipelineLayout({ bindGroupLayouts: [this.stairBgl] });
        this.pSceneRanksort = dev.createComputePipeline({ layout: stairLayout, compute: { module: stairMod, entryPoint: "ranksort" } });
        this.pSceneEmit     = dev.createComputePipeline({ layout: stairLayout, compute: { module: stairMod, entryPoint: "emit" } });

        this.hvBgl = dev.createBindGroupLayout({ entries: [
            un(0), ro(1), ro(2), ro(3), rw(4), rw(5), rw(6), rw(7) ] });
        const hvMod = dev.createShaderModule({ code: WEBGPU_HVCONTRIB_WGSL });
        const hvLayout = dev.createPipelineLayout({ bindGroupLayouts: [this.hvBgl] });
        this.pSceneHvTotal   = dev.createComputePipeline({ layout: hvLayout, compute: { module: hvMod, entryPoint: "hvTotal" } });
        this.pSceneHvContrib = dev.createComputePipeline({ layout: hvLayout, compute: { module: hvMod, entryPoint: "hvContrib" } });
        this.pSceneHvMax     = dev.createComputePipeline({ layout: hvLayout, compute: { module: hvMod, entryPoint: "hvMax" } });
        this.pSceneHvRadius  = dev.createComputePipeline({ layout: hvLayout, compute: { module: hvMod, entryPoint: "hvRadius" } });

        // ── G2 render: stair line, HV shade, frontier dots ──
        const uV = (b) => ({ binding: b, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } });
        const sV = (b) => ({ binding: b, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } });
        this.stairLineBgl = dev.createBindGroupLayout({ entries: [ uV(0), sV(1), uV(2) ] });
        this.pSceneStairLine = dev.createRenderPipeline({
            layout: dev.createPipelineLayout({ bindGroupLayouts: [this.stairLineBgl] }),
            vertex: { module: dev.createShaderModule({ code: WEBGPU_STAIRLINE_GRAPH_WGSL }), entryPoint: "vs" },
            fragment: { module: dev.createShaderModule({ code: WEBGPU_STAIRLINE_GRAPH_WGSL }), entryPoint: "fs", targets: [{ format: this.format, blend }] },
            primitive: { topology: "line-strip" } });

        this.hvShadeBgl = dev.createBindGroupLayout({ entries: [ uV(0), sV(1), uV(2), uV(3) ] });
        const shadeMod = dev.createShaderModule({ code: WEBGPU_HVSHADE_GRAPH_WGSL });
        this.pSceneHvShade = dev.createRenderPipeline({
            layout: dev.createPipelineLayout({ bindGroupLayouts: [this.hvShadeBgl] }),
            vertex: { module: shadeMod, entryPoint: "vs" },
            fragment: { module: shadeMod, entryPoint: "fs", targets: [{ format: this.format, blend }] },
            primitive: { topology: "triangle-list" } });

        this.sceneFrontBgl = dev.createBindGroupLayout({ entries: [ uV(0), sV(1), sV(2), sV(3), sV(4), uV(5) ] });
        const frontMod = dev.createShaderModule({ code: WEBGPU_SCENEFRONT_WGSL });
        this.pSceneFront = dev.createRenderPipeline({
            layout: dev.createPipelineLayout({ bindGroupLayouts: [this.sceneFrontBgl] }),
            vertex: { module: frontMod, entryPoint: "vs" },
            fragment: { module: frontMod, entryPoint: "fs", targets: [{ format: this.format, blend }] },
            primitive: { topology: "triangle-list" } });

        // ── G3 render: glyph-atlas text (the first sampled texture) ──
        this.glyphBgl = dev.createBindGroupLayout({ entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        ] });
        const glyphMod = dev.createShaderModule({ code: WEBGPU_GLYPH_WGSL });
        this.pSceneGlyph = dev.createRenderPipeline({
            layout: dev.createPipelineLayout({ bindGroupLayouts: [this.glyphBgl] }),
            vertex: { module: glyphMod, entryPoint: "vs" },
            fragment: { module: glyphMod, entryPoint: "fs", targets: [{ format: this.format, blend }] },
            primitive: { topology: "triangle-list" } });
        this.glyphSampler = dev.createSampler({ magFilter: "linear", minFilter: "linear" });
    };

    // Build (or rebuild) the Canvas2D glyph atlas at the given dpr covering `charset`.
    // Rasterizes each (variant, char) cell white-on-transparent (alpha coverage; the
    // fragment tints by instance colour); label variants additionally get a white
    // STROKE cell for the halo (pixel-matching .frontier-label's paint-order:stroke).
    // Returns nothing; populates this.glyph = { dpr, metrics, w, h, charset, uploadPath }
    // and (re)creates this.glyphTex. metrics maps variant*0x10000+codepoint → cell info.
    P._buildGlyphAtlas = function (dpr, charset) {
        const family = (getComputedStyle(document.documentElement)
            .getPropertyValue("--font-sans") || "sans-serif").trim() || "sans-serif";
        const cv = document.createElement("canvas");
        const ctx = cv.getContext("2d");
        const pad = Math.ceil(3 * dpr) + 1;             // absorbs the 1.5·dpr halo stroke + 1px guard
        const chars = Array.from(new Set(Array.from(charset)));
        // ── Cell model (device px) ──────────────────────────────────────────────
        // Advance-based: cell width = ceil(advance) + 2·pad; the pen origin sits at
        // (pad, pad+asc) inside the cell. fill and halo are SEPARATE cells of the same
        // footprint (pad covers the stroke overhang). Placement contract for the CPU:
        //   rect.x = penX − padCss,  rect.y = baselineY − ascCss − padCss,
        //   rect.w = wCss, rect.h = hCss; then penX += advanceCss.
        const cells = [];
        for (let v = 0; v < GRAPH_GLYPH_VARIANTS.length; v++) {
            const { px, weight } = GRAPH_GLYPH_VARIANTS[v];
            ctx.font = `${weight} ${Math.round(px * dpr)}px ${family}`;
            ctx.textBaseline = "alphabetic";
            for (const ch of chars) {
                const m = ctx.measureText(ch);
                const adv = m.width;
                const asc = Math.ceil(m.actualBoundingBoxAscent || Math.round(px * dpr * 0.8));
                const desc = Math.ceil(m.actualBoundingBoxDescent || Math.round(px * dpr * 0.25));
                const right = Math.ceil(m.actualBoundingBoxRight || adv);
                const cw = Math.max(Math.ceil(adv), right) + pad * 2;
                const chh = asc + desc + pad * 2;
                const base = { v, ch, cw, chh, advance: adv, asc };
                cells.push({ ...base, halo: false });
                if (GRAPH_GLYPH_HALO_VARIANTS.has(v)) cells.push({ ...base, halo: true });
            }
        }
        // Shelf-pack.
        let x = 0, y = 0, shelfH = 0, atlasW = 0;
        for (const c of cells) {
            if (x + c.cw > GRAPH_GLYPH_ATLAS_MAX) { x = 0; y += shelfH; shelfH = 0; }
            c.x = x; c.y = y; x += c.cw; shelfH = Math.max(shelfH, c.chh);
            atlasW = Math.max(atlasW, x);
        }
        cv.width = Math.min(GRAPH_GLYPH_ATLAS_MAX, atlasW);
        cv.height = y + shelfH;
        // Rasterize.
        const metrics = new Map();
        for (const c of cells) {
            const { px, weight } = GRAPH_GLYPH_VARIANTS[c.v];
            ctx.font = `${weight} ${Math.round(px * dpr)}px ${family}`;
            ctx.textBaseline = "alphabetic";
            const drawX = c.x + pad, drawY = c.y + pad + c.asc;   // pen origin in the cell
            if (c.halo) {
                ctx.strokeStyle = "#fff"; ctx.lineWidth = 3 * dpr; ctx.lineJoin = "round";
                ctx.strokeText(c.ch, drawX, drawY);
            } else {
                ctx.fillStyle = "#fff"; ctx.fillText(c.ch, drawX, drawY);
            }
            const key = c.v * 0x10000 + c.ch.codePointAt(0);
            const u0 = c.x / cv.width, v0 = c.y / cv.height;
            const u1 = (c.x + c.cw) / cv.width, v1 = (c.y + c.chh) / cv.height;
            const entry = metrics.get(key) || {
                advance: c.advance / dpr, w: c.cw / dpr, h: c.chh / dpr,
                padCss: pad / dpr, ascCss: c.asc / dpr };
            if (c.halo) { entry.hu0 = u0; entry.hv0 = v0; entry.hu1 = u1; entry.hv1 = v1; }
            else { entry.u0 = u0; entry.v0 = v0; entry.u1 = u1; entry.v1 = v1; }
            metrics.set(key, entry);
        }
        // Upload to a GPUTexture. Prefer copyExternalImageToTexture; fall back to
        // writeTexture(getImageData) under backends that reject the canvas source.
        const dev = this.device;
        this.glyphTex?.destroy();
        this.glyphTex = dev.createTexture({
            size: [cv.width, cv.height], format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
        // Upload via writeTexture(getImageData): reliable on every backend including
        // headless SwiftShader, where copyExternalImageToTexture can silently produce a
        // BLANK texture (it doesn't throw, so it can't be caught — only the missing text
        // gives it away). The atlas is built rarely (once per dpr), so the getImageData
        // copy is a non-issue. The canvas is in-process → not tainted → getImageData safe.
        let uploadPath = "writeTexture";
        const img = ctx.getImageData(0, 0, cv.width, cv.height);
        dev.queue.writeTexture({ texture: this.glyphTex }, img.data, { bytesPerRow: cv.width * 4 }, [cv.width, cv.height, 1]);
        this.glyph = { dpr, metrics, w: cv.width, h: cv.height, charset, uploadPath };
    };

    // Ensure the glyph atlas covers `charset` at the current dpr, building/rebuilding it
    // if needed, and return its metrics map so the CPU can lay out glyph instances before
    // uploadText. Idempotent — the common refresh (atlas already current) is a no-op.
    P.ensureGlyphAtlas = function (charset) {
        this._initGraphPipelines();
        const covered = this.glyph && this.glyph.dpr === this.dpr &&
            !Array.from(charset).some(c => !this.glyph.metrics.has(c.codePointAt(0)));
        if (!covered) this._buildGlyphAtlas(this.dpr, GRAPH_GLYPH_BASE_CHARSET + charset);
        return this.glyph.metrics;
    };

    // Upload this refresh's text as glyph instances. Unlike the scene cloud, text is NOT
    // scale-retained — layout (tick positions, label collision) depends on the scales, so
    // the CPU rebuilds the instances each refresh (counts are tiny, ≤ a few hundred). The
    // atlas itself is cached and only rebuilt on a dpr change or a codepoint cache-miss.
    // `instances` is a flat Float32Array already in the 3·vec4 (48 B) record layout;
    // opts = { count, strings, charset }.
    P.uploadText = function (instances, opts) {
        this._initGraphPipelines();
        const g = this.graph;
        if (!g) return;
        const dev = this.device;
        // (Re)build the atlas if dpr changed or a requested codepoint isn't covered.
        const needRebuild = !this.glyph || this.glyph.dpr !== this.dpr ||
            (opts.charset && Array.from(opts.charset).some(c =>
                !this.glyph.metrics.has(0 * 0x10000 + c.codePointAt(0))));
        if (needRebuild) {
            const charset = GRAPH_GLYPH_BASE_CHARSET + (opts.charset || "");
            this._buildGlyphAtlas(this.dpr, charset);
            g.glyphTexRef = null;             // force bind-group rebuild against the new texture
        }
        const count = opts.count | 0;
        const bytes = Math.max(48, count * 48);
        const grew = !g.bGlyph || g.bGlyph.size < ((bytes + 255) & ~255);
        if (grew) {
            g.bGlyph?.destroy();
            g.bGlyph = dev.createBuffer({ size: Math.max(256, (bytes + 255) & ~255),
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
        }
        if (count > 0) dev.queue.writeBuffer(g.bGlyph, 0, instances, 0, count * 12);
        if (grew || g.glyphTexRef !== this.glyphTex || !g.glyphBindGroup) {
            g.glyphBindGroup = dev.createBindGroup({ layout: this.glyphBgl, entries: [
                { binding: 0, resource: { buffer: g.uScene } },
                { binding: 1, resource: { buffer: g.bGlyph } },
                { binding: 2, resource: this.glyphTex.createView() },
                { binding: 3, resource: this.glyphSampler },
            ] });
            g.glyphTexRef = this.glyphTex;
        }
        g.glyphCount = count;
        g.glyphStrings = opts.strings || null;
        g.glyphCharset = opts.charset || "";
    };

    // Upload (or skip!) the scene. `key` is the SCALE-INDEPENDENT identity of the
    // point set — filters/mode/axes/colors but NOT the scale domain, viewport, or
    // dpr. Same key ⇒ the resident buffers are already correct ⇒ this returns
    // without touching the bus. That skip IS the retained-scene win: on a
    // zoom/resize-only refresh, only writeSceneScale()'s 64 bytes move.
    P.uploadScene = function (points, opts) {
        this._initGraphPipelines();
        const g = this.graph || (this.graph = {
            bPos: null, bCol: null, bSize: null, uScene: null, bindGroup: null,
            count: 0, key: null, uploads: 0, cpuPos: null,
            // G1 frontier state. bOnFront/bFrontIdx/bCount are the compute
            // outputs; uSky the compute uniform; stage[] the double-buffered
            // MAP_READ staging pair for the fire-and-forget readback contract.
            bOnFront: null, bFrontIdx: null, bCount: null, uSky: null,
            skyBindGroup: null,
            stage: [null, null], stagePending: [false, false],
            front: null,        // latest mapped result: { count, indices, key }
            frontReads: 0,      // verify hook asserts retention (stays 1, like uploads)
            cpuMeta: null,      // written-index → {x, y, playerID, year} for reconciliation
            xSign: 1, ySign: 1,
            // G2: staircase + HV state. bFrontSorted/bFrontSortedIdx hold the canonical
            // x-sorted frontier; bStaircase/bStairIndirect the line-strip; bShadeIndirect
            // the fan; bHv the per-rank contributions; bFrontRadius the per-instance dot
            // radius; bHvScalar [totalHv, maxContrib]. uStair/uHv compute uniforms;
            // uGraphCol the render colours (stair line / HV shade / worst-mode override).
            bFrontSorted: null, bFrontSortedIdx: null, bStaircase: null,
            bStairIndirect: null, bShadeIndirect: null, bHv: null, bFrontRadius: null,
            bHvScalar: null, uStair: null, uHv: null, uGraphCol: null,
            stairBindGroup: null, hvBindGroup: null,
            stairLineBindGroup: null, hvShadeBindGroup: null, frontBindGroup: null,
            // G3: glyph text. bGlyph = instance buffer (3·vec4 per glyph); glyphBindGroup
            // binds uScene + bGlyph + the atlas texture + sampler; glyphCount drives the
            // draw; glyphStrings/glyphCharset feed the verify hook.
            bGlyph: null, glyphCount: 0, glyphBindGroup: null,
            glyphTexRef: null, glyphStrings: null, glyphCharset: null,
            // G4: depth-layer peeling. bPeeled/bLayerOf/bOnTmp are cloud-sized scratch
            // (layerOf[i] = a point's onion-peel layer, BIG if deeper than `depth`);
            // uDepth the per-iteration uniform; depth the requested peel count (1 = the
            // frontier only = no peeling). depthBindGroup binds them all.
            bPeeled: null, bLayerOf: null, bOnTmp: null, uDepth: null,
            depthBindGroup: null, depth: 1,
        });
        if (!g.uScene) {
            g.uScene = this.device.createBuffer({
                size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        }
        if (g.key === opts.key) return;     // identity unchanged → buffers stay resident

        const n = points ? points.length : 0;
        // SoA flatten in data units. Non-finite values are COMPACTED out (not
        // NaN-holed): count is the written length, so arrays and draw agree.
        const posArr = new Float32Array(Math.max(1, n) * 2);
        const colArr = new Uint32Array(Math.max(1, n));
        const sizeArr = new Float32Array(Math.max(1, n));
        const { fillFor, alpha, radius } = opts;
        // G1: parallel JS-side metadata, indexed by the WRITTEN position (post
        // compaction), so a frontIdx readback maps straight to player identity —
        // the bridge between GPU indices and the CPU world (cards, verify).
        const meta = new Array(n);
        // Canonical (sign-folded) min/max of the cloud — the HV reference point R is the
        // min corner − eps, exactly as computeHvContributions derives it (script.js).
        const xSign = opts.xSign ?? 1, ySign = opts.ySign ?? 1;
        let xMinS = Infinity, yMinS = Infinity, xMaxS = -Infinity, yMaxS = -Infinity;
        let w = 0;
        for (let k = 0; k < n; k++) {
            const d = points[k];
            const x = d.x, y = d.y;
            if (!isFinite(x) || !isFinite(y)) continue;
            posArr[w * 2] = x; posArr[w * 2 + 1] = y;
            colArr[w] = packColorRGBA(fillFor(d), alpha);
            sizeArr[w] = radius;
            meta[w] = { x, y, playerID: d.playerID, year: d.year ?? d.yearID };
            const sx = x * xSign, sy = y * ySign;
            if (sx < xMinS) xMinS = sx; if (sx > xMaxS) xMaxS = sx;
            if (sy < yMinS) yMinS = sy; if (sy > yMaxS) yMaxS = sy;
            w++;
        }
        // Grow-on-demand with COPY_SRC so the verify hook can read positions back
        // (the same flag the streaming engine sets on bPos for verifySpring).
        const ensure = (buf, bytes) => {
            const size = Math.max(256, (bytes + 255) & ~255);
            if (buf && buf.size >= size) return buf;
            buf?.destroy();
            return this.device.createBuffer({ size,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
        };
        const oldPos = g.bPos, oldCol = g.bCol, oldSize = g.bSize, oldFront = g.bOnFront,
              oldRad = g.bFrontRadius, oldLayer = g.bLayerOf;
        g.bPos = ensure(g.bPos, w * 8);
        g.bCol = ensure(g.bCol, w * 4);
        g.bSize = ensure(g.bSize, w * 4);
        g.bOnFront = ensure(g.bOnFront, w * 4);
        g.bFrontRadius = ensure(g.bFrontRadius, w * 4);   // G2: per-instance dot radius
        g.bPeeled = ensure(g.bPeeled, w * 4);             // G4: peel mask + layer scratch
        g.bLayerOf = ensure(g.bLayerOf, w * 4);
        g.bOnTmp = ensure(g.bOnTmp, w * 4);
        // G1 fixed-size frontier scratch + uniform, allocated once with the scene.
        if (!g.bFrontIdx) {
            g.bFrontIdx = this.device.createBuffer({
                size: WEBGPU_GRAPH_MAX_FRONT * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
            g.bCount = this.device.createBuffer({
                size: 16,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
            g.uSky = this.device.createBuffer({
                size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            g.uDepth = this.device.createBuffer({   // G4 peel uniform {n, xSign, ySign, layer}
                size: WEBGPU_GRAPH_MAX_DEPTH * 256,  // one 256-aligned slot per layer (dynamic offset)
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            // G2 fixed-size scratch + uniforms.
            const mk = (size, usage) => this.device.createBuffer({ size, usage });
            const ST = GPUBufferUsage.STORAGE, CS = GPUBufferUsage.COPY_SRC, CD = GPUBufferUsage.COPY_DST;
            g.bFrontSorted    = mk(WEBGPU_GRAPH_MAX_FRONT * 8, ST | CS);
            g.bFrontSortedIdx = mk(WEBGPU_GRAPH_MAX_FRONT * 4, ST | CS);
            g.bStaircase      = mk((2 * WEBGPU_GRAPH_MAX_FRONT + 2) * 8, ST | CS);
            g.bStairIndirect  = mk(16, ST | GPUBufferUsage.INDIRECT | CD | CS);
            g.bShadeIndirect  = mk(16, ST | GPUBufferUsage.INDIRECT | CD | CS);
            g.bHv             = mk(WEBGPU_GRAPH_MAX_FRONT * 4, ST | CS);
            g.bHvScalar       = mk(16, ST | CD | CS);
            g.uStair    = mk(32, GPUBufferUsage.UNIFORM | CD);
            g.uHv       = mk(32, GPUBufferUsage.UNIFORM | CD);
            g.uGraphCol = mk(48, GPUBufferUsage.UNIFORM | CD);
        }
        const grew = g.bPos !== oldPos || g.bCol !== oldCol || g.bSize !== oldSize ||
                     g.bOnFront !== oldFront || g.bFrontRadius !== oldRad || g.bLayerOf !== oldLayer;
        if (w > 0) {
            this.device.queue.writeBuffer(g.bPos, 0, posArr, 0, w * 2);
            this.device.queue.writeBuffer(g.bCol, 0, colArr, 0, w);
            this.device.queue.writeBuffer(g.bSize, 0, sizeArr, 0, w);
        }
        // Bind groups only rebuild when a buffer object was replaced (grew) —
        // writeBuffer into an existing buffer keeps the old bind group valid.
        if (grew || !g.bindGroup) {
            g.bindGroup = this.device.createBindGroup({ layout: this.sceneBgl, entries: [
                { binding: 0, resource: { buffer: g.uScene } },
                { binding: 1, resource: { buffer: g.bPos } },
                { binding: 2, resource: { buffer: g.bCol } },
                { binding: 3, resource: { buffer: g.bSize } },
                { binding: 4, resource: { buffer: g.bOnFront } },
            ] });
            g.skyBindGroup = this.device.createBindGroup({ layout: this.skyBgl, entries: [
                { binding: 0, resource: { buffer: g.uSky } },
                { binding: 1, resource: { buffer: g.bPos } },
                { binding: 2, resource: { buffer: g.bOnFront } },
                { binding: 3, resource: { buffer: g.bFrontIdx } },
                { binding: 4, resource: { buffer: g.bCount } },
            ] });
            const bg = (buf) => ({ buffer: buf });
            g.stairBindGroup = this.device.createBindGroup({ layout: this.stairBgl, entries: [
                { binding: 0, resource: bg(g.uStair) }, { binding: 1, resource: bg(g.bPos) },
                { binding: 2, resource: bg(g.bFrontIdx) }, { binding: 3, resource: bg(g.bCount) },
                { binding: 4, resource: bg(g.bFrontSorted) }, { binding: 5, resource: bg(g.bFrontSortedIdx) },
                { binding: 6, resource: bg(g.bStaircase) }, { binding: 7, resource: bg(g.bStairIndirect) },
                { binding: 8, resource: bg(g.bShadeIndirect) },
            ] });
            g.hvBindGroup = this.device.createBindGroup({ layout: this.hvBgl, entries: [
                { binding: 0, resource: bg(g.uHv) }, { binding: 1, resource: bg(g.bPos) },
                { binding: 2, resource: bg(g.bFrontSorted) }, { binding: 3, resource: bg(g.bFrontSortedIdx) },
                { binding: 4, resource: bg(g.bCount) }, { binding: 5, resource: bg(g.bHv) },
                { binding: 6, resource: bg(g.bFrontRadius) }, { binding: 7, resource: bg(g.bHvScalar) },
            ] });
            g.stairLineBindGroup = this.device.createBindGroup({ layout: this.stairLineBgl, entries: [
                { binding: 0, resource: bg(g.uScene) }, { binding: 1, resource: bg(g.bStaircase) },
                { binding: 2, resource: bg(g.uGraphCol) },
            ] });
            g.hvShadeBindGroup = this.device.createBindGroup({ layout: this.hvShadeBgl, entries: [
                { binding: 0, resource: bg(g.uScene) }, { binding: 1, resource: bg(g.bStaircase) },
                { binding: 2, resource: bg(g.uGraphCol) }, { binding: 3, resource: bg(g.uStair) },
            ] });
            g.frontBindGroup = this.device.createBindGroup({ layout: this.sceneFrontBgl, entries: [
                { binding: 0, resource: bg(g.uScene) }, { binding: 1, resource: bg(g.bPos) },
                { binding: 2, resource: bg(g.bCol) }, { binding: 3, resource: bg(g.bOnFront) },
                { binding: 4, resource: bg(g.bFrontRadius) }, { binding: 5, resource: bg(g.uGraphCol) },
            ] });
            g.depthBindGroup = this.device.createBindGroup({ layout: this.depthBgl, entries: [
                { binding: 0, resource: { buffer: g.uDepth, offset: 0, size: 16 } },
                { binding: 1, resource: bg(g.bPos) },
                { binding: 2, resource: bg(g.bPeeled) }, { binding: 3, resource: bg(g.bLayerOf) },
                { binding: 4, resource: bg(g.bOnTmp) },
            ] });
        }
        g.count = w;
        g.key = opts.key;
        g.uploads++;                          // verify hook asserts this stays put across re-renders
        g.cpuPos = posArr.subarray(0, w * 2); // JS-side copy for the G0 readback invariant
        g.cpuMeta = meta;
        g.xSign = xSign;
        g.ySign = ySign;
        g.depth = Math.max(1, Math.min(WEBGPU_GRAPH_MAX_DEPTH, opts.depth | 0 || 1));   // G4 peel count
        // G2 canonical geometry. Anti-ideal corner = the canonical-min DOMAIN edges
        // (the CPU staircase caps at screen 0 / plotH = the worst-value edges). HV
        // reference R = cloud canonical-min corner − eps (matches computeHvContributions).
        const xd = opts.xDomain || [xMinS * xSign, xMaxS * xSign];
        const yd = opts.yDomain || [yMinS * ySign, yMaxS * ySign];
        const antiXC = Math.min(xd[0] * xSign, xd[1] * xSign);
        const antiYC = Math.min(yd[0] * ySign, yd[1] * ySign);
        const epsX = Math.max(1e-9, (xMaxS - xMinS) * 1e-6);
        const epsY = Math.max(1e-9, (yMaxS - yMinS) * 1e-6);
        g.RxC = (isFinite(xMinS) ? xMinS : 0) - epsX;
        g.RyC = (isFinite(yMinS) ? yMinS : 0) - epsY;
        g.antiXC = antiXC; g.antiYC = antiYC;
        // uStair / uHv compute uniforms (n, signs, anti or ref corner).
        const stU = new ArrayBuffer(32);
        new Uint32Array(stU, 0, 1)[0] = w;
        new Float32Array(stU, 4, 4).set([xSign, ySign, antiXC, antiYC]);
        this.device.queue.writeBuffer(g.uStair, 0, stU);
        const hvU = new ArrayBuffer(32);
        new Uint32Array(hvU, 0, 1)[0] = w;
        new Float32Array(hvU, 4, 4).set([xSign, ySign, g.RxC, g.RyC]);
        this.device.queue.writeBuffer(g.uHv, 0, hvU);
        // uGraphCol: stair line rgba, HV shade rgb, worst-mode front override (rgb, use).
        const sc = opts.stairColor || [0.06, 0.09, 0.16, 0.55];
        const hc = opts.hvColor || [0.0, 0.176, 0.447];
        const fo = opts.frontOverride || [0, 0, 0, 0];
        this.device.queue.writeBuffer(g.uGraphCol, 0, new Float32Array([
            sc[0], sc[1], sc[2], sc[3] ?? 0.55,
            hc[0], hc[1], hc[2], 0,
            fo[0], fo[1], fo[2], fo[3] ?? 0,
        ]));
        // The skyline runs HERE — i.e. only on scene-dirty frames, by
        // construction (this point is only reached when the key changed). The
        // submit lands on the queue BEFORE present()'s, so the same-frame cloud
        // draw vertex-pulls a settled bOnFront — even right after a grow (a
        // fresh zeroed buffer never reaches the rasterizer un-judged).
        this._computeGraphFrontier();
    };

    // G1: one encoder — skyline (O(n²) verdicts) → compact (count + indices) →
    // copy the compact result into a free staging buffer — then submit and hand
    // the staging buffer to the fire-and-forget readback. Separate compute
    // passes in one encoder serialize, so compact sees skyline's writes and the
    // copy sees compact's.
    P._computeGraphFrontier = function () {
        const g = this.graph;
        if (!g || !(g.count > 0)) return;
        const dev = this.device;
        // n as u32, signs as f32, originDrop pinned to 0 (static scene: an
        // uploaded (0,0) is real data, unlike the streaming engine's phantoms).
        const u = new ArrayBuffer(16);
        new Uint32Array(u, 0, 1)[0] = g.count;
        new Float32Array(u, 4, 3).set([g.xSign, g.ySign, 0]);
        dev.queue.writeBuffer(g.uSky, 0, u);
        dev.queue.writeBuffer(g.bCount, 0, new Uint32Array(4)); // K → 0
        // G2: reset the GPU-written draw args (a frame with K==0 must draw nothing).
        dev.queue.writeBuffer(g.bStairIndirect, 0, new Uint32Array([0, 1, 0, 0]));
        dev.queue.writeBuffer(g.bShadeIndirect, 0, new Uint32Array([0, 1, 0, 0]));
        dev.queue.writeBuffer(g.bHvScalar, 0, new Float32Array([0, 1]));
        const enc = dev.createCommandEncoder();
        const wg = Math.ceil(g.count / 64);
        const wgF = Math.ceil(WEBGPU_GRAPH_MAX_FRONT / 64);   // frontier passes self-guard by K
        for (const pipe of [this.pSceneSkyline, this.pSceneCompact]) {
            const cp = enc.beginComputePass();
            cp.setPipeline(pipe);
            cp.setBindGroup(0, g.skyBindGroup);
            cp.dispatchWorkgroups(wg);
            cp.end();
        }
        // G2 chain (same encoder, serialized): sort the frontier by canonical x, emit
        // the staircase + shade-fan draw args, then the HV passes — totalHv (1) →
        // per-rank leave-one-out contributions (K) → maxContrib (1) → per-dot radius (K).
        const pass = (pipe, bgKey, groups) => {
            const cp = enc.beginComputePass();
            cp.setPipeline(pipe); cp.setBindGroup(0, g[bgKey]); cp.dispatchWorkgroups(groups); cp.end();
        };
        pass(this.pSceneRanksort, "stairBindGroup", wgF);
        pass(this.pSceneEmit,     "stairBindGroup", wgF);
        pass(this.pSceneHvTotal,  "hvBindGroup", 1);
        pass(this.pSceneHvContrib,"hvBindGroup", wgF);
        pass(this.pSceneHvMax,    "hvBindGroup", 1);
        pass(this.pSceneHvRadius, "hvBindGroup", wgF);
        // G4: depth-layer peeling (only when requested). peelInit, then `depth`
        // (peelSky, peelMark) pairs — each pass over the whole cloud, serialized so
        // every dominance test sees the prior mark's settled peeled[]. layerOf[] is
        // the result (read back by the verify hook; rendered in the next phase).
        if (g.depth > 1) {
            // Write every layer's uniform slot up front (one submit, so all queue
            // writes precede the command buffer); pick the slot per pass via the
            // dynamic offset. peelInit reads slot 0 (only n is meaningful there).
            for (let L = 0; L < g.depth; L++) {
                const du = new ArrayBuffer(16);
                new Uint32Array(du, 0, 1)[0] = g.count;
                new Float32Array(du, 4, 2).set([g.xSign, g.ySign]);
                new Uint32Array(du, 12, 1)[0] = L;
                dev.queue.writeBuffer(g.uDepth, L * 256, du);
            }
            const dpass = (pipe, slot) => {
                const cp = enc.beginComputePass();
                cp.setPipeline(pipe); cp.setBindGroup(0, g.depthBindGroup, [slot * 256]);
                cp.dispatchWorkgroups(wg); cp.end();
            };
            dpass(this.pDepthInit, 0);
            for (let L = 0; L < g.depth; L++) { dpass(this.pDepthSky, L); dpass(this.pDepthMark, L); }
        }
        // Pick a free staging buffer (double-buffered: a still-mapped buffer
        // from a previous scene-dirty frame must not be re-targeted). At
        // scene-dirty cadence both being busy "can't happen" — latest-wins skip
        // if it somehow does; the next dirty frame re-reads.
        const si = !g.stagePending[0] ? 0 : !g.stagePending[1] ? 1 : -1;
        if (si >= 0) {
            if (!g.stage[si]) {
                g.stage[si] = dev.createBuffer({
                    size: 16 + WEBGPU_GRAPH_MAX_FRONT * 4,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            }
            enc.copyBufferToBuffer(g.bCount, 0, g.stage[si], 0, 16);
            enc.copyBufferToBuffer(g.bFrontIdx, 0, g.stage[si], 16, WEBGPU_GRAPH_MAX_FRONT * 4);
        }
        dev.queue.submit([enc.finish()]);
        if (si >= 0) this._readbackGraphFrontier(si, g.key);
    };

    // The readback contract (docs/rendering.md §G-track "Interaction"): a tiny
    // fire-and-forget mapAsync on scene-dirty frames only — render NEVER waits
    // on a map (per-frame mapAsync is the documented headless device-loss
    // trigger; this is the same one-shot risk class as the verify hooks).
    // In G1 the result only feeds state + verification (`g.front`); rewiring
    // cards/tooltip/quadtree onto it is the G5 convergence.
    P._readbackGraphFrontier = function (si, key) {
        const g = this.graph;
        g.stagePending[si] = true;
        g.stage[si].mapAsync(GPUMapMode.READ).then(() => {
            const buf = g.stage[si].getMappedRange();
            const count = Math.min(new Uint32Array(buf, 0, 1)[0], WEBGPU_GRAPH_MAX_FRONT);
            const indices = Array.from(new Uint32Array(buf, 16, count));
            g.stage[si].unmap();
            g.stagePending[si] = false;
            // Latest-wins: a stale map resolving after a newer scene upload must
            // not clobber it (keys are scene identities, so compare is exact).
            if (this.graph === g && g.key === key) {
                g.front = { count, indices, key };
                g.frontReads++;
            }
        }).catch(() => { g.stagePending[si] = false; });
    };

    // The per-refresh half of the contract: the affine data→px map (the D3 linear
    // scale collapsed to slope/intercept, margin folded in — see gpuScaleUniform)
    // plus the CSS-px viewport. 64 bytes, every refresh, and nothing else.
    P.writeSceneScale = function (xScale, yScale, margin, width, height, xSign, ySign) {
        const g = this.graph;
        if (!g || !g.uScene) return;
        const u = new Float32Array(16);
        u[0] = xScale(1) - xScale(0); u[1] = margin.left + xScale(0);
        u[2] = yScale(1) - yScale(0); u[3] = margin.top + yScale(0);
        u[4] = width; u[5] = height; u[6] = this.dpr; u[7] = 0;
        // sgn row: filled since G1. The cloud shader doesn't read it (the
        // skyline gets signs via its own uSky — they're scene identity, not
        // view), but G2's HV shade orients its quadrant from here.
        u[8] = xSign ?? 1; u[9] = ySign ?? 1;
        // corn row = (antiX, antiY, idealX, idealY) in FULL pixel space (margin folded
        // in, matching the affine output) — the HV shade fragment projects onto the
        // ideal→anti axis for its gradient t. Plot edges from the D3 scale ranges:
        // xScale.range() = [0, plotW], yScale.range() = [plotH, 0].
        const sx = xSign ?? 1, sy = ySign ?? 1;
        const plotW = xScale.range()[1] - xScale.range()[0];
        const plotH = yScale.range()[0] - yScale.range()[1];
        u[12] = margin.left + (sx > 0 ? 0 : plotW);      // antiX
        u[13] = margin.top + (sy > 0 ? plotH : 0);       // antiY
        u[14] = margin.left + (sx > 0 ? plotW : 0);      // idealX
        u[15] = margin.top + (sy > 0 ? 0 : plotH);       // idealY
        this.device.queue.writeBuffer(g.uScene, 0, u);
    };

    // Called from present() via the one-line optional-chained hook, right after
    // the pixel-space bg instances draw — the scene cloud occupies the same
    // background layer (under trails / heads / frontier dots). Restores pPoints
    // because present()'s later drawPts calls assume it's still bound.
    P._drawGraphScene = function (rp) {
        const g = this.graph;
        if (!g || !(g.count > 0)) return;
        rp.setPipeline(this.pSceneCloud);
        rp.setBindGroup(0, g.bindGroup);
        rp.draw(6, g.count);
        rp.setPipeline(this.pPoints);
    };

    // G2: the HV shade — drawn BEFORE the scene cloud so the dominated-region fill
    // sits UNDER the dots (matching the SVG order: shade, then cloud, then dots). The
    // fan vertex count came from the GPU (bShadeIndirect), so a K==0 frame draws nothing.
    P._drawGraphShade = function (rp) {
        const g = this.graph;
        if (!g || !(g.count > 0) || !g.bShadeIndirect) return;
        rp.setPipeline(this.pSceneHvShade);
        rp.setBindGroup(0, g.hvShadeBindGroup);
        rp.drawIndirect(g.bShadeIndirect, 0);
        rp.setPipeline(this.pPoints);
    };

    // G2: the on-top overlays — the red/purple staircase line (drawIndirect, vertex
    // count from emit) then the GPU frontier dots (HV-sized, white-ringed; non-front
    // instances degenerate). Drawn AFTER the cloud + heads, mirroring drawFrontierDots.
    P._drawGraphOverlays = function (rp) {
        const g = this.graph;
        if (!g || !(g.count > 0)) return;
        rp.setPipeline(this.pSceneStairLine);
        rp.setBindGroup(0, g.stairLineBindGroup);
        rp.drawIndirect(g.bStairIndirect, 0);
        rp.setPipeline(this.pSceneFront);
        rp.setBindGroup(0, g.frontBindGroup);
        rp.draw(6, g.count);
        rp.setPipeline(this.pPoints);
    };

    // G3: the glyph text — drawn LAST in present() (on top of everything). Tick labels
    // + frontier names; halo+fill glyph instances composite via the premultiplied blend.
    P._drawGraphText = function (rp) {
        const g = this.graph;
        if (!g || !(g.glyphCount > 0) || !g.glyphBindGroup) return;
        rp.setPipeline(this.pSceneGlyph);
        rp.setBindGroup(0, g.glyphBindGroup);
        rp.draw(6, g.glyphCount);
        rp.setPipeline(this.pPoints);
    };

    // Drop the scene (clear() and any frame that leaves the gpuGraph path).
    // Buffers stay allocated — only the count/key reset, so re-entering the path
    // with the same identity still re-uploads (the key is gone) but without a
    // re-allocation. Cheap and unconditionally safe to call.
    P._clearGraphScene = function () {
        const g = this.graph;
        if (!g) return;
        g.count = 0;
        g.key = null;
        g.front = null;   // a keyed readback result must not outlive its scene
        g.glyphCount = 0; // text must vanish when leaving the path
    };

    // destroy() hook: free the GPU objects with the renderer (device swap /
    // device loss). Mirrors _destroyEvt.
    P._destroyGraph = function () {
        const g = this.graph;
        if (!g) return;
        for (const k of ["bPos", "bCol", "bSize", "uScene",
                         "bOnFront", "bFrontIdx", "bCount", "uSky",
                         "bFrontSorted", "bFrontSortedIdx", "bStaircase", "bStairIndirect",
                         "bShadeIndirect", "bHv", "bFrontRadius", "bHvScalar",
                         "uStair", "uHv", "uGraphCol", "bGlyph",
                         "bPeeled", "bLayerOf", "bOnTmp", "uDepth"]) g[k]?.destroy();
        for (const s of g.stage || []) s?.destroy();
        this.glyphTex?.destroy(); this.glyphTex = null; this.glyph = null;
        this.graph = null;
    };

    // ── G0 verification (one-shot, never in the render loop) ────────────────
    // The invariant pair from the design doc's G0 gate:
    //   dotCount   — instances the GPU will draw == finite points the CPU sent
    //                (compared against window.__bl2d_gpuGraphN by the caller);
    //   posMis     — GPU buffer readback != the JS-side copy at any float ⇒ the
    //                upload path corrupted data (expects EXACT equality: the
    //                bytes are copied, never transformed).
    // `uploads` lets the harness assert retention: refresh twice with the same
    // identity ⇒ uploads stays at 1 (the second refresh only wrote uScene).
    // G1 adds three invariants on top:
    //   skylineMis — GPU onFront[] vs a JS brute-force strict-dominance reference
    //                computed over the SAME f32 data (cpuPos) with the same signs.
    //                Expect 0; any mismatch means the shader or signs diverged.
    //   frontMis   — the READBACK set (bCount+bFrontIdx via g.front) vs the CPU
    //                sweep that feeds the sidebar cards (__bl2d_frontierXY),
    //                compared as a frounded-(x,y) multiset. This is the phase
    //                gate's "readback set == cards" — by provenance, frontierXY
    //                comes from the very `frontier` array renderFrontierCards
    //                received. -1 = readback not landed yet (mapAsync pending).
    //   frontReads — retention: 1 after any number of identity-preserving
    //                redraws (the skyline only ran on the scene-dirty frame).
    window.__bl2d_verifyGraph = async () => {
        if (!(pointRenderer instanceof WebGPURenderer)) return null;
        const g = pointRenderer.graph;
        if (!g || !(g.count > 0)) return null;
        const gpuPos = await pointRenderer._readback(g.bPos, g.count * 8, Float32Array);
        let posMis = 0, maxAbs = 0;
        for (let i = 0; i < g.count * 2; i++) {
            const d = Math.abs(gpuPos[i] - g.cpuPos[i]);
            if (d > 0) { posMis++; if (d > maxAbs) maxAbs = d; }
        }
        // JS brute-force reference over the f32 copy — O(n²), one-shot only.
        const gpuFront = await pointRenderer._readback(g.bOnFront, g.count * 4, Uint32Array);
        const n = g.count, fp = g.cpuPos, sx = g.xSign, sy = g.ySign;
        let skylineMis = 0, refFrontSize = 0;
        for (let i = 0; i < n; i++) {
            const xi = fp[i * 2] * sx, yi = fp[i * 2 + 1] * sy;
            let dom = 0;
            for (let j = 0; j < n; j++) {
                const xj = fp[j * 2] * sx, yj = fp[j * 2 + 1] * sy;
                if (xj >= xi && yj >= yi && (xj > xi || yj > yi)) { dom = 1; break; }
            }
            if (!dom) refFrontSize++;
            if ((gpuFront[i] !== 0 ? 1 : 0) !== (dom ? 0 : 1)) skylineMis++;
        }
        // Readback set vs the cards' frontier, as a frounded-(x,y) multiset
        // (fround both sides: the GPU saw f32, the cards hold f64).
        let frontMis = -1, frontCount = null, cardPidsMatch = null;
        if (g.front && g.front.key === g.key && window.__bl2d_frontierXY) {
            frontCount = g.front.count;
            const tally = (keys) => { const m = new Map(); for (const k of keys) m.set(k, (m.get(k) || 0) + 1); return m; };
            const kOf = (x, y) => Math.fround(x) + "|" + Math.fround(y);
            const gotM = tally(g.front.indices.map(i => kOf(g.cpuMeta[i].x, g.cpuMeta[i].y)));
            const refM = tally(window.__bl2d_frontierXY.map(([x, y]) => kOf(x, y)));
            frontMis = 0;
            for (const [k, v] of refM) frontMis += Math.abs(v - (gotM.get(k) || 0));
            for (const [k, v] of gotM) if (!refM.has(k)) frontMis += v;
            // pid-level reconciliation (set compare: dedup may keep a different
            // equal-(x,y) object than the sweep, but G1 uploads the same unique
            // array the sweep ran on, so pids should agree exactly).
            const gotPids = new Set(g.front.indices.map(i => g.cpuMeta[i].playerID));
            const refPids = new Set(window.__bl2d_frontierPids || []);
            cardPidsMatch = gotPids.size === refPids.size &&
                [...refPids].every(p => gotPids.has(p));
        }

        // ── G2 invariants: staircase vertex count, HV contributions, dot radii, shade
        // quadrant. The HV oracle is an f32 re-sweep over g.cpuPos (NOT the f64
        // computeHvContributions) so it matches the GPU's f32 arithmetic exactly — the
        // same provenance trick skylineMis uses; we also report the rel error vs the
        // f64 sidebar numbers for sanity. Driven by the GPU's OWN rank order
        // (bFrontSortedIdx) so rank r in bHv lines up with the JS oracle.
        let stairVertMis = -1, hvMis = -1, hvMaxRel = -1, radiusMis = -1, shadeQuadrant = null;
        if (g.front && g.front.key === g.key && g.count > 0) {
            const K = g.front.count;
            const stairCount = (await pointRenderer._readback(g.bStairIndirect, 16, Uint32Array))[0];
            stairVertMis = Math.abs(stairCount - (1 + 2 * K));
            const sortedIdx = await pointRenderer._readback(g.bFrontSortedIdx, K * 4, Uint32Array);
            const gpuHv = await pointRenderer._readback(g.bHv, K * 4, Float32Array);
            const gpuRad = await pointRenderer._readback(g.bFrontRadius, g.count * 4, Float32Array);
            const fp = g.cpuPos, nn = g.count, sgx = g.xSign, sgy = g.ySign, RxC = g.RxC, RyC = g.RyC;
            const hvOfStack = (st) => { let hv = 0, xp = RxC; for (const p of st) { hv += (p[0] - xp) * (p[1] - RyC); xp = p[0]; } return hv; };
            const sweepExcl = (skip) => {
                const st = [];
                for (let i = 0; i < nn; i++) {
                    if (i === skip) continue;
                    const X = Math.fround(fp[i * 2] * sgx), Y = Math.fround(fp[i * 2 + 1] * sgy);
                    while (st.length && st[st.length - 1][1] < Y) st.pop();
                    if (st.length && st[st.length - 1][1] === Y && st[st.length - 1][0] < X) st.pop();
                    st.push([X, Y]);
                }
                return st;
            };
            const totalJs = hvOfStack(sweepExcl(-1));
            const contribJs = new Float64Array(K);
            for (let r = 0; r < K; r++) contribJs[r] = totalJs - hvOfStack(sweepExcl(sortedIdx[r]));
            let maxJs = 0; for (let r = 0; r < K; r++) maxJs = Math.max(maxJs, contribJs[r]);
            if (maxJs <= 0) maxJs = 1;
            hvMis = 0; hvMaxRel = 0; radiusMis = 0;
            const R_MIN = WEBGPU_GRAPH_R_MIN, R_MAX = WEBGPU_GRAPH_R_MAX;
            for (let r = 0; r < K; r++) {
                const c = Math.max(contribJs[r], 0);
                // Accuracy normalized by maxContrib — the quantity the dot radius actually
                // consumes (radius = R_MIN + Δ·sqrt(contrib/max)). A RAW relative error is
                // meaningless for near-zero contributions (radius is R_MIN either way), and
                // a contribution is total−alt of two large HV areas, so f32 cancellation is
                // unavoidable (the JS oracle accumulates in f64). 1e-3 of the dynamic range
                // is the f32-realistic floor; radiusMis below is the authoritative visual gate.
                const rel = Math.abs(gpuHv[r] - c) / maxJs;
                if (rel > 1e-3) hvMis++;
                if (rel > hvMaxRel) hvMaxRel = rel;
                const cpuRad = R_MIN + (R_MAX - R_MIN) * Math.sqrt(c / maxJs);
                if (Math.abs(gpuRad[sortedIdx[r]] - cpuRad) > 1e-3) radiusMis++;
            }
            // Shade quadrant: the anti-ideal corner must be the canonical MINIMUM corner
            // (≤ every frontier point in canonical space) — flips correctly with signs.
            shadeQuadrant = true;
            for (const idx of g.front.indices) {
                const X = g.cpuMeta[idx].x * sgx, Y = g.cpuMeta[idx].y * sgy;
                if (g.antiXC > X + 1e-6 || g.antiYC > Y + 1e-6) shadeQuadrant = false;
            }
        }

        // ── G3 invariants: glyph instances, tick strings, atlas coverage. All CPU-side
        // (no GPU readback): the instance count vs the ideal Σ-codepoints (×2 for halo'd
        // labels), the GPU tick strings vs d3's default format, and every requested
        // codepoint present in the atlas (no .notdef).
        let glyphMis = -1, tickMis = -1, atlasMissing = -1, glyphCount = g.glyphCount || 0;
        let glyphUploadPath = pointRenderer.glyph?.uploadPath ?? null;
        let atlasW = pointRenderer.glyph?.w ?? null, atlasH = pointRenderer.glyph?.h ?? null;
        if (g.glyphCount > 0) {
            const txt = window.__bl2d_gpuGraphText;
            glyphMis = txt ? Math.abs(g.glyphCount - txt.expected) : -1;
            // Tick strings: re-derive d3's default format over the live scales and compare.
            const tk = window.__bl2d_gpuGraphTicks;
            if (tk && window.__bl2d_liveScales) {
                const { xScale, yScale, nx, ny } = window.__bl2d_liveScales;
                const rx = xScale.ticks(nx).map(xScale.tickFormat(nx));
                const ry = yScale.ticks(ny).map(yScale.tickFormat(ny));
                tickMis = 0;
                if (rx.length !== tk.x.length || ry.length !== tk.y.length) tickMis = 999;
                else { for (let i = 0; i < rx.length; i++) if (rx[i] !== tk.x[i]) tickMis++;
                       for (let i = 0; i < ry.length; i++) if (ry[i] !== tk.y[i]) tickMis++; }
            }
            // Atlas coverage: every codepoint in the uploaded charset has a (variant-0) cell.
            const cs = g.glyphCharset || "";
            atlasMissing = 0;
            const met = pointRenderer.glyph?.metrics;
            for (const ch of new Set(Array.from(cs)))
                if (!met || !met.has(ch.codePointAt(0))) atlasMissing++;
        }

        // ── G4 invariant: GPU onion-peel layer sizes == the CPU oracle. Read layerOf[]
        // back, tally points per layer 0..depth-1, and compare to __bl2d_depthLayers
        // (script.js paretoLayers). depthMis -1 when depth==1 (no peeling requested).
        let depthMis = -1, depthLayersGpu = null;
        if (g.depth > 1) {
            const lo = await pointRenderer._readback(g.bLayerOf, g.count * 4, Uint32Array);
            depthLayersGpu = new Array(g.depth).fill(0);
            for (let i = 0; i < g.count; i++) { const L = lo[i]; if (L < g.depth) depthLayersGpu[L]++; }
            const cpu = window.__bl2d_depthLayers || [];
            depthMis = Math.abs(depthLayersGpu.length - cpu.length);
            for (let L = 0; L < g.depth; L++) depthMis += Math.abs((depthLayersGpu[L] || 0) - (cpu[L] || 0));
        }

        return {
            dotCount: g.count,
            expectedN: window.__bl2d_gpuGraphN ?? null,
            posMis, maxAbs,
            skylineMis, refFrontSize,
            frontMis, frontCount, cardPidsMatch,
            stairVertMis, hvMis, hvMaxRel, radiusMis, shadeQuadrant,
            glyphCount, glyphMis, tickMis, atlasMissing, glyphUploadPath, atlasW, atlasH,
            depthMis, depthLayersGpu, depth: g.depth,
            frontReads: g.frontReads,
            uploads: g.uploads,
            key: g.key,
        };
    };
    window.__bl2d_graphMode = () =>
        pointRenderer instanceof WebGPURenderer && !!pointRenderer.graphMode;
})();
