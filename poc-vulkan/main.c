// ============================================================================
// MLB HR x SB replay — a fully working native Vulkan (MoltenVK) POC.
//
// Implements the Phase-1 design: a CPU time engine streams events to the GPU,
// which accumulates them into persistent per-player counters and renders those.
//
//   CPU  : timeline advances; a cursor walks the date-sorted event list and,
//          each frame, dispatches the GPU over just the NEW [lo, lo+count)
//          slice of events (never re-scanning history). On loop/seek-back the
//          counters are zeroed and replayed (accumulation is forward-only).
//   GPU  : accumulate.comp does  if HR: hr[player]+=n;  if SB: sb[player]+=n
//          (atomicAdd) into persistent state buffers;
//   GPU  : points.vert reads x = hr[player], y = sb[player] straight from those
//          buffers (no CPU readback), era-coloured by debut year.
//
// Data is the committed real corpus (data/pbp/hr.evt.gz + sb.evt.gz, the STEV
// ".evt" format in docs/pbp-evt-format.md) for ~11k batters, 1871-2025.
//
// Headless verification (this env has no Screen Recording permission, so the
// live window can't be screenshotted): BL2D_SNAPSHOT=1 applies all events once,
// then diffs every player's GPU counters against a CPU replay (expect 0
// mismatches) and writes /tmp/poc-vulkan.bmp. BL2D_VALIDATE=1 turns on the
// Khronos validation layer.
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

// Pareto frontier, maintained incrementally. Kept sorted by x ascending (so y
// is strictly descending — a staircase). Parallel arrays + a count.
#define MAX_FRONT 2048                     // real frontier is dozens; assert-guarded
static uint32_t g_frX[MAX_FRONT], g_frY[MAX_FRONT], g_frP[MAX_FRONT];
static int      g_frN;
static uint32_t *g_onFront;                // -> mapped GPU buffer, 1 if on frontier

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

// Incremental Pareto update for player p, which just moved to (x,y). Events are
// monotone (points only go up/right), so: p is the only point that can join the
// frontier; it can evict a contiguous run of points it now dominates; and
// nothing else is ever promoted. The frontier stays sorted by x ascending.
static void frontier_apply_event(uint32_t p, uint32_t x, uint32_t y) {
    // 1. p already on the frontier? Splice out its stale entry (it's moving up/
    //    right; its removal can't promote anyone). Then re-evaluate uniformly.
    if (g_onFront[p]) {
        for (int i = 0; i < g_frN; i++) if (g_frP[i] == p) {
            memmove(&g_frX[i], &g_frX[i+1], (g_frN-i-1)*4);
            memmove(&g_frY[i], &g_frY[i+1], (g_frN-i-1)*4);
            memmove(&g_frP[i], &g_frP[i+1], (g_frN-i-1)*4);
            g_frN--; break;
        }
        g_onFront[p] = 0;
    }
    // 2. Dominated by a current frontier point? The candidate is the first entry
    //    with x' >= x (largest y among those), since y descends with x.
    int k = 0; while (k < g_frN && g_frX[k] < x) k++;
    if (k < g_frN && g_frY[k] >= y) return;          // dominated → not on frontier
    // 3. p joins: drop the contiguous run it dominates (x' <= x && y' <= y)...
    int j = 0; while (j < g_frN && !(g_frX[j] <= x && g_frY[j] <= y)) j++;
    int e = j; while (e < g_frN && g_frX[e] <= x && g_frY[e] <= y) e++;
    if (e > j) {
        memmove(&g_frX[j], &g_frX[e], (g_frN-e)*4);
        memmove(&g_frY[j], &g_frY[e], (g_frN-e)*4);
        memmove(&g_frP[j], &g_frP[e], (g_frN-e)*4);
        g_frN -= e - j;
    }
    // ...then insert p at its sorted slot (j if a run was removed, else by x).
    int ins = (e > j) ? j : 0;
    if (e == j) while (ins < g_frN && g_frX[ins] < x) ins++;
    assert(g_frN + 1 <= MAX_FRONT);
    memmove(&g_frX[ins+1], &g_frX[ins], (g_frN-ins)*4);
    memmove(&g_frY[ins+1], &g_frY[ins], (g_frN-ins)*4);
    memmove(&g_frP[ins+1], &g_frP[ins], (g_frN-ins)*4);
    g_frX[ins] = x; g_frY[ins] = y; g_frP[ins] = p; g_frN++;
    g_onFront[p] = 1;
}

