#version 450
// Draws the Pareto-frontier staircase. The CPU writes the step-function
// vertices (already in (HR, SB) units) into staircase[]; we pull them by index
// and map to clip space with the same axis maxima the points use.
layout(std430, binding = 5) readonly buffer Staircase { vec2 staircase[]; };

layout(push_constant) uniform PC { float maxX; float maxY; } pc;

void main() {
    vec2 p = staircase[gl_VertexIndex];
    float x = (p.x / max(pc.maxX, 1.0)) * 1.9 - 0.95;   // same margin as points.vert
    float y = (p.y / max(pc.maxY, 1.0)) * 1.9 - 0.95;
    gl_Position = vec4(x, -y, 0.0, 1.0);
}
