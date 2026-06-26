// ============================================================================
// MLB HR x SB replay — the SPRING twin: a more fully GPU-resident native Vulkan
// (MoltenVK) POC. Diff it against ../poc-vulkan (the baseline) to see the change.
//
// What the baseline did: a CPU time engine streamed events to the GPU, which
// atomicAdd'd them into per-player counters; the dots were drawn straight from
// those integer counters (so a dot TELEPORTS one notch when a counter ticks),
// and the Pareto frontier ("the limits") was maintained INCREMENTALLY ON THE CPU.
//
// What this twin changes (see ../docs/rendering.md (orig: gpu-spring-skyline-design.md, git history)):
//   GPU  : accumulate.comp — UNCHANGED. hr[]/sb[] are still the atomicAdd target,
//          but they are now the spring DESTINATION, not the drawn position.
//   GPU  : spring.comp (NEW) — each frame, integrate a critically-damped spring
//          per player so the rendered position pos[] GLIDES toward (hr,sb) with
//          no overshoot. This is the visual win: smooth motion instead of jumps.
//   GPU  : skyline.comp (NEW) — each frame, recompute the 2-D Pareto frontier by
//          brute-force O(n^2) domination over the SMOOTHED pos[] (the integer-
//          event incremental trick no longer applies once positions are floats),
//          writing onFront[]. No CPU frontier, no spatial tiling (Pareto
//          domination isn't spatially local — see the design doc).
//   GPU  : points.vert reads pos[] (not the counters); a CPU pass reads the GPU's
//          onFront[]+pos[] over unified memory to assemble the staircase line.
//
//   CPU  : only advances the clock, computes the per-frame [lo, lo+count) event
//          slice, submits, and assembles the (tiny) frontier staircase line.
//
// Data is the committed real corpus (../data/pbp/hr.evt.gz + sb.evt.gz, the STEV
// ".evt" format in docs/data-formats.md §Deprecated) for ~11k batters, 1871-2025.
//
// Headless verification (this env has no Screen Recording permission, so the
// live window can't be screenshotted): BL2D_SNAPSHOT=1 applies all events once,
// SETTLES the springs, runs the skyline, then asserts three invariants — GPU
// counters == CPU replay, springs converged (pos ≈ integer (hr,sb)), and the GPU
// skyline == a brute-force O(n^2) Pareto check — and writes /tmp/poc-vulkan-spring.bmp.
// BL2D_VALIDATE=1 turns on the Khronos validation layer.
//
// Style: one flat main.c, straight-line code, a handful of small helpers that
// each earn their keep through reuse (vk_check, read_varint, gunzip_file,
// intern, ev_by_date, find_memory_type, create_buffer, load_shader, write_bmp).
// ============================================================================

#define GLFW_INCLUDE_VULKAN
#include <GLFW/glfw3.h>

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

// ---------------------------------------------------------------------------
// Decoded dataset (filled by the decode pass). intern() needs to see the
// player table, so this small amount of module state is the simplest home.
// ---------------------------------------------------------------------------
#define MAX_PLAYERS 20000        // the real union is 11,131; an assert guards
#define HASH_SIZE   (1 << 16)    // > 2*MAX_PLAYERS, power of two

static int      g_n = 0;                  // number of distinct players (union)
static char    *g_name[MAX_PLAYERS];      // strdup'd display name
static uint32_t g_debut[MAX_PLAYERS];     // debut calendar year (era colour)
static int      g_hash[HASH_SIZE];        // FNV(name) -> player index, -1 empty

// One decoded event: a single-game increase of one stat for one player.
typedef struct { uint32_t date, player, count, stat; } Ev;  // stat: 0=HR, 1=SB
static Ev      *g_ev;                      // all events, sorted by date
static uint32_t g_evN;

// Pareto frontier. In this SPRING twin the frontier is recomputed on the GPU every frame by
// skyline.comp (from the smoothed positions), NOT maintained incrementally on the CPU as in the
// baseline. The CPU only READS the GPU's onFront flags to assemble the staircase line strip.
#define MAX_FRONT 2048                     // real frontier is dozens; assert-guarded
static uint32_t *g_onFront;                // -> mapped GPU buffer (binding 4), 1 if on frontier

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
static void vk_check(VkResult r) {
    if (r != VK_SUCCESS) { fprintf(stderr, "Vulkan error %d\n", r); exit(1); }
}

// Unsigned LEB128 (low 7 bits/byte, high bit = continuation).
static uint32_t read_varint(const uint8_t *b, size_t *p) {
    uint32_t v = 0, shift = 0; uint8_t c;
    do { c = b[(*p)++]; v |= (uint32_t)(c & 0x7f) << shift; shift += 7; } while (c & 0x80);
    return v;
}

// Gunzip a whole file into a malloc'd buffer (zlib handles the gzip wrapper).
static uint8_t *gunzip_file(const char *path, size_t *out_len) {
    gzFile f = gzopen(path, "rb");
    if (!f) { fprintf(stderr, "cannot open %s\n", path); exit(1); }
    size_t cap = 1 << 20, n = 0; uint8_t *buf = malloc(cap);
    for (;;) {
        if (n == cap) { cap *= 2; buf = realloc(buf, cap); }
        int r = gzread(f, buf + n, (unsigned)(cap - n));
        if (r < 0) { fprintf(stderr, "gzread failed on %s\n", path); exit(1); }
        if (r == 0) break;
        n += (size_t)r;
    }
    gzclose(f);
    *out_len = n;
    return buf;
}

// Intern a player name into the union table; returns its index (creating it on
// first sight). Open-addressed FNV-1a hash over the module-level player arrays.
static int intern(const char *name) {
    uint32_t h = 2166136261u;
    for (const char *s = name; *s; s++) h = (h ^ (uint8_t)*s) * 16777619u;
    for (uint32_t i = h & (HASH_SIZE - 1); ; i = (i + 1) & (HASH_SIZE - 1)) {
        if (g_hash[i] < 0) {
            int idx = g_n++;
            assert(idx < MAX_PLAYERS);
            g_hash[i] = idx;
            g_name[idx] = strdup(name);
            g_debut[idx] = 9999;
            return idx;
        }
        if (strcmp(g_name[g_hash[i]], name) == 0) return g_hash[i];
    }
}

// qsort comparator: order events by game-date (the cursor walks them forward).
static int ev_by_date(const void *a, const void *b) {
    uint32_t da = ((const Ev *)a)->date, db = ((const Ev *)b)->date;
    return da < db ? -1 : da > db ? 1 : 0;
}

static uint32_t find_memory_type(VkPhysicalDevice phys, uint32_t bits, VkMemoryPropertyFlags want) {
    VkPhysicalDeviceMemoryProperties mp;
    vkGetPhysicalDeviceMemoryProperties(phys, &mp);
    for (uint32_t i = 0; i < mp.memoryTypeCount; i++)
        if ((bits & (1u << i)) && (mp.memoryTypes[i].propertyFlags & want) == want) return i;
    fprintf(stderr, "no suitable memory type\n"); exit(1);
}

// Create a buffer + back it with memory; if src != NULL, map and upload it.
static void create_buffer(VkDevice dev, VkPhysicalDevice phys, VkDeviceSize size,
                          VkBufferUsageFlags usage, VkMemoryPropertyFlags props,
                          const void *src, VkBuffer *buf, VkDeviceMemory *mem) {
    VkBufferCreateInfo bi = { .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
                              .size = size, .usage = usage,
                              .sharingMode = VK_SHARING_MODE_EXCLUSIVE };
    vk_check(vkCreateBuffer(dev, &bi, NULL, buf));
    VkMemoryRequirements req;
    vkGetBufferMemoryRequirements(dev, *buf, &req);
    VkMemoryAllocateInfo ai = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
                                .allocationSize = req.size,
                                .memoryTypeIndex = find_memory_type(phys, req.memoryTypeBits, props) };
    vk_check(vkAllocateMemory(dev, &ai, NULL, mem));
    vk_check(vkBindBufferMemory(dev, *buf, *mem, 0));
    if (src) {
        void *dst; vk_check(vkMapMemory(dev, *mem, 0, size, 0, &dst));
        memcpy(dst, src, size);
        vkUnmapMemory(dev, *mem);
    }
}

