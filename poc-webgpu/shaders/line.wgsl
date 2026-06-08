// Draws the Pareto-frontier staircase. The CPU (WASM) writes the step-function
// vertices (already in HR/SB units) into staircase[]; we pull them by index and
// map to clip space with the same axis maxima the points use. Drawn as a
// line-strip in MLB red. (Port of poc-vulkan/shaders/line.vert + line.frag.)
struct Params { maxX: f32, maxY: f32, ptSize: f32, aspect: f32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> staircase: array<vec2<f32>>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    let p = staircase[vi];
    let x = (p.x / max(P.maxX, 1.0)) * 1.9 - 0.95;
    let y = (p.y / max(P.maxY, 1.0)) * 1.9 - 0.95;
    return vec4<f32>(x, y, 0.0, 1.0);   // WebGPU NDC is +Y up (no flip)
}

@fragment
fn fs() -> @location(0) vec4<f32> {
    return vec4<f32>(0.85, 0.12, 0.20, 1.0);
}
