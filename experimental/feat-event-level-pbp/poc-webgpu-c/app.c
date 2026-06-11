// ============================================================================
// poc-webgpu-c — the "full WASM" POC (Option 2): the WHOLE app, including the
// WebGPU orchestration, in C against <webgpu/webgpu.h>, compiled to WASM via
// emcc + the emdawnwebgpu port. The all-C counterpart to poc-webgpu/ (which
// keeps WebGPU in JS). It reuses ../poc-webgpu/core.c VERBATIM — the same host
// core (STEV decode, incremental Pareto frontier, brute-force invariant) — so
// the only new code here is the C WebGPU layer (poc-vulkan wrote it in Vulkan).
//
//   GPU : accumulate.wgsl atomicAdds each frame's new event window into per-
//         player (HR,SB) counters; points.wgsl vertex-pulls them (instanced
//         quads); line.wgsl draws the frontier staircase.
//   CPU : core.c advances the cursor, replays the window into the shadow, keeps
//         the incremental frontier, and writes onFront[]/staircase[] — all read
//         straight out of WASM memory (no JS boundary).
//
// Live (real browser): renders to the canvas surface in a RAF loop. Headless:
// renders to an offscreen texture, asserts GPU==shadow + frontier==brute-force
// (the same gate poc-vulkan's BL2D_SNAPSHOT runs), and exposes _capture() to
// read pixels back into a PNG (canvas present is skipped — it loses the device
// under headless Dawn, exactly as in the JS twin).
// ============================================================================
#include <webgpu/webgpu.h>
#include <emscripten.h>
#include <emscripten/html5.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

#include "shaders.h"

// ---- shared host core (../poc-webgpu/core.c) -------------------------------
extern int   wasm_init(const unsigned char *hr, int hrLen, const unsigned char *sb, int sbLen);
extern void  step_career(uint32_t cursorDate);
extern void  step_season(uint32_t cursorDate);
extern void *step_out_ptr(void);
extern void *open_render_ptr(void);
extern void *open_color_ptr(void);
extern void *completed_hr_ptr(void);
extern void *completed_sb_ptr(void);
extern void *completed_year_ptr(void);
extern void *completed_onfront_ptr(void);
extern int   completed_cap(void);
extern int   season_max_hr(void);
extern int   season_max_sb(void);
extern void *events_ptr(void);
extern int   events_count(void);
extern void *debut_ptr(void);
extern void *onfront_ptr(void);
extern void *staircase_ptr(void);
extern void *hr_shadow_ptr(void);
extern void *sb_shadow_ptr(void);
extern int   player_count(void);
extern int   num_dates(void);
extern int   max_hr(void);
extern int   max_sb(void);
extern int   verify_career(void);
extern int   verify_frontier_size(void);
extern const char *name_ptr(int i);
extern int   player_hr(int p);
extern int   player_sb(int p);

// step_out layout (see core.c StepOut): lo, cnt, zeroGpu, lineVerts, ...
typedef struct { uint32_t lo, cnt, zeroGpu, lineVerts, completedDirty, completedCount, openCount; } StepOut;

#define W 900
#define H 700

static WGPUInstance instance;
static WGPUDevice   device;
static WGPUQueue    queue;
static WGPUSurface  surface;
static int g_pc, g_evN, g_canvasOk = 0, g_headless = 0;

static WGPUBuffer bEvents, bHr, bSb, bDebut, bOnFront, bStaircase, bWin, bParams;
static WGPUBuffer bCHr, bCSb, bCYear, bCOnFront, bOpenColor, bOpenRender;  // season
static WGPUBuffer bStgHr, bStgSb, bStgPix;
static WGPUTexture offTex;
static WGPUComputePipeline pAccum;
static WGPURenderPipeline  pPoints, pLine;
static WGPUBindGroup bgAccum, bgPoints, bgLine, bgPointsOpen, bgPointsCompleted;  // season
static uint32_t *g_zeros;
static int g_mode = 0;                     // 0 = career, 1 = season
static int g_cCap;

