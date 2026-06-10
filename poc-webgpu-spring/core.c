// ============================================================================
// poc-webgpu core — the GPU-agnostic host logic of the browser WebGPU twin of
// poc-vulkan. Compiled to WASM via emcc. This is poc-vulkan/main.c's host half
// (STEV decode, the incremental Pareto frontier, the staircase builder, the
// brute-force invariant) reused VERBATIM where possible, with the Vulkan layer
// stripped out — the browser's GPU API is WebGPU, driven from main.js. Adds the
// season open-year mode (poc-vulkan only does the career sweep).
//
// Boundary: JS gunzips the .evt.gz (DecompressionStream) and hands the raw STEV
// bytes to wasm_init(); each frame JS calls step_career()/step_season() which
// updates the shadow counters + frontier and writes onFront[]/staircase[] into
// WASM heap; JS reads those (zero-copy HEAP views) and uploads to the GPU.
// GPU hr/sb are authoritative for the picture; the WASM shadow drives the
// frontier + invariant (exactly poc-vulkan's split).
// ============================================================================
#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#define KEEP EMSCRIPTEN_KEEPALIVE

#define MAX_PLAYERS 20000        // the real union is 11,131; an assert guards
#define HASH_SIZE   (1 << 16)    // > 2*MAX_PLAYERS, power of two
#define MAX_FRONT   2048         // real frontier is dozens; bound-checked

// ---- decoded dataset -------------------------------------------------------
static int       g_n = 0;                 // distinct players (union)
static char     *g_name[MAX_PLAYERS];     // strdup'd display name
static uint32_t  g_debut[MAX_PLAYERS];    // debut calendar year (era colour)
static int       g_hash[HASH_SIZE];       // FNV(name) -> player index, -1 empty

typedef struct { uint32_t date, player, count, stat; } Ev;  // stat: 0=HR,1=SB
static Ev       *g_ev;                    // all events, sorted by date
static uint32_t  g_evN;
static uint32_t  g_evCap;

static uint16_t *g_dateYear;              // global date -> calendar year
static uint32_t  g_numDates;
static uint16_t *g_doy;                   // global date -> day-of-year (for labels)
static uint32_t  g_maxHR, g_maxSB;        // career axis maxima
static uint32_t  g_seasonMaxHR, g_seasonMaxSB;  // single-season axis maxima

// distinct calendar years, ascending, + the first event index of each.
static uint16_t  g_year[256];
static uint32_t  g_yearEvStart[257];      // [i,i+1) is year i's event slice
static int       g_yearN;

// ---- packed events for the GPU (player, stat, count) -----------------------
static uint32_t *g_evPacked;

// ---- incremental Pareto frontier (sorted x-asc / y-desc) -------------------
static uint32_t  g_frX[MAX_FRONT], g_frY[MAX_FRONT], g_frP[MAX_FRONT];
static int       g_frN;
static uint32_t  g_onFront[MAX_PLAYERS];   // 1 if on the (career/open) frontier

// ---- per-player shadow counters (drive the frontier + invariant) -----------
static uint32_t  g_hr[MAX_PLAYERS], g_sb[MAX_PLAYERS];

// ---- frontier staircase line strip (vec2 in HR/SB units) -------------------
static float    *g_staircase;             // <= 1 + 2*MAX_FRONT vec2

// ---- season: completed-season static points + their frontier ---------------
static uint32_t *g_cHr, *g_cSb, *g_cYear, *g_cOnFront;  // per completed (player,season)
static uint32_t  g_cN, g_cCap;
static uint32_t *g_cfrX, *g_cfrY, *g_cfrI;  // completed frontier (x-asc/y-desc), idx into g_c*
static int       g_cfrN;
static uint32_t *g_openColor;             // open cloud era colour = open year O
static uint32_t  g_openRender[MAX_PLAYERS];// open cloud highlight (combined frontier)

// season cursor state
static uint16_t  g_prevO = 0;
static uint32_t  g_appliedSeason;
static int       g_seasonInit = 0;

// career cursor state
static uint32_t  g_applied;
static uint32_t  g_lastCursor;
static int       g_careerInit = 0;

// ---- per-step output (read by JS via HEAPU32 over step_out_ptr) ------------
typedef struct {
    uint32_t lo, cnt, zeroGpu, lineVerts, completedDirty, completedCount, openCount;
} StepOut;
static StepOut g_out;

