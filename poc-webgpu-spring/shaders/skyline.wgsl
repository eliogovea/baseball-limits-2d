// ── skyline.wgsl — per-frame GPU Pareto frontier (WGSL twin of skyline.comp) ────────────────
//
// WHY — the baseline kept the non-dominated "limits" set on the CPU (cheap, because integer events
// are monotone). Once positions are SMOOTHED floats (pos[]) that incremental trick no longer holds,
// so we recompute the frontier on the GPU every frame: brute-force O(n²) domination over pos[],
// writing onFront[]. n ≈ 11k ⇒ ~124M comparisons/frame, sub-ms on real hardware. We rejected the
// spatial-tiling scheme some "GPU frontier" write-ups suggest: its "influence is local" premise is
// FALSE for Pareto domination (one high point dominates an entire lower-left quadrant). See
// ../../docs/gpu-spring-skyline-design.md.
//
// Point i is on-front iff no j strictly dominates it: pj ≥ pi on both axes, strictly greater on
// one. Same strict tie-break the verification oracle (core.c verify_career) uses, so settled
// positions (pos ≈ integer) reproduce the CPU frontier exactly.
//
// Reuses the Spring uniform struct purely for its `n` field (dt/omega ignored here).

struct Spring { dt: f32, omega: f32, n: u32, _pad: u32 };
@group(0) @binding(0) var<uniform>             S:       Spring;
@group(0) @binding(1) var<storage, read_write> onFront: array<u32>;       // output: 1 = on frontier
@group(0) @binding(2) var<storage, read>       pos:     array<vec2<f32>>; // smoothed positions

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= S.n) { return; }
    let pi = pos[i];
    var dom = 0u;
    for (var j = 0u; j < S.n; j = j + 1u) {
        let pj = pos[j];
        if (pj.x >= pi.x && pj.y >= pi.y && (pj.x > pi.x || pj.y > pi.y)) { dom = 1u; break; }
    }
    onFront[i] = select(1u, 0u, dom == 1u);   // select(falseVal, trueVal, cond): dom → 0, else 1
}