// ---- EM_JS helpers (commas in the body are fine here, unlike EM_ASM) -------
EM_JS(int, js_is_headless, (void), { return /HeadlessChrome/i.test(navigator.userAgent) ? 1 : 0; });
EM_JS(void, js_set_canvas_size, (int w, int h), {
    var c = document.getElementById('canvas'); if (c) { c.width = w; c.height = h; c.style.width = w + 'px'; c.style.height = h + 'px'; }
});
EM_JS(void, js_make_png, (int ptr, int w, int h, int bpr), {
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var c2d = cv.getContext('2d'); var img = c2d.createImageData(w, h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
        var s = ptr + y * bpr + x * 4, d = (y * w + x) * 4;
        img.data[d] = HEAPU8[s + 2]; img.data[d + 1] = HEAPU8[s + 1]; img.data[d + 2] = HEAPU8[s]; img.data[d + 3] = 255;
    }
    c2d.putImageData(img, 0, 0); window.__bl2dc_png = cv.toDataURL('image/png');
});

// ---- helpers ---------------------------------------------------------------
static WGPUStringView sv(const char *s) { WGPUStringView v = { s, strlen(s) }; return v; }

static unsigned char *gunzip_file(const char *path, size_t *outLen) {
    gzFile f = gzopen(path, "rb");
    if (!f) { fprintf(stderr, "cannot open %s\n", path); exit(1); }
    size_t cap = 1 << 20, n = 0; unsigned char *buf = malloc(cap);
    for (;;) {
        if (n == cap) { cap *= 2; buf = realloc(buf, cap); }
        int r = gzread(f, buf + n, (unsigned)(cap - n));
        if (r < 0) { fprintf(stderr, "gzread failed on %s\n", path); exit(1); }
        if (r == 0) break;
        n += (size_t)r;
    }
    gzclose(f);
    *outLen = n;
    return buf;
}

static WGPUBuffer mkbuf(uint64_t size, WGPUBufferUsage usage) {
    WGPUBufferDescriptor d = { .size = size, .usage = usage };
    return wgpuDeviceCreateBuffer(device, &d);
}
static WGPUShaderModule mkshader(const char *code) {
    WGPUShaderSourceWGSL wgsl = { .chain = { .sType = WGPUSType_ShaderSourceWGSL }, .code = sv(code) };
    WGPUShaderModuleDescriptor d = { .nextInChain = &wgsl.chain };
    return wgpuDeviceCreateShaderModule(device, &d);
}
static WGPUBindGroup bind4(WGPUBindGroupLayout l, WGPUBuffer b0, uint64_t s0, WGPUBuffer b1, uint64_t s1,
                          WGPUBuffer b2, uint64_t s2, WGPUBuffer b3, uint64_t s3) {
    WGPUBindGroupEntry e[4] = {
        { .binding = 0, .buffer = b0, .size = s0 }, { .binding = 1, .buffer = b1, .size = s1 },
        { .binding = 2, .buffer = b2, .size = s2 }, { .binding = 3, .buffer = b3, .size = s3 } };
    WGPUBindGroupDescriptor d = { .layout = l, .entryCount = 4, .entries = e };
    return wgpuDeviceCreateBindGroup(device, &d);
}

static WGPURenderPipeline mkRenderPipe(WGPUShaderModule mod, WGPUPrimitiveTopology topo) {
    WGPUColorTargetState target = { .format = WGPUTextureFormat_BGRA8Unorm, .writeMask = WGPUColorWriteMask_All };
    WGPUFragmentState frag = { .module = mod, .entryPoint = sv("fs"), .targetCount = 1, .targets = &target };
    WGPURenderPipelineDescriptor d = {
        .vertex = { .module = mod, .entryPoint = sv("vs") },
        .primitive = { .topology = topo },
        .multisample = { .count = 1, .mask = 0xFFFFFFFF },
        .fragment = &frag,
    };
    return wgpuDeviceCreateRenderPipeline(device, &d);
}