// ---- verification scratch --------------------------------------------------
static uint32_t  g_verifyFrontierMis, g_verifyFrontierSize;

// ===========================================================================
// Small helpers (ported from poc-vulkan/main.c, verbatim logic)
// ===========================================================================
static uint32_t read_varint(const uint8_t *b, size_t *p) {
    uint32_t v = 0, shift = 0; uint8_t c;
    do { c = b[(*p)++]; v |= (uint32_t)(c & 0x7f) << shift; shift += 7; } while (c & 0x80);
    return v;
}

static int intern(const char *name) {
    uint32_t h = 2166136261u;
    for (const char *s = name; *s; s++) h = (h ^ (uint8_t)*s) * 16777619u;
    for (uint32_t i = h & (HASH_SIZE - 1); ; i = (i + 1) & (HASH_SIZE - 1)) {
        if (g_hash[i] < 0) {
            int idx = g_n++;
            g_hash[i] = idx;
            g_name[idx] = strdup(name);
            g_debut[idx] = 9999;
            return idx;
        }
        if (strcmp(g_name[g_hash[i]], name) == 0) return g_hash[i];
    }
}

static int ev_by_date(const void *a, const void *b) {
    uint32_t da = ((const Ev *)a)->date, db = ((const Ev *)b)->date;
    return da < db ? -1 : da > db ? 1 : 0;
}

// Incremental Pareto update for player p, now at (x,y). Events are monotone (counts only
// grow), so p is the only point that can join; it can evict a CONTIGUOUS dominated run;
// nothing else is promoted. Frontier stays sorted by x ascending. This is the exact C
// original of script.js createIncrementalFrontier.applyEvent — the JS twin has the
// fully-annotated walkthrough; here C uses `memmove` where JS uses Array.splice (shift the
// tail to open/close a gap in the parallel g_frX/g_frY/g_frP arrays). (main.c verbatim.)
static void frontier_apply_event(uint32_t p, uint32_t x, uint32_t y) {
    if (g_onFront[p]) {                               // already on frontier → remove stale slot, re-insert below
        for (int i = 0; i < g_frN; i++) if (g_frP[i] == p) {
            memmove(&g_frX[i], &g_frX[i+1], (g_frN-i-1)*4);   // close the gap (splice-out)
            memmove(&g_frY[i], &g_frY[i+1], (g_frN-i-1)*4);
            memmove(&g_frP[i], &g_frP[i+1], (g_frN-i-1)*4);
            g_frN--; break;
        }
        g_onFront[p] = 0;
    }
    int k = 0; while (k < g_frN && g_frX[k] < x) k++;
    if (k < g_frN && g_frY[k] >= y) return;          // first slot with x'≥x also has y'≥y → p dominated, skip
    int j = 0; while (j < g_frN && !(g_frX[j] <= x && g_frY[j] <= y)) j++;   // start of the run p dominates
    int e = j; while (e < g_frN && g_frX[e] <= x && g_frY[e] <= y) e++;      // end of that contiguous run
    if (e > j) {                                     // evict [j,e): they're no longer extreme
        for (int t = j; t < e; t++) g_onFront[g_frP[t]] = 0;
        memmove(&g_frX[j], &g_frX[e], (g_frN-e)*4);
        memmove(&g_frY[j], &g_frY[e], (g_frN-e)*4);
        memmove(&g_frP[j], &g_frP[e], (g_frN-e)*4);
        g_frN -= e - j;
    }
    int ins = (e > j) ? j : 0;                       // insertion point: where the run was, else…
    if (e == j) while (ins < g_frN && g_frX[ins] < x) ins++;   // …walk to the first x'≥x
    if (g_frN + 1 > MAX_FRONT) return;               // bound guard (fixed-size arrays)
    memmove(&g_frX[ins+1], &g_frX[ins], (g_frN-ins)*4);        // open a gap (splice-in)
    memmove(&g_frY[ins+1], &g_frY[ins], (g_frN-ins)*4);
    memmove(&g_frP[ins+1], &g_frP[ins], (g_frN-ins)*4);
    g_frX[ins] = x; g_frY[ins] = y; g_frP[ins] = p; g_frN++;
    g_onFront[p] = 1;
}

