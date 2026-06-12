// ─────────────────────────────────────────────────────────────────────────────
// webgpu-graph.js — the G-track: full-GPU rendering of the STATIC chart.
// Phase G0: a retained-scene dot renderer (docs/webgpu-graph-render-design.md).
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
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
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
        ] });
        const mod = dev.createShaderModule({ code: WEBGPU_SCENECLOUD_WGSL });
        this.pSceneCloud = dev.createRenderPipeline({
            layout: dev.createPipelineLayout({ bindGroupLayouts: [this.sceneBgl] }),
            vertex: { module: mod, entryPoint: "vs" },
            fragment: { module: mod, entryPoint: "fs", targets: [{ format: this.format, blend }] },
            primitive: { topology: "triangle-list" } });
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
        let w = 0;
        for (let k = 0; k < n; k++) {
            const d = points[k];
            const x = d.x, y = d.y;
            if (!isFinite(x) || !isFinite(y)) continue;
            posArr[w * 2] = x; posArr[w * 2 + 1] = y;
            colArr[w] = packColorRGBA(fillFor(d), alpha);
            sizeArr[w] = radius;
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
        const oldPos = g.bPos, oldCol = g.bCol, oldSize = g.bSize;
        g.bPos = ensure(g.bPos, w * 8);
        g.bCol = ensure(g.bCol, w * 4);
        g.bSize = ensure(g.bSize, w * 4);
        const grew = g.bPos !== oldPos || g.bCol !== oldCol || g.bSize !== oldSize;
        if (w > 0) {
            this.device.queue.writeBuffer(g.bPos, 0, posArr, 0, w * 2);
            this.device.queue.writeBuffer(g.bCol, 0, colArr, 0, w);
            this.device.queue.writeBuffer(g.bSize, 0, sizeArr, 0, w);
        }
        // Bind group only rebuilds when a buffer object was replaced (grew) —
        // writeBuffer into an existing buffer keeps the old bind group valid.
        if (grew || !g.bindGroup) {
            g.bindGroup = this.device.createBindGroup({ layout: this.sceneBgl, entries: [
                { binding: 0, resource: { buffer: g.uScene } },
                { binding: 1, resource: { buffer: g.bPos } },
                { binding: 2, resource: { buffer: g.bCol } },
                { binding: 3, resource: { buffer: g.bSize } },
            ] });
        }
        g.count = w;
        g.key = opts.key;
        g.uploads++;                          // verify hook asserts this stays put across re-renders
        g.cpuPos = posArr.subarray(0, w * 2); // JS-side copy for the G0 readback invariant
    };

    // The per-refresh half of the contract: the affine data→px map (the D3 linear
    // scale collapsed to slope/intercept, margin folded in — see gpuScaleUniform)
    // plus the CSS-px viewport. 64 bytes, every refresh, and nothing else.
    P.writeSceneScale = function (xScale, yScale, margin, width, height) {
        const g = this.graph;
        if (!g || !g.uScene) return;
        const u = new Float32Array(16);
        u[0] = xScale(1) - xScale(0); u[1] = margin.left + xScale(0);
        u[2] = yScale(1) - yScale(0); u[3] = margin.top + yScale(0);
        u[4] = width; u[5] = height; u[6] = this.dpr; u[7] = 0;
        // u[8..15] = sgn + corn rows: zeroed until G1 (sign-aware skyline) / G2
        // (HV shade corners) start writing them.
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
    };

    // destroy() hook: free the GPU objects with the renderer (device swap /
    // device loss). Mirrors _destroyEvt.
    P._destroyGraph = function () {
        const g = this.graph;
        if (!g) return;
        for (const k of ["bPos", "bCol", "bSize", "uScene"]) g[k]?.destroy();
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
        return {
            dotCount: g.count,
            expectedN: window.__bl2d_gpuGraphN ?? null,
            posMis, maxAbs,
            uploads: g.uploads,
            key: g.key,
        };
    };
    window.__bl2d_graphMode = () =>
        pointRenderer instanceof WebGPURenderer && !!pointRenderer.graphMode;
})();
