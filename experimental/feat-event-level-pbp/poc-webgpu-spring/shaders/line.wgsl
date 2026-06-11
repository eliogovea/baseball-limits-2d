// ── line.wgsl — the Pareto-frontier STAIRCASE ───────────────────────────────────
// Same vertex-pull idea as points.wgsl, but for a line. The CPU/WASM frontier code emits
// the step-function vertices (in raw HR/SB units) into the `staircase` storage buffer;
// this shader pulls vertex vi, maps it to clip space with the SAME axis maxima the points
// use (so the line sits exactly on the cloud), and the pipeline draws them as a
// line-strip (each vertex connected to the next). The reason it's a separate pipeline
// from points.wgsl is purely the primitive topology: line-strip vs triangle-list.
// (Port of poc-vulkan/shaders/line.vert + line.frag.)
struct Params { maxX: f32, maxY: f32, ptSize: f32, aspect: f32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> staircase: array<vec2<f32>>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    let p = staircase[vi];                              // (HR, SB) of this staircase vertex
    let x = (p.x / max(P.maxX, 1.0)) * 1.9 - 0.95;      // identical mapping to points.wgsl → they align
    let y = (p.y / max(P.maxY, 1.0)) * 1.9 - 0.95;
    return vec4<f32>(x, y, 0.0, 1.0);   // WebGPU NDC is +Y up (no flip)
}

@fragment
fn fs() -> @location(0) vec4<f32> {
    return vec4<f32>(0.85, 0.12, 0.20, 1.0);            // constant MLB red — the frontier line
}
