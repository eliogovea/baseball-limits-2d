// ── accumulate.wgsl — the COMPUTE pass that grows the per-player counters ────────
// This is the engine of the "compute-accumulate" approach. The full event history lives
// in one resident storage buffer (`events`), date-sorted, never re-uploaded. Each frame
// the CPU advances a cursor and tells us, via the `Win` uniform, the [lo, lo+count) SLICE
// of events that became due since last frame. We launch one GPU thread per event in that
// slice and add it into the player's running total — so per-frame work is O(new events),
// never O(history). The counters persist across frames (the GPU buffer is the source of
// truth for the picture), and points.wgsl reads them directly with no readback.
//
// Why atomicAdd and not `hr[player] += cnt`: the threads in a workgroup run concurrently,
// and two events in the same slice can target the SAME player (a 2-HR game, or two
// players' events interleaved). A plain read-modify-write would race and lose updates;
// atomicAdd serialises the additions to each cell. (Port of poc-vulkan/shaders/accumulate.comp.)
struct Win { lo: u32, count: u32 };
@group(0) @binding(0) var<uniform> W: Win;
@group(0) @binding(1) var<storage, read>       events: array<u32>;       // flat {player,stat,count} ×3 per event
@group(0) @binding(2) var<storage, read_write> hr: array<atomic<u32>>;   // per-player HR total (read+written here)
@group(0) @binding(3) var<storage, read_write> sb: array<atomic<u32>>;   // per-player SB total

// workgroup_size(64): the GPU runs threads in fixed-size groups; 64 is a good default
// (a multiple of the hardware warp/wave size). The CPU dispatches ceil(count/64) groups,
// so the LAST group overshoots `count` — hence the bounds guard below.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let g = gid.x;                      // this thread's global event-slot within the slice
    if (g >= W.count) { return; }       // guard the partial final workgroup
    let e = (W.lo + g) * 3u;            // 3 u32 per event → byte-free index into `events`
    let player = events[e + 0u];
    let stat   = events[e + 1u];        // 0 = HR, 1 = SB
    let cnt    = events[e + 2u];        // this date's delta (≥ 0)
    if (stat == 0u) { atomicAdd(&hr[player], cnt); }
    else            { atomicAdd(&sb[player], cnt); }
}
