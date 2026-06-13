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
        let w = 0;
        for (let k = 0; k < n; k++) {
            const d = points[k];
            const x = d.x, y = d.y;
            if (!isFinite(x) || !isFinite(y)) continue;
            posArr[w * 2] = x; posArr[w * 2 + 1] = y;
            colArr[w] = packColorRGBA(fillFor(d), alpha);
            sizeArr[w] = radius;
            meta[w] = { x, y, playerID: d.playerID, year: d.year ?? d.yearID };
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
        const oldPos = g.bPos, oldCol = g.bCol, oldSize = g.bSize, oldFront = g.bOnFront;
        g.bPos = ensure(g.bPos, w * 8);
        g.bCol = ensure(g.bCol, w * 4);
        g.bSize = ensure(g.bSize, w * 4);
        g.bOnFront = ensure(g.bOnFront, w * 4);
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
        }
        const grew = g.bPos !== oldPos || g.bCol !== oldCol || g.bSize !== oldSize ||
                     g.bOnFront !== oldFront;
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
        }
        g.count = w;
        g.key = opts.key;
        g.uploads++;                          // verify hook asserts this stays put across re-renders
        g.cpuPos = posArr.subarray(0, w * 2); // JS-side copy for the G0 readback invariant
        g.cpuMeta = meta;
        g.xSign = opts.xSign ?? 1;
        g.ySign = opts.ySign ?? 1;
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
        const enc = dev.createCommandEncoder();
        const wg = Math.ceil(g.count / 64);
        for (const pipe of [this.pSceneSkyline, this.pSceneCompact]) {
            const cp = enc.beginComputePass();
            cp.setPipeline(pipe);
            cp.setBindGroup(0, g.skyBindGroup);
            cp.dispatchWorkgroups(wg);
            cp.end();
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
        // u[12..15] = corn row: zeroed until G2 writes the shade corners.
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
    };

    // destroy() hook: free the GPU objects with the renderer (device swap /
    // device loss). Mirrors _destroyEvt.
    P._destroyGraph = function () {
        const g = this.graph;
        if (!g) return;
        for (const k of ["bPos", "bCol", "bSize", "uScene",
                         "bOnFront", "bFrontIdx", "bCount", "uSky"]) g[k]?.destroy();
        for (const s of g.stage || []) s?.destroy();
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
        return {
            dotCount: g.count,
            expectedN: window.__bl2d_gpuGraphN ?? null,
            posMis, maxAbs,
            skylineMis, refFrontSize,
            frontMis, frontCount, cardPidsMatch,
            frontReads: g.frontReads,
            uploads: g.uploads,
            key: g.key,
        };
    };
    window.__bl2d_graphMode = () =>
        pointRenderer instanceof WebGPURenderer && !!pointRenderer.graphMode;
})();