// Load a SPIR-V file into a shader module.
static VkShaderModule load_shader(VkDevice dev, const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "cannot open shader %s (run make first)\n", path); exit(1); }
    fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
    uint32_t *code = malloc((size_t)sz);
    if (fread(code, 1, (size_t)sz, f) != (size_t)sz) { fprintf(stderr, "short read %s\n", path); exit(1); }
    fclose(f);
    VkShaderModuleCreateInfo ci = { .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
                                    .codeSize = (size_t)sz, .pCode = code };
    VkShaderModule m; vk_check(vkCreateShaderModule(dev, &ci, NULL, &m));
    free(code);
    return m;
}

// Write a 24-bit bottom-up BMP from a B8G8R8A8 (BGRA) pixel buffer.
static void write_bmp(const char *path, const uint8_t *bgra, uint32_t w, uint32_t h) {
    uint32_t row = (w * 3 + 3) & ~3u, imgsz = row * h, total = 54 + imgsz;
    uint8_t hdr[54] = {0};
    hdr[0] = 'B'; hdr[1] = 'M';
    memcpy(hdr + 2, &total, 4); hdr[10] = 54; hdr[14] = 40;
    memcpy(hdr + 18, &w, 4); memcpy(hdr + 22, &h, 4);
    hdr[26] = 1; hdr[28] = 24; memcpy(hdr + 34, &imgsz, 4);
    FILE *f = fopen(path, "wb");
    if (!f) { fprintf(stderr, "cannot write %s\n", path); exit(1); }
    fwrite(hdr, 1, 54, f);
    uint8_t pad[3] = {0};
    for (int y = (int)h - 1; y >= 0; y--) {              // BMP rows are bottom-up
        const uint8_t *p = bgra + (size_t)y * w * 4;
        for (uint32_t x = 0; x < w; x++) fwrite(p + x * 4, 1, 3, f);  // B,G,R
        fwrite(pad, 1, row - w * 3, f);
    }
    fclose(f);
}

// ---------------------------------------------------------------------------
// Tiny 5x7 bitmap font, just enough to label the frontier players in the BMP
// (raw Vulkan has no text API, and a glyph-atlas GPU pass would dwarf this POC —
// so we plot the names into the readback pixels on the CPU before write_bmp).
// Each glyph is 7 rows; the low 5 bits of each row are the pixels (bit 4 = left).
// Uppercase A–Z only (names are upper-cased to a single last name); space and a
// couple of punctuation marks fall through to "draw nothing / advance".
// ---------------------------------------------------------------------------
static const uint8_t FONT_AZ[26][7] = {
    {0x0E,0x11,0x11,0x1F,0x11,0x11,0x11}, // A
    {0x1E,0x11,0x11,0x1E,0x11,0x11,0x1E}, // B
    {0x0E,0x11,0x10,0x10,0x10,0x11,0x0E}, // C
    {0x1E,0x11,0x11,0x11,0x11,0x11,0x1E}, // D
    {0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F}, // E
    {0x1F,0x10,0x10,0x1E,0x10,0x10,0x10}, // F
    {0x0E,0x11,0x10,0x17,0x11,0x11,0x0F}, // G
    {0x11,0x11,0x11,0x1F,0x11,0x11,0x11}, // H
    {0x0E,0x04,0x04,0x04,0x04,0x04,0x0E}, // I
    {0x07,0x02,0x02,0x02,0x02,0x12,0x0C}, // J
    {0x11,0x12,0x14,0x18,0x14,0x12,0x11}, // K
    {0x10,0x10,0x10,0x10,0x10,0x10,0x1F}, // L
    {0x11,0x1B,0x15,0x15,0x11,0x11,0x11}, // M
    {0x11,0x11,0x19,0x15,0x13,0x11,0x11}, // N
    {0x0E,0x11,0x11,0x11,0x11,0x11,0x0E}, // O
    {0x1E,0x11,0x11,0x1E,0x10,0x10,0x10}, // P
    {0x0E,0x11,0x11,0x11,0x15,0x12,0x0D}, // Q
    {0x1E,0x11,0x11,0x1E,0x14,0x12,0x11}, // R
    {0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E}, // S
    {0x1F,0x04,0x04,0x04,0x04,0x04,0x04}, // T
    {0x11,0x11,0x11,0x11,0x11,0x11,0x0E}, // U
    {0x11,0x11,0x11,0x11,0x11,0x0A,0x04}, // V
    {0x11,0x11,0x11,0x15,0x15,0x1B,0x11}, // W
    {0x11,0x11,0x0A,0x04,0x0A,0x11,0x11}, // X
    {0x11,0x11,0x0A,0x04,0x04,0x04,0x04}, // Y
    {0x1F,0x01,0x02,0x04,0x08,0x10,0x1F}, // Z
};

// Plot one glyph at (x0,y0) into the BGRA pixel buffer (row 0 = top), scaled.
static void draw_char(uint8_t *px, uint32_t W, uint32_t H, int x0, int y0, char c,
                      int scale, uint8_t R, uint8_t G, uint8_t B) {
    const uint8_t *g = NULL;
    uint8_t dot[7]    = {0,0,0,0,0,0,0x04};
    uint8_t hyphen[7] = {0,0,0,0x0E,0,0,0};
    uint8_t apos[7]   = {0x04,0x04,0,0,0,0,0};
    if (c >= 'A' && c <= 'Z') g = FONT_AZ[c - 'A'];
    else if (c == '.')        g = dot;
    else if (c == '-')        g = hyphen;
    else if (c == '\'')       g = apos;
    else return;                                   // space / unknown → blank cell
    for (int row = 0; row < 7; row++)
        for (int col = 0; col < 5; col++)
            if (g[row] & (1u << (4 - col)))
                for (int sy = 0; sy < scale; sy++) for (int sx = 0; sx < scale; sx++) {
                    int X = x0 + col*scale + sx, Y = y0 + row*scale + sy;
                    if (X >= 0 && X < (int)W && Y >= 0 && Y < (int)H) {
                        uint8_t *p = px + ((size_t)Y * W + X) * 4;
                        p[0] = B; p[1] = G; p[2] = R; p[3] = 255;   // BGRA
                    }
                }
}
static void draw_text(uint8_t *px, uint32_t W, uint32_t H, int x, int y, const char *s,
                      int scale, uint8_t R, uint8_t G, uint8_t B) {
    for (const char *c = s; *c; c++) { draw_char(px, W, H, x, y, *c, scale, R, G, B); x += 6*scale; }
}

// Reduce a display name ("Rickey Henderson (b.1958)") to an UPPER-CASE last name
// ("HENDERSON") for the on-chart label — the native echo of main.js's lastNameOf.
static void last_name_upper(char *dst, const char *src) {
    char buf[256]; size_t n = 0;
    for (const char *c = src; *c && n < 255; c++) {            // drop the " (b.YYYY)" disambiguator
        if (c[0] == ' ' && c[1] == '(' && c[2] == 'b' && c[3] == '.') break;
        buf[n++] = *c;
    }
    buf[n] = 0;
    char *sp = strrchr(buf, ' ');                              // last token = surname
    const char *ln = sp ? sp + 1 : buf;
    size_t i = 0;
    for (; ln[i] && i < 63; i++) { char ch = ln[i]; if (ch >= 'a' && ch <= 'z') ch -= 32; dst[i] = ch; }
    dst[i] = 0;
}

// A frontier point in HR/SB units, used only to sort the staircase by x.
typedef struct { float x, y; } FPoint;
static int fpoint_by_x(const void *a, const void *b) {
    float ax = ((const FPoint *)a)->x, bx = ((const FPoint *)b)->x;
    return ax < bx ? -1 : ax > bx ? 1 : 0;
}