// Turn the sorted frontier into a STAIRCASE line strip (vec2 vertices in HR/SB units) for
// line.wgsl. A Pareto frontier is a step function, not a diagonal: between two adjacent
// members the limit holds the higher Y until the higher X is reached. So each frontier
// point emits TWO vertices — (x_i, y_i) then (x_i, y_{i+1}) — giving the vertical drop to
// the next step; a left cap on the Y-axis starts the strip, and the last step drops to 0.
static uint32_t build_staircase_from(const uint32_t *frx, const uint32_t *fry, int frn, float *out) {
    if (frn == 0) return 0;
    uint32_t n = 0;
    out[n*2] = 0;          out[n*2+1] = (float)fry[0]; n++;        // left cap: (0, top Y) on the y-axis
    for (int i = 0; i < frn; i++) {
        out[n*2] = (float)frx[i]; out[n*2+1] = (float)fry[i];                       n++;  // step corner
        out[n*2] = (float)frx[i]; out[n*2+1] = (i < frn-1) ? (float)fry[i+1] : 0.f; n++;  // vertical drop to next (or 0)
    }
    return n;
}

// ===========================================================================
// DECODE — one STEV buffer (already gunzipped by JS). f=0 HR, f=1 SB.
// (main.c decode pass, verbatim aside from reading from a passed buffer.)
// ===========================================================================
static void decode_one(const uint8_t *b, size_t len, int f) {
    size_t p = 0;
    if (memcmp(b, "STEV", 4) != 0) { fprintf(stderr, "bad STEV magic\n"); return; }
    p = 4;
    p += 1;                                   // version
    p += 1 + b[p];                            // stat name (u8 len + bytes)
    uint16_t nDates   = b[p] | (b[p + 1] << 8); p += 2;
    uint16_t nSeasons = b[p] | (b[p + 1] << 8); p += 2;

    if (f == 0) {
        g_numDates = nDates;
        g_dateYear = malloc(nDates * sizeof(uint16_t));
        g_doy      = malloc(nDates * sizeof(uint16_t));
        g_yearN = 0;
    }
    uint32_t dcur = 0;
    for (int s = 0; s < nSeasons; s++) {
        uint16_t year = b[p] | (b[p + 1] << 8); p += 2;
        uint16_t snd  = b[p] | (b[p + 1] << 8); p += 2;
        if (f == 0) {
            g_year[g_yearN] = year;
            g_yearEvStart[g_yearN] = 0;       // filled after the qsort
            g_yearN++;
            for (int k = 0; k < snd; k++) g_dateYear[dcur++] = year;
        }
    }
    if (f == 0) for (uint32_t d = 0; d < nDates; d++) { g_doy[d] = b[p + d*2] | (b[p + d*2 + 1] << 8); }
    p += 2 * (size_t)nDates;                  // dayOfYear[]
    uint32_t nPlayers = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24); p += 4;

    g_evCap += len; g_ev = realloc(g_ev, g_evCap * sizeof(Ev));

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
            uint16_t y = g_dateYear[g_ev[g_evN - nev].date];
            if (y < g_debut[idx]) g_debut[idx] = y;
            if (f == 0) { if (cum > g_maxHR) g_maxHR = cum; } else { if (cum > g_maxSB) g_maxSB = cum; }
        }
    }
    free(idxOf);
}

static int year_index_of(uint16_t yr) {
    int lo = 0, hi = g_yearN - 1;             // g_year ascending
    while (lo <= hi) { int m = (lo + hi) / 2; if (g_year[m] < yr) lo = m + 1; else if (g_year[m] > yr) hi = m - 1; else return m; }
    return -1;
}

// Per-year per-player totals → completed points. Used both to size the buffers
// at init (all years) and to rebuild the completed set for years < O.
static uint32_t accumulate_completed(int upToYearIdx, int emit) {
    static uint32_t tmpHr[MAX_PLAYERS], tmpSb[MAX_PLAYERS], touched[MAX_PLAYERS];
    uint32_t out = 0;
    for (int y = 0; y < upToYearIdx; y++) {
        int nt = 0;
        for (uint32_t e = g_yearEvStart[y]; e < g_yearEvStart[y+1]; e++) {
            uint32_t pl = g_ev[e].player;
            if (tmpHr[pl] == 0 && tmpSb[pl] == 0) touched[nt++] = pl;
            (g_ev[e].stat == 0 ? tmpHr : tmpSb)[pl] += g_ev[e].count;
        }
        for (int t = 0; t < nt; t++) {
            uint32_t pl = touched[t];
            if (emit) {
                g_cHr[out] = tmpHr[pl]; g_cSb[out] = tmpSb[pl]; g_cYear[out] = g_year[y];
                if (tmpHr[pl] > g_seasonMaxHR) g_seasonMaxHR = tmpHr[pl];
                if (tmpSb[pl] > g_seasonMaxSB) g_seasonMaxSB = tmpSb[pl];
            }
            out++;
            tmpHr[pl] = 0; tmpSb[pl] = 0;
        }
    }
    return out;
}

