#version 450
// Round the square point sprite into a soft disc.
layout(location = 0) in  vec3 vColor;
layout(location = 0) out vec4 outColor;

void main() {
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    if (dot(d, d) > 1.0) discard;
    outColor = vec4(vColor, 1.0);
}
