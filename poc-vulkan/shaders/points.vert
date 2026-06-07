#version 450
// Vertex-pull: no vertex buffers. gl_VertexIndex is the player index; we read
// that player's accumulated (HR, SB) counters straight from the buffers the
// compute shader maintains, map to clip space, and colour by debut era.
// Frontier players (onFront) are drawn brighter and larger; the rest dimmed.
layout(std430, binding = 1) readonly buffer Hr      { uint hr[]; };
layout(std430, binding = 2) readonly buffer Sb      { uint sb[]; };
layout(std430, binding = 3) readonly buffer Debut   { uint debut[]; };
layout(std430, binding = 4) readonly buffer OnFront { uint onFront[]; };

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
    uint idx = uint(gl_VertexIndex);

    // [0, max] -> [-0.95, 0.95] (small margin so the record-holders at the axis
    // maxima aren't clipped at the screen edge); flip Y so more goes up.
    float x = (float(hr[idx]) / max(pc.maxX, 1.0)) * 1.9 - 0.95;
    float y = (float(sb[idx]) / max(pc.maxY, 1.0)) * 1.9 - 0.95;
    gl_Position = vec4(x, -y, 0.0, 1.0);

    if (onFront[idx] != 0u) {            // frontier point: MLB red (as in the web app)
        gl_PointSize = 5.0;
        vColor = vec3(0.78, 0.06, 0.18);
    } else {                             // background cloud: dimmed era colour
        gl_PointSize = 3.0;
        vColor = eraColor(float(debut[idx])) * 0.55;
    }
}