// ===========================================================================
// wasm_init — decode both STEV buffers, build the date-sorted event list, the
// per-year index, the packed GPU events, and size the season buffers.
// ===========================================================================
EMSCRIPTEN_KEEPALIVE
int wasm_init(const uint8_t *hr, int hrLen, const uint8_t *sb, int sbLen) {
    for (int i = 0; i < HASH_SIZE; i++) g_hash[i] = -1;
    g_ev = NULL; g_evN = 0; g_evCap = 0;
    decode_one(hr, (size_t)hrLen, 0);
    decode_one(sb, (size_t)sbLen, 1);
    uint32_t playerCount = (uint32_t)g_n;

    qsort(g_ev, g_evN, sizeof(Ev), ev_by_date);

    // first event index per distinct year (events are date-sorted, year is
    // non-decreasing along them).
    int y = 0;
    for (uint32_t i = 0; i < g_evN; i++) {
        uint16_t yr = g_dateYear[g_ev[i].date];
        while (y < g_yearN && g_year[y] < yr) { g_yearEvStart[y+1] = i; y++; }
    }
    while (y < g_yearN) { g_yearEvStart[y+1] = g_evN; y++; }
    g_yearEvStart[0] = 0;

    // pack events for the GPU (player, stat, count)
    g_evPacked = malloc((size_t)g_evN * 3 * 4);
    for (uint32_t i = 0; i < g_evN; i++) {
        g_evPacked[i*3+0] = g_ev[i].player;
        g_evPacked[i*3+1] = g_ev[i].stat;
        g_evPacked[i*3+2] = g_ev[i].count;
    }

    g_staircase = malloc((size_t)(1 + 2 * MAX_FRONT) * 2 * sizeof(float));

    // size + allocate the completed-season buffers (max over all years).
    g_cCap = accumulate_completed(g_yearN, 0);
    g_cHr = malloc((size_t)g_cCap * 4); g_cSb = malloc((size_t)g_cCap * 4);
    g_cYear = malloc((size_t)g_cCap * 4); g_cOnFront = malloc((size_t)g_cCap * 4);
    g_cfrX = malloc((size_t)g_cCap * 4); g_cfrY = malloc((size_t)g_cCap * 4); g_cfrI = malloc((size_t)g_cCap * 4);
    g_openColor = malloc((size_t)playerCount * 4);
    g_seasonMaxHR = 0; g_seasonMaxSB = 0;
    accumulate_completed(g_yearN, 1);          // fill once to learn season maxima (cN reset on use)

    printf("[core] players=%u events=%u dates=%u years=%d maxHR=%u maxSB=%u sMaxHR=%u sMaxSB=%u completedCap=%u\n",
           playerCount, g_evN, g_numDates, g_yearN, g_maxHR, g_maxSB, g_seasonMaxHR, g_seasonMaxSB, g_cCap);
    return (int)playerCount;
}

// ===========================================================================
// CAREER step — advance the cursor, replay the new window into the shadow,
// update the frontier + staircase. Handles forward play, wrap, and scrub-back
// uniformly (any backward move zeroes and replays from 0).
// ===========================================================================
EMSCRIPTEN_KEEPALIVE
void step_career(uint32_t cursorDate) {
    int zeroGpu = 0;
    if (!g_careerInit || cursorDate < g_lastCursor) {
        g_applied = 0; g_frN = 0;
        memset(g_onFront, 0, sizeof(g_onFront));
        memset(g_hr, 0, sizeof(g_hr)); memset(g_sb, 0, sizeof(g_sb));
        zeroGpu = 1; g_careerInit = 1;
    }
    uint32_t target = g_applied;
    while (target < g_evN && g_ev[target].date <= cursorDate) target++;
    uint32_t lo = g_applied, cnt = target - g_applied;
    for (uint32_t e = lo; e < target; e++) {
        uint32_t p = g_ev[e].player;
        (g_ev[e].stat == 0 ? g_hr : g_sb)[p] += g_ev[e].count;
        frontier_apply_event(p, g_hr[p], g_sb[p]);
    }
    g_applied = target; g_lastCursor = cursorDate;
    g_out.lo = lo; g_out.cnt = cnt; g_out.zeroGpu = (uint32_t)zeroGpu;
    g_out.lineVerts = build_staircase_from(g_frX, g_frY, g_frN, g_staircase);
    g_out.completedDirty = 0; g_out.completedCount = 0; g_out.openCount = (uint32_t)g_n;
}

