// ── staircase.wgsl — build the frontier step-line ENTIRELY on the GPU ───────────────────────
//
// WHY THIS IS DIFFERENT FROM THE VULKAN TWIN: poc-vulkan-spring builds the staircase on the CPU,
// reading pos[]/onFront[] over Apple's host-coherent unified memory (free after the frame fence).
// WebGPU CAN'T do that cheaply — a per-frame GPU→CPU readback is async (mapAsync) and, under
// headless Chrome, the documented trigger that LOSES THE DEVICE. So here the staircase is produced
// without ever touching the CPU: three tiny compute passes turn skyline.comp's onFront[] into an
// ordered line-strip vertex buffer plus a GPU-written draw count for an INDIRECT draw.
//
// THE PIPELINE (frontier size K is tiny — tens of points; MAX_FRONT bounds it):
//   1. compact   — gather the on-front player indices into frontIdx[0..K), K via an atomic counter.
//   2. ranksort  — O(K²) rank sort: each frontier point counts how many others have a smaller x
//                  (ties broken by index), then scatters its position into frontSorted[rank].
//                  O(K²) is trivial at this K and mirrors the brute-force skyline's spirit.
//   3. emit      — each sorted point writes its two step vertices (the corner + the vertical drop
//                  to the next point's y) at deterministic offsets; thread 0 also writes the cap
//                  vertex and the indirect draw's vertexCount = 1 + 2K.
//
// One module, three @compute entry points, ONE shared bind-group layout (the union of all the
// bindings; each entry uses a subset — a superset layout is legal). The three passes run as
// separate compute passes in one encoder, so they serialize (ranksort sees compact's writes, etc.).
//
// `count` is atomic for the compact pass (concurrent atomicAdd) and read back via atomicLoad in the
// later passes. Reset to 0 by the host each frame (queue.writeBuffer); the indirect args are reset
// to {0,1,0,0} too, so when K==0 (no frontier yet) the indirect draw renders nothing.

const MAX_FRONT : u32 = 2048u;

struct Spring   { dt: f32, omega: f32, n: u32, _pad: u32 };
struct DrawArgs { vertexCount: u32, instanceCount: u32, firstVertex: u32, firstInstance: u32 };

@group(0) @binding(0) var<uniform>             S:           Spring;
@group(0) @binding(1) var<storage, read>       onFront:     array<u32>;
@group(0) @binding(2) var<storage, read>       pos:         array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> frontIdx:    array<u32>;        // compacted on-front player ids
@group(0) @binding(4) var<storage, read_write> frontSorted: array<vec2<f32>>;  // positions, sorted by x asc
@group(0) @binding(5) var<storage, read_write> count:       array<atomic<u32>>;// [0] = K (frontier size)
@group(0) @binding(6) var<storage, read_write> staircase:   array<vec2<f32>>;  // line-strip output
@group(0) @binding(7) var<storage, read_write> indirect:    DrawArgs;          // GPU-written draw count

// 1. COMPACT — one thread per player; append on-front indices, bump the atomic counter.
@compute @workgroup_size(64)
fn compact(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= S.n) { return; }
    if (onFront[i] != 0u) {
        let k = atomicAdd(&count[0], 1u);
        if (k < MAX_FRONT) { frontIdx[k] = i; }   // bound guard (fixed-size scratch)
    }
}

// 2. RANKSORT — one thread per frontier slot; O(K²) rank, then scatter into sorted order.
@compute @workgroup_size(64)
fn ranksort(@builtin(global_invocation_id) gid: vec3<u32>) {
    let kk = gid.x;
    let K = atomicLoad(&count[0]);
    if (kk >= K) { return; }
    let p  = frontIdx[kk];
    let pp = pos[p];
    var rank = 0u;
    for (var j = 0u; j < K; j = j + 1u) {
        let q  = frontIdx[j];
        let qx = pos[q].x;
        if (qx < pp.x || (qx == pp.x && q < p)) { rank = rank + 1u; }   // deterministic tie-break
    }
    frontSorted[rank] = pp;
}

// 3. EMIT — one thread per sorted slot; write the step vertices + (thread 0) the cap and the count.
@compute @workgroup_size(64)
fn emit(@builtin(global_invocation_id) gid: vec3<u32>) {
    let r = gid.x;
    let K = atomicLoad(&count[0]);
    if (r >= K) { return; }

    if (r == 0u) {
        staircase[0] = vec2<f32>(0.0, frontSorted[0].y);   // left cap on the y-axis (top point's y)
        indirect.vertexCount   = 1u + 2u * K;              // line-strip length for drawIndirect
        indirect.instanceCount = 1u;
        indirect.firstVertex   = 0u;
        indirect.firstInstance = 0u;
    }
    // Each point emits its corner, then the vertical drop to the next (lower) y — the staircase.
    let here = frontSorted[r];
    let next = r + 1u;
    let hasNext = next < K;
    let safe = select(0u, next, hasNext);                  // avoid an out-of-bounds read when r is last
    let dropY = select(0.0, frontSorted[safe].y, hasNext); // last point drops to the x-axis (0)
    staircase[1u + 2u*r]      = here;                      // the step corner (x_r, y_r)
    staircase[1u + 2u*r + 1u] = vec2<f32>(here.x, dropY);  // vertical drop at x_r
}
