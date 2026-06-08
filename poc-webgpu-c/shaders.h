// WGSL shaders as C strings (same sources as poc-webgpu/shaders/*.wgsl, with
// WebGPU's +Y-up convention). Inlined so the all-C build needs no fetch.
#ifndef SHADERS_H
#define SHADERS_H

static const char *ACCUMULATE_WGSL =
"struct Win { lo: u32, count: u32 };\n"
"@group(0) @binding(0) var<uniform> W: Win;\n"
"@group(0) @binding(1) var<storage, read>       events: array<u32>;\n"
"@group(0) @binding(2) var<storage, read_write> hr: array<atomic<u32>>;\n"
"@group(0) @binding(3) var<storage, read_write> sb: array<atomic<u32>>;\n"
"@compute @workgroup_size(64)\n"
"fn main(@builtin(global_invocation_id) gid: vec3<u32>) {\n"
"    let g = gid.x;\n"
"    if (g >= W.count) { return; }\n"
"    let e = (W.lo + g) * 3u;\n"
"    let player = events[e + 0u];\n"
"    let stat   = events[e + 1u];\n"
"    let cnt    = events[e + 2u];\n"
"    if (stat == 0u) { atomicAdd(&hr[player], cnt); }\n"
"    else            { atomicAdd(&sb[player], cnt); }\n"
"}\n";

static const char *POINTS_WGSL =
"struct Params { maxX: f32, maxY: f32, ptSize: f32, aspect: f32 };\n"
"@group(0) @binding(0) var<uniform> P: Params;\n"
"@group(0) @binding(1) var<storage, read> hr: array<u32>;\n"
"@group(0) @binding(2) var<storage, read> sb: array<u32>;\n"
"@group(0) @binding(3) var<storage, read> debut: array<u32>;\n"
"@group(0) @binding(4) var<storage, read> onFront: array<u32>;\n"
"struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) color: vec3<f32>, @location(1) quad: vec2<f32> };\n"
"fn eraColor(yr: f32) -> vec3<f32> {\n"
"    let t = clamp((yr - 1871.0) / (2025.0 - 1871.0), 0.0, 1.0);\n"
"    let blue = vec3<f32>(0.20, 0.40, 0.90); let gold = vec3<f32>(0.95, 0.78, 0.20); let red = vec3<f32>(0.88, 0.20, 0.20);\n"
"    if (t < 0.5) { return mix(blue, gold, t * 2.0); }\n"
"    return mix(gold, red, (t - 0.5) * 2.0);\n"
"}\n"
"const CORNERS = array<vec2<f32>, 6>(vec2<f32>(-1.0,-1.0), vec2<f32>(1.0,-1.0), vec2<f32>(-1.0,1.0), vec2<f32>(-1.0,1.0), vec2<f32>(1.0,-1.0), vec2<f32>(1.0,1.0));\n"
"@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {\n"
"    let idx = ii;\n"
"    let x = (f32(hr[idx]) / max(P.maxX, 1.0)) * 1.9 - 0.95;\n"
"    let y = (f32(sb[idx]) / max(P.maxY, 1.0)) * 1.9 - 0.95;\n"
"    let onF = onFront[idx] != 0u;\n"
"    let sz = select(P.ptSize, P.ptSize * 1.7, onF);\n"
"    let corner = CORNERS[vi];\n"
"    var out: VSOut;\n"
"    out.pos = vec4<f32>(x + corner.x * sz / P.aspect, y + corner.y * sz, 0.0, 1.0);\n"
"    out.quad = corner;\n"
"    if (onF) { out.color = vec3<f32>(0.78, 0.06, 0.18); } else { out.color = eraColor(f32(debut[idx])) * 0.55; }\n"
"    return out;\n"
"}\n"
"@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {\n"
"    if (dot(in.quad, in.quad) > 1.0) { discard; }\n"
"    return vec4<f32>(in.color, 1.0);\n"
"}\n";

static const char *LINE_WGSL =
"struct Params { maxX: f32, maxY: f32, ptSize: f32, aspect: f32 };\n"
"@group(0) @binding(0) var<uniform> P: Params;\n"
"@group(0) @binding(1) var<storage, read> staircase: array<vec2<f32>>;\n"
"@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {\n"
"    let p = staircase[vi];\n"
"    let x = (p.x / max(P.maxX, 1.0)) * 1.9 - 0.95;\n"
"    let y = (p.y / max(P.maxY, 1.0)) * 1.9 - 0.95;\n"
"    return vec4<f32>(x, y, 0.0, 1.0);\n"
"}\n"
"@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(0.85, 0.12, 0.20, 1.0); }\n";

#endif