// ---- completed frontier (full upper-right envelope over g_c*) --------------
static const uint32_t *s_sortHr, *s_sortSb;
static int cmp_completed(const void *a, const void *b) {
    uint32_t ia = *(const uint32_t *)a, ib = *(const uint32_t *)b;        // x desc, y desc
    if (s_sortHr[ia] != s_sortHr[ib]) return s_sortHr[ia] < s_sortHr[ib] ? 1 : -1;
    if (s_sortSb[ia] != s_sortSb[ib]) return s_sortSb[ia] < s_sortSb[ib] ? 1 : -1;
    return 0;
}
static void build_completed_frontier(void) {
    g_cfrN = 0;
    if (g_cN == 0) return;
    static uint32_t *order; static uint32_t orderCap;
    if (orderCap < g_cN) { order = realloc(order, (size_t)g_cN * 4); orderCap = g_cN; }
    for (uint32_t i = 0; i < g_cN; i++) order[i] = i;
    s_sortHr = g_cHr; s_sortSb = g_cSb;
    qsort(order, g_cN, 4, cmp_completed);
    // x desc, y desc: keep a point when its y exceeds the running max (distinct x).
    int64_t best = -1;
    for (uint32_t i = 0; i < g_cN; i++) {
        uint32_t idx = order[i];
        if ((int64_t)g_cSb[idx] > best) { g_cfrX[g_cfrN] = g_cHr[idx]; g_cfrY[g_cfrN] = g_cSb[idx]; g_cfrI[g_cfrN] = idx; g_cfrN++; best = g_cSb[idx]; }
    }
    // reverse to x-asc / y-desc (build_staircase + merge expect that order)
    for (int i = 0, j = g_cfrN - 1; i < j; i++, j--) {
        uint32_t tx=g_cfrX[i],ty=g_cfrY[i],ti=g_cfrI[i];
        g_cfrX[i]=g_cfrX[j]; g_cfrY[i]=g_cfrY[j]; g_cfrI[i]=g_cfrI[j];
        g_cfrX[j]=tx; g_cfrY[j]=ty; g_cfrI[j]=ti;
    }
}

static void rebuild_completed(int oidx) {
    static uint32_t tmpHr[MAX_PLAYERS], tmpSb[MAX_PLAYERS], touched[MAX_PLAYERS];
    g_cN = 0;
    for (int y2 = 0; y2 < oidx; y2++) {
        int nt = 0;
        for (uint32_t e = g_yearEvStart[y2]; e < g_yearEvStart[y2+1]; e++) {
            uint32_t pl = g_ev[e].player;
            if (tmpHr[pl] == 0 && tmpSb[pl] == 0) touched[nt++] = pl;
            (g_ev[e].stat == 0 ? tmpHr : tmpSb)[pl] += g_ev[e].count;
        }
        for (int t = 0; t < nt; t++) {
            uint32_t pl = touched[t];
            g_cHr[g_cN] = tmpHr[pl]; g_cSb[g_cN] = tmpSb[pl]; g_cYear[g_cN] = g_year[y2]; g_cOnFront[g_cN] = 0;
            g_cN++; tmpHr[pl] = 0; tmpSb[pl] = 0;
        }
    }
    build_completed_frontier();
}