// ---- setup -----------------------------------------------------------------
static void setup(void) {
    uint64_t pcB = (uint64_t)g_pc * 4;
    bEvents = mkbuf((uint64_t)g_evN * 3 * 4, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
    wgpuQueueWriteBuffer(queue, bEvents, 0, events_ptr(), (size_t)g_evN * 3 * 4);
    bHr = mkbuf(pcB, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst);
    bSb = mkbuf(pcB, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst);
    bDebut = mkbuf(pcB, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
    wgpuQueueWriteBuffer(queue, bDebut, 0, debut_ptr(), pcB);
    bOnFront = mkbuf(pcB, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
    bStaircase = mkbuf((uint64_t)(1 + 2 * 2048) * 2 * 4, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
    bWin = mkbuf(16, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
    bParams = mkbuf(16, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
    bStgHr = mkbuf(pcB, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
    bStgSb = mkbuf(pcB, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
    g_zeros = calloc(g_pc, 4);

    pAccum = wgpuDeviceCreateComputePipeline(device, &(WGPUComputePipelineDescriptor){
        .compute = { .module = mkshader(ACCUMULATE_WGSL), .entryPoint = sv("main") } });
    pPoints = mkRenderPipe(mkshader(POINTS_WGSL), WGPUPrimitiveTopology_TriangleList);
    pLine   = mkRenderPipe(mkshader(LINE_WGSL),   WGPUPrimitiveTopology_LineStrip);

    bgAccum  = bind4(wgpuComputePipelineGetBindGroupLayout(pAccum, 0), bWin, 16, bEvents, (uint64_t)g_evN * 3 * 4, bHr, pcB, bSb, pcB);
    bgPoints = wgpuDeviceCreateBindGroup(device, &(WGPUBindGroupDescriptor){
        .layout = wgpuRenderPipelineGetBindGroupLayout(pPoints, 0), .entryCount = 5, .entries = (WGPUBindGroupEntry[]){
            { .binding = 0, .buffer = bParams, .size = 16 }, { .binding = 1, .buffer = bHr, .size = pcB },
            { .binding = 2, .buffer = bSb, .size = pcB }, { .binding = 3, .buffer = bDebut, .size = pcB },
            { .binding = 4, .buffer = bOnFront, .size = pcB } } });
    bgLine = wgpuDeviceCreateBindGroup(device, &(WGPUBindGroupDescriptor){
        .layout = wgpuRenderPipelineGetBindGroupLayout(pLine, 0), .entryCount = 2, .entries = (WGPUBindGroupEntry[]){
            { .binding = 0, .buffer = bParams, .size = 16 }, { .binding = 1, .buffer = bStaircase, .size = (uint64_t)(1 + 2 * 2048) * 2 * 4 } } });

    // ---- season: completed-season + open clouds (reuse the points pipeline) --
    g_cCap = completed_cap();
    uint64_t cB = (uint64_t)g_cCap * 4;
    bCHr = mkbuf(cB, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
    bCSb = mkbuf(cB, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
    bCYear = mkbuf(cB, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
    bCOnFront = mkbuf(cB, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
    bOpenColor = mkbuf(pcB, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
    bOpenRender = mkbuf(pcB, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
    WGPUBindGroupLayout ptsL = wgpuRenderPipelineGetBindGroupLayout(pPoints, 0);
    bgPointsOpen = wgpuDeviceCreateBindGroup(device, &(WGPUBindGroupDescriptor){
        .layout = ptsL, .entryCount = 5, .entries = (WGPUBindGroupEntry[]){
            { .binding = 0, .buffer = bParams, .size = 16 }, { .binding = 1, .buffer = bHr, .size = pcB },
            { .binding = 2, .buffer = bSb, .size = pcB }, { .binding = 3, .buffer = bOpenColor, .size = pcB },
            { .binding = 4, .buffer = bOpenRender, .size = pcB } } });
    bgPointsCompleted = wgpuDeviceCreateBindGroup(device, &(WGPUBindGroupDescriptor){
        .layout = ptsL, .entryCount = 5, .entries = (WGPUBindGroupEntry[]){
            { .binding = 0, .buffer = bParams, .size = 16 }, { .binding = 1, .buffer = bCHr, .size = cB },
            { .binding = 2, .buffer = bCSb, .size = cB }, { .binding = 3, .buffer = bCYear, .size = cB },
            { .binding = 4, .buffer = bCOnFront, .size = cB } } });

    offTex = wgpuDeviceCreateTexture(device, &(WGPUTextureDescriptor){
        .usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc, .dimension = WGPUTextureDimension_2D,
        .size = { W, H, 1 }, .format = WGPUTextureFormat_BGRA8Unorm, .mipLevelCount = 1, .sampleCount = 1 });

    // Live canvas present is skipped under headless (loses the device, as in the
    // JS twin). In a real browser, configure the surface from the #canvas.
    if (!g_headless) {
        WGPUEmscriptenSurfaceSourceCanvasHTMLSelector cv = {
            .chain = { .sType = WGPUSType_EmscriptenSurfaceSourceCanvasHTMLSelector }, .selector = sv("#canvas") };
        surface = wgpuInstanceCreateSurface(instance, &(WGPUSurfaceDescriptor){ .nextInChain = &cv.chain });
        wgpuSurfaceConfigure(surface, &(WGPUSurfaceConfiguration){
            .device = device, .format = WGPUTextureFormat_BGRA8Unorm,
            .usage = WGPUTextureUsage_RenderAttachment, .width = W, .height = H,
            .alphaMode = WGPUCompositeAlphaMode_Opaque, .presentMode = WGPUPresentMode_Fifo });
        g_canvasOk = 1;
    }
}

// ---- per-frame: step in core.c, upload, compute window, render to `target` --
static void renderFrame(uint32_t cursor, WGPUTextureView target) {
    if (g_mode) step_season(cursor); else step_career(cursor);
    const StepOut *o = step_out_ptr();
    uint64_t pcB = (uint64_t)g_pc * 4;

    if (g_mode) {
        wgpuQueueWriteBuffer(queue, bOpenRender, 0, open_render_ptr(), pcB);
        wgpuQueueWriteBuffer(queue, bOpenColor, 0, open_color_ptr(), pcB);
        if (o->completedCount) wgpuQueueWriteBuffer(queue, bCOnFront, 0, completed_onfront_ptr(), (size_t)o->completedCount * 4);
        if (o->completedDirty && o->completedCount) {
            wgpuQueueWriteBuffer(queue, bCHr, 0, completed_hr_ptr(), (size_t)o->completedCount * 4);
            wgpuQueueWriteBuffer(queue, bCSb, 0, completed_sb_ptr(), (size_t)o->completedCount * 4);
            wgpuQueueWriteBuffer(queue, bCYear, 0, completed_year_ptr(), (size_t)o->completedCount * 4);
        }
    } else {
        wgpuQueueWriteBuffer(queue, bOnFront, 0, onfront_ptr(), pcB);
    }
    if (o->lineVerts) wgpuQueueWriteBuffer(queue, bStaircase, 0, staircase_ptr(), (size_t)o->lineVerts * 8);
    if (o->zeroGpu) { wgpuQueueWriteBuffer(queue, bHr, 0, g_zeros, pcB); wgpuQueueWriteBuffer(queue, bSb, 0, g_zeros, pcB); }
    uint32_t win[4] = { o->lo, o->cnt, 0, 0 };
    wgpuQueueWriteBuffer(queue, bWin, 0, win, 16);
    float mx = g_mode ? (float)season_max_hr() : (float)max_hr();
    float my = g_mode ? (float)season_max_sb() : (float)max_sb();
    float params[4] = { mx, my, 0.010f, (float)W / (float)H };
    wgpuQueueWriteBuffer(queue, bParams, 0, params, 16);

    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
    if (o->cnt > 0) {
        WGPUComputePassEncoder cp = wgpuCommandEncoderBeginComputePass(enc, NULL);
        wgpuComputePassEncoderSetPipeline(cp, pAccum);
        wgpuComputePassEncoderSetBindGroup(cp, 0, bgAccum, 0, NULL);
        wgpuComputePassEncoderDispatchWorkgroups(cp, (o->cnt + 63) / 64, 1, 1);
        wgpuComputePassEncoderEnd(cp);
    }
    WGPURenderPassColorAttachment att = { .view = target, .depthSlice = WGPU_DEPTH_SLICE_UNDEFINED,
                                          .loadOp = WGPULoadOp_Clear, .storeOp = WGPUStoreOp_Store,
                                          .clearValue = { 0.04, 0.05, 0.09, 1.0 } };
    WGPURenderPassEncoder rp = wgpuCommandEncoderBeginRenderPass(enc, &(WGPURenderPassDescriptor){ .colorAttachmentCount = 1, .colorAttachments = &att });
    wgpuRenderPassEncoderSetPipeline(rp, pPoints);
    if (g_mode) {
        wgpuRenderPassEncoderSetBindGroup(rp, 0, bgPointsCompleted, 0, NULL);
        wgpuRenderPassEncoderDraw(rp, 6, o->completedCount, 0, 0);
        wgpuRenderPassEncoderSetBindGroup(rp, 0, bgPointsOpen, 0, NULL);
        wgpuRenderPassEncoderDraw(rp, 6, o->openCount, 0, 0);
    } else {
        wgpuRenderPassEncoderSetBindGroup(rp, 0, bgPoints, 0, NULL);
        wgpuRenderPassEncoderDraw(rp, 6, g_pc, 0, 0);
    }
    if (o->lineVerts >= 2) {
        wgpuRenderPassEncoderSetPipeline(rp, pLine);
        wgpuRenderPassEncoderSetBindGroup(rp, 0, bgLine, 0, NULL);
        wgpuRenderPassEncoderDraw(rp, o->lineVerts, 1, 0, 0);
    }
    wgpuRenderPassEncoderEnd(rp);
    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cmd);
}

// ---- headless visual capture: render offscreen -> readback -> PNG on window -
static int g_capBpr;
static void onCapMap(WGPUMapAsyncStatus s, WGPUStringView m, void *u1, void *u2) {
    (void)m; (void)u1; (void)u2;
    if (s != WGPUMapAsyncStatus_Success) { printf("[poc-webgpu-c] capture map failed\n"); return; }
    const void *p = wgpuBufferGetConstMappedRange(bStgPix, 0, (size_t)g_capBpr * H);
    js_make_png((int)(intptr_t)p, W, H, g_capBpr);
    wgpuBufferUnmap(bStgPix);
}
EMSCRIPTEN_KEEPALIVE
void capture(int mode, int cursor) {
    g_mode = mode;
    renderFrame((uint32_t)cursor, wgpuTextureCreateView(offTex, NULL));
    g_capBpr = (W * 4 + 255) & ~255;            // 256-byte row alignment
    if (!bStgPix) bStgPix = mkbuf((uint64_t)g_capBpr * H, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
    wgpuCommandEncoderCopyTextureToBuffer(enc,
        &(WGPUTexelCopyTextureInfo){ .texture = offTex },
        &(WGPUTexelCopyBufferInfo){ .buffer = bStgPix, .layout = { .bytesPerRow = (uint32_t)g_capBpr, .rowsPerImage = H } },
        &(WGPUExtent3D){ W, H, 1 });
    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cmd);
    wgpuBufferMapAsync(bStgPix, WGPUMapMode_Read, 0, (size_t)g_capBpr * H,
        (WGPUBufferMapCallbackInfo){ .mode = WGPUCallbackMode_AllowSpontaneous, .callback = onCapMap });
}

// ---- invariant snapshot (M2 gate): GPU counters == shadow, frontier == BF ---
static void onMapSb(WGPUMapAsyncStatus, WGPUStringView, void *, void *);
static void onMapHr(WGPUMapAsyncStatus s, WGPUStringView m, void *u1, void *u2) {
    (void)m; (void)u1; (void)u2;
    if (s != WGPUMapAsyncStatus_Success) { printf("[poc-webgpu-c] map hr failed\n"); return; }
    wgpuBufferMapAsync(bStgSb, WGPUMapMode_Read, 0, (size_t)g_pc * 4,
        (WGPUBufferMapCallbackInfo){ .mode = WGPUCallbackMode_AllowSpontaneous, .callback = onMapSb });
}
static void onMapSb(WGPUMapAsyncStatus s, WGPUStringView m, void *u1, void *u2) {
    (void)m; (void)u1; (void)u2;
    if (s != WGPUMapAsyncStatus_Success) { printf("[poc-webgpu-c] map sb failed\n"); return; }
    const uint32_t *gHr = wgpuBufferGetConstMappedRange(bStgHr, 0, (size_t)g_pc * 4);
    const uint32_t *gSb = wgpuBufferGetConstMappedRange(bStgSb, 0, (size_t)g_pc * 4);
    const uint32_t *sHr = hr_shadow_ptr(), *sSb = sb_shadow_ptr();
    uint32_t mism = 0;
    for (int i = 0; i < g_pc; i++) if (gHr[i] != sHr[i] || gSb[i] != sSb[i]) mism++;
    wgpuBufferUnmap(bStgHr); wgpuBufferUnmap(bStgSb);
    int fmis = verify_career();
    printf("[poc-webgpu-c] RESULT %s counterMis=%u frontierMis=%d frontierSize=%d\n",
           (mism == 0 && fmis == 0) ? "PASS" : "FAIL", mism, fmis, verify_frontier_size());
}
static void runInvariant(void) {
    // renderFrame(end) leaves the GPU counters == full-history accumulation.
    uint64_t pcB = (uint64_t)g_pc * 4;
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(device, NULL);
    wgpuCommandEncoderCopyBufferToBuffer(enc, bHr, 0, bStgHr, 0, pcB);
    wgpuCommandEncoderCopyBufferToBuffer(enc, bSb, 0, bStgSb, 0, pcB);
    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, NULL);
    wgpuQueueSubmit(queue, 1, &cmd);
    wgpuBufferMapAsync(bStgHr, WGPUMapMode_Read, 0, pcB,
        (WGPUBufferMapCallbackInfo){ .mode = WGPUCallbackMode_AllowSpontaneous, .callback = onMapHr });
}

// ---- live RAF loop (real browser only) -------------------------------------
static double g_cursor = 0;
static EM_BOOL rafTick(double t, void *ud) {
    (void)t; (void)ud;
    g_cursor += 18.0;                          // game-dates per frame
    if (g_cursor >= num_dates() - 1) g_cursor = 0;
    WGPUSurfaceTexture st;
    wgpuSurfaceGetCurrentTexture(surface, &st);
    if (st.texture) { renderFrame((uint32_t)g_cursor, wgpuTextureCreateView(st.texture, NULL)); }
    return EM_TRUE;
}

// ---- device acquisition ----------------------------------------------------
static void onDevice(WGPURequestDeviceStatus status, WGPUDevice d, WGPUStringView msg, void *u1, void *u2) {
    (void)u1; (void)u2;
    if (status != WGPURequestDeviceStatus_Success) { printf("[poc-webgpu-c] device request failed: %.*s\n", (int)msg.length, msg.data); return; }
    device = d; queue = wgpuDeviceGetQueue(device);
    setup();
    renderFrame((uint32_t)(num_dates() - 1), wgpuTextureCreateView(offTex, NULL));  // end-of-history
    runInvariant();
    if (g_canvasOk) emscripten_request_animation_frame_loop(rafTick, NULL);          // live sweep
    printf("[poc-webgpu-c] ready (headless=%d, canvas=%d)\n", g_headless, g_canvasOk);
}
static void onGpuError(WGPUDevice const *dev, WGPUErrorType type, WGPUStringView msg, void *u1, void *u2) {
    (void)dev; (void)u1; (void)u2;
    printf("[poc-webgpu-c] GPU ERROR (type=%d): %.*s\n", type, (int)msg.length, msg.data);
}
static void onAdapter(WGPURequestAdapterStatus status, WGPUAdapter a, WGPUStringView msg, void *u1, void *u2) {
    (void)u1; (void)u2;
    if (status != WGPURequestAdapterStatus_Success) { printf("[poc-webgpu-c] adapter request failed: %.*s\n", (int)msg.length, msg.data); return; }
    WGPUDeviceDescriptor dd = { .uncapturedErrorCallbackInfo = { .callback = onGpuError } };
    wgpuAdapterRequestDevice(a, &dd, (WGPURequestDeviceCallbackInfo){ .mode = WGPUCallbackMode_AllowSpontaneous, .callback = onDevice });
}

int main(void) {
    g_headless = js_is_headless();
    js_set_canvas_size(W, H);
    size_t hl, sl;
    unsigned char *hr = gunzip_file("/data/pbp/hr.evt.gz", &hl);
    unsigned char *sb = gunzip_file("/data/pbp/sb.evt.gz", &sl);
    g_pc = wasm_init(hr, (int)hl, sb, (int)sl);
    free(hr); free(sb);
    g_evN = events_count();
    printf("[poc-webgpu-c] decoded: players=%d events=%d maxHR=%d maxSB=%d (headless=%d)\n", g_pc, g_evN, max_hr(), max_sb(), g_headless);

    instance = wgpuCreateInstance(NULL);
    wgpuInstanceRequestAdapter(instance, NULL,
        (WGPURequestAdapterCallbackInfo){ .mode = WGPUCallbackMode_AllowSpontaneous, .callback = onAdapter });
    emscripten_exit_with_live_runtime();
    return 0;
}