// Build the frontier staircase as a line strip (in HR/SB units) into `out`; returns the vertex
// count. skyline.comp (GPU) has just flagged the non-dominated players in onFront[]; their smoothed
// coordinates live in pos[] (interleaved x,y floats). We gather the flagged points, sort by x
// ascending — a non-dominated set then has strictly DESCENDING y and DISTINCT x (if two shared an x
// the higher-y one would dominate the other, so they can't both be on-front) — and emit the same
// step geometry the web app and the baseline used: a cap on the y-axis at the top point, a vertical
// drop at each x down to the next lower y, and a final drop to the x-axis.
//
// WHY THE CPU DOES THIS (and not the GPU, on Vulkan): the buffers are host-coherent unified memory
// on Apple, so reading pos[]/onFront[] right after the frame fence is essentially free — far simpler
// than a GPU compaction+sort+indirect-draw. The frontier is tiny (tens of points), so the O(K log K)
// sort is nothing. (The WebGPU twin CANNOT do this cheaply — its GPU→CPU readback is async and the
// documented headless device-loss trigger — so it builds the staircase fully on the GPU instead.
// See ../docs/rendering.md (orig: gpu-spring-skyline-design.md, git history).)
static uint32_t build_staircase_gpu(float *out, const float *pos,
                                    const uint32_t *onFront, uint32_t playerCount) {
    static FPoint fr[MAX_FRONT];
    int n = 0;
    for (uint32_t i = 0; i < playerCount; i++) if (onFront[i]) {
        assert(n < MAX_FRONT);
        fr[n].x = pos[i*2]; fr[n].y = pos[i*2 + 1]; n++;
    }
    if (n == 0) return 0;
    qsort(fr, (size_t)n, sizeof(FPoint), fpoint_by_x);
    uint32_t v = 0;
    out[v*2] = 0.0f; out[v*2 + 1] = fr[0].y; v++;                          // left cap on the y-axis
    for (int i = 0; i < n; i++) {
        out[v*2] = fr[i].x; out[v*2 + 1] = fr[i].y;                     v++;  // the point
        out[v*2] = fr[i].x; out[v*2 + 1] = (i < n-1) ? fr[i+1].y : 0.0f; v++;  // drop at this x
    }
    return v;                                                  // last drop reaches the x-axis
}

