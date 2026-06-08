// Vertex-pull point cloud. instance_index is the point index; we read its
// accumulated (HR, SB) counters straight from the buffers the compute shader
// maintains, map to clip space, and colour by debut era. Frontier points
// (onFront) are MLB red and larger; the rest are dimmed era colours.
//
// WebGPU has no point primitive / gl_PointSize, so each point is an instanced
// quad (6 verts) and the fragment does the round-disc test. (Port of
// poc-vulkan/shaders/points.vert + points.frag.)
struct Params { maxX: f32, maxY: f32, ptSize: f32, aspect: f32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> hr: array<u32>;
@group(0) @binding(2) var<storage, read> sb: array<u32>;
@group(0) @binding(3) var<storage, read> debut: array<u32>;
@group(0) @binding(4) var<storage, read> onFront: array<u32>;

struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) color: vec3<f32>,
    @location(1) quad: vec2<f32>,
};

// Old (1871) blue -> mid gold -> new (2025) red.
fn eraColor(yr: f32) -> vec3<f32> {
    let t = clamp((yr - 1871.0) / (2025.0 - 1871.0), 0.0, 1.0);
    let blue = vec3<f32>(0.20, 0.40, 0.90);
    let gold = vec3<f32>(0.95, 0.78, 0.20);
    let red  = vec3<f32>(0.88, 0.20, 0.20);
    if (t < 0.5) { return mix(blue, gold, t * 2.0); }
    return mix(gold, red, (t - 0.5) * 2.0);
}

const CORNERS = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>(1.0, -1.0), vec2<f32>( 1.0, 1.0),
);

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
    let idx = ii;
    // [0, max] -> [-0.95, 0.95] (small margin so axis-maxima points aren't
    // clipped). WebGPU NDC is +Y up, so high SB is high y (no flip — unlike
    // poc-vulkan's Vulkan-flipped Y).
    let x = (f32(hr[idx]) / max(P.maxX, 1.0)) * 1.9 - 0.95;
    let y = (f32(sb[idx]) / max(P.maxY, 1.0)) * 1.9 - 0.95;
    let onF = onFront[idx] != 0u;
    let sz = select(P.ptSize, P.ptSize * 1.7, onF);
    let corner = CORNERS[vi];
    var out: VSOut;
    // divide the x-offset by aspect so the disc stays round on a wide viewport.
    out.pos = vec4<f32>(x + corner.x * sz / P.aspect, y + corner.y * sz, 0.0, 1.0);
    out.quad = corner;
    if (onF) { out.color = vec3<f32>(0.78, 0.06, 0.18); }
    else     { out.color = eraColor(f32(debut[idx])) * 0.55; }
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
    if (dot(in.quad, in.quad) > 1.0) { discard; }
    return vec4<f32>(in.color, 1.0);
}