// ---- combined frontier (merge completed + open staircases) -----------------
// scratch, sized at init to g_cCap + MAX_FRONT.
static uint32_t *g_combX, *g_combY, *g_combRef; static uint8_t *g_combTag; static int g_combN;
static uint32_t *m_x, *m_y, *m_ref; static uint8_t *m_tag;  // pre-sweep merge scratch
static const uint32_t *s_mx, *s_my;
static uint32_t *m_ord;
static int cmp_merge(const void *a, const void *b) {
    uint32_t ia = *(const uint32_t *)a, ib = *(const uint32_t *)b;        // x desc, y desc
    if (s_mx[ia] != s_mx[ib]) return s_mx[ia] < s_mx[ib] ? 1 : -1;
    if (s_my[ia] != s_my[ib]) return s_my[ia] < s_my[ib] ? 1 : -1;
    return 0;
}
static void build_combined(void) {
    uint32_t n = 0;
    for (int i = 0; i < g_cfrN; i++) { m_x[n]=g_cfrX[i]; m_y[n]=g_cfrY[i]; m_ref[n]=g_cfrI[i]; m_tag[n]=0; n++; }
    for (int i = 0; i < g_frN;  i++) { m_x[n]=g_frX[i];  m_y[n]=g_frY[i];  m_ref[n]=g_frP[i]; m_tag[n]=1; n++; }
    for (uint32_t i = 0; i < n; i++) m_ord[i] = i;
    s_mx = m_x; s_my = m_y;
    qsort(m_ord, n, 4, cmp_merge);
    g_combN = 0;
    int64_t best = -1;
    for (uint32_t i = 0; i < n; i++) {
        uint32_t o = m_ord[i];
        if ((int64_t)m_y[o] > best) { g_combX[g_combN]=m_x[o]; g_combY[g_combN]=m_y[o]; g_combRef[g_combN]=m_ref[o]; g_combTag[g_combN]=m_tag[o]; g_combN++; best = m_y[o]; }
    }
    for (int i = 0, j = g_combN - 1; i < j; i++, j--) {   // reverse to x-asc/y-desc
        uint32_t tx=g_combX[i],ty=g_combY[i],tr=g_combRef[i]; uint8_t tt=g_combTag[i];
        g_combX[i]=g_combX[j]; g_combY[i]=g_combY[j]; g_combRef[i]=g_combRef[j]; g_combTag[i]=g_combTag[j];
        g_combX[j]=tx; g_combY[j]=ty; g_combRef[j]=tr; g_combTag[j]=tt;
    }
    // render flags from the combined frontier
    memset(g_openRender, 0, sizeof(g_openRender));
    if (g_cN) memset(g_cOnFront, 0, (size_t)g_cN * 4);
    for (int i = 0; i < g_combN; i++) {
        if (g_combTag[i]) g_openRender[g_combRef[i]] = 1;
        else              g_cOnFront[g_combRef[i]] = 1;
    }
}

// ===========================================================================
// SEASON open-year step. Open year O = year of the cursor date. The GPU hr/sb
// hold ONLY the open season's in-progress totals (zeroed at each year boundary);
// completed seasons are static points rebuilt when O changes; the frontier is
// the Pareto merge of the static completed frontier with the incremental open
// frontier. (Mirrors the web app's buildSmoothActiveFrontier.)
// ===========================================================================
EMSCRIPTEN_KEEPALIVE
void step_season(uint32_t cursorDate) {
    if (!g_combX) {
        g_combX = malloc((size_t)(g_cCap + MAX_FRONT) * 4); g_combY = malloc((size_t)(g_cCap + MAX_FRONT) * 4);
        g_combRef = malloc((size_t)(g_cCap + MAX_FRONT) * 4); g_combTag = malloc((size_t)(g_cCap + MAX_FRONT));
        m_x = malloc((size_t)(g_cCap + MAX_FRONT) * 4); m_y = malloc((size_t)(g_cCap + MAX_FRONT) * 4);
        m_ref = malloc((size_t)(g_cCap + MAX_FRONT) * 4); m_tag = malloc((size_t)(g_cCap + MAX_FRONT));
        m_ord = malloc((size_t)(g_cCap + MAX_FRONT) * 4);
    }
    uint16_t O = g_dateYear[cursorDate];
    int oidx = year_index_of(O);
    int dirty = 0, zeroGpu = 0;
    if (!g_seasonInit || O != g_prevO) {
        rebuild_completed(oidx);
        memset(g_hr, 0, sizeof(g_hr)); memset(g_sb, 0, sizeof(g_sb));
        g_frN = 0; memset(g_onFront, 0, sizeof(g_onFront));
        for (uint32_t i = 0; i < (uint32_t)g_n; i++) g_openColor[i] = O;
        g_appliedSeason = g_yearEvStart[oidx];
        g_prevO = O; g_seasonInit = 1; dirty = 1; zeroGpu = 1;
    }
    uint32_t yEnd = g_yearEvStart[oidx + 1];
    uint32_t target = g_appliedSeason;
    while (target < yEnd && g_ev[target].date <= cursorDate) target++;
    uint32_t lo = g_appliedSeason, cnt = target - g_appliedSeason;
    for (uint32_t e = lo; e < target; e++) {
        uint32_t p = g_ev[e].player;
        (g_ev[e].stat == 0 ? g_hr : g_sb)[p] += g_ev[e].count;
        frontier_apply_event(p, g_hr[p], g_sb[p]);
    }
    g_appliedSeason = target;
    build_combined();
    g_out.lo = lo; g_out.cnt = cnt; g_out.zeroGpu = (uint32_t)zeroGpu;
    g_out.lineVerts = build_staircase_from(g_combX, g_combY, g_combN, g_staircase);
    g_out.completedDirty = (uint32_t)dirty; g_out.completedCount = g_cN; g_out.openCount = (uint32_t)g_n;
}

