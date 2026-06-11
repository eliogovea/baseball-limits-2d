// ── points.wgsl — the point cloud, rendered by VERTEX PULL ──────────────────────
// The big idea: there is NO vertex buffer of positions. We issue one instanced draw of
// `playerCount` instances; for each instance the GPU hands the vertex shader its
// instance_index, and we use that index to READ the player's (HR, SB) totals straight
// out of the storage buffers the compute pass (accumulate.wgsl) just wrote. The data
// never leaves the GPU between accumulate and draw — that's the whole performance win.
//
// WebGPU has no round-point primitive and no gl_PointSize, so each point is drawn as a
// small QUAD (two triangles = 6 vertices) and the fragment shader carves a disc out of it
// by discarding the corners. (Port of poc-vulkan/shaders/points.vert + points.frag.)
//
// Bindings (group 0) — the @binding numbers must match the JS bind-group layout exactly:
//   0 P        uniform   per-frame constants (axis maxima, point size, aspect ratio)
//   1 hr       storage   per-player HR counter  (written by the compute pass, READ here)
//   2 sb       storage   per-player SB counter
//   3 debut    storage   per-player debut year  (drives the era colour; static)
//   4 onFront  storage   per-player frontier flag (CPU writes it from the JS frontier)
struct Params { maxX: f32, maxY: f32, ptSize: f32, aspect: f32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> hr: array<u32>;
@group(0) @binding(2) var<storage, read> sb: array<u32>;
@group(0) @binding(3) var<storage, read> debut: array<u32>;
@group(0) @binding(4) var<storage, read> onFront: array<u32>;

// What the vertex shader passes to the fragment shader, interpolated across the quad.
// `quad` is the corner offset in [-1,1]² — the fragment uses it for the disc test.
struct VSOut {
    @builtin(position) pos: vec4<f32>,   // clip-space position (required)
    @location(0) color: vec3<f32>,
    @location(1) quad: vec2<f32>,
};

// Era ramp: old (1871) blue → mid gold → new (2025) red. A two-segment lerp on the
// debut year normalised to [0,1] — purely cosmetic (encodes WHEN a player debuted).
fn eraColor(yr: f32) -> vec3<f32> {
    let t = clamp((yr - 1871.0) / (2025.0 - 1871.0), 0.0, 1.0);
    let blue = vec3<f32>(0.20, 0.40, 0.90);
    let gold = vec3<f32>(0.95, 0.78, 0.20);
    let red  = vec3<f32>(0.88, 0.20, 0.20);
    if (t < 0.5) { return mix(blue, gold, t * 2.0); }
    return mix(gold, red, (t - 0.5) * 2.0);
}

// The 6 corners of the unit quad as two triangles (tri 1: BL,BR,TL; tri 2: TL,BR,TR).
// vertex_index (0..5) indexes this; instance_index picks the player. Drawn as draw(6, N).
const CORNERS = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>(1.0, -1.0), vec2<f32>( 1.0, 1.0),
);

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
    let idx = ii;                       // instance index == player index (vertex pull)
    // Map the player's counter to clip space. NDC is [-1,1]; we target [-0.95, 0.95]
    // (a 5% margin so a record-holder at the axis maximum isn't clipped at the edge).
    // WebGPU NDC is +Y up, so a high SB maps to a high y with NO flip — unlike poc-vulkan,
    // whose Vulkan NDC is +Y down and needs an explicit flip in points.vert.
    let x = (f32(hr[idx]) / max(P.maxX, 1.0)) * 1.9 - 0.95;   // max(...,1) guards divide-by-zero before any events
    let y = (f32(sb[idx]) / max(P.maxY, 1.0)) * 1.9 - 0.95;
    let onF = onFront[idx] != 0u;
    let sz = select(P.ptSize, P.ptSize * 1.7, onF);   // frontier points 1.7× bigger (select(false,true,cond))
    let corner = CORNERS[vi];
    var out: VSOut;
    // Place the corner: centre + corner·size. Divide the X offset by the aspect ratio so
    // the quad is square in PIXELS (not in NDC) on a wide viewport → the disc stays round.
    out.pos = vec4<f32>(x + corner.x * sz / P.aspect, y + corner.y * sz, 0.0, 1.0);
    out.quad = corner;
    if (onF) { out.color = vec3<f32>(0.78, 0.06, 0.18); }    // MLB red for frontier
    else     { out.color = eraColor(f32(debut[idx])) * 0.55; } // dimmed era colour for the cloud
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
    // Disc test: `quad` is the interpolated corner offset; its length is the distance from
    // the quad centre in [0..√2]. Discard everything outside the unit circle → a round dot
    // from a square quad. (dot(v,v) = |v|²; compare to 1² to avoid a sqrt.)
    if (dot(in.quad, in.quad) > 1.0) { discard; }
    return vec4<f32>(in.color, 1.0);
}
