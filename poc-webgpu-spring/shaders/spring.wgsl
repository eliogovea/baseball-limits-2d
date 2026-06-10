// ── spring.wgsl — GPU critically-damped spring motion (WGSL twin of spring.comp) ────────────
//
// WHY THIS EXISTS — see the long header in ../../poc-vulkan-spring/shaders/spring.comp for the
// full derivation; the short version: in the baseline a dot teleports one notch when its counter
// ticks. Here we keep a continuous position pos[] + velocity vel[] per player and each frame glide
// pos toward the integer target (hr, sb) with a CRITICALLY-DAMPED spring — the fastest approach
// with NO overshoot. accumulate.wgsl is unchanged; hr/sb are now the spring TARGET, points.wgsl
// draws pos[].
//
// THE MATH (1-D, applied per axis via vec2): the offset (x - target) obeys the damped-oscillator
// ODE  x'' + 2ζω·x' + ω²(x-target) = 0. At the critical ratio ζ=1 there is no overshoot. We use
// the stable closed form (Game Programming Gems 4 / "SmoothDamp"): replace the exact decay e^{-ωΔt}
// with a polynomial that stays in (0,1] for ANY Δt, so a frame-time spike can't make it blow up.
//
// WGSL-vs-GLSL deltas (all mechanical, same math):
//   • No push constants in WebGPU → the {dt, omega, n} live in a UNIFORM buffer (Spring).
//   • hr/sb are declared array<atomic<u32>> for accumulate.wgsl. Here we only READ them and there
//     are no concurrent writers during this pass, so we bind the SAME buffers through a plain,
//     read-only `array<u32>` view — a non-atomic read of atomic storage, which is well-defined.
//   • Storage vec2<f32> arrays: WGSL gives them an 8-byte stride, matching the JS Float32Array.

struct Spring { dt: f32, omega: f32, n: u32, _pad: u32 };
@group(0) @binding(0) var<uniform>               S:   Spring;
@group(0) @binding(1) var<storage, read>         hr:  array<u32>;        // target X (non-atomic read)
@group(0) @binding(2) var<storage, read>         sb:  array<u32>;        // target Y
@group(0) @binding(3) var<storage, read_write>   pos: array<vec2<f32>>;  // rendered position (HR,SB units)
@group(0) @binding(4) var<storage, read_write>   vel: array<vec2<f32>>;  // motion state

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= S.n) { return; }

    let tgt = vec2<f32>(f32(hr[i]), f32(sb[i]));   // 'target' is a reserved WGSL keyword → tgt
    let x = pos[i];
    let v = vel[i];

    let wd = S.omega * S.dt;
    let e  = 1.0 / (1.0 + wd + 0.5*wd*wd + (1.0/6.0)*wd*wd*wd + (1.0/24.0)*wd*wd*wd*wd);
    let change = x - tgt;
    let temp   = (v + S.omega * change) * S.dt;
    pos[i] = tgt + (change + temp) * e;   // decays toward target, no overshoot
    vel[i] = (v - S.omega * temp) * e;
}