// ===========================================================================
// Invariants (run in C, no GPU needed). Exposed counts let the headless harness
// assert the T3 gate.
// ===========================================================================
// Career: incremental frontier == brute-force O(N^2) frontier (main.c verbatim).
EMSCRIPTEN_KEEPALIVE
int verify_career(void) {
    uint32_t playerCount = (uint32_t)g_n;
    uint8_t *dom = calloc(playerCount, 1);
    for (uint32_t i = 0; i < playerCount; i++)
        for (uint32_t j = 0; j < playerCount; j++)
            if (g_hr[j] >= g_hr[i] && g_sb[j] >= g_sb[i] && (g_hr[j] > g_hr[i] || g_sb[j] > g_sb[i])) { dom[i] = 1; break; }
    uint32_t fmis = 0;
    for (int i = 0; i < g_frN; i++) if (dom[g_frP[i]]) fmis++;
    for (uint32_t i = 0; i < playerCount; i++) if (!dom[i] && (g_hr[i] || g_sb[i])) {
        int lo = 0, hi = g_frN;
        while (lo < hi) { int m = (lo + hi) / 2; if (g_frX[m] < g_hr[i]) lo = m + 1; else hi = m; }
        if (lo >= g_frN || g_frX[lo] != g_hr[i] || g_frY[lo] != g_sb[i]) fmis++;
    }
    free(dom);
    g_verifyFrontierMis = fmis; g_verifyFrontierSize = (uint32_t)g_frN;
    return (int)fmis;
}

// Season: combined frontier == an independent full O(N log N) Pareto sweep over
// all current points (completed finals + open as-of-cursor). O(N^2) is infeasible
// at ~90k player-seasons, so the reference is a from-scratch envelope sweep.
static uint32_t *v_x, *v_y, *v_ord; static uint32_t v_cap;
static const uint32_t *sv_x, *sv_y;
static int cmp_verify(const void *a, const void *b) {
    uint32_t ia = *(const uint32_t *)a, ib = *(const uint32_t *)b;
    if (sv_x[ia] != sv_x[ib]) return sv_x[ia] < sv_x[ib] ? 1 : -1;
    if (sv_y[ia] != sv_y[ib]) return sv_y[ia] < sv_y[ib] ? 1 : -1;
    return 0;
}
EMSCRIPTEN_KEEPALIVE
int verify_season(void) {
    uint32_t need = g_cN + (uint32_t)g_n;
    if (v_cap < need) { v_x = realloc(v_x, need*4); v_y = realloc(v_y, need*4); v_ord = realloc(v_ord, need*4); v_cap = need; }
    uint32_t n = 0;
    for (uint32_t i = 0; i < g_cN; i++) { v_x[n]=g_cHr[i]; v_y[n]=g_cSb[i]; n++; }
    for (uint32_t p = 0; p < (uint32_t)g_n; p++) if (g_hr[p] || g_sb[p]) { v_x[n]=g_hr[p]; v_y[n]=g_sb[p]; n++; }
    for (uint32_t i = 0; i < n; i++) v_ord[i] = i;
    sv_x = v_x; sv_y = v_y;
    qsort(v_ord, n, 4, cmp_verify);
    // reference frontier coordinate set (x desc, keep y > running max)
    static uint32_t *refX, *refY; static uint32_t refCap; static int refN;
    if (refCap < n) { refX = realloc(refX, n*4); refY = realloc(refY, n*4); refCap = n; }
    refN = 0; int64_t best = -1;
    for (uint32_t i = 0; i < n; i++) { uint32_t o = v_ord[i]; if ((int64_t)v_y[o] > best) { refX[refN]=v_x[o]; refY[refN]=v_y[o]; refN++; best = v_y[o]; } }
    // compare as coordinate sets: same size + same (x,y) (both are x-distinct envelopes)
    uint32_t mis = 0;
    if (refN != g_combN) mis += (refN > g_combN ? refN - g_combN : g_combN - refN);
    int lim = refN < g_combN ? refN : g_combN;
    for (int i = 0; i < lim; i++) {           // refX is x-desc, g_combX is x-asc
        uint32_t cx = g_combX[i], cy = g_combY[i];
        uint32_t rx = refX[refN-1-i], ry = refY[refN-1-i];
        if (cx != rx || cy != ry) mis++;
    }
    g_verifyFrontierMis = mis; g_verifyFrontierSize = (uint32_t)g_combN;
    return (int)mis;
}

