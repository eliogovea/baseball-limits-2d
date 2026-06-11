#version 450
// The frontier staircase is drawn in MLB red (as in the web app).
layout(location = 0) out vec4 outColor;

void main() {
    outColor = vec4(0.85, 0.12, 0.20, 1.0);
}
