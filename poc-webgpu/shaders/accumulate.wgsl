// Consume one event per invocation and accumulate it into the persistent
// per-player counters. The CPU (WASM) advances a cursor and dispatches us only
// over the new [lo, lo+count) slice of date-sorted events each frame; we never
// scan full history. atomicAdd because several events in the same slice can
// target the same player. (Port of poc-vulkan/shaders/accumulate.comp.)
struct Win { lo: u32, count: u32 };
@group(0) @binding(0) var<uniform> W: Win;
@group(0) @binding(1) var<storage, read>       events: array<u32>;       // player,stat,count ×3
@group(0) @binding(2) var<storage, read_write> hr: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> sb: array<atomic<u32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let g = gid.x;
    if (g >= W.count) { return; }
    let e = (W.lo + g) * 3u;
    let player = events[e + 0u];
    let stat   = events[e + 1u];
    let cnt    = events[e + 2u];
    if (stat == 0u) { atomicAdd(&hr[player], cnt); }
    else            { atomicAdd(&sb[player], cnt); }
}