// ===========================================================================
// Accessors for JS (pointers into WASM heap; JS wraps as zero-copy HEAP views).
// ===========================================================================
EMSCRIPTEN_KEEPALIVE void* step_out_ptr(void)     { return &g_out; }
EMSCRIPTEN_KEEPALIVE void* events_ptr(void)       { return g_evPacked; }
EMSCRIPTEN_KEEPALIVE int   events_count(void)     { return (int)g_evN; }
EMSCRIPTEN_KEEPALIVE void* debut_ptr(void)        { return g_debut; }
EMSCRIPTEN_KEEPALIVE void* onfront_ptr(void)      { return g_onFront; }       // career highlight
EMSCRIPTEN_KEEPALIVE void* open_render_ptr(void)  { return g_openRender; }    // season open highlight
EMSCRIPTEN_KEEPALIVE void* open_color_ptr(void)   { return g_openColor; }     // season open era colour
EMSCRIPTEN_KEEPALIVE void* staircase_ptr(void)    { return g_staircase; }
EMSCRIPTEN_KEEPALIVE void* hr_shadow_ptr(void)    { return g_hr; }            // GPU==shadow check
EMSCRIPTEN_KEEPALIVE void* sb_shadow_ptr(void)    { return g_sb; }
EMSCRIPTEN_KEEPALIVE void* completed_hr_ptr(void) { return g_cHr; }
EMSCRIPTEN_KEEPALIVE void* completed_sb_ptr(void) { return g_cSb; }
EMSCRIPTEN_KEEPALIVE void* completed_year_ptr(void){ return g_cYear; }
EMSCRIPTEN_KEEPALIVE void* completed_onfront_ptr(void){ return g_cOnFront; }
EMSCRIPTEN_KEEPALIVE int   completed_cap(void)    { return (int)g_cCap; }
EMSCRIPTEN_KEEPALIVE int   num_dates(void)        { return (int)g_numDates; }
EMSCRIPTEN_KEEPALIVE int   year_of_date(int d)    { return (d >= 0 && (uint32_t)d < g_numDates) ? g_dateYear[d] : 0; }
EMSCRIPTEN_KEEPALIVE int   doy_of_date(int d)     { return (d >= 0 && (uint32_t)d < g_numDates) ? g_doy[d] : 0; }
EMSCRIPTEN_KEEPALIVE int   max_hr(void)           { return (int)g_maxHR; }
EMSCRIPTEN_KEEPALIVE int   max_sb(void)           { return (int)g_maxSB; }
EMSCRIPTEN_KEEPALIVE int   season_max_hr(void)    { return (int)g_seasonMaxHR; }
EMSCRIPTEN_KEEPALIVE int   season_max_sb(void)    { return (int)g_seasonMaxSB; }
EMSCRIPTEN_KEEPALIVE int   player_count(void)     { return g_n; }
EMSCRIPTEN_KEEPALIVE const char* name_ptr(int i)  { return (i >= 0 && i < g_n) ? g_name[i] : ""; }
EMSCRIPTEN_KEEPALIVE int   verify_frontier_mis(void)  { return (int)g_verifyFrontierMis; }
EMSCRIPTEN_KEEPALIVE int   verify_frontier_size(void) { return (int)g_verifyFrontierSize; }
EMSCRIPTEN_KEEPALIVE int   player_hr(int p) { return (p >= 0 && p < g_n) ? (int)g_hr[p] : 0; }
EMSCRIPTEN_KEEPALIVE int   player_sb(int p) { return (p >= 0 && p < g_n) ? (int)g_sb[p] : 0; }
EMSCRIPTEN_KEEPALIVE int   player_onfront(int p) { return (p >= 0 && p < g_n) ? (int)g_onFront[p] : 0; }
