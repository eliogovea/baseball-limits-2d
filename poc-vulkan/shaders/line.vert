#version 450
// Pareto-frontier staircase (native-Vulkan original of line.wgsl). Vertex-pull again:
// the CPU writes the step-function vertices (in raw HR/SB units) into staircase[], we map
// vertex gl_VertexIndex to clip space with the SAME maxima as points.vert (so the line
// lands on the cloud), and the pipeline draws them as a line-strip. Separate shader only
// because the primitive topology differs from the point cloud.
layout(std430, binding = 5) readonly buffer Staircase { vec2 staircase[]; };

layout(push_constant) uniform PC { float maxX; float maxY; } pc;

void main() {
    vec2 p = staircase[gl_VertexIndex];
    float x = (p.x / max(pc.maxX, 1.0)) * 1.9 - 0.95;   // same margin as points.vert → they align
    float y = (p.y / max(pc.maxY, 1.0)) * 1.9 - 0.95;
    gl_Position = vec4(x, -y, 0.0, 1.0);                // -y: Vulkan +Y-down flip (cf. line.wgsl, no flip)
}