// ============================================================================
int main(void) {
    int snapshot = getenv("BL2D_SNAPSHOT") != NULL;
    int validate = getenv("BL2D_VALIDATE") != NULL;

    // ------------------------------------------------------------------
    // DECODE both .evt streams into one date-sorted event list. The body
    // runs once per file (f=0 HR, f=1 SB); each player is interned by name so
    // a batter present in only one file still gets a row.
    // ------------------------------------------------------------------
    for (int i = 0; i < HASH_SIZE; i++) g_hash[i] = -1;
    const char *paths[2] = { "../data/pbp/hr.evt.gz", "../data/pbp/sb.evt.gz" };
    uint32_t maxHR = 0, maxSB = 0, numDates = 0;

    // Generous upper bound on total events (each event is >= 2 varint bytes).
    size_t evCap = 0;
    g_ev = NULL; g_evN = 0;

    for (int f = 0; f < 2; f++) {
        size_t len, p = 0;
        uint8_t *b = gunzip_file(paths[f], &len);
        if (memcmp(b, "STEV", 4) != 0) { fprintf(stderr, "%s: bad magic\n", paths[f]); exit(1); }
        p = 4;
        p += 1;                                   // version
        p += 1 + b[p];                            // stat name (u8 len + bytes)
        uint16_t nDates   = b[p] | (b[p + 1] << 8); p += 2;
        uint16_t nSeasons = b[p] | (b[p + 1] << 8); p += 2;

        // seasons: {u16 year, u16 nDates}. Build global-date -> year on file 0.
        static uint16_t *dateYear; if (f == 0) { numDates = nDates; dateYear = malloc(nDates * sizeof(uint16_t)); }
        uint32_t dcur = 0;
        for (int s = 0; s < nSeasons; s++) {
            uint16_t year = b[p] | (b[p + 1] << 8); p += 2;
            uint16_t snd  = b[p] | (b[p + 1] << 8); p += 2;
            if (f == 0) for (int k = 0; k < snd; k++) dateYear[dcur++] = year;
        }
        p += 2 * (size_t)nDates;                  // skip dayOfYear[]
        uint32_t nPlayers = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24); p += 4;

        // grow the global event array by this file's worst case
        evCap += len; g_ev = realloc(g_ev, evCap * sizeof(Ev));

        // Player dict (all names first), then event blocks in the same order.
        int *idxOf = malloc(nPlayers * sizeof(int));
        for (uint32_t i = 0; i < nPlayers; i++) {
            uint8_t nl = b[p++]; char nm[256];
            memcpy(nm, b + p, nl); nm[nl] = 0; p += nl;
            idxOf[i] = intern(nm);
        }
        for (uint32_t i = 0; i < nPlayers; i++) {
            int idx = idxOf[i];
            uint32_t nev = read_varint(b, &p), date = 0, cum = 0;
            for (uint32_t e = 0; e < nev; e++) {
                date += read_varint(b, &p);
                uint32_t cnt = read_varint(b, &p);
                cum += cnt;
                g_ev[g_evN++] = (Ev){ date, (uint32_t)idx, cnt, (uint32_t)f };
            }
            if (nev) {
                uint16_t y = dateYear[g_ev[g_evN - nev].date];   // year of first event
                if (y < g_debut[idx]) g_debut[idx] = y;
                if (f == 0) { if (cum > maxHR) maxHR = cum; } else { if (cum > maxSB) maxSB = cum; }
            }
        }
        free(idxOf);
        free(b);
    }
    uint32_t playerCount = (uint32_t)g_n;

    // Sort all events by game-date so the cursor can walk them forward.
    qsort(g_ev, g_evN, sizeof(Ev), ev_by_date);
    printf("decoded %u players  maxHR=%u maxSB=%u  events=%u  dates=%u\n",
           playerCount, maxHR, maxSB, g_evN, numDates);

    // Pack the events for the GPU (3 uints each: player, stat, count) and the
    // per-player debut years (for era colour). Counters start at zero.
    uint32_t *evPacked = malloc((size_t)g_evN * 3 * 4);
    for (uint32_t i = 0; i < g_evN; i++) {
        evPacked[i*3+0] = g_ev[i].player;
        evPacked[i*3+1] = g_ev[i].stat;
        evPacked[i*3+2] = g_ev[i].count;
    }
    uint32_t *zeros = calloc(playerCount, 8);  // 8 bytes/player: big enough to zero-init a vec2 buffer

    // ------------------------------------------------------------------
    // WINDOW (GLFW must use the Homebrew Vulkan loader; hidden when headless)
    // ------------------------------------------------------------------
    glfwInitVulkanLoader(vkGetInstanceProcAddr);
    glfwInit();
    glfwWindowHint(GLFW_CLIENT_API, GLFW_NO_API);
    if (snapshot) glfwWindowHint(GLFW_VISIBLE, GLFW_FALSE);
    GLFWwindow *window = glfwCreateWindow(1000, 800, "MLB HR vs SB Replay", NULL, NULL);

    // ------------------------------------------------------------------
    // INSTANCE — macOS/MoltenVK needs the portability-enumeration extension
    // AND its create flag, else zero physical devices are reported.
    // ------------------------------------------------------------------
    uint32_t glfwExtN = 0;
    const char **glfwExt = glfwGetRequiredInstanceExtensions(&glfwExtN);
    const char *instExt[16]; uint32_t instExtN = 0;
    for (uint32_t i = 0; i < glfwExtN; i++) instExt[instExtN++] = glfwExt[i];
    instExt[instExtN++] = "VK_KHR_portability_enumeration";
    instExt[instExtN++] = "VK_KHR_get_physical_device_properties2";  // dep of portability_subset
    const char *layers[] = { "VK_LAYER_KHRONOS_validation" };

    VkApplicationInfo app = { .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
                              .apiVersion = VK_API_VERSION_1_2 };
    VkInstanceCreateInfo ici = { .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
                                 .flags = VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR,
                                 .pApplicationInfo = &app,
                                 .enabledExtensionCount = instExtN,
                                 .ppEnabledExtensionNames = instExt,
                                 .enabledLayerCount = validate ? 1u : 0u,
                                 .ppEnabledLayerNames = layers };
    VkInstance instance;
    vk_check(vkCreateInstance(&ici, NULL, &instance));

    VkSurfaceKHR surface;
    vk_check(glfwCreateWindowSurface(instance, window, NULL, &surface));

    // ------------------------------------------------------------------
    // PHYSICAL DEVICE + a queue family with graphics + present (compute and
    // transfer are implied by a graphics-capable family on MoltenVK).
    // ------------------------------------------------------------------
    uint32_t devN = 1; VkPhysicalDevice phys;
    vkEnumeratePhysicalDevices(instance, &devN, &phys);
    if (devN == 0) { fprintf(stderr, "no Vulkan devices\n"); exit(1); }

    uint32_t qfN = 0; vkGetPhysicalDeviceQueueFamilyProperties(phys, &qfN, NULL);
    VkQueueFamilyProperties qf[16]; if (qfN > 16) qfN = 16;
    vkGetPhysicalDeviceQueueFamilyProperties(phys, &qfN, qf);
    uint32_t qfi = UINT32_MAX;
    for (uint32_t i = 0; i < qfN; i++) {
        VkBool32 present = VK_FALSE;
        vkGetPhysicalDeviceSurfaceSupportKHR(phys, i, surface, &present);
        if ((qf[i].queueFlags & VK_QUEUE_GRAPHICS_BIT) && present) { qfi = i; break; }
    }
    if (qfi == UINT32_MAX) { fprintf(stderr, "no graphics+present queue\n"); exit(1); }

    float prio = 1.0f;
    VkDeviceQueueCreateInfo qci = { .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
                                    .queueFamilyIndex = qfi, .queueCount = 1, .pQueuePriorities = &prio };
    const char *devExt[] = { VK_KHR_SWAPCHAIN_EXTENSION_NAME, "VK_KHR_portability_subset" };
    VkPhysicalDeviceFeatures feats = { .largePoints = VK_TRUE };  // point size > 1
    VkDeviceCreateInfo dci = { .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
                               .queueCreateInfoCount = 1, .pQueueCreateInfos = &qci,
                               .enabledExtensionCount = 2, .ppEnabledExtensionNames = devExt,
                               .pEnabledFeatures = &feats };
    VkDevice device; vk_check(vkCreateDevice(phys, &dci, NULL, &device));
    VkQueue queue; vkGetDeviceQueue(device, qfi, 0, &queue);

    // ------------------------------------------------------------------
    // SWAPCHAIN (B8G8R8A8, FIFO). TRANSFER_SRC so the snapshot can copy out.
    // ------------------------------------------------------------------
    VkSurfaceCapabilitiesKHR caps;
    vkGetPhysicalDeviceSurfaceCapabilitiesKHR(phys, surface, &caps);
    VkExtent2D extent = caps.currentExtent.width != UINT32_MAX ? caps.currentExtent
                                                               : (VkExtent2D){1000, 800};
    uint32_t imgCount = caps.minImageCount + 1;
    if (caps.maxImageCount && imgCount > caps.maxImageCount) imgCount = caps.maxImageCount;

    VkSwapchainCreateInfoKHR sci = {
        .sType = VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR, .surface = surface,
        .minImageCount = imgCount, .imageFormat = VK_FORMAT_B8G8R8A8_UNORM,
        .imageColorSpace = VK_COLOR_SPACE_SRGB_NONLINEAR_KHR, .imageExtent = extent,
        .imageArrayLayers = 1,
        .imageUsage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
        .imageSharingMode = VK_SHARING_MODE_EXCLUSIVE, .preTransform = caps.currentTransform,
        .compositeAlpha = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR, .presentMode = VK_PRESENT_MODE_FIFO_KHR,
        .clipped = VK_TRUE };
    VkSwapchainKHR swapchain; vk_check(vkCreateSwapchainKHR(device, &sci, NULL, &swapchain));

    vkGetSwapchainImagesKHR(device, swapchain, &imgCount, NULL);
    VkImage scImages[8]; if (imgCount > 8) imgCount = 8;
    vkGetSwapchainImagesKHR(device, swapchain, &imgCount, scImages);

    VkImageView scViews[8];
    for (uint32_t i = 0; i < imgCount; i++) {
        VkImageViewCreateInfo vi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO,
            .image = scImages[i], .viewType = VK_IMAGE_VIEW_TYPE_2D, .format = VK_FORMAT_B8G8R8A8_UNORM,
            .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
        vk_check(vkCreateImageView(device, &vi, NULL, &scViews[i]));
    }

    // ------------------------------------------------------------------
    // RENDER PASS + FRAMEBUFFERS
    // ------------------------------------------------------------------
    VkAttachmentDescription color = { .format = VK_FORMAT_B8G8R8A8_UNORM, .samples = VK_SAMPLE_COUNT_1_BIT,
        .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR, .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
        .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE, .stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE,
        .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED, .finalLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR };
    VkAttachmentReference colorRef = { 0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL };
    VkSubpassDescription subpass = { .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS,
                                     .colorAttachmentCount = 1, .pColorAttachments = &colorRef };
    VkSubpassDependency dep = { .srcSubpass = VK_SUBPASS_EXTERNAL, .dstSubpass = 0,
        .srcStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
        .dstStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
        .dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT };
    VkRenderPassCreateInfo rpci = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO,
        .attachmentCount = 1, .pAttachments = &color, .subpassCount = 1, .pSubpasses = &subpass,
        .dependencyCount = 1, .pDependencies = &dep };
    VkRenderPass renderPass; vk_check(vkCreateRenderPass(device, &rpci, NULL, &renderPass));

    VkFramebuffer framebuffers[8];
    for (uint32_t i = 0; i < imgCount; i++) {
        VkFramebufferCreateInfo fci = { .sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO,
            .renderPass = renderPass, .attachmentCount = 1, .pAttachments = &scViews[i],
            .width = extent.width, .height = extent.height, .layers = 1 };
        vk_check(vkCreateFramebuffer(device, &fci, NULL, &framebuffers[i]));
    }

    // ------------------------------------------------------------------
    // GPU BUFFERS — all host-visible|coherent (Apple unified memory). 8 storage
    // buffers, one shared descriptor set (vs 6 in the baseline; +pos, +vel):
    //   0 events    (player,stat,count x3)  resident, uploaded once
    //   1 hr        per-player counter       compute atomicAdd; spring reads as target
    //   2 sb        per-player counter       compute atomicAdd; spring reads as target
    //   3 debut     per-player debut year    vertex read (era colour)
    //   4 onFront   per-player frontier flag skyline.comp WRITES, vertex read + CPU staircase
    //   5 staircase frontier line-strip xy   CPU writes, vertex read (line draw)
    //   6 pos       per-player vec2 position spring WRITES; skyline + vertex + CPU read
    //   7 vel       per-player vec2 velocity spring read-write (motion state)
    // hr/sb need TRANSFER_DST so the loop can zero them on wrap; pos/vel too (so a
    // wrap snaps the cloud back to the origin for a crisp replay).
    // ------------------------------------------------------------------
    VkMemoryPropertyFlags hostMem = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
    VkBufferUsageFlags storage  = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
    VkBufferUsageFlags storageT = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    VkBuffer buf[8]; VkDeviceMemory bmem[8];
    VkDeviceSize bsize[8] = {
        (VkDeviceSize)g_evN * 3 * 4,          // 0 events
        (VkDeviceSize)playerCount * 4,        // 1 hr
        (VkDeviceSize)playerCount * 4,        // 2 sb
        (VkDeviceSize)playerCount * 4,        // 3 debut
        (VkDeviceSize)playerCount * 4,        // 4 onFront
        (VkDeviceSize)MAX_FRONT * 2 * 2 * 8,  // 5 staircase (<=1+2*(K-1) vec2)
        (VkDeviceSize)playerCount * 8,        // 6 pos (vec2 = 2 floats)
        (VkDeviceSize)playerCount * 8 };      // 7 vel (vec2)
    create_buffer(device, phys, bsize[0], storage,  hostMem, evPacked, &buf[0], &bmem[0]);
    create_buffer(device, phys, bsize[1], storageT, hostMem, zeros,    &buf[1], &bmem[1]);
    create_buffer(device, phys, bsize[2], storageT, hostMem, zeros,    &buf[2], &bmem[2]);
    create_buffer(device, phys, bsize[3], storage,  hostMem, g_debut,  &buf[3], &bmem[3]);
    create_buffer(device, phys, bsize[4], storage,  hostMem, zeros,    &buf[4], &bmem[4]);
    create_buffer(device, phys, bsize[5], storage,  hostMem, NULL,     &buf[5], &bmem[5]);
    create_buffer(device, phys, bsize[6], storageT, hostMem, zeros,    &buf[6], &bmem[6]);
    create_buffer(device, phys, bsize[7], storageT, hostMem, zeros,    &buf[7], &bmem[7]);
    void *hrMap, *sbMap, *staircaseMap, *posMap;
    vk_check(vkMapMemory(device, bmem[1], 0, bsize[1], 0, &hrMap));
    vk_check(vkMapMemory(device, bmem[2], 0, bsize[2], 0, &sbMap));
    vk_check(vkMapMemory(device, bmem[4], 0, bsize[4], 0, (void **)&g_onFront));
    vk_check(vkMapMemory(device, bmem[5], 0, bsize[5], 0, &staircaseMap));
    vk_check(vkMapMemory(device, bmem[6], 0, bsize[6], 0, &posMap));  // CPU reads pos[] for the staircase

    // ------------------------------------------------------------------
    // DESCRIPTORS — one set layout (8 storage buffers, visible to compute and
    // vertex) shared by ALL pipelines (accumulate, spring, skyline, points, line);
    // one descriptor set bound to each. Declaring every binding visible to both
    // stages is the simplest correct thing — a pipeline simply doesn't reference
    // the bindings it doesn't use (e.g. the vertex stage ignores events/vel).
    // ------------------------------------------------------------------
    enum { NBIND = 8 };
    VkDescriptorSetLayoutBinding binds[NBIND];
    for (int i = 0; i < NBIND; i++)
        binds[i] = (VkDescriptorSetLayoutBinding){ .binding = (uint32_t)i,
            .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .descriptorCount = 1,
            .stageFlags = VK_SHADER_STAGE_COMPUTE_BIT | VK_SHADER_STAGE_VERTEX_BIT };
    VkDescriptorSetLayoutCreateInfo dslci = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
        .bindingCount = NBIND, .pBindings = binds };
    VkDescriptorSetLayout dsl; vk_check(vkCreateDescriptorSetLayout(device, &dslci, NULL, &dsl));

    VkDescriptorPoolSize psize = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, NBIND };
    VkDescriptorPoolCreateInfo pci = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
        .poolSizeCount = 1, .pPoolSizes = &psize, .maxSets = 1 };
    VkDescriptorPool pool; vk_check(vkCreateDescriptorPool(device, &pci, NULL, &pool));
    VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
        .descriptorPool = pool, .descriptorSetCount = 1, .pSetLayouts = &dsl };
    VkDescriptorSet dset; vk_check(vkAllocateDescriptorSets(device, &dai, &dset));

    VkDescriptorBufferInfo dbi[NBIND]; VkWriteDescriptorSet writes[NBIND];
    for (int i = 0; i < NBIND; i++) {
        dbi[i] = (VkDescriptorBufferInfo){ buf[i], 0, bsize[i] };
        writes[i] = (VkWriteDescriptorSet){ .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
            .dstSet = dset, .dstBinding = (uint32_t)i, .descriptorCount = 1,
            .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &dbi[i] };
    }
    vkUpdateDescriptorSets(device, NBIND, writes, 0, NULL);

    // ------------------------------------------------------------------
    // PIPELINES — three compute passes (accumulate, spring, skyline) and two
    // graphics pipelines (points, line), all sharing the 8-binding descriptor set
    // layout. Each compute pass needs its OWN pipeline layout because their push
    // constants differ in size: accumulate {lo,count}=8B, spring {dt,omega,count}=
    // 12B, skyline {count}=4B.
    // ------------------------------------------------------------------
    VkShaderModule comp     = load_shader(device, "shaders/accumulate.comp.spv");
    VkShaderModule springSm  = load_shader(device, "shaders/spring.comp.spv");
    VkShaderModule skylineSm = load_shader(device, "shaders/skyline.comp.spv");
    VkShaderModule vert = load_shader(device, "shaders/points.vert.spv");
    VkShaderModule frag = load_shader(device, "shaders/points.frag.spv");
    VkShaderModule lvert = load_shader(device, "shaders/line.vert.spv");
    VkShaderModule lfrag = load_shader(device, "shaders/line.frag.spv");

    // Small helper-free inline: build a compute pipeline (layout + pipeline) for a
    // module with a push-constant range of `pcSize` bytes. Written out three times
    // rather than via a helper to keep the straight-line POC style.
    VkPushConstantRange cpcRange = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 8 };  // accumulate {lo,count}
    VkPipelineLayoutCreateInfo cplci = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        .setLayoutCount = 1, .pSetLayouts = &dsl, .pushConstantRangeCount = 1, .pPushConstantRanges = &cpcRange };
    VkPipelineLayout computeLayout; vk_check(vkCreatePipelineLayout(device, &cplci, NULL, &computeLayout));
    VkComputePipelineCreateInfo cpci = { .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
                   .stage = VK_SHADER_STAGE_COMPUTE_BIT, .module = comp, .pName = "main" },
        .layout = computeLayout };
    VkPipeline computePipe; vk_check(vkCreateComputePipelines(device, VK_NULL_HANDLE, 1, &cpci, NULL, &computePipe));

    // spring pass: push {float dt; float omega; uint count} = 12 bytes.
    VkPushConstantRange spcRange = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 12 };
    VkPipelineLayoutCreateInfo splci = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        .setLayoutCount = 1, .pSetLayouts = &dsl, .pushConstantRangeCount = 1, .pPushConstantRanges = &spcRange };
    VkPipelineLayout springLayout; vk_check(vkCreatePipelineLayout(device, &splci, NULL, &springLayout));
    VkComputePipelineCreateInfo spci = { .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
                   .stage = VK_SHADER_STAGE_COMPUTE_BIT, .module = springSm, .pName = "main" },
        .layout = springLayout };
    VkPipeline springPipe; vk_check(vkCreateComputePipelines(device, VK_NULL_HANDLE, 1, &spci, NULL, &springPipe));

    // skyline pass: push {uint count} = 4 bytes.
    VkPushConstantRange skcRange = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 4 };
    VkPipelineLayoutCreateInfo sklci = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        .setLayoutCount = 1, .pSetLayouts = &dsl, .pushConstantRangeCount = 1, .pPushConstantRanges = &skcRange };
    VkPipelineLayout skylineLayout; vk_check(vkCreatePipelineLayout(device, &sklci, NULL, &skylineLayout));
    VkComputePipelineCreateInfo skci = { .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
                   .stage = VK_SHADER_STAGE_COMPUTE_BIT, .module = skylineSm, .pName = "main" },
        .layout = skylineLayout };
    VkPipeline skylinePipe; vk_check(vkCreateComputePipelines(device, VK_NULL_HANDLE, 1, &skci, NULL, &skylinePipe));

    VkPushConstantRange gpcRange = { VK_SHADER_STAGE_VERTEX_BIT, 0, 8 };
    VkPipelineLayoutCreateInfo gplci = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        .setLayoutCount = 1, .pSetLayouts = &dsl, .pushConstantRangeCount = 1, .pPushConstantRanges = &gpcRange };
    VkPipelineLayout graphicsLayout; vk_check(vkCreatePipelineLayout(device, &gplci, NULL, &graphicsLayout));

    VkPipelineShaderStageCreateInfo stages[2] = {
        { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
          .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vert, .pName = "main" },
        { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
          .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = frag, .pName = "main" } };
    VkPipelineVertexInputStateCreateInfo vin = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO };
    VkPipelineInputAssemblyStateCreateInfo ia = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
        .topology = VK_PRIMITIVE_TOPOLOGY_POINT_LIST };
    VkViewport viewport = { 0, 0, (float)extent.width, (float)extent.height, 0, 1 };
    VkRect2D scissor = { {0, 0}, extent };
    VkPipelineViewportStateCreateInfo vp = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO,
        .viewportCount = 1, .pViewports = &viewport, .scissorCount = 1, .pScissors = &scissor };
    VkPipelineRasterizationStateCreateInfo rs = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
        .polygonMode = VK_POLYGON_MODE_FILL, .cullMode = VK_CULL_MODE_NONE, .lineWidth = 1.0f };
    VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
        .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT };
    VkPipelineColorBlendAttachmentState cba = { .colorWriteMask = 0xf };
    VkPipelineColorBlendStateCreateInfo cb = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
        .attachmentCount = 1, .pAttachments = &cba };
    VkGraphicsPipelineCreateInfo gpci = { .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO,
        .stageCount = 2, .pStages = stages, .pVertexInputState = &vin, .pInputAssemblyState = &ia,
        .pViewportState = &vp, .pRasterizationState = &rs, .pMultisampleState = &ms,
        .pColorBlendState = &cb, .layout = graphicsLayout, .renderPass = renderPass, .subpass = 0 };
    VkPipeline graphicsPipe; vk_check(vkCreateGraphicsPipelines(device, VK_NULL_HANDLE, 1, &gpci, NULL, &graphicsPipe));

    // Line pipeline for the frontier staircase — same layout/state, but a
    // line-strip topology and the line shaders (vertex-pull from staircase[]).
    VkPipelineShaderStageCreateInfo lstages[2] = {
        { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
          .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = lvert, .pName = "main" },
        { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
          .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = lfrag, .pName = "main" } };
    VkPipelineInputAssemblyStateCreateInfo iaLine = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
        .topology = VK_PRIMITIVE_TOPOLOGY_LINE_STRIP };
    VkGraphicsPipelineCreateInfo lpci = gpci;
    lpci.pStages = lstages; lpci.pInputAssemblyState = &iaLine;
    VkPipeline linePipe; vk_check(vkCreateGraphicsPipelines(device, VK_NULL_HANDLE, 1, &lpci, NULL, &linePipe));

    // ------------------------------------------------------------------
    // COMMAND POOL + per-frame command buffers + sync objects.
    // (render-finished semaphore is per swapchain image, not per frame.)
    // ------------------------------------------------------------------
    VkCommandPoolCreateInfo cpoolci = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
        .flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT, .queueFamilyIndex = qfi };
    VkCommandPool cpool; vk_check(vkCreateCommandPool(device, &cpoolci, NULL, &cpool));

    // FIF = 1: one frame in flight. The CPU rewrites the onFront/staircase
    // buffers every frame, so we fully serialize (wait the fence before writing)
    // rather than double-buffer them — simplest correct choice for a POC.
    enum { FIF = 1 };
    VkCommandBuffer cmd[FIF];
    VkCommandBufferAllocateInfo cbai = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
        .commandPool = cpool, .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = FIF };
    vk_check(vkAllocateCommandBuffers(device, &cbai, cmd));

    VkSemaphore imgAvail[FIF], renderDone[8]; VkFence inFlight[FIF];
    VkSemaphoreCreateInfo seci = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO };
    VkFenceCreateInfo feci = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO,
                               .flags = VK_FENCE_CREATE_SIGNALED_BIT };
    for (int i = 0; i < FIF; i++) { vkCreateSemaphore(device, &seci, NULL, &imgAvail[i]);
                                    vkCreateFence(device, &feci, NULL, &inFlight[i]); }
    for (uint32_t i = 0; i < imgCount; i++) vkCreateSemaphore(device, &seci, NULL, &renderDone[i]);

    VkClearValue clear = { .color = { { 0.04f, 0.05f, 0.09f, 1.0f } } };
    float gpc[2] = { (float)maxHR, (float)maxSB };  // graphics push: axis maxima
    float omega = 12.0f;                            // spring stiffness (1/sec) → ~0.3s settle
    // Barrier: a compute pass's storage WRITE feeds the next compute pass's READ.
    // Used twice per frame: accumulate(hr/sb) → spring(reads), and spring(pos) →
    // skyline(reads). One generic barrier covers all storage hazards between dispatches.
    VkMemoryBarrier storageRW = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT,
        .dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT };
    // Barrier: the last compute writes (skyline→onFront, spring→pos) -> vertex reads them.
    VkMemoryBarrier compToVert = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT, .dstAccessMask = VK_ACCESS_SHADER_READ_BIT };
    // Barrier: transfer (fill-buffer zeroing on wrap) -> compute reads/writes.
    VkMemoryBarrier fillToComp = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
        .dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT };

    if (snapshot) {
        // -------------------- HEADLESS SNAPSHOT --------------------
        // The live loop's GPU passes can't be screenshotted here, so we run them
        // once at the FINAL state and assert their invariants:
        //   submit 1 (compute): accumulate ALL events → SETTLE the springs (one
        //     spring dispatch with a huge dt drives pos → target in a single step,
        //     keeping the snapshot cheap even on a software device) → skyline once.
        //   then (CPU): build the staircase from the settled pos[]/onFront[].
        //   submit 2 (graphics): render points + staircase, copy the image out.
        // A CPU replay (hrc/sbc) is the oracle for all three invariant checks.
        uint32_t *hrc = calloc(playerCount, 4), *sbc = calloc(playerCount, 4);
        for (uint32_t i = 0; i < g_evN; i++) {
            uint32_t p = g_ev[i].player;
            (g_ev[i].stat == 0 ? hrc : sbc)[p] += g_ev[i].count;
        }

        VkBuffer rb; VkDeviceMemory rbmem;
        VkDeviceSize rbsize = (VkDeviceSize)extent.width * extent.height * 4;
        create_buffer(device, phys, rbsize, VK_BUFFER_USAGE_TRANSFER_DST_BIT, hostMem, NULL, &rb, &rbmem);

        // Push-constant payloads for the three compute passes.
        struct { uint32_t lo, count; }              acc_pc = { 0u, g_evN };
        struct { float dt, omega; uint32_t count; } spr_pc = { 1000.0f, omega, playerCount };  // huge dt → settle now
        uint32_t                                    sky_pc = playerCount;

        VkCommandBufferBeginInfo bi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };

        // ---- submit 1: accumulate → spring settle → skyline (compute only) ----
        vkBeginCommandBuffer(cmd[0], &bi);
        vkCmdBindPipeline(cmd[0], VK_PIPELINE_BIND_POINT_COMPUTE, computePipe);
        vkCmdBindDescriptorSets(cmd[0], VK_PIPELINE_BIND_POINT_COMPUTE, computeLayout, 0, 1, &dset, 0, NULL);
        vkCmdPushConstants(cmd[0], computeLayout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 8, &acc_pc);
        vkCmdDispatch(cmd[0], (g_evN + 63) / 64, 1, 1);
        vkCmdPipelineBarrier(cmd[0], VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                             0, 1, &storageRW, 0, NULL, 0, NULL);            // accumulate hr/sb → spring reads
        vkCmdBindPipeline(cmd[0], VK_PIPELINE_BIND_POINT_COMPUTE, springPipe);
        vkCmdBindDescriptorSets(cmd[0], VK_PIPELINE_BIND_POINT_COMPUTE, springLayout, 0, 1, &dset, 0, NULL);
        vkCmdPushConstants(cmd[0], springLayout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 12, &spr_pc);
        vkCmdDispatch(cmd[0], (playerCount + 63) / 64, 1, 1);
        vkCmdPipelineBarrier(cmd[0], VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                             0, 1, &storageRW, 0, NULL, 0, NULL);            // spring pos → skyline reads
        vkCmdBindPipeline(cmd[0], VK_PIPELINE_BIND_POINT_COMPUTE, skylinePipe);
        vkCmdBindDescriptorSets(cmd[0], VK_PIPELINE_BIND_POINT_COMPUTE, skylineLayout, 0, 1, &dset, 0, NULL);
        vkCmdPushConstants(cmd[0], skylineLayout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &sky_pc);
        vkCmdDispatch(cmd[0], (playerCount + 63) / 64, 1, 1);
        vkEndCommandBuffer(cmd[0]);
        VkSubmitInfo si1 = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
            .commandBufferCount = 1, .pCommandBuffers = &cmd[0] };
        vkResetFences(device, 1, &inFlight[0]);
        vk_check(vkQueueSubmit(queue, 1, &si1, inFlight[0]));
        vkWaitForFences(device, 1, &inFlight[0], VK_TRUE, UINT64_MAX);

        // CPU staircase from the settled GPU pos[] + onFront[] (host-coherent).
        uint32_t lineVerts = build_staircase_gpu(staircaseMap, posMap, g_onFront, playerCount);

        // ---- submit 2: render points + staircase, copy image to a host buffer ----
        uint32_t img;
        vkAcquireNextImageKHR(device, swapchain, UINT64_MAX, imgAvail[0], VK_NULL_HANDLE, &img);
        vkResetCommandBuffer(cmd[0], 0);
        vkBeginCommandBuffer(cmd[0], &bi);
        VkRenderPassBeginInfo rpbi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO,
            .renderPass = renderPass, .framebuffer = framebuffers[img], .renderArea = scissor,
            .clearValueCount = 1, .pClearValues = &clear };
        vkCmdBeginRenderPass(cmd[0], &rpbi, VK_SUBPASS_CONTENTS_INLINE);
        vkCmdBindPipeline(cmd[0], VK_PIPELINE_BIND_POINT_GRAPHICS, graphicsPipe);
        vkCmdBindDescriptorSets(cmd[0], VK_PIPELINE_BIND_POINT_GRAPHICS, graphicsLayout, 0, 1, &dset, 0, NULL);
        vkCmdPushConstants(cmd[0], graphicsLayout, VK_SHADER_STAGE_VERTEX_BIT, 0, 8, gpc);
        vkCmdDraw(cmd[0], playerCount, 1, 0, 0);
        if (lineVerts >= 2) {                       // draw the frontier staircase
            vkCmdBindPipeline(cmd[0], VK_PIPELINE_BIND_POINT_GRAPHICS, linePipe);
            vkCmdPushConstants(cmd[0], graphicsLayout, VK_SHADER_STAGE_VERTEX_BIT, 0, 8, gpc);
            vkCmdDraw(cmd[0], lineVerts, 1, 0, 0);
        }
        vkCmdEndRenderPass(cmd[0]);
        VkImageMemoryBarrier ib = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
            .oldLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR, .newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
            .srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT, .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT,
            .image = scImages[img], .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
        vkCmdPipelineBarrier(cmd[0], VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT,
                             0, 0, NULL, 0, NULL, 1, &ib);
        VkBufferImageCopy region = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
                                     .imageExtent = { extent.width, extent.height, 1 } };
        vkCmdCopyImageToBuffer(cmd[0], scImages[img], VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, rb, 1, &region);
        vkEndCommandBuffer(cmd[0]);
        VkPipelineStageFlags wait = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
        VkSubmitInfo si2 = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
            .waitSemaphoreCount = 1, .pWaitSemaphores = &imgAvail[0], .pWaitDstStageMask = &wait,
            .commandBufferCount = 1, .pCommandBuffers = &cmd[0] };
        vkResetFences(device, 1, &inFlight[0]);
        vk_check(vkQueueSubmit(queue, 1, &si2, inFlight[0]));
        vkWaitForFences(device, 1, &inFlight[0], VK_TRUE, UINT64_MAX);

        // (1) GPU counters == CPU replay (validates accumulate.comp, unchanged).
        const uint32_t *hg = hrMap, *sg = sbMap;
        const float    *pg = posMap;                 // interleaved x,y per player
        uint32_t mism = 0;
        for (uint32_t i = 0; i < playerCount; i++)
            if (hg[i] != hrc[i] || sg[i] != sbc[i]) mism++;
        printf("snapshot (all %u events): counter mismatches: %u / %u\n", g_evN, mism, playerCount);

        // (2) Springs converged: settled pos ≈ integer (hr,sb) (validates spring.comp).
        uint32_t smis = 0;
        for (uint32_t i = 0; i < playerCount; i++) {
            float dx = pg[i*2] - (float)hrc[i], dy = pg[i*2 + 1] - (float)sbc[i];
            if (dx < -0.5f || dx > 0.5f || dy < -0.5f || dy > 0.5f) smis++;
        }
        printf("spring: |pos - (hr,sb)| > 0.5 mismatches: %u / %u\n", smis, playerCount);

        // (3) GPU skyline == brute-force O(N^2) Pareto (validates skyline.comp).
        //     dom[i] = player i is strictly dominated by someone; on-front ⇔ !dom.
        uint8_t *dom = calloc(playerCount, 1);
        for (uint32_t i = 0; i < playerCount; i++)
            for (uint32_t j = 0; j < playerCount; j++)
                if (hrc[j] >= hrc[i] && sbc[j] >= sbc[i] && (hrc[j] > hrc[i] || sbc[j] > sbc[i])) { dom[i] = 1; break; }
        uint32_t fmis = 0, frontN = 0;
        for (uint32_t i = 0; i < playerCount; i++) {
            int onFr = g_onFront[i] != 0u;
            if (onFr) frontN++;
            if (onFr == (int)dom[i]) fmis++;        // on-front must equal NOT-dominated
        }
        printf("skyline: GPU onFront vs brute-force: %u mismatches (frontier size %u)\n", fmis, frontN);

        // Frontier endpoints (leftmost / rightmost on-front by HR) + record-holders.
        int sbEnd = -1, hrEnd = -1;
        for (uint32_t i = 0; i < playerCount; i++) if (g_onFront[i]) {
            if (sbEnd < 0 || hrc[i] < hrc[sbEnd]) sbEnd = (int)i;
            if (hrEnd < 0 || hrc[i] > hrc[hrEnd]) hrEnd = (int)i;
        }
        if (sbEnd >= 0) printf("  SB end: %-18s HR=%u SB=%u\n", g_name[sbEnd], hrc[sbEnd], sbc[sbEnd]);
        if (hrEnd >= 0) printf("  HR end: %-18s HR=%u SB=%u\n", g_name[hrEnd], hrc[hrEnd], sbc[hrEnd]);
        for (uint32_t i = 0; i < playerCount; i++)
            if (!strcmp(g_name[i], "Barry Bonds") || !strcmp(g_name[i], "Rickey Henderson"))
                printf("  %-18s HR=%u SB=%u  %s\n", g_name[i], hg[i], sg[i], g_onFront[i] ? "[frontier]" : "");

        void *px; vk_check(vkMapMemory(device, rbmem, 0, rbsize, 0, &px));
        // Label each frontier player by name, mapping (hr,sb) to pixels with the SAME transform
        // points.vert uses (incl. the Vulkan +Y-down flip: clip_y = -y_ndc; row 0 = top).
        for (uint32_t i = 0; i < playerCount; i++) if (g_onFront[i]) {
            float xn = (float)hrc[i] / (maxHR < 1 ? 1.f : (float)maxHR) * 1.9f - 0.95f;
            float yn = (float)sbc[i] / (maxSB < 1 ? 1.f : (float)maxSB) * 1.9f - 0.95f;
            int pxX = (int)((xn * 0.5f + 0.5f) * extent.width);
            int pxY = (int)(((-yn) * 0.5f + 0.5f) * extent.height);   // -yn: Vulkan +Y-down flip
            char ln[64]; last_name_upper(ln, g_name[i]);
            int scale = 3, textw = (int)strlen(ln) * 6 * scale;
            int tx = (pxX > (int)extent.width * 72 / 100) ? pxX - 8 - textw : pxX + 8;
            draw_text(px, extent.width, extent.height, tx, pxY - 7*scale/2, ln, scale, 0xEE, 0xF1, 0xF7);
        }
        write_bmp("/tmp/poc-vulkan-spring.bmp", px, extent.width, extent.height);
        vkUnmapMemory(device, rbmem);
        printf("wrote /tmp/poc-vulkan-spring.bmp (%ux%u)\n", extent.width, extent.height);
        return (mism == 0 && smis == 0 && fmis == 0) ? 0 : 1;
    }

    // -------------------- LIVE AUTO-PLAY LOOP --------------------
    // The cursor walks the date-sorted events forward; each frame we run the GPU
    // frame graph:  accumulate (new event slice) → spring (glide pos toward the
    // counters) → skyline (recompute the frontier from pos) → render. spring and
    // skyline run EVERY frame (even with no new events) because pos keeps gliding.
    // On wrap we zero the counters AND pos/vel and replay from the start.
    float cursor = 0.0f, datesPerSec = 600.0f;  // full 1871->2025 sweep ~30 s
    uint32_t applied = 0;
    uint32_t lineVerts = 0;
    double prev = glfwGetTime();
    int fif = 0;
    while (!glfwWindowShouldClose(window)) {
        glfwPollEvents();
        double now = glfwGetTime();
        float dt = (float)(now - prev); prev = now;
        if (dt > 0.05f) dt = 0.05f;             // clamp hitches (first frame, window drag)
        cursor += datesPerSec * dt;
        int wrapped = 0;
        if (cursor >= (float)numDates) { cursor -= (float)numDates; wrapped = 1; }
        uint32_t cursorDate = (uint32_t)cursor;

        // How many events should be applied by now? (forward scan, monotonic)
        if (wrapped) applied = 0;
        uint32_t target = applied;
        while (target < g_evN && g_ev[target].date <= cursorDate) target++;
        uint32_t lo = applied, cnt = target - applied;
        struct { uint32_t lo, count; }              acc_pc = { lo, cnt };
        struct { float dt, omega; uint32_t count; } spr_pc = { dt, omega, playerCount };
        uint32_t                                    sky_pc = playerCount;

        vkWaitForFences(device, 1, &inFlight[fif], VK_TRUE, UINT64_MAX);
        vkResetFences(device, 1, &inFlight[fif]);

        // Build the staircase from the PREVIOUS frame's GPU output (pos[]/onFront[],
        // valid now that we've waited the fence; FIF=1 ⇒ that submit is complete).
        // This lags the cloud by one frame (~16 ms, imperceptible) but avoids a
        // mid-frame GPU→CPU→GPU stall. On the very first frame these are still zero
        // (onFront all 0), so lineVerts==0 and no line is drawn.
        lineVerts = build_staircase_gpu(staircaseMap, posMap, g_onFront, playerCount);

        uint32_t img;
        vkAcquireNextImageKHR(device, swapchain, UINT64_MAX, imgAvail[fif], VK_NULL_HANDLE, &img);

        vkResetCommandBuffer(cmd[fif], 0);
        VkCommandBufferBeginInfo bi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
        vkBeginCommandBuffer(cmd[fif], &bi);
        if (wrapped) {                          // reset counters AND motion state, then replay
            vkCmdFillBuffer(cmd[fif], buf[1], 0, bsize[1], 0);  // hr
            vkCmdFillBuffer(cmd[fif], buf[2], 0, bsize[2], 0);  // sb
            vkCmdFillBuffer(cmd[fif], buf[6], 0, bsize[6], 0);  // pos
            vkCmdFillBuffer(cmd[fif], buf[7], 0, bsize[7], 0);  // vel
            // Make the zeroing visible to the compute passes that read it this frame.
            vkCmdPipelineBarrier(cmd[fif], VK_PIPELINE_STAGE_TRANSFER_BIT,
                                 VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                                 0, 1, &fillToComp, 0, NULL, 0, NULL);
        }
        // accumulate: fold the new event slice into hr/sb (skip if no new events).
        if (cnt > 0) {
            vkCmdBindPipeline(cmd[fif], VK_PIPELINE_BIND_POINT_COMPUTE, computePipe);
            vkCmdBindDescriptorSets(cmd[fif], VK_PIPELINE_BIND_POINT_COMPUTE, computeLayout, 0, 1, &dset, 0, NULL);
            vkCmdPushConstants(cmd[fif], computeLayout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 8, &acc_pc);
            vkCmdDispatch(cmd[fif], (cnt + 63) / 64, 1, 1);
            vkCmdPipelineBarrier(cmd[fif], VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                                 0, 1, &storageRW, 0, NULL, 0, NULL);   // hr/sb → spring reads
        }
        // spring: glide pos[] toward (hr,sb). Always runs (motion continues at rest).
        vkCmdBindPipeline(cmd[fif], VK_PIPELINE_BIND_POINT_COMPUTE, springPipe);
        vkCmdBindDescriptorSets(cmd[fif], VK_PIPELINE_BIND_POINT_COMPUTE, springLayout, 0, 1, &dset, 0, NULL);
        vkCmdPushConstants(cmd[fif], springLayout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 12, &spr_pc);
        vkCmdDispatch(cmd[fif], (playerCount + 63) / 64, 1, 1);
        vkCmdPipelineBarrier(cmd[fif], VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                             0, 1, &storageRW, 0, NULL, 0, NULL);       // pos → skyline reads
        // skyline: recompute the frontier from the smoothed pos[]. Always runs.
        vkCmdBindPipeline(cmd[fif], VK_PIPELINE_BIND_POINT_COMPUTE, skylinePipe);
        vkCmdBindDescriptorSets(cmd[fif], VK_PIPELINE_BIND_POINT_COMPUTE, skylineLayout, 0, 1, &dset, 0, NULL);
        vkCmdPushConstants(cmd[fif], skylineLayout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &sky_pc);
        vkCmdDispatch(cmd[fif], (playerCount + 63) / 64, 1, 1);
        vkCmdPipelineBarrier(cmd[fif], VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_VERTEX_SHADER_BIT,
                             0, 1, &compToVert, 0, NULL, 0, NULL);      // pos + onFront → vertex reads

        VkRenderPassBeginInfo rpbi = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO,
            .renderPass = renderPass, .framebuffer = framebuffers[img], .renderArea = scissor,
            .clearValueCount = 1, .pClearValues = &clear };
        vkCmdBeginRenderPass(cmd[fif], &rpbi, VK_SUBPASS_CONTENTS_INLINE);
        vkCmdBindPipeline(cmd[fif], VK_PIPELINE_BIND_POINT_GRAPHICS, graphicsPipe);
        vkCmdBindDescriptorSets(cmd[fif], VK_PIPELINE_BIND_POINT_GRAPHICS, graphicsLayout, 0, 1, &dset, 0, NULL);
        vkCmdPushConstants(cmd[fif], graphicsLayout, VK_SHADER_STAGE_VERTEX_BIT, 0, 8, gpc);
        vkCmdDraw(cmd[fif], playerCount, 1, 0, 0);
        if (lineVerts >= 2) {                       // draw the frontier staircase
            vkCmdBindPipeline(cmd[fif], VK_PIPELINE_BIND_POINT_GRAPHICS, linePipe);
            vkCmdPushConstants(cmd[fif], graphicsLayout, VK_SHADER_STAGE_VERTEX_BIT, 0, 8, gpc);
            vkCmdDraw(cmd[fif], lineVerts, 1, 0, 0);
        }
        vkCmdEndRenderPass(cmd[fif]);
        vkEndCommandBuffer(cmd[fif]);
        applied = target;

        VkPipelineStageFlags wait = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
        VkSubmitInfo si = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
            .waitSemaphoreCount = 1, .pWaitSemaphores = &imgAvail[fif], .pWaitDstStageMask = &wait,
            .commandBufferCount = 1, .pCommandBuffers = &cmd[fif],
            .signalSemaphoreCount = 1, .pSignalSemaphores = &renderDone[img] };
        vk_check(vkQueueSubmit(queue, 1, &si, inFlight[fif]));

        VkPresentInfoKHR pi = { .sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR,
            .waitSemaphoreCount = 1, .pWaitSemaphores = &renderDone[img],
            .swapchainCount = 1, .pSwapchains = &swapchain, .pImageIndices = &img };
        vkQueuePresentKHR(queue, &pi);
        fif = (fif + 1) % FIF;
    }
    vkDeviceWaitIdle(device);
    return 0;
}
