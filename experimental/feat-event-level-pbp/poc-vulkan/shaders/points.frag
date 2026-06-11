#version 450
// Round the square point sprite into a disc. gl_PointCoord is [0,1]² across the point
// sprite the rasteriser generates from gl_PointSize; remap to [-1,1]² and discard outside
// the unit circle. (points.wgsl does the same test on its own quad's interpolated corner,
// because WebGPU has no point sprite / gl_PointCoord to lean on.)
layout(location = 0) in  vec3 vColor;
layout(location = 0) out vec4 outColor;

void main() {
    vec2 d = gl_PointCoord * 2.0 - 1.0;   // sprite coord → centred [-1,1]
    if (dot(d, d) > 1.0) discard;         // |d|² > 1 → outside the disc
    outColor = vec4(vColor, 1.0);
}
