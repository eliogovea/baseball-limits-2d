#version 450
// ── points.vert — the native-Vulkan original of points.wgsl ─────────────────────
// Same vertex-pull idea (gl_VertexIndex == player index; read GPU-resident state; no vertex
// buffer). Two instructive differences from the WebGPU port:
//   • Vulkan HAS a point primitive + gl_PointSize, so this draws ONE vertex per player
//     and sets the dot size directly — no instanced quad, no fragment disc test needed
//     (points.frag just rounds it). WebGPU dropped gl_PointSize, which is why points.wgsl
//     has to build a quad and carve the disc itself.
//   • Vulkan's clip space is +Y DOWN, so we negate y (`-y`) to make "more SB" go UP on
//     screen. WebGPU's NDC is +Y up, so points.wgsl needs no flip. Same data, opposite
//     convention — a classic native-vs-web gotcha.
//
// SPRING-TWIN CHANGE vs the baseline: we no longer read the integer counters hr[]/sb[]. We read
// the SMOOTHED position pos[] that spring.comp produced (still in HR/SB data units, so the NDC
// mapping below is unchanged). onFront[] is now written by skyline.comp (GPU) rather than the CPU,
// but it's consumed here exactly the same way — frontier dots get the red highlight + larger size.
layout(std430, binding = 3) readonly buffer Debut   { uint debut[]; };
layout(std430, binding = 4) readonly buffer OnFront { uint onFront[]; };
layout(std430, binding = 6) readonly buffer Pos     { vec2 pos[]; };  // smoothed (x=HR, y=SB)

layout(push_constant) uniform PC { float maxX; float maxY; } pc;

layout(location = 0) out vec3 vColor;

// Old (1871) blue -> mid gold -> new (2025) red.
vec3 eraColor(float yr) {
    float t = clamp((yr - 1871.0) / (2025.0 - 1871.0), 0.0, 1.0);
    vec3 blue = vec3(0.20, 0.40, 0.90);
    vec3 gold = vec3(0.95, 0.78, 0.20);
    vec3 red  = vec3(0.88, 0.20, 0.20);
    return t < 0.5 ? mix(blue, gold, t * 2.0) : mix(gold, red, (t - 0.5) * 2.0);
}

void main() {
    uint idx = uint(gl_VertexIndex);     // one vertex per player → index IS the player
    vec2 p = pos[idx];                   // smoothed position (HR, SB), from spring.comp

    // [0, max] -> [-0.95, 0.95] (5% margin so record-holders at the axis maxima aren't
    // clipped at the screen edge). max(...,1) guards divide-by-zero before any events.
    float x = (p.x / max(pc.maxX, 1.0)) * 1.9 - 0.95;
    float y = (p.y / max(pc.maxY, 1.0)) * 1.9 - 0.95;
    gl_Position = vec4(x, -y, 0.0, 1.0);  // -y: Vulkan clip space is +Y down → flip so more SB is higher

    if (onFront[idx] != 0u) {            // frontier point: MLB red + bigger (as in the web app)
        gl_PointSize = 5.0;
        vColor = vec3(0.78, 0.06, 0.18);
    } else {                             // background cloud: dimmed era colour
        gl_PointSize = 3.0;
        vColor = eraColor(float(debut[idx])) * 0.55;
    }
}