// Build the frontier staircase as a line strip (in HR/SB units) into out;
// returns the vertex count. Each step is a horizontal then a vertical segment.
static uint32_t build_staircase(float *out) {
    if (g_frN == 0) return 0;
    uint32_t n = 0;
    out[n*2] = g_frX[0]; out[n*2+1] = g_frY[0]; n++;
    for (int i = 1; i < g_frN; i++) {
        out[n*2] = g_frX[i]; out[n*2+1] = g_frY[i-1]; n++;   // across at prev y
        out[n*2] = g_frX[i]; out[n*2+1] = g_frY[i];   n++;   // down to new y
    }
    return n;
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
    uint32_t *zeros = calloc(playerCount, 4);

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
    // GPU BUFFERS — all host-visible|coherent (Apple unified memory). 6 storage
    // buffers, one shared descriptor set:
    //   0 events    (player,stat,count x3)  resident, uploaded once
    //   1 hr        per-player counter       compute atomicAdd, vertex read
    //   2 sb        per-player counter       compute atomicAdd, vertex read
    //   3 debut     per-player debut year    vertex read (era colour)
    //   4 onFront   per-player frontier flag CPU writes, vertex read (highlight)
    //   5 staircase frontier line-strip xy   CPU writes, vertex read (line draw)
    // hr/sb also need TRANSFER_DST so the loop can zero them on wrap.
    // ------------------------------------------------------------------
    VkMemoryPropertyFlags hostMem = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
    VkBufferUsageFlags storage  = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
    VkBufferUsageFlags storageT = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    VkBuffer buf[6]; VkDeviceMemory bmem[6];
    VkDeviceSize bsize[6] = {
        (VkDeviceSize)g_evN * 3 * 4,         // 0 events
        (VkDeviceSize)playerCount * 4,       // 1 hr
        (VkDeviceSize)playerCount * 4,       // 2 sb
        (VkDeviceSize)playerCount * 4,       // 3 debut
        (VkDeviceSize)playerCount * 4,       // 4 onFront
        (VkDeviceSize)MAX_FRONT * 2 * 2 * 8 };// 5 staircase (<=1+2*(K-1) vec2)
    create_buffer(device, phys, bsize[0], storage,  hostMem, evPacked, &buf[0], &bmem[0]);
    create_buffer(device, phys, bsize[1], storageT, hostMem, zeros,    &buf[1], &bmem[1]);
    create_buffer(device, phys, bsize[2], storageT, hostMem, zeros,    &buf[2], &bmem[2]);
    create_buffer(device, phys, bsize[3], storage,  hostMem, g_debut,  &buf[3], &bmem[3]);
    create_buffer(device, phys, bsize[4], storage,  hostMem, zeros,    &buf[4], &bmem[4]);
    create_buffer(device, phys, bsize[5], storage,  hostMem, NULL,     &buf[5], &bmem[5]);
    void *hrMap, *sbMap, *staircaseMap;
    vk_check(vkMapMemory(device, bmem[1], 0, bsize[1], 0, &hrMap));
    vk_check(vkMapMemory(device, bmem[2], 0, bsize[2], 0, &sbMap));
    vk_check(vkMapMemory(device, bmem[4], 0, bsize[4], 0, (void **)&g_onFront));
    vk_check(vkMapMemory(device, bmem[5], 0, bsize[5], 0, &staircaseMap));

    // ------------------------------------------------------------------
    // DESCRIPTORS — one set layout (4 storage buffers, visible to compute and
    // vertex) shared by both pipelines; one descriptor set bound to both.
    // ------------------------------------------------------------------
    VkDescriptorSetLayoutBinding binds[6];
    for (int i = 0; i < 6; i++)
        binds[i] = (VkDescriptorSetLayoutBinding){ .binding = (uint32_t)i,
            .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .descriptorCount = 1,
            .stageFlags = VK_SHADER_STAGE_COMPUTE_BIT | VK_SHADER_STAGE_VERTEX_BIT };
    VkDescriptorSetLayoutCreateInfo dslci = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
        .bindingCount = 6, .pBindings = binds };
    VkDescriptorSetLayout dsl; vk_check(vkCreateDescriptorSetLayout(device, &dslci, NULL, &dsl));

    VkDescriptorPoolSize psize = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 6 };
    VkDescriptorPoolCreateInfo pci = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
        .poolSizeCount = 1, .pPoolSizes = &psize, .maxSets = 1 };
    VkDescriptorPool pool; vk_check(vkCreateDescriptorPool(device, &pci, NULL, &pool));
    VkDescriptorSetAllocateInfo dai = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
        .descriptorPool = pool, .descriptorSetCount = 1, .pSetLayouts = &dsl };
    VkDescriptorSet dset; vk_check(vkAllocateDescriptorSets(device, &dai, &dset));

    VkDescriptorBufferInfo dbi[6]; VkWriteDescriptorSet writes[6];
    for (int i = 0; i < 6; i++) {
        dbi[i] = (VkDescriptorBufferInfo){ buf[i], 0, bsize[i] };
        writes[i] = (VkWriteDescriptorSet){ .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
            .dstSet = dset, .dstBinding = (uint32_t)i, .descriptorCount = 1,
            .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &dbi[i] };
    }
    vkUpdateDescriptorSets(device, 6, writes, 0, NULL);

    // ------------------------------------------------------------------
    // PIPELINES — accumulate (push: lo, count) and graphics points (push:
    // maxX, maxY), both using the shared descriptor set layout.
    // ------------------------------------------------------------------
    VkShaderModule comp = load_shader(device, "shaders/accumulate.comp.spv");
    VkShaderModule vert = load_shader(device, "shaders/points.vert.spv");
    VkShaderModule frag = load_shader(device, "shaders/points.frag.spv");
    VkShaderModule lvert = load_shader(device, "shaders/line.vert.spv");
    VkShaderModule lfrag = load_shader(device, "shaders/line.frag.spv");

    VkPushConstantRange cpcRange = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 8 };
    VkPipelineLayoutCreateInfo cplci = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        .setLayoutCount = 1, .pSetLayouts = &dsl, .pushConstantRangeCount = 1, .pPushConstantRanges = &cpcRange };
    VkPipelineLayout computeLayout; vk_check(vkCreatePipelineLayout(device, &cplci, NULL, &computeLayout));

    VkComputePipelineCreateInfo cpci = { .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
                   .stage = VK_SHADER_STAGE_COMPUTE_BIT, .module = comp, .pName = "main" },
        .layout = computeLayout };
    VkPipeline computePipe; vk_check(vkCreateComputePipelines(device, VK_NULL_HANDLE, 1, &cpci, NULL, &computePipe));

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
    // Barrier: compute atomicAdd to hr/sb -> vertex reads them.
    VkMemoryBarrier compToVert = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT, .dstAccessMask = VK_ACCESS_SHADER_READ_BIT };
    // Barrier: transfer (fill-buffer zeroing on wrap) -> compute reads/writes.
    VkMemoryBarrier fillToComp = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
        .dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT };

    if (snapshot) {
        // -------------------- HEADLESS SNAPSHOT --------------------
        // Apply every event once (full careers). Build the frontier on the CPU
        // first so the highlight + staircase are ready to render; then diff the
        // GPU counters vs the CPU replay and the frontier vs a brute-force check.
        // No swapchain present needed, but the image must be acquired first.
        uint32_t *hrc = calloc(playerCount, 4), *sbc = calloc(playerCount, 4);
        for (uint32_t i = 0; i < g_evN; i++) {
            uint32_t p = g_ev[i].player;
            (g_ev[i].stat == 0 ? hrc : sbc)[p] += g_ev[i].count;
            frontier_apply_event(p, hrc[p], sbc[p]);
        }
        uint32_t lineVerts = build_staircase(staircaseMap);
        uint32_t cpc[2] = { 0, g_evN };

        VkBuffer rb; VkDeviceMemory rbmem;
        VkDeviceSize rbsize = (VkDeviceSize)extent.width * extent.height * 4;
        create_buffer(device, phys, rbsize, VK_BUFFER_USAGE_TRANSFER_DST_BIT, hostMem, NULL, &rb, &rbmem);

        uint32_t img;
        vkAcquireNextImageKHR(device, swapchain, UINT64_MAX, imgAvail[0], VK_NULL_HANDLE, &img);

        VkCommandBufferBeginInfo bi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
        vkBeginCommandBuffer(cmd[0], &bi);
        vkCmdBindPipeline(cmd[0], VK_PIPELINE_BIND_POINT_COMPUTE, computePipe);
        vkCmdBindDescriptorSets(cmd[0], VK_PIPELINE_BIND_POINT_COMPUTE, computeLayout, 0, 1, &dset, 0, NULL);
        vkCmdPushConstants(cmd[0], computeLayout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 8, cpc);
        vkCmdDispatch(cmd[0], (g_evN + 63) / 64, 1, 1);
        vkCmdPipelineBarrier(cmd[0], VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_VERTEX_SHADER_BIT,
                             0, 1, &compToVert, 0, NULL, 0, NULL);
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
        VkSubmitInfo si = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
            .waitSemaphoreCount = 1, .pWaitSemaphores = &imgAvail[0], .pWaitDstStageMask = &wait,
            .commandBufferCount = 1, .pCommandBuffers = &cmd[0] };
        vkResetFences(device, 1, &inFlight[0]);
        vk_check(vkQueueSubmit(queue, 1, &si, inFlight[0]));
        vkWaitForFences(device, 1, &inFlight[0], VK_TRUE, UINT64_MAX);

        // (1) GPU counters == CPU replay?
        const uint32_t *hg = hrMap, *sg = sbMap;
        uint32_t mism = 0;
        for (uint32_t i = 0; i < playerCount; i++)
            if (hg[i] != hrc[i] || sg[i] != sbc[i]) mism++;
        printf("snapshot (all %u events): counter mismatches: %u / %u\n", g_evN, mism, playerCount);

        // (2) Incremental frontier == brute-force O(N^2) frontier (as coordinate
        //     sets). dom[i] = player i's (HR,SB) is strictly dominated by someone.
        uint8_t *dom = calloc(playerCount, 1);
        for (uint32_t i = 0; i < playerCount; i++)
            for (uint32_t j = 0; j < playerCount; j++)
                if (hrc[j] >= hrc[i] && sbc[j] >= sbc[i] && (hrc[j] > hrc[i] || sbc[j] > sbc[i])) { dom[i] = 1; break; }
        uint32_t fmis = 0;
        for (int i = 0; i < g_frN; i++) if (dom[g_frP[i]]) fmis++;      // no invalid members
        for (uint32_t i = 0; i < playerCount; i++) if (!dom[i]) {        // every non-dom coord present
            int lo = 0, hi = g_frN;                                     // binary search frX (x distinct)
            while (lo < hi) { int m = (lo + hi) / 2; if (g_frX[m] < hrc[i]) lo = m + 1; else hi = m; }
            if (lo >= g_frN || g_frX[lo] != hrc[i] || g_frY[lo] != sbc[i]) fmis++;
        }
        printf("frontier: incremental vs brute-force: %u mismatches (frontier size %d)\n", fmis, g_frN);

        // frontier endpoints (min-HR/max-SB end and max-HR end) + record-holders
        if (g_frN) printf("  SB end: %-18s HR=%u SB=%u\n", g_name[g_frP[0]], g_frX[0], g_frY[0]);
        if (g_frN) printf("  HR end: %-18s HR=%u SB=%u\n", g_name[g_frP[g_frN-1]], g_frX[g_frN-1], g_frY[g_frN-1]);
        for (uint32_t i = 0; i < playerCount; i++)
            if (!strcmp(g_name[i], "Barry Bonds") || !strcmp(g_name[i], "Rickey Henderson"))
                printf("  %-18s HR=%u SB=%u  %s\n", g_name[i], hg[i], sg[i], g_onFront[i] ? "[frontier]" : "");

        void *px; vk_check(vkMapMemory(device, rbmem, 0, rbsize, 0, &px));
        write_bmp("/tmp/poc-vulkan.bmp", px, extent.width, extent.height);
        vkUnmapMemory(device, rbmem);
        printf("wrote /tmp/poc-vulkan.bmp (%ux%u)\n", extent.width, extent.height);
        return (mism == 0 && fmis == 0) ? 0 : 1;
    }

    // -------------------- LIVE AUTO-PLAY LOOP --------------------
    // The cursor walks the date-sorted events forward; each frame we dispatch
    // the compute over only the newly-passed slice. On wrap we zero the
    // counters and replay from the start (accumulation is forward-only).
    float cursor = 0.0f, datesPerSec = 600.0f;  // full 1871->2025 sweep ~30 s
    uint32_t applied = 0;
    uint32_t *hrCpu = calloc(playerCount, 4), *sbCpu = calloc(playerCount, 4);  // shadow
    uint32_t lineVerts = 0;
    double prev = glfwGetTime();
    int fif = 0;
    while (!glfwWindowShouldClose(window)) {
        glfwPollEvents();
        double now = glfwGetTime(); float dt = (float)(now - prev); prev = now;
        cursor += datesPerSec * dt;
        int wrapped = 0;
        if (cursor >= (float)numDates) { cursor -= (float)numDates; wrapped = 1; }
        uint32_t cursorDate = (uint32_t)cursor;

        // How many events should be applied by now? (forward scan, monotonic)
        if (wrapped) applied = 0;
        uint32_t target = applied;
        while (target < g_evN && g_ev[target].date <= cursorDate) target++;
        uint32_t lo = applied, cnt = target - applied;
        uint32_t cpc[2] = { lo, cnt };

        vkWaitForFences(device, 1, &inFlight[fif], VK_TRUE, UINT64_MAX);
        vkResetFences(device, 1, &inFlight[fif]);

        // CPU frontier maintenance, in lockstep with the GPU accumulate window.
        // Done after the fence wait, since it rewrites the GPU-read onFront /
        // staircase buffers (and FIF=1 means the prior frame is now done).
        if (wrapped) {
            g_frN = 0;
            memset(g_onFront, 0, (size_t)playerCount * 4);
            memset(hrCpu, 0, (size_t)playerCount * 4);
            memset(sbCpu, 0, (size_t)playerCount * 4);
        }
        for (uint32_t e = lo; e < target; e++) {
            uint32_t p = g_ev[e].player;
            (g_ev[e].stat == 0 ? hrCpu : sbCpu)[p] += g_ev[e].count;
            frontier_apply_event(p, hrCpu[p], sbCpu[p]);
        }
        lineVerts = build_staircase(staircaseMap);

        uint32_t img;
        vkAcquireNextImageKHR(device, swapchain, UINT64_MAX, imgAvail[fif], VK_NULL_HANDLE, &img);

        vkResetCommandBuffer(cmd[fif], 0);
        VkCommandBufferBeginInfo bi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
        vkBeginCommandBuffer(cmd[fif], &bi);
        if (wrapped) {                          // reset counters to zero, then replay
            vkCmdFillBuffer(cmd[fif], buf[1], 0, bsize[1], 0);
            vkCmdFillBuffer(cmd[fif], buf[2], 0, bsize[2], 0);
            // make the zeroing visible to the compute accumulate AND, if no
            // events land this frame, to the vertex read of the counters.
            vkCmdPipelineBarrier(cmd[fif], VK_PIPELINE_STAGE_TRANSFER_BIT,
                                 VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_VERTEX_SHADER_BIT,
                                 0, 1, &fillToComp, 0, NULL, 0, NULL);
        }
        if (cnt > 0) {
            vkCmdBindPipeline(cmd[fif], VK_PIPELINE_BIND_POINT_COMPUTE, computePipe);
            vkCmdBindDescriptorSets(cmd[fif], VK_PIPELINE_BIND_POINT_COMPUTE, computeLayout, 0, 1, &dset, 0, NULL);
            vkCmdPushConstants(cmd[fif], computeLayout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 8, cpc);
            vkCmdDispatch(cmd[fif], (cnt + 63) / 64, 1, 1);
            vkCmdPipelineBarrier(cmd[fif], VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_VERTEX_SHADER_BIT,
                                 0, 1, &compToVert, 0, NULL, 0, NULL);
        }
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
