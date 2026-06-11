// Era → color. A luminance-ordered, single-hue (blue) SEQUENTIAL ramp,
// light(old) → dark(modern). Ordinal time maps to a monotonic lightness so the
// encoding stays truthful and is safe under protanopia/deuteranopia (CVD) — a
// categorical multi-hue scale fails both. Per-theme ramps live in THEMES; this
// is the Classic default. Invariant asserted at startup on __bl2d_eraRampLum.
const ERAS = [
    { start: 1871, end: 1899, name: "Pre-modern",   color: "#d9e3f0" },
    { start: 1900, end: 1919, name: "Dead Ball",    color: "#b3c6e0" },
    { start: 1920, end: 1941, name: "Live Ball",    color: "#8aa9cf" },
    { start: 1942, end: 1968, name: "Integration",  color: "#6189bd" },
    { start: 1969, end: 1992, name: "Free Agency",  color: "#3f6aa3" },
    { start: 1993, end: 2005, name: "Steroid",      color: "#244a7d" },
    { start: 2006, end: 2099, name: "Modern",       color: "#122a4d" },
];
function eraFor(year) {
    for (const e of ERAS) if (year >= e.start && year <= e.end) return e;
    return null;
}

// Relative luminance (WCAG) of a #rrggbb hex — used to assert the era ramp is
// monotonic in lightness (the property that makes it CVD-safe and ordinal).
function relLuminance(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return NaN;
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const [r, g, b] = [m[1], m[2], m[3]].map((h) => lin(parseInt(h, 16)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
(function assertEraRampMonotonic() {
    const lum = ERAS.map((e) => relLuminance(e.color));
    let monotonic = true;
    for (let i = 1; i < lum.length; i++) if (lum[i] >= lum[i - 1]) monotonic = false;
    // Old → modern goes light → dark, so luminance must strictly DECREASE.
    window.__bl2d_eraRampLum = { luminance: lum, monotonicDecreasing: monotonic };
    if (!monotonic) console.warn("[bl2d] era ramp is not monotonic in luminance — CVD-safety invariant violated", lum);
})();

// Color palettes per encoding mode. Keep deliberate — Red/Blue echo MLB.
// Categorical color tables for the two NON-era encodings (handedness, league). Era is
// NOT here — it's the ordinal ERAS ramp above, because time is ordinal and wants a
// luminance-ordered ramp, whereas bats/league are unordered categories that want
// distinct hues. Each entry is an OBJECT (not a bare string) so applyTheme can mutate
// `.color` in place per theme without any call site (colorOf) needing to change — the
// indirection is what lets a theme switch re-skin the D3 chart for free. `unknown` is a
// real bucket, not an error path: Lahman is missing handedness/country for some old
// players, so colorOf must always resolve to a swatch. League carries a `.dark` variant
// for chrome that needs a darker shade on light themes (legend dots vs. cloud).
const COLOR_PALETTES = {
    bats: {
        // Switch hitters get their own hue; L/R deliberately reuse the league red/blue
        // (applyTheme overwrites these with the active theme's league colors) so the two
        // categorical encodings share a palette and the legend stays visually coherent.
        L: { color: "#c8102e", name: "Left" },
        R: { color: "#002d72", name: "Right" },
        S: { color: "#7a3f5f", name: "Switch" },
        unknown: { color: "#94a3b8", name: "Unknown" },
    },
    league: {
        AL: { color: "#c8102e", dark: "#c8102e", name: "American" },   // MLB red
        NL: { color: "#002d72", dark: "#002d72", name: "National" },   // MLB blue
        unknown: { color: "#94a3b8", dark: "#0f172a", name: "Other" },
    },
};

// ── Theming ──────────────────────────────────────────────────────────────
// Three coherent themes. Each drives the CSS-variable chrome (via `vars`,
// written onto <html> so the var-based styles.css re-skins for free) AND the
// D3-painted chart, by mutating the in-place ERAS / COLOR_PALETTES color tables
// (so colorOf + renderLegend reflect the theme with no call-site changes).
// Classic's cloud is the CVD-safe sequential ramp; Editorial/Night carry their
// own sequential ramps. cloudOpacity lifts on darker themes so dots stay legible.
const THEMES = {
    classic: {
        label: "Classic",
        vars: {
            "--bg": "#f6f7f9", "--panel": "#ffffff", "--border": "#e3e6ea", "--border-strong": "#cdd2d8",
            "--text": "#1a1f2e", "--text-muted": "#5a6478", "--mlb-blue": "#002d72",
            "--mlb-blue-hover": "#001a44", "--mlb-red": "#c8102e", "--frontier-color": "#0f172a",
            "--glass-bg": "rgba(255,255,255,0.92)", "--gold": "#f59e0b",
            "--league-al": "#c8102e", "--league-nl": "#002d72", "--on-primary": "#ffffff",
        },
        cloud: ["#d9e3f0", "#b3c6e0", "#8aa9cf", "#6189bd", "#3f6aa3", "#244a7d", "#122a4d"],
        cloudOpacity: 0.4, league: { AL: "#c8102e", NL: "#002d72" }, switchColor: "#7a3f5f",
    },
    editorial: {
        label: "Editorial",
        vars: {
            "--bg": "#f7f4ed", "--panel": "#fffdf8", "--border": "#e7e0d2", "--border-strong": "#d3c9b4",
            "--text": "#1f1b16", "--text-muted": "#6b6357", "--mlb-blue": "#243b53",
            "--mlb-blue-hover": "#1a2c3f", "--mlb-red": "#b23a2e", "--frontier-color": "#16130f",
            "--glass-bg": "rgba(255,253,248,0.92)", "--gold": "#c4781b",
            "--league-al": "#b23a2e", "--league-nl": "#243b53", "--on-primary": "#fffdf8",
        },
        cloud: ["#e8dcc0", "#d9c098", "#c79f6f", "#b87d4b", "#9c5d34", "#7d4226", "#5c2f1c"],
        cloudOpacity: 0.5, league: { AL: "#b23a2e", NL: "#243b53" }, switchColor: "#8a5a3c",
    },
    dark: {
        label: "Night",
        vars: {
            "--bg": "#0d1117", "--panel": "#161b22", "--border": "#283039", "--border-strong": "#3a444f",
            "--text": "#e6edf3", "--text-muted": "#9aa6b2", "--mlb-blue": "#58a6ff",
            "--mlb-blue-hover": "#4793e8", "--mlb-red": "#ff6b81", "--frontier-color": "#f0f6fc",
            "--glass-bg": "rgba(22,27,34,0.85)", "--gold": "#f5a623",
            "--league-al": "#ff6b81", "--league-nl": "#58a6ff", "--on-primary": "#0d1117",
        },
        cloud: ["#33414f", "#3e5061", "#4a5f73", "#566f86", "#637f98", "#708fab", "#7e9fbe"],
        cloudOpacity: 0.72, league: { AL: "#ff6b81", NL: "#58a6ff" }, switchColor: "#b07fd6",
    },
};
// Base cloud opacity for the active theme; read by drawScatterPlot.
let themeCloudOpacity = THEMES.classic.cloudOpacity;

function applyTheme(name) {
    const t = THEMES[name] || THEMES.classic;   // unknown name → Classic (defensive: URL/localStorage could be stale)
    const root = document.documentElement;
    // 1. CSS chrome: write every theme var onto <html>. styles.css is authored entirely
    //    against these vars, so the whole UI re-skins with no per-element work here.
    Object.entries(t.vars).forEach(([k, v]) => root.style.setProperty(k, v));
    root.setAttribute("data-theme", name);       // a few CSS rules also key off [data-theme]
    // 2. D3 chart: the chart is painted in JS (canvas/SVG), so CSS vars don't reach it.
    //    Instead we MUTATE the existing color-table objects in place — colorOf/renderLegend
    //    hold references to these same objects, so they pick up the new colors on the next
    //    redraw without being passed the theme. (Reassigning ERAS/COLOR_PALETTES instead
    //    would orphan those held references — hence in-place mutation.)
    t.cloud.forEach((c, i) => { if (ERAS[i]) ERAS[i].color = c; });   // era ramp, band-for-band
    COLOR_PALETTES.league.AL.color = COLOR_PALETTES.league.AL.dark = t.league.AL;
    COLOR_PALETTES.league.NL.color = COLOR_PALETTES.league.NL.dark = t.league.NL;
    COLOR_PALETTES.bats.L.color = t.league.AL;   // keep handedness sharing the league hues
    COLOR_PALETTES.bats.R.color = t.league.NL;
    COLOR_PALETTES.bats.S.color = t.switchColor;
    themeCloudOpacity = t.cloudOpacity;          // darker themes need a higher floor to stay legible
    try { localStorage.setItem("bl2d-theme", name); } catch (e) {}   // private-mode/quota → ignore, just don't persist
    // Reflect the choice in the header switcher.
    document.querySelectorAll("#theme-switch .theme-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.theme === name));
}

// Theme to apply at startup: the user's last choice, else Classic. Wrapped in try/catch
// because localStorage throws in some privacy modes — we degrade to the default, never crash.
function initialTheme() {
    try { return localStorage.getItem("bl2d-theme") || "classic"; } catch (e) { return "classic"; }
}

// The single source of truth for a background-cloud dot's fill, given the active
// "Color by" encoding. Frontier-red / career-gold are decided by the caller and win over
// this — colorOf only paints the cloud. getMeta is injected (not imported) so this stays
// a pure function of its inputs, easy to reuse from the canvas and SVG paths alike.
function colorOf(p, colorBy, getMeta) {
    if (colorBy === "era") {
        // `p.year ?? p.yearID`: the smooth/streaming rows carry `.year`, the static
        // season/career rows carry `.yearID` — accept either. `|| {color}` is the
        // out-of-range guard (a year before 1871 has no era band) → a neutral slate.
        return (eraFor(p.year ?? p.yearID) || { color: "#4a6fa5" }).color;
    }
    if (colorBy === "bats") {
        const m = getMeta(p.playerID);             // handedness lives in People, not the stat rows
        const k = m && m.bats;                     // may be undefined (missing meta) → falls to `unknown`
        return (COLOR_PALETTES.bats[k] || COLOR_PALETTES.bats.unknown).color;
    }
    if (colorBy === "league") {
        const k = p.lgID;                          // lgID is on the row itself (AL/NL/…)
        return (COLOR_PALETTES.league[k] || COLOR_PALETTES.league.unknown).color;
    }
    return "#4a6fa5";                              // unknown encoding → neutral (should not happen)
}

// Keep the chart legend honest: show the key for whatever encoding is actually
// painting the cloud. Era → a sequential colorbar matching the ramp; League /
// Bats → categorical swatches. Called from drawScatterPlot on every redraw.
function renderLegend(colorBy) {
    const el = document.getElementById("legend-encoding");
    if (!el) return;
    if (colorBy === "league") {
        el.innerHTML =
            `<div class="legend-row">` +
            `<span class="legend-item"><span class="legend-dot legend-dot--al"></span>AL</span>` +
            `<span class="legend-item"><span class="legend-dot legend-dot--nl"></span>NL</span>` +
            `</div>`;
    } else if (colorBy === "bats") {
        const b = COLOR_PALETTES.bats;
        el.innerHTML =
            `<div class="legend-row">` +
            `<span class="legend-item"><span class="legend-dot" style="background:${b.L.color}"></span>L</span>` +
            `<span class="legend-item"><span class="legend-dot" style="background:${b.R.color}"></span>R</span>` +
            `<span class="legend-item"><span class="legend-dot" style="background:${b.S.color}"></span>S</span>` +
            `</div>`;
    } else { // era (default)
        const bar = ERAS.map(e => `<span style="background:${e.color}"></span>`).join("");
        // Lower bound from the ramp; upper is the dataset's last season (1871–2025).
        el.innerHTML =
            `<div class="legend-encoding">` +
            `<span class="legend-enc-label">Era</span>` +
            `<div class="legend-era-bar">${bar}</div>` +
            `<div class="legend-era-scale"><span>${ERAS[0].start}</span><span>2025</span></div>` +
            `</div>`;
    }
}

const COUNTRY_FLAGS = {
    "USA": "🇺🇸", "D.R.": "🇩🇴", "Venezuela": "🇻🇪", "P.R.": "🇵🇷",
    "Cuba": "🇨🇺", "Mexico": "🇲🇽", "Japan": "🇯🇵", "Panama": "🇵🇦",
    "Australia": "🇦🇺", "Canada": "🇨🇦", "Colombia": "🇨🇴", "Nicaragua": "🇳🇮",
    "Curacao": "🇨🇼", "Netherlands": "🇳🇱", "South Korea": "🇰🇷", "Aruba": "🇦🇼",
    "Brazil": "🇧🇷", "Germany": "🇩🇪", "Spain": "🇪🇸", "Italy": "🇮🇹",
    "UK": "🇬🇧", "Bahamas": "🇧🇸", "Jamaica": "🇯🇲", "Taiwan": "🇹🇼",
    "France": "🇫🇷", "Belgium": "🇧🇪", "Sweden": "🇸🇪", "Haiti": "🇭🇹",
    "Honduras": "🇭🇳", "Belize": "🇧🇿", "South Africa": "🇿🇦", "Ireland": "🇮🇪",
    "Russia": "🇷🇺",
    // Lahman birthCountry aliases that differ from the canonical display strings above
    "CAN": "🇨🇦", "México": "🇲🇽", "Curaçao": "🇨🇼",
    "England": "🇬🇧", "Scotland": "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "Wales": "🏴󠁧󠁢󠁷󠁬󠁳󠁿",
    "U.S. Virgin Islands": "🇻🇮", "West Germany": "🇩🇪",
};
// Maps raw Lahman birthCountry strings to readable display names for chips.
const COUNTRY_DISPLAY = {
    "CAN": "Canada",
    "México": "Mexico",
    "Curaçao": "Curaçao",
    "U.S. Virgin Islands": "US Virgin Islands",
    "West Germany": "West Germany",
    "D.R.": "Dominican Rep.",
    "P.R.": "Puerto Rico",
    "South Korea": "South Korea",
    "South Africa": "South Africa",
};

// Current 30 MLB franchises with every historical Lahman teamID that belongs
// to the same franchise. Used for the franchise filter dropdown.
const FRANCHISES = [
    { id: "ari", abbr: "ARI", color: "#A71930", division: "NL West",    name: "Arizona Diamondbacks",                         teams: ["ARI"] },
    { id: "atl", abbr: "ATL", color: "#CE1141", division: "NL East",    name: "Atlanta Braves",        note: "incl. Boston & Milwaukee",      teams: ["BSN","BS1","BS2","ML1","ATL"] },
    { id: "bal", abbr: "BAL", color: "#DF4601", division: "AL East",    name: "Baltimore Orioles",     note: "incl. St. Louis Browns",        teams: ["SLA","SL4","BAL"] },
    { id: "bos", abbr: "BOS", color: "#BD3039", division: "AL East",    name: "Boston Red Sox",                               teams: ["BOS"] },
    { id: "chc", abbr: "CHC", color: "#0E3386", division: "NL Central", name: "Chicago Cubs",          note: "incl. White Stockings era",     teams: ["CHN","CH1","CH2"] },
    { id: "cws", abbr: "CWS", color: "#27251F", division: "AL Central", name: "Chicago White Sox",                            teams: ["CHA"] },
    { id: "cin", abbr: "CIN", color: "#C6011F", division: "NL Central", name: "Cincinnati Reds",                              teams: ["CIN","CN1","CN2","CN3","CNU"] },
    { id: "cle", abbr: "CLE", color: "#00385D", division: "AL Central", name: "Cleveland Guardians",   note: "incl. Indians/Spiders/Blues",   teams: ["CL1","CL2","CL3","CL4","CL5","CL6","CLE"] },
    { id: "col", abbr: "COL", color: "#33006F", division: "NL West",    name: "Colorado Rockies",                             teams: ["COL"] },
    { id: "det", abbr: "DET", color: "#0C2C56", division: "AL Central", name: "Detroit Tigers",                               teams: ["DET"] },
    { id: "hou", abbr: "HOU", color: "#002D62", division: "AL West",    name: "Houston Astros",                               teams: ["HOU"] },
    { id: "kc",  abbr: "KC",  color: "#004687", division: "AL Central", name: "Kansas City Royals",                           teams: ["KCA"] },
    { id: "laa", abbr: "LAA", color: "#BA0021", division: "AL West",    name: "Los Angeles Angels",    note: "incl. California & Anaheim",    teams: ["CAL","ANA","LAA"] },
    { id: "lad", abbr: "LAD", color: "#005A9C", division: "NL West",    name: "Los Angeles Dodgers",   note: "incl. Brooklyn",                teams: ["BRO","LAN"] },
    { id: "mia", abbr: "MIA", color: "#00A3E0", division: "NL East",    name: "Miami Marlins",         note: "incl. Florida Marlins",         teams: ["FLO","MIA"] },
    { id: "mil", abbr: "MIL", color: "#12284B", division: "NL Central", name: "Milwaukee Brewers",                                           teams: ["MIL"] },
    { id: "min", abbr: "MIN", color: "#002B5C", division: "AL Central", name: "Minnesota Twins",       note: "incl. Washington Senators",     teams: ["WS1","MIN"] },
    { id: "nym", abbr: "NYM", color: "#002D72", division: "NL East",    name: "New York Mets",                                teams: ["NYN"] },
    { id: "nyy", abbr: "NYY", color: "#0C2340", division: "AL East",    name: "New York Yankees",      note: "incl. Highlanders",             teams: ["NYA"] },
    { id: "oak", abbr: "OAK", color: "#003831", division: "AL West",    name: "Oakland Athletics",     note: "incl. Philadelphia & KC A's",   teams: ["PHA","KC1","KC2","OAK"] },
    { id: "phi", abbr: "PHI", color: "#E81828", division: "NL East",    name: "Philadelphia Phillies",                        teams: ["PHI","PHP"] },
    { id: "pit", abbr: "PIT", color: "#FDB827", division: "NL Central", name: "Pittsburgh Pirates",                           teams: ["PIT"] },
    { id: "sd",  abbr: "SD",  color: "#2F241D", division: "NL West",    name: "San Diego Padres",                             teams: ["SDN"] },
    { id: "sea", abbr: "SEA", color: "#0C2C56", division: "AL West",    name: "Seattle Mariners",                             teams: ["SEA"] },
    { id: "sf",  abbr: "SF",  color: "#FD5A1E", division: "NL West",    name: "San Francisco Giants",  note: "incl. New York Giants",         teams: ["NY1","SFN"] },
    { id: "stl", abbr: "STL", color: "#C41E3A", division: "NL Central", name: "St. Louis Cardinals",                          teams: ["SLN","SL1","SL5"] },
    { id: "tb",  abbr: "TB",  color: "#092C5C", division: "AL East",    name: "Tampa Bay Rays",        note: "orig. Devil Rays",              teams: ["TBA"] },
    { id: "tex", abbr: "TEX", color: "#003278", division: "AL West",    name: "Texas Rangers",         note: "incl. Washington Senators '61", teams: ["WS2","TEX"] },
    { id: "tor", abbr: "TOR", color: "#134A8E", division: "AL East",    name: "Toronto Blue Jays",                            teams: ["TOR"] },
    { id: "was", abbr: "WSH", color: "#AB0003", division: "NL East",    name: "Washington Nationals",  note: "incl. Montreal Expos",          teams: ["MON","WAS"] },
];
// Fast lookups, flattened from FRANCHISES once at load. A stat row carries a historical
// Lahman teamID (e.g. "BRO" for 1950s Brooklyn); FRANCHISE_BY_TEAM maps it to the modern
// franchise id ("lad") so the franchise filter can match a Dodgers career across its
// Brooklyn→LA move. BY_ID is the reverse, for rendering the dropdown/label from an id.
const FRANCHISE_BY_TEAM = new Map(FRANCHISES.flatMap(f => f.teams.map(t => [t, f.id])));
const FRANCHISE_BY_ID   = new Map(FRANCHISES.map(f => [f.id, f]));
const DIVISIONS = [
    { label: "AL East",    ids: ["nyy","bos","tb","tor","bal"] },
    { label: "AL Central", ids: ["cle","cws","det","kc","min"] },
    { label: "AL West",    ids: ["hou","laa","oak","sea","tex"] },
    { label: "NL East",    ids: ["atl","mia","nym","phi","was"] },
    { label: "NL Central", ids: ["chc","cin","mil","pit","stl"] },
    { label: "NL West",    ids: ["ari","col","lad","sd","sf"] },
];

// Career-highlight state. Set when the user clicks a frontier point; cleared
// on outside click, Escape, or any filter change.
let playerIndex = null;       // Map<playerID, Point[]>  (all seasons per player)
// Up to 6 players can be highlighted simultaneously, each with a distinct color.
const HIGHLIGHT_COLORS = ["#f59e0b","#14b8a6","#a855f7","#f97316","#84cc16","#ec4899"];
let careerHighlights = new Map(); // playerID → color
let spotlightPos = new Map();     // playerID → {left, top} once the user drags a card

// Add a player to the highlight set, assigning the first FREE palette color (so two
// highlighted players never collide, and removing+re-adding reuses a freed color rather
// than cycling off the end). No-op if already highlighted or the 6-slot palette is full.
function addHighlight(playerID) {
    if (!playerID || careerHighlights.has(playerID)) return;
    if (careerHighlights.size >= HIGHLIGHT_COLORS.length) return;
    const used = new Set(careerHighlights.values());
    const color = HIGHLIGHT_COLORS.find(c => !used.has(c));   // lowest-index unused color
    careerHighlights.set(playerID, color);
}
function removeHighlight(playerID) { careerHighlights.delete(playerID); }
function clearHighlights() { careerHighlights.clear(); }
let metaFor = () => null;     // populated after decode: (playerID) -> {bats, throws, country, ...} | null

// Pin state for the tooltip (UX only; not serialized to URL — the career
// highlight, which IS in the URL, plays the role of "sharable focus").
let tooltipPinned = false;

// Zoom state. viewDomain overrides the chart's x/y scale domains when set.
// zoomMode controls which interaction layer mounts on the chart: "brush",
// "pan", or "off". Currently "off" by default — the SVG-based zoom paths
// are laggy on the larger clouds; the toolbar UI is hidden via CSS until
// we have a faster renderer (canvas, etc.). Code paths preserved.
let viewDomain = null;          // {x: [a,b], y: [c,d]} | null
let zoomMode = "off";
let showWorstFrontier = false;  // toggle: false = best (default), true = worst
const VERIFY_FRONTIER = new URLSearchParams(location.search).has("verifyFrontier"); // ?verifyFrontier=1 → assert incremental == full sweep each frame
let hvEncodingEnabled = true;  // scale frontier dot radius by hypervolume contribution (always on)
let animTimer = null;           // setInterval handle while frontier animation is running
let animExtentCache = null;     // { key, x, y } — full-range axis extents cached per animation session
let pbpTimeline = null;         // multi-year cursor model (buildPbpTimeline) when smooth mode is on, else null
let pbpCursorIdx = 0;           // global index into the concatenated multi-year game-date space
let pbpExtentCache = null;      // { key, x, y } — axis-extent lock held across the smooth sweep
let pbpCompletedCache = null;   // { key, points } — completed-season points (yearID < openYear) cached per open year so play doesn't re-filter all of data.points every frame
let pbpFrontierPrepCache = null; // { key, filtered } — completed-season frontier rows, sorted for merge with the open season
let evtIncFrontier = null;      // { stream, xSign, ySign, engine, comp, applied, lastCursor } — incremental .evt-career Pareto frontier state, replayed across frames (reset on backward seek / model rebuild)
let pbpRaf = null;              // requestAnimationFrame handle while the cursor is playing
// Phase-5 spring glide loop: a dedicated rAF that runs the (cheap) GPU present every display
// refresh so the spring animates smoothly, DECOUPLED from the ~15fps-throttled refreshChart
// (which still owns the expensive CPU frontier/cards/quadtree). See docs / the plan file.
let springRaf = null;           // rAF handle for the continuous GPU glide present (null = idle)
let springLoopUntil = 0;        // performance.now() deadline for the post-playback settle tail
let springFinalPending = false; // a final interactive (non-lite) refreshChart owed once the settle tail drains
let lastGpuSpringFrame = false; // did the most recent real refreshChart render the GPU spring? (gates glide)
const SPRING_SETTLE_MS = 500;   // keep gliding this long after the cursor stops so springs visibly settle
let pendingCursorYmd = null;    // a t=YYYYMMDD from a deep-link, applied once data is loaded
// The point-cloud renderer (Canvas2DRenderer) owns the bg/fg canvas layers + the
// background cache key — see the class near the export/render helpers below.
let groupCareerMode = false;    // group-career animation: the selected players' cumulative careers race through stat-space (vs. the all-player accumulating cloud)
let groupTrailHistory = new Map(); // playerID → [{x,y,cursor}] recent career positions (DATA coords) for the fading trail
const GROUP_TRAIL_LEN = 40;     // max retained positions per player in a group-career trail (~ the last few seconds at 15fps)
let pbpEvt = null;              // resident .evt full-history model (one counting-stat pair) when active, else null
let smoothLite = false;        // while playing/scrubbing: skip interaction-only work (HV, cards, rings, quadtree) for demo-smooth frames; a full render fires when idle
let smoothLiteTimer = null;    // debounce → full (interactive) render after the user stops scrubbing
let playbackSpeed = 1;         // ▶ playback speed multiplier (1× = the default sweep pace); live-adjustable
let pbpGranularity = "pbp";    // cursor granularity: "pbp" (game-by-game, full date) | "season" (year-by-year, year only)
const evtStreamCache = new Map(); // `${dataset}:${stat}` -> Promise<decoded STEV>  (resident once loaded)
// Per-dataset .evt registry. `stats` = raw streamed counting columns (committed as
// data/pbp/<prefix><stat>.evt.gz); `derived` = axes computed per player from cumulative
// components (rate:true → ratio needing the qualifier threshold + qualified axis lock;
// rate:false → monotonic sum). `qual` = the playing-time total (PA / IP) for the
// rate-axis threshold and axis-lock floor. Keep in sync with build_stat_streams.js.
const EVT_REGISTRY = {
    batting: {
        prefix: "", thresholdField: "PA", qualDeps: ["AB", "BB", "HBP", "SH", "SF"],
        qual: (c) => c.AB + c.BB + c.HBP + c.SH + c.SF,
        stats: new Set(["HR", "SB", "H", "2B", "3B", "RBI", "R", "BB", "SO", "CS", "AB", "HBP", "SF", "SH", "IBB", "GIDP", "G"]),
        derived: {
            TB:   { deps: ["H", "2B", "3B", "HR"], rate: false, fn: (c) => c.H + c["2B"] + 2 * c["3B"] + 3 * c.HR },
            PA:   { deps: ["AB", "BB", "HBP", "SH", "SF"], rate: false, fn: (c) => c.AB + c.BB + c.HBP + c.SH + c.SF },
            AVG:  { deps: ["H", "AB"], rate: true, fn: (c) => c.AB > 0 ? c.H / c.AB : NaN },
            SLG:  { deps: ["H", "2B", "3B", "HR", "AB"], rate: true, fn: (c) => c.AB > 0 ? (c.H + c["2B"] + 2 * c["3B"] + 3 * c.HR) / c.AB : NaN },
            ISO:  { deps: ["2B", "3B", "HR", "AB"], rate: true, fn: (c) => c.AB > 0 ? (c["2B"] + 2 * c["3B"] + 3 * c.HR) / c.AB : NaN },
            OBP:  { deps: ["H", "BB", "HBP", "AB", "SF"], rate: true, fn: (c) => { const d = c.AB + c.BB + c.HBP + c.SF; return d > 0 ? (c.H + c.BB + c.HBP) / d : NaN; } },
            OPS:  { deps: ["H", "2B", "3B", "HR", "AB", "BB", "HBP", "SF"], rate: true, fn: (c) => { const slg = c.AB > 0 ? (c.H + c["2B"] + 2 * c["3B"] + 3 * c.HR) / c.AB : NaN; const d = c.AB + c.BB + c.HBP + c.SF; const obp = d > 0 ? (c.H + c.BB + c.HBP) / d : NaN; return obp + slg; } },
            BABIP:{ deps: ["H", "HR", "AB", "SO", "SF"], rate: true, fn: (c) => { const d = c.AB - c.SO - c.HR + c.SF; return d > 0 ? (c.H - c.HR) / d : NaN; } },
            "BB%":{ deps: ["BB", "AB", "HBP", "SH", "SF"], rate: true, fn: (c) => { const pa = c.AB + c.BB + c.HBP + c.SH + c.SF; return pa > 0 ? c.BB / pa : NaN; } },
            "K%": { deps: ["SO", "AB", "BB", "HBP", "SH", "SF"], rate: true, fn: (c) => { const pa = c.AB + c.BB + c.HBP + c.SH + c.SF; return pa > 0 ? c.SO / pa : NaN; } },
        },
    },
    pitching: {
        prefix: "p_", thresholdField: "IP", qualDeps: ["IPouts"],
        qual: (c) => c.IPouts / 3,
        stats: new Set(["W", "L", "G", "GS", "CG", "SHO", "SV", "IPouts", "H", "ER", "HR", "BB", "SO", "IBB", "WP", "HBP", "BK", "BFP", "GF", "R", "SH", "SF", "GIDP"]),
        derived: {
            // ERA = 9·ER / (IPouts/3) = 27·ER / IPouts, etc. (per-9-innings → ×27/IPouts).
            IP:     { deps: ["IPouts"], rate: false, fn: (c) => c.IPouts / 3 },
            ERA:    { deps: ["ER", "IPouts"], rate: true, fn: (c) => c.IPouts > 0 ? 27 * c.ER / c.IPouts : NaN },
            WHIP:   { deps: ["BB", "H", "IPouts"], rate: true, fn: (c) => c.IPouts > 0 ? 3 * (c.BB + c.H) / c.IPouts : NaN },
            "K/9":  { deps: ["SO", "IPouts"], rate: true, fn: (c) => c.IPouts > 0 ? 27 * c.SO / c.IPouts : NaN },
            "BB/9": { deps: ["BB", "IPouts"], rate: true, fn: (c) => c.IPouts > 0 ? 27 * c.BB / c.IPouts : NaN },
            "H/9":  { deps: ["H", "IPouts"], rate: true, fn: (c) => c.IPouts > 0 ? 27 * c.H / c.IPouts : NaN },
            "HR/9": { deps: ["HR", "IPouts"], rate: true, fn: (c) => c.IPouts > 0 ? 27 * c.HR / c.IPouts : NaN },
            "K/BB": { deps: ["SO", "BB"], rate: true, fn: (c) => c.BB > 0 ? c.SO / c.BB : NaN },
            "K%":   { deps: ["SO", "BFP"], rate: true, fn: (c) => c.BFP > 0 ? c.SO / c.BFP : NaN },
            "BB%":  { deps: ["BB", "BFP"], rate: true, fn: (c) => c.BFP > 0 ? c.BB / c.BFP : NaN },
            "K-BB%":{ deps: ["SO", "BB", "BFP"], rate: true, fn: (c) => c.BFP > 0 ? (c.SO - c.BB) / c.BFP : NaN },
            BAOpp:  { deps: ["H", "BFP", "BB", "HBP", "SH", "SF"], rate: true, fn: (c) => { const ab = c.BFP - c.BB - c.HBP - c.SH - c.SF; return ab > 0 ? c.H / ab : NaN; } },
        },
    },
};
const evtReg = () => EVT_REGISTRY[activeDatasetKey];
const PBP_NOMINAL_DATES = 185;  // assumed game-date count for a not-yet-loaded season (scrubber estimate)
const PBP_PREFETCH_TAIL = 10;   // prefetch the neighbouring season when within this many dates of an edge
const PBP_PLAY_FRAME_MS = 66;   // min ms between full chart re-renders while playing (~15fps) — keeps the main thread responsive on wide windows
const PBP_PLAY_MAX_MS = 45000;  // cap a full sweep so a 100-season window doesn't take ~18 minutes

// URL state defaults — params at their default value are omitted from the
// hash to keep it short.
const URL_DEFAULTS = {
    ds: "batting",
    x: "HR", y: "SB", sy: "1920", ey: "2024", pa: "502",
    m: "season", lg: "all", bt: "all", cb: "era", co: "all",
    fr: "all", hl: "", d: "1", c2: "0", sy2: "1900", ey2: "1919",
    t: "",
};

// Per-dataset metadata — the central declaration that makes batting vs. pitching a
// data difference, not a code difference. The Stats toggle sets `activeDatasetKey`;
// every read of axis options / threshold / formatting goes through here, so adding a
// dataset is mostly a matter of adding an entry. Field families and why each exists:
//   • dimensions      — the ordered axis-dropdown options.
//   • defaultX/Y      — the fresh-view axes (also the URL_DEFAULTS).
//   • thresholdField  — the playing-time gate (PA / IP); rows below the slider value are
//                       dropped before the Pareto sweep so cup-of-coffee outliers don't
//                       distort the frontier.
//   • rateStats       — ratios (AVG, ERA, …); used for number formatting (decimals) and
//                       to decide when the qualifier threshold matters.
//   • lowerIsBetter   — stats where SMALL is good (ERA, SO, GIDP). The frontier sweep
//                       finds the upper-right envelope, so for these axes the sign is
//                       flipped (xSign/ySign) to find the correct (lower-left) limit.
//   • thresholdConfig — per-mode slider range/step/default/presets (Season defaults to the
//                       qualifier minimum; Career to 0 — see the inline note).
const DATASETS = {
    batting: {
        label: "Batting",
        dimensions: ["PA","G","AB","R","H","2B","3B","HR","TB","RBI","SB","CS","BB","SO","IBB","HBP","SH","SF","GIDP","AVG","OBP","SLG","OPS","ISO","BABIP","BB%","K%","RC"],
        defaultX: "HR",
        defaultY: "SB",
        thresholdField: "PA",
        thresholdLabel: "Min PA",
        handField: "bats",
        rateStats: new Set(["AVG", "OBP", "SLG", "OPS", "ISO", "BABIP"]),
        lowerIsBetter: new Set(["CS", "GIDP", "SO", "K%"]),
        thresholdConfig: {
            // `default` is the threshold the slider lands on for a fresh view
            // (no PA in the URL). Set to the qualifier minimum in Season mode
            // so cup-of-coffee 1.000 AVG outliers don't pollute the default
            // frontier on rate-stat axes; left at 0 in Career mode where the
            // qualifier number doesn't apply.
            season: {
                max: 600, step: 1, default: 502,
                presets: [
                    { val: 0,   label: "All" },
                    { val: 100, label: "100" },
                    { val: 300, label: "300" },
                    { val: 502, label: "502" },
                ],
                hint: "502 PA qualifies for the batting title.",
            },
            career: {
                max: 16000, step: 100, default: 0,
                presets: [
                    { val: 0,     label: "All" },
                    { val: 1000,  label: "1k" },
                    { val: 5000,  label: "5k" },
                    { val: 10000, label: "10k" },
                ],
                hint: "10,000+ PA marks a long, full career.",
            },
        },
    },
    pitching: {
        label: "Pitching",
        dimensions: ["IP","G","GS","W","L","CG","SHO","SV","H","ER","HR","BB","SO","BFP","ERA","WHIP","K/9","BB/9","K/BB","H/9","HR/9","K%","BB%","K-BB%","BAOpp"],
        defaultX: "IP",
        defaultY: "SO",
        thresholdField: "IP",
        thresholdLabel: "Min IP",
        handField: "throws",
        rateStats: new Set(["ERA", "WHIP", "K/9", "BB/9", "K/BB", "H/9", "HR/9", "BAOpp"]),
        lowerIsBetter: new Set(["ERA","WHIP","BB/9","H/9","HR/9","BAOpp","BB%","L","H","ER","HR","BB"]),
        thresholdConfig: {
            season: {
                max: 400, step: 1, default: 162,
                presets: [
                    { val: 0,   label: "All" },
                    { val: 50,  label: "50" },
                    { val: 100, label: "100" },
                    { val: 162, label: "162" },
                ],
                hint: "162 IP qualifies for the ERA title.",
            },
            career: {
                max: 6000, step: 10, default: 0,
                presets: [
                    { val: 0,    label: "All" },
                    { val: 500,  label: "500" },
                    { val: 1500, label: "1.5k" },
                    { val: 3000, label: "3k" },
                ],
                hint: "3,000+ IP marks a long pitching career.",
            },
        },
    },
};
let activeDatasetKey = "batting";
// Loaded after both datasets resolve; keyed by dataset key.
const datasetState = {};
const activeDataset = () => DATASETS[activeDatasetKey];
const activeData    = () => datasetState[activeDatasetKey];


// People CSV is loaded in parallel for the multi-file site (the bundle's
// decoder already attaches metaFor to the points array and the bundler
// short-circuits this fetch to a Promise.resolve(null)).
const peoplePromise = d3.csv("data/people_lahman_1871-2025.csv").catch(() => null);

const BATTING_COUNT_COLS = ["G","AB","R","H","2B","3B","HR","RBI","SB","CS","BB","SO","IBB","HBP","SH","SF","GIDP"];
const PITCHING_COUNT_COLS = ["W","L","G","GS","CG","SHO","SV","IPouts","H","ER","HR","BB","SO","IBB","WP","HBP","BK","BFP","GF","R","SH","SF","GIDP"];

// `|| 0` coerces NaN (from a blank CSV cell) to 0 so the sum stays a
// number. HBP / SH / SF aren't tracked for early eras; treating those
// blanks as zero gives an approximate-but-numeric PA. Critical for the
// threshold filter — NaN < 502 is false in JS, so a NaN PA would bypass
// the filter entirely and let cup-of-coffee 1.000 averages onto the
// frontier.
const z = (v) => (isFinite(v) ? v : 0);

// CSV rows arrive as all-strings. This turns each row into a typed point with every
// derived stat PRE-COMPUTED once at load, so the hot frontier path (which runs per
// frame) only reads numbers, never parses or divides. The formulas mirror
// EVT_REGISTRY.batting.derived — they must agree, since the same axis can be fed by a
// static season row (here) OR a streamed .evt cumulative (there). Rate stats are NaN
// when their denominator is 0 (no AB yet); NaN is deliberate — it drops the point from
// the chart rather than plotting a bogus 0.000.
function parseBattingRows(rawPoints) {
    const out = [];
    for (const r of rawPoints) {
        const p = {
            playerID: r.playerID,
            yearID: parseInt(r.yearID),
            teamID: r.teamID,
            lgID: r.lgID,
        };
        for (const c of BATTING_COUNT_COLS) p[c] = parseInt(r[c]);
        p.PA = z(p.AB) + z(p.BB) + z(p.HBP) + z(p.SH) + z(p.SF);
        p.TB = z(p.H) + z(p["2B"]) + 2 * z(p["3B"]) + 3 * z(p.HR);
        p.AVG = p.AB > 0 ? p.H / p.AB : NaN;
        const obpDen = p.AB + p.BB + p.HBP + p.SF;
        p.OBP = obpDen > 0 ? (p.H + p.BB + p.HBP) / obpDen : NaN;
        p.SLG = p.AB > 0 ? p.TB / p.AB : NaN;
        p.OPS  = isFinite(p.OBP) && isFinite(p.SLG) ? p.OBP + p.SLG : NaN;
        p.ISO  = p.AB > 0 ? (z(p.TB) - z(p.H)) / p.AB : NaN;
        const babipDen = z(p.AB) - z(p.SO) - z(p.HR) + z(p.SF);
        p.BABIP  = babipDen > 0 ? (z(p.H) - z(p.HR)) / babipDen : NaN;
        p["BB%"] = p.PA > 0 ? z(p.BB) / p.PA : NaN;
        p["K%"]  = p.PA > 0 ? z(p.SO) / p.PA : NaN;
        const rcDen = z(p.AB) + z(p.BB);
        p.RC = rcDen > 0 ? (z(p.H) + z(p.BB)) * z(p.TB) / rcDen : NaN;
        out.push(p);
    }
    return out;
}

function parsePitchingRows(rawPoints) {
    const out = [];
    for (const r of rawPoints) {
        const p = {
            playerID: r.playerID,
            yearID: parseInt(r.yearID),
            teamID: r.teamID,
            lgID: r.lgID,
        };
        for (const c of PITCHING_COUNT_COLS) p[c] = parseInt(r[c]);
        // Lahman stores IPouts (innings * 3). IP as a decimal is simpler for
        // charting than the .1/.2 "outs-as-fractions" baseball convention.
        // Coerce blank IPouts to 0 so the IP threshold filter never bypasses
        // (parallel reason to PA above).
        p.IPouts = z(p.IPouts);
        p.IP     = p.IPouts / 3;
        p.ERA   = p.IPouts > 0 ? (9 * p.ER) / (p.IPouts / 3) : NaN;
        p.WHIP  = p.IPouts > 0 ? (p.BB + p.H) / (p.IPouts / 3) : NaN;
        p["K/9"]  = p.IPouts > 0 ? (9 * p.SO) / (p.IPouts / 3) : NaN;
        p["BB/9"] = p.IPouts > 0 ? (9 * p.BB) / (p.IPouts / 3) : NaN;
        p["H/9"]  = p.IPouts > 0 ? (9 * p.H)  / (p.IPouts / 3) : NaN;
        p["K/BB"]  = p.BB > 0 ? p.SO / p.BB : NaN;
        p["HR/9"]  = p.IPouts > 0 ? (9 * z(p.HR)) / (p.IPouts / 3) : NaN;
        p["K%"]    = z(p.BFP) > 0 ? z(p.SO) / z(p.BFP) : NaN;
        p["BB%"]   = z(p.BFP) > 0 ? z(p.BB) / z(p.BFP) : NaN;
        p["K-BB%"] = z(p.BFP) > 0 ? (z(p.SO) - z(p.BB)) / z(p.BFP) : NaN;
        const abFacedP = z(p.BFP) - z(p.BB) - z(p.HBP) - z(p.SH) - z(p.SF);
        p.BAOpp = abFacedP > 0 ? z(p.H) / abFacedP : NaN;
        out.push(p);
    }
    return out;
}

// Group all of a player's season rows under their playerID, once at load. This is the
// O(1) lookup the click-to-highlight career trail needs: clicking one frontier season
// must instantly find that player's OTHER seasons to plot the gold trail, without
// re-scanning the whole points array each click.
function buildPlayerIndex(points) {
    const idx = new Map();
    for (const p of points) {
        let arr = idx.get(p.playerID);
        if (!arr) { arr = []; idx.set(p.playerID, arr); }
        arr.push(p);
    }
    return idx;
}

// Load + parse one dataset. The same call serves both run modes: in the multi-file dev
// site `d3.csv` fetches from data/; in the single-file bundle the bundler regex-swaps
// these exact two calls for in-memory decoders (so keep the literal paths stable — see
// CLAUDE.md "Single-file bundle"). The decoder also attaches a `.metaFor` (People lookup)
// to its result array; the CSV path leaves it undefined and buildMetaFromPeopleCsv fills
// `metaFor` instead — either way `metaFor(playerID)` resolves handedness/country.
async function loadDataset(key) {
    // The bundler swaps these two d3.csv() calls for the inline decoders.
    const rawPoints = key === "pitching"
        ? await d3.csv("data/pitching_limits_1871-2025.csv")
        : await d3.csv("data/batting_limits_1871-2025.csv");
    if (typeof rawPoints.metaFor === "function") metaFor = rawPoints.metaFor;
    const points = key === "pitching" ? parsePitchingRows(rawPoints) : parseBattingRows(rawPoints);
    return { points, playerIndex: buildPlayerIndex(points) };
}

// ── Sub-season (Retrosheet) play-by-play layer ──────────────────────────────
// A lazy-loaded BL2P season file (scripts/convert_retrosheet_pbp.py) holds every
// player's per-game counting-stat deltas in date order. We prefix-sum them into
// cumulative-as-of-date trajectories so the frontier can be animated game by game
// within a season. The synthetic points pointsAsOf() emits are shaped exactly like
// parseBattingRows output, so they feed the existing frontier pipeline unchanged.
const pbpCache = new Map();   // `${dataset}:${year}` -> Promise<decoded | null>

function decodePbpSeason(year, dataset) {
    const key = `${dataset}:${year}`;
    if (pbpCache.has(key)) return pbpCache.get(key);
    const prefix = dataset === "pitching" ? "p" : "b";
    const promise = fetch(`data/pbp/${prefix}${year}.bl2p.gz`)
        .then(async (resp) => {
            if (!resp.ok) return null;            // 404 → caller degrades to year animation
            const stream = resp.body.pipeThrough(new DecompressionStream("gzip"));
            const buf = new Uint8Array(await new Response(stream).arrayBuffer());
            return parseBl2p(buf);
        })
        .catch(() => null);
    pbpCache.set(key, promise);
    return promise;
}

// Decode one BL2P season blob (little-endian, produced by
// scripts/convert_retrosheet_pbp.py). The format is a hand-rolled columnar binary chosen
// over JSON/CSV because a season is ~thousands of player-games and we want it small over
// the wire AND zero-parse on the hot path. Layout, in order:
//   "BL2P"                      4-byte magic
//   major,minor,dataset,flags   4 bytes (only major is checked)
//   year, P, D, C               4× u16  — year, #players, #dates, #stat columns
//   dates[D]                    D× u16  — the day-of-year index for each game date
//   cols[C]                     per col: u8 bit-width, u8 name-len, name bytes
//   names[P]                    per player: u8 len, name bytes
//   gameCounts[P]               P× u16  — games per player (Σ = G, the total game rows)
//   dateIdxAll[G]               G× u16  — each game row's date index (grouped by player)
//   columns[C]                  G× `width`-bit values, LSB-first, byte-aligned per column
// The values are PER-GAME deltas; we prefix-sum them per player at the end so a cursor
// lookup is "cumulative as of date X" without re-summing. Throws on bad magic/version so
// decodePbpSeason's caller can degrade to whole-season animation.
function parseBl2p(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dec = new TextDecoder();
    let off = 0;
    if (dec.decode(buf.subarray(0, 4)) !== "BL2P") throw new Error("parseBl2p: bad magic");
    off = 4;
    const major = buf[off++]; off += 3;           // minor, dataset, flags (unused here)
    if (major !== 1) throw new Error("parseBl2p: unsupported version " + major);
    const year = dv.getUint16(off, true); off += 2;
    const P = dv.getUint16(off, true); off += 2;   // players
    const D = dv.getUint16(off, true); off += 2;   // distinct game dates
    const C = dv.getUint16(off, true); off += 2;   // stat columns

    const dates = new Uint16Array(D);
    for (let i = 0; i < D; i++) { dates[i] = dv.getUint16(off, true); off += 2; }

    const cols = new Array(C);
    for (let i = 0; i < C; i++) {
        const width = buf[off++];
        const nl = buf[off++];
        const name = dec.decode(buf.subarray(off, off + nl)); off += nl;
        cols[i] = { name, width };
    }

    const names = new Array(P);
    for (let i = 0; i < P; i++) {
        const nl = buf[off++];
        names[i] = dec.decode(buf.subarray(off, off + nl)); off += nl;
    }

    const gameCounts = new Uint16Array(P);
    let G = 0;
    for (let i = 0; i < P; i++) { gameCounts[i] = dv.getUint16(off, true); off += 2; G += gameCounts[i]; }

    const dateIdxAll = new Uint16Array(G);
    for (let i = 0; i < G; i++) { dateIdxAll[i] = dv.getUint16(off, true); off += 2; }

    // Bit-unpack each column. Each stat is stored in just `width` bits (most per-game
    // counts fit in 2–4 bits — a player rarely hits 4 HR in a game), packed LSB-first
    // into a bit stream that resets to a byte boundary at each column. The classic
    // shift-register unpack: keep an accumulator `acc` with `nbits` valid low bits, refill
    // a byte at a time until we have ≥ width, then take the low `width` bits and shift them
    // out. `mask` clears the high bits; `acc >>>= width` (unsigned) discards the consumed value.
    const colArrays = {};
    for (const { name, width } of cols) {
        const arr = new Int32Array(G);
        const mask = (1 << width) - 1;
        let acc = 0, nbits = 0, p = off;
        for (let i = 0; i < G; i++) {
            while (nbits < width) { acc |= buf[p++] << nbits; nbits += 8; }  // refill
            arr[i] = acc & mask;                                            // take width bits
            acc >>>= width;                                                 // drop them
            nbits -= width;
        }
        off += Math.ceil((G * width) / 8);          // next column is byte-aligned
        colArrays[name] = arr;
    }

    // Prefix-sum per player into cumulative-by-game arrays: arr[i] is the running total
    // through game i, so pbpPointsAsOf can binary-search "state as of date X" in O(log n)
    // instead of summing deltas every frame.
    const colNames = cols.map((c) => c.name);
    const perPlayer = new Map();
    let g = 0;
    for (let pi = 0; pi < P; pi++) {
        const n = gameCounts[pi];
        const dateIdx = dateIdxAll.subarray(g, g + n);
        const cum = {};
        for (const name of colNames) {
            const src = colArrays[name];
            const c = new Int32Array(n);
            let run = 0;
            for (let k = 0; k < n; k++) { run += src[g + k]; c[k] = run; }
            cum[name] = c;
        }
        perPlayer.set(names[pi], { dateIdx, cum });
        g += n;
    }

    return { year, dates, dateCount: D, cols: colNames, perPlayer, games: G, players: P };
}

// Largest index k with sortedDateIdx[k] <= cursorIdx, or -1 if the player has
// not yet appeared by the cursor date.
function pbpLastGameAtOrBefore(sortedDateIdx, cursorIdx) {
    let lo = 0, hi = sortedDateIdx.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sortedDateIdx[mid] <= cursorIdx) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return ans;
}

// Build season-shaped points from each player's cumulative stats as of the
// cursor date, then run them through parseBattingRows so every derived stat
// (PA, AVG, OBP, …) is computed identically to the season-level pipeline.
function pbpPointsAsOf(decoded, withinIdx, dataset) {
    const seasonIdx = datasetState[dataset]?.playerIndex;
    const rawRows = [];
    for (const [name, rec] of decoded.perPlayer) {
        const k = pbpLastGameAtOrBefore(rec.dateIdx, withinIdx);
        if (k < 0) continue;                       // no game yet → no point
        const row = { playerID: name, yearID: String(decoded.year) };
        for (const col of decoded.cols) row[col] = rec.cum[col][k];
        // Team / league come from the player's season-level row (same display
        // key), so the league filter and color-by-league work unchanged.
        let teamID = "—", lgID = "—";
        const seasonRows = seasonIdx && seasonIdx.get(name);
        if (seasonRows) {
            const s = seasonRows.find((r) => r.yearID === decoded.year);
            if (s) { teamID = s.teamID; lgID = s.lgID; }
        }
        row.teamID = teamID;
        row.lgID = lgID;
        rawRows.push(row);
    }
    return dataset === "pitching" ? parsePitchingRows(rawRows) : parseBattingRows(rawRows);
}

// ── Multi-year cursor timeline ───────────────────────────────────────────────
// A virtual timeline over the selected sYear..eYear. Each year is decoded lazily
// when the cursor reaches it; 404 years are marked "missing" and skipped. The
// global cursor (pbpCursorIdx) indexes a concatenation of every year's game-date
// table; not-yet-loaded years are estimated at PBP_NOMINAL_DATES so the scrubber
// has a sane range without fetching all 100+ seasons up front.

function buildPbpTimeline(sYear, eYear, dataset) {
    const years = [];
    for (let y = sYear; y <= eYear; y++) {
        years.push({ year: y, status: "unknown", decoded: null, dateCount: null, offset: 0 });
    }
    const tl = { dataset, sYear, eYear, years, totalEstimate: 0, openYearIdx: 0 };
    pbpRecomputeOffsets(tl);
    return tl;
}

// Effective length of a year in the concatenated day-space.
function pbpYearLen(entry) {
    if (entry.status === "covered") return entry.dateCount;
    if (entry.status === "missing") return 0;
    return PBP_NOMINAL_DATES;
}

// Recompute per-year offsets + the timeline total. When `keep` ({yearIdx,
// withinIdx}) is given, remap the global cursor so it holds the same calendar
// position across a year's estimate→real length change.
function pbpRecomputeOffsets(tl, keep) {
    let acc = 0;
    for (const e of tl.years) { e.offset = acc; acc += pbpYearLen(e); }
    tl.totalEstimate = acc;
    if (keep) pbpCursorIdx = pbpGlobalFor(tl, keep.yearIdx, keep.withinIdx);
}

function pbpGlobalFor(tl, yearIdx, withinIdx) {
    const e = tl.years[yearIdx];
    if (!e) return 0;
    return e.offset + Math.max(0, Math.min(pbpYearLen(e) - 1, withinIdx | 0));
}

// Map a global cursor index to { yearEntry, yearIdx, withinIdx }, skipping
// zero-length (missing) years. Clamps into [0, totalEstimate-1].
function pbpResolveGlobal(tl, globalIdx) {
    const g = Math.max(0, Math.min(tl.totalEstimate - 1, globalIdx | 0));
    let chosen = -1;
    for (let i = 0; i < tl.years.length; i++) {
        if (pbpYearLen(tl.years[i]) === 0) continue;   // skip missing years
        chosen = i;
        if (g < tl.years[i].offset + pbpYearLen(tl.years[i])) break;
    }
    if (chosen < 0) return { yearEntry: tl.years[0], yearIdx: 0, withinIdx: 0 };
    const e = tl.years[chosen];
    return { yearEntry: e, yearIdx: chosen, withinIdx: Math.max(0, Math.min(pbpYearLen(e) - 1, g - e.offset)) };
}

// Lazily decode a year (idempotent). Preserves the cursor's calendar position
// across the resulting length change.
async function pbpEnsureYearLoaded(tl, yearIdx) {
    const e = tl.years[yearIdx];
    if (!e || e.status !== "unknown") return e;
    e.status = "loading";
    const decoded = await decodePbpSeason(e.year, tl.dataset);
    const keep = pbpResolveGlobal(tl, pbpCursorIdx);
    if (decoded) { e.status = "covered"; e.decoded = decoded; e.dateCount = decoded.dateCount; }
    else { e.status = "missing"; }
    pbpRecomputeOffsets(tl, { yearIdx: keep.yearIdx, withinIdx: keep.withinIdx });
    return e;
}

// Prefetch the neighbouring season as the cursor nears a year's edge.
function pbpMaybePrefetch(tl, yearIdx, withinIdx) {
    const e = tl.years[yearIdx];
    if (!e || e.status !== "covered") return;
    if (withinIdx >= e.dateCount - PBP_PREFETCH_TAIL) {
        const next = tl.years[yearIdx + 1];
        if (next && next.status === "unknown") pbpEnsureYearLoaded(tl, yearIdx + 1);
    }
    if (withinIdx <= PBP_PREFETCH_TAIL) {
        const prev = tl.years[yearIdx - 1];
        if (prev && prev.status === "unknown") pbpEnsureYearLoaded(tl, yearIdx - 1);
    }
}

// Eagerly load the next `ahead` not-yet-loaded seasons. Group-career sweeps span the
// whole career (decades), and the per-year prefetch above only kicks in within a few
// dates of a boundary — too late when the play loop crosses a year in one frame. With
// several years of lead the small (~130 KB) fetches land before the cursor arrives, so
// the sweep doesn't stall on "Loading <year>…" at every boundary. Idempotent.
function pbpEnsureAhead(tl, yearIdx, ahead) {
    for (let k = 1; k <= ahead; k++) {
        const i = yearIdx + k;
        if (i >= tl.years.length) break;
        if (tl.years[i].status === "unknown") pbpEnsureYearLoaded(tl, i);
    }
}

// Memory bound for long sweeps. Only the OPEN year's decoded PBP is ever read
// (completed years render from Lahman season totals in `data.points`), so a sweep
// across a wide span — e.g. a group-career spanning 1920–2025 — otherwise retains
// ~100 decoded seasons (hundreds of MB, OOM-crashes the tab). Drop decoded payloads
// for years outside a small window around the cursor AND evict them from `pbpCache`
// so they're actually GC'd (both hold a reference). Status + dateCount are kept, so
// offsets and the cursor are undisturbed; a step back re-decodes on demand.
function pbpReleaseFarYears(tl, openIdx, behind, ahead) {
    for (let i = 0; i < tl.years.length; i++) {
        if (i >= openIdx - behind && i <= openIdx + ahead) continue;
        const e = tl.years[i];
        if (e.decoded) {
            e.decoded = null;
            pbpCache.delete(`${tl.dataset}:${e.year}`);
        }
    }
}

// Re-decode a year whose decoded payload was released (a backward scrub landed on it),
// WITHOUT touching status/offsets — dateCount is preserved, so the cursor stays put.
function pbpReloadDecoded(tl, idx) {
    const e = tl.years[idx];
    if (!e || e.status !== "covered" || e.decoded || e.reloading) return Promise.resolve();
    e.reloading = true;
    return decodePbpSeason(e.year, tl.dataset).then((decoded) => {
        if (decoded) e.decoded = decoded;
        e.reloading = false;
    });
}

// Axis-extent lock for the smooth sweep: the extent of every season in the full
// selected window (sYear..eYear) at its full totals, so the axes are fixed from
// the first frame and the accumulating frontier visibly grows into that frame
// instead of the axes jittering as cumulative totals climb. Computed from the
// always-available Lahman season points (windowPoints), so it needs no PBP files
// loaded and is stable for the whole animation. Cheap point-level filters
// (league, franchise) are applied; bats/country are not — they can only shrink
// the envelope, and a slightly-wider stable axis is preferable to one that jitters.
function pbpComputeExtent(tl, xDim, yDim, filters, windowPoints, mode, datasetKey, group = null) {
    const grpKey = group ? [...group].sort().join(",") : "";
    const key = `${tl.dataset}|${mode}|${xDim}|${yDim}|${filters.league}|${filters.franchise}|${tl.sYear}|${tl.eYear}|grp=${grpKey}`;
    if (pbpExtentCache && pbpExtentCache.key === key) return { x: pbpExtentCache.x, y: pbpExtentCache.y };
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const acc = (vx, vy) => {
        if (isFinite(vx)) { if (vx < x0) x0 = vx; if (vx > x1) x1 = vx; }
        if (isFinite(vy)) { if (vy < y0) y0 = vy; if (vy > y1) y1 = vy; }
    };
    const inWindow = (p) => p.yearID >= tl.sYear && p.yearID <= tl.eYear
        && (filters.league === "all" || p.lgID === filters.league)
        && (filters.franchise === "all" || FRANCHISE_BY_TEAM.get(p.teamID) === filters.franchise);
    if (mode === "career") {
        // Career mode aggregates each player's seasons into one career point, so the
        // envelope must be over FULL career totals (career HR reaches the hundreds),
        // not season totals — otherwise the axes lock to season maxima (~80 HR) and
        // the growing career dots run off the chart.
        const byPlayer = new Map();
        for (const p of windowPoints) {
            if (!inWindow(p)) continue;
            if (group && !group.has(p.playerID)) continue;   // group-career: envelope over just the selected players' careers
            let arr = byPlayer.get(p.playerID);
            if (!arr) { arr = []; byPlayer.set(p.playerID, arr); }
            arr.push(p);
        }
        for (const seasons of byPlayer.values()) {
            seasons.sort((a, b) => a.yearID - b.yearID);
            const agg = aggregateCareer(seasons, datasetKey);
            acc(+agg[xDim], +agg[yDim]);
        }
        // Anchor the group-career frame at the origin so trajectories grow outward
        // from (0,0) into the fixed career-end envelope rather than starting cramped.
        if (group) acc(0, 0);
    } else {
        for (const p of windowPoints) {
            if (!inWindow(p)) continue;
            acc(+p[xDim], +p[yDim]);
        }
    }
    const x = isFinite(x0) ? [x0, x1] : undefined;
    const y = isFinite(y0) ? [y0, y1] : undefined;
    pbpExtentCache = { key, x, y };
    return { x, y };
}

// ── Group-career mode ────────────────────────────────────────────────────────
// The selected players (careerHighlights) race their CUMULATIVE careers through
// stat-space as the cursor sweeps calendar time. Shares the whole pbpTimeline
// engine (cursor, scrubber, play loop, lazy season decode) — only the per-frame
// point-builder differs: one cumulative-career point per player instead of the
// all-player accumulating cloud.

function groupCareerActive() {
    return groupCareerMode && pbpTimeline && careerHighlights.size >= 1;
}

// The group's combined career span: earliest debut → latest final season, across
// every selected player's Lahman seasons. Used to set the timeline window so a
// short-career player and a long-career one both fit in one animation.
function groupCareerSpan(datasetKey) {
    const idx = datasetState[datasetKey]?.playerIndex;
    let lo = Infinity, hi = -Infinity;
    if (idx) {
        for (const pid of careerHighlights.keys()) {
            const seasons = idx.get(pid);
            if (!seasons || !seasons.length) continue;
            for (const s of seasons) {
                if (s.yearID < lo) lo = s.yearID;
                if (s.yearID > hi) hi = s.yearID;
            }
        }
    }
    return isFinite(lo) ? { lo, hi } : null;
}

// Per-frame builder: for each selected player, the cumulative-career point as of
// the cursor = aggregateCareer(prior completed seasons at full totals  +  the open
// season's PBP partial). Players with no game yet hold at their prior career total
// (a step); players whose career hasn't started are omitted.
function pbpBuildGroupCareer(tl, resolved, xDim, yDim, filt, datasetKey) {
    const { yearEntry, withinIdx } = resolved;
    const openYear = yearEntry.year;
    const group = new Set(careerHighlights.keys());
    const seasonIndex = datasetState[datasetKey]?.playerIndex;
    // Open-season cumulative-to-date partials, filtered to the group; normalize the
    // String yearID emitted by pbpPointsAsOf to a number for aggregateCareer/sorts.
    const openByPid = new Map();
    for (const r of pbpPointsAsOf(yearEntry.decoded, withinIdx, tl.dataset)) {
        if (!group.has(r.playerID)) continue;
        r.yearID = openYear;
        openByPid.set(r.playerID, r);
    }
    const pts = [];
    for (const pid of group) {
        const seasons = (seasonIndex && seasonIndex.get(pid)) || [];
        const priorFull = seasons.filter(s => s.yearID < openYear);   // strict: the open year is represented only by its partial
        const openRow = openByPid.get(pid);
        const careerSeasons = openRow ? priorFull.concat(openRow) : priorFull;
        if (!careerSeasons.length) continue;                          // career not started by the cursor
        careerSeasons.sort((a, b) => a.yearID - b.yearID);
        pts.push(aggregateCareer(careerSeasons, datasetKey));
    }
    const pbpExtent = pbpComputeExtent(tl, xDim, yDim, filt, datasetState[datasetKey].points, "career", datasetKey, group);
    window.__bl2d_groupCareerPoints = pts.map(p => ({ pid: p.playerID, x: p[xDim], y: p[yDim] }));
    window.__bl2d_groupCareerActive = true;
    return { points: pts, sY: tl.sYear, eY: openYear, pbpExtent };
}

// ── .evt full-history mode (single counting-stat pair) ──────────────────────
// When both chart axes are counting stats with committed event streams, decode the
// two resident .evt files (docs/pbp-evt-format.md) and animate every player's
// cumulative-as-of-date career across ALL history — no per-season .bl2p streaming,
// no lazy load / release. Rate stats stay on .bl2p (they're not sparse events).
// Resolve a chart dimension to {deps, fn, rate}: a raw streamed column, or a derived
// stat whose components are all streamed. Returns null if not .evt-eligible.
function evtDimSpec(dim) {
    const reg = evtReg(); if (!reg) return null;
    if (reg.derived[dim]) return reg.derived[dim].deps.every((d) => reg.stats.has(d)) ? reg.derived[dim] : null;
    return reg.stats.has(dim) ? { deps: [dim], rate: false, fn: (c) => c[dim] } : null;
}
function evtEligible(xDim, yDim) {
    // .evt drives BOTH modes over all history, batting AND pitching. Career: one
    // cumulative point per player. Season: one point per player per season (completed
    // from Lahman data.points, open growing from .evt — pitching is all step events).
    return !!evtReg() && !!evtDimSpec(xDim) && !!evtDimSpec(yDim);
}
// Decode one STEV ("stat event") blob — a single counting stat's full-history per-player
// event stream (data/pbp/<stat>.evt.gz, built by build_stat_streams.js). One file per
// stat (HR, SB, …); buildEvtModel loads the two/few a chart needs. Layout:
//   "STEV"                  4-byte magic
//   version                 1 byte
//   statName                u8 len + name bytes
//   numDates, numSeasons    2× u16  — global date table size, #seasons
//   seasons[numSeasons]     per season: u16 year, u16 #dates  (lets yearOf[] be rebuilt)
//   doy[numDates]           u16 each — day-of-year per global date index
//   P                       u32 — #players
//   names[P]                per player: u8 len + name bytes
//   players[P]              per player: varint n, then n×(varint dDate, varint dCum)
// The two inner streams are DELTA-encoded and LEB128 varint-packed: dates and cumulative
// values are both monotone, so storing successive DIFFERENCES keeps every number tiny
// (1 byte each, usually) and the gzip layer compresses the rest. We prefix-sum the deltas
// back (`gd += `, `run += `) into absolute global-date indices and absolute cumulative
// totals as we read — so evtAsOf can binary-search a player's value as of any date.
function decodeStev(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dec = new TextDecoder(); let off = 0;
    if (dec.decode(buf.subarray(0, 4)) !== "STEV") throw new Error("bad STEV magic");
    off = 4; off++;                                   // version
    const snLen = buf[off++]; const stat = dec.decode(buf.subarray(off, off + snLen)); off += snLen;
    const numDates = dv.getUint16(off, true); off += 2;
    const numSeasons = dv.getUint16(off, true); off += 2;
    const seasons = [];
    for (let i = 0; i < numSeasons; i++) { const year = dv.getUint16(off, true); off += 2; const nD = dv.getUint16(off, true); off += 2; seasons.push({ year, nDates: nD }); }
    const doy = new Uint16Array(numDates);
    for (let i = 0; i < numDates; i++) { doy[i] = dv.getUint16(off, true); off += 2; }
    const P = dv.getUint32(off, true); off += 4;
    const names = new Array(P);
    for (let i = 0; i < P; i++) { const nl = buf[off++]; names[i] = dec.decode(buf.subarray(off, off + nl)); off += nl; }
    // LEB128 varint reader: 7 data bits per byte, high bit = "more bytes follow".
    const rv = () => { let v = 0, s = 0, b; do { b = buf[off++]; v |= (b & 127) << s; s += 7; } while (b & 128); return v >>> 0; };
    const byName = new Map();
    for (let i = 0; i < P; i++) {
        const n = rv(); const dates = new Uint16Array(n); const cum = new Uint16Array(n);
        let gd = 0, run = 0;                          // running date index + running cumulative total
        for (let k = 0; k < n; k++) { gd += rv(); run += rv(); dates[k] = gd; cum[k] = run; }  // un-delta
        byName.set(names[i], { dates, cum });
    }
    return { stat, numDates, seasons, doy, byName };
}
function loadEvtStat(stat) {
    const reg = evtReg();
    const key = `${activeDatasetKey}:${stat}`;
    if (evtStreamCache.has(key)) return evtStreamCache.get(key);
    const p = fetch(`data/pbp/${reg.prefix}${stat.toLowerCase()}.evt.gz`).then(async (r) => {
        if (!r.ok) return null;
        const ds = r.body.pipeThrough(new DecompressionStream("gzip"));
        return decodeStev(new Uint8Array(await new Response(ds).arrayBuffer()));
    }).catch(() => null);
    evtStreamCache.set(key, p);
    return p;
}
async function buildEvtModel(xDim, yDim) {
    const reg = evtReg();
    const xs = evtDimSpec(xDim), ys = evtDimSpec(yDim);
    if (!xs || !ys) return null;
    const usesQual = xs.rate || ys.rate;                  // a rate axis → need the qualifier (PA/IP) for the threshold
    const deps = new Set([...xs.deps, ...ys.deps]);
    if (usesQual) reg.qualDeps.forEach((d) => deps.add(d));
    const depList = [...deps];
    const loaded = await Promise.all(depList.map(loadEvtStat));
    if (loaded.some((s) => !s)) return null;
    const streams = {}; depList.forEach((d, i) => streams[d] = loaded[i]);
    const ref = loaded[0];
    const numDates = ref.numDates;
    const empty = { dates: new Uint16Array(0), cum: new Uint16Array(0) };
    const yearOf = new Int16Array(numDates); let g = 0;
    const seasonStartByYear = new Map();              // year → first global date index (for season-mode differencing)
    for (const s of ref.seasons) { if (!seasonStartByYear.has(s.year)) seasonStartByYear.set(s.year, g); for (let i = 0; i < s.nDates && g < numDates; i++) yearOf[g++] = s.year; }
    const seasonEndByYear = new Map();                // year → last global date index (for season-granularity snapping)
    { const yrs = [...seasonStartByYear.keys()].sort((a, b) => a - b);
      for (let i = 0; i < yrs.length; i++) seasonEndByYear.set(yrs[i], (i + 1 < yrs.length ? seasonStartByYear.get(yrs[i + 1]) : numDates) - 1); }

    // One record per player who appears in any needed stream: their component series,
    // their debut/last year (debut → era colour; both → season-mode active-window skip),
    // and a final-state value (for axis lock).
    const names = new Set(); for (const d of depList) for (const k of streams[d].byName.keys()) names.add(k);
    const players = [];
    let xMax = 0, yMax = 0;
    const cEnd = {};
    for (const nm of names) {
        const comp = {}; let debut = numDates, last = 0;
        for (const d of depList) { const s = streams[d].byName.get(nm) || empty; comp[d] = s; if (s.dates.length) { debut = Math.min(debut, s.dates[0]); last = Math.max(last, s.dates[s.dates.length - 1]); } }
        const debutYear = debut < numDates ? yearOf[debut] : ref.seasons[0].year;
        const lastYear = yearOf[last] || debutYear;
        players.push({ name: nm, comp, debutYear, lastYear });
        // axis lock: career-end value; for rate axes only count players with enough PA
        // so a 3-for-3 cup-of-coffee 1.000 AVG doesn't blow out the frame.
        for (const d of depList) cEnd[d] = (comp[d].cum.length ? comp[d].cum[comp[d].cum.length - 1] : 0);
        const qEnd = usesQual ? reg.qual(cEnd) : Infinity;
        const xv = xs.fn(cEnd), yv = ys.fn(cEnd);
        const qual = qEnd >= 1000;                         // ~career qualifier (1000 PA / 1000 IP) for axis framing
        if (isFinite(xv) && (!xs.rate || qual)) xMax = Math.max(xMax, xv);
        if (isFinite(yv) && (!ys.rate || qual)) yMax = Math.max(yMax, yv);
    }
    return { xDim, yDim, xs, ys, usesQual, qual: reg.qual, thresholdField: reg.thresholdField, depList,
             numDates, players, doy: ref.doy, yearOf, seasonStartByYear, seasonEndByYear,
             xMax, yMax, minYear: ref.seasons[0].year, maxYear: ref.seasons[ref.seasons.length - 1].year };
}
// Season granularity: snap a global date index to its season's LAST date (so the cursor
// steps year-by-year and shows the full-season state).
function evtSeasonSnap(model, gi) {
    const d = Math.max(0, Math.min(model.numDates - 1, Math.floor(gi)));
    return Math.min(model.winEnd ?? (model.numDates - 1), model.seasonEndByYear.get(model.yearOf[d]) ?? d);
}
// Season mode: one point per player for the OPEN season `O`, accumulated game-by-game to
// date `d` (within-season = cumulative at d minus cumulative at the season's start). The
// completed seasons (year < O) come from Lahman data.points, so this only builds the
// growing open-season points (a few hundred active players).
function evtOpenSeasonPoints(model, d, O) {
    const start = model.seasonStartByYear.get(O);
    if (start == null) return [];
    const before = start - 1;
    const rows = [], c = {};
    for (const p of model.players) {
        if (O < p.debutYear || O > p.lastYear) continue;   // player not active in O
        let any = false;
        for (const dep of model.depList) { const v = evtAsOf(p.comp[dep], d) - evtAsOf(p.comp[dep], before); c[dep] = v; if (v) any = true; }
        if (!any) continue;                                 // no games yet in O by date d
        const x = model.xs.fn(c), y = model.ys.fn(c);
        if (!isFinite(x) || !isFinite(y)) continue;
        if (!model.xs.rate && !model.ys.rate && x === 0 && y === 0) continue;
        const q = model.usesQual ? model.qual(c) : 1e9;
        rows.push({ playerID: p.name, teamID: "—", lgID: "—", yearID: O, [model.thresholdField]: q, [model.xDim]: x, [model.yDim]: y });
    }
    return rows;
}
function evtAsOf(series, d) {                          // cumulative value as of global date d
    const a = series.dates; let lo = 0, hi = a.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] <= d) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans < 0 ? 0 : series.cum[ans];
}
function evtPointsAsOf(model, d) {                      // season-shaped rows for the frontier pipeline
    d = Math.max(0, Math.min(model.numDates - 1, d));
    const rows = [];
    const c = {};
    for (const p of model.players) {
        for (const dep of model.depList) c[dep] = evtAsOf(p.comp[dep], d);
        const x = model.xs.fn(c), y = model.ys.fn(c);
        if (!isFinite(x) || !isFinite(y)) continue;        // rate undefined (no AB yet) → not on chart
        if (!model.xs.rate && !model.ys.rate && x === 0 && y === 0) continue;
        // yearID = the player's debut year so the era colour reflects their cohort
        // (an as-of career point has no single season year). sY/eY span all history,
        // so this never filters anyone out.
        const q = model.usesQual ? model.qual(c) : 1e9;
        rows.push({ playerID: p.name, teamID: "—", lgID: "—", yearID: p.debutYear, [model.thresholdField]: q, [model.xDim]: x, [model.yDim]: y });
    }
    return rows;
}
// Flat, date-sorted event stream derived from the resident .evt model — the
// `g_ev[]` the incremental frontier replays (poc-webgpu/core.c). One entry per
// (player, dep, date) carrying that date's delta (cum[k]-cum[k-1]). Struct-of-
// arrays of typed arrays, counting-sorted by date (date ∈ [0,numDates), so O(n)).
// Memoized on the model so only the first incremental use pays for it.
function buildEvtEventStream(model) {
    if (model.evStream) return model.evStream;
    const players = model.players, depList = model.depList;
    let n = 0;
    for (const p of players) for (const d of depList) n += (p.comp[d]?.dates.length || 0);
    const date = new Uint16Array(n), player = new Uint32Array(n), dep = new Uint8Array(n), delta = new Int32Array(n);
    let w = 0;
    for (let pi = 0; pi < players.length; pi++) {
        const comp = players[pi].comp;
        for (let di = 0; di < depList.length; di++) {
            const s = comp[depList[di]]; if (!s) continue;
            const dts = s.dates, cum = s.cum; let prev = 0;
            for (let k = 0; k < dts.length; k++) { date[w] = dts[k]; player[w] = pi; dep[w] = di; delta[w] = cum[k] - prev; prev = cum[k]; w++; }
        }
    }
    // Counting sort by date (stable: preserves per-date player/dep order — irrelevant
    // to the final frontier, which is read only after a whole date window is applied).
    const D = model.numDates;
    const cnt = new Uint32Array(D + 1);
    for (let i = 0; i < n; i++) cnt[date[i] + 1]++;
    for (let i = 0; i < D; i++) cnt[i + 1] += cnt[i];
    const sd = new Uint16Array(n), sp = new Uint32Array(n), sdep = new Uint8Array(n), sdl = new Int32Array(n);
    for (let i = 0; i < n; i++) { const pos = cnt[date[i]]++; sd[pos] = date[i]; sp[pos] = player[i]; sdep[pos] = dep[i]; sdl[pos] = delta[i]; }
    model.evStream = { date: sd, player: sp, dep: sdep, delta: sdl, n };
    return model.evStream;
}

// Can this .evt model's axis pair be GPU compute-accumulated? YES when each axis value
// is a LINEAR, MONOTONE-NONDECREASING combination of the streamed counting components —
// which is exactly the class the per-player atomic running-sum represents. That covers:
//   • single-component counting stats (HR, SB, R, RBI, …) — coefficient 1; and
//   • composite counting stats that never decrease (TB = 1·H+2·2B+3·3B+4·HR, PA, …).
// It excludes rate stats (AVG/OBP/SLG: xs.rate true — they can DECREASE, so a running
// sum is meaningless) and any combination with a negative coefficient (e.g. a net stat
// like SB−CS), which would break monotonicity and the incremental frontier.
//
// We discover each component's coefficient WITHOUT parsing the stat formula: a linear
// fn satisfies coeff_d = fn(unit_d) − fn(0). Probing one unit of each component gives the
// whole coefficient vector. Caches { ok, cx[], cy[] } (per-component X/Y coefficients,
// aligned to model.depList) on the model. Requires integer, ≥ 0 coefficients and a zero
// intercept (true for counting stats — keeps the GPU's u32 atomic exact).
function evtGpuMonotone(model) {
    if (model._gpuMono !== undefined) return model._gpuMono;
    let ok = !model.xs.rate && !model.ys.rate && model.xDim !== model.yDim;
    const cx = [], cy = [];
    if (ok) {
        const dl = model.depList, zero = {};
        for (const d of dl) zero[d] = 0;
        const x0 = model.xs.fn(zero), y0 = model.ys.fn(zero);
        if (x0 !== 0 || y0 !== 0) ok = false;          // counting stats have no constant term
        for (let i = 0; i < dl.length && ok; i++) {
            const u = { ...zero, [dl[i]]: 1 };
            const dx = model.xs.fn(u) - x0, dy = model.ys.fn(u) - y0;
            // integer, non-negative ⇒ a valid monotone counting coefficient.
            if (!Number.isInteger(dx) || !Number.isInteger(dy) || dx < 0 || dy < 0) ok = false;
            cx.push(dx); cy.push(dy);
        }
    }
    model._gpuMono = ok ? { ok, cx, cy } : { ok: false };
    return model._gpuMono;
}

// Express the D3 LINEAR scales as slope+intercept so the cloud vertex shader can map a
// player's counter straight to the SAME CSS pixel the CPU path uses (px = margin.left +
// xScale(value)). For any linear scale xScale(v) = xScale(0) + slope·v, hence:
//   interceptX = margin.left + xScale(0);  slopeX = xScale(1) − xScale(0).
// vpX/vpY are the CSS chart dimensions (the same width/height passed to resize() and
// used by uViewport), so the shader's px→NDC step matches the instanced pPoints shader.
function gpuScaleUniform(xScale, yScale, margin, width, height, radius, alpha) {
    return {
        slopeX: xScale(1) - xScale(0), interceptX: margin.left + xScale(0),
        slopeY: yScale(1) - yScale(0), interceptY: margin.top + yScale(0),
        vpX: width, vpY: height, radius, alpha,
    };
}

// Incremental Pareto frontier — JS port of poc-webgpu/core.c `frontier_apply_event`
// (commit a1e0ad0). Works in CANONICAL coords X=x*xSign, Y=y*ySign so it is always
// "higher is better" (matching the +x/+y POC); the frontier stays sorted X-ascending /
// Y-descending. Events must be monotone non-decreasing in canonical space — true for
// the counting (.evt) axes this path is gated to. Each event moves exactly one player,
// which can evict a contiguous dominated run and re-insert; nothing else is promoted.
function createIncrementalFrontier(playerCount, xSign, ySign) {
    // The live frontier as three PARALLEL arrays (struct-of-arrays, kept sorted by
    // canonical X ascending ⇒ canonical Y descending — a staircase). frP[i] is the player
    // owning slot i. onFront[p] is a fast membership test (avoids scanning frP). All math
    // is in CANONICAL space (X = x·xSign): with xSign/ySign ∈ {+1,−1} a "lower is better"
    // axis becomes "higher is better", so one piece of code handles all four quadrants.
    const frX = [], frY = [], frP = [];
    const onFront = new Uint8Array(playerCount);
    function reset() { frX.length = 0; frY.length = 0; frP.length = 0; onFront.fill(0); }
    // Apply ONE event: player p's stat just advanced to (x, y). Because the .evt streams
    // are counting stats, a player's canonical (X, Y) only ever moves UP and/or RIGHT — it
    // never regresses. That monotonicity is what makes the update O(frontier) instead of a
    // full O(N) re-sweep: p can only ENTER the frontier or push further out, dominating a
    // CONTIGUOUS run of neighbours; nothing else changes membership.
    function applyEvent(p, x, y) {
        const X = x * xSign, Y = y * ySign;
        if (onFront[p]) {
            // p was already on the frontier and just moved up-right; remove its stale slot
            // so we can re-insert at the correct (now further-out) position below.
            const i = frP.indexOf(p);
            if (i >= 0) { frX.splice(i, 1); frY.splice(i, 1); frP.splice(i, 1); }
            onFront[p] = 0;
        }
        // Dominance test: find the first slot with X' ≥ X. If that neighbour also has
        // Y' ≥ Y, it dominates p (≥ in both) → p is not on the frontier, nothing to do.
        let k = 0; while (k < frP.length && frX[k] < X) k++;
        if (k < frP.length && frY[k] >= Y) return;
        // p IS on the frontier. Find the contiguous run [j, e) of existing slots that p now
        // dominates (X' ≤ X AND Y' ≤ Y) — the staircase ordering guarantees they're adjacent.
        let j = 0; while (j < frP.length && !(frX[j] <= X && frY[j] <= Y)) j++;
        let e = j; while (e < frP.length && frX[e] <= X && frY[e] <= Y) e++;
        if (e > j) {                               // evict that run (they're no longer extreme)
            for (let t = j; t < e; t++) onFront[frP[t]] = 0;
            frX.splice(j, e - j); frY.splice(j, e - j); frP.splice(j, e - j);
        }
        // Insert p in canonical-X order: at j if it replaced a run, else binary-walk to the
        // first slot with X' ≥ X (an insert that dominates nobody, e.g. a new low-X/high-Y point).
        let ins = (e > j) ? j : 0;
        if (e === j) while (ins < frP.length && frX[ins] < X) ins++;
        frX.splice(ins, 0, X); frY.splice(ins, 0, Y); frP.splice(ins, 0, p);
        onFront[p] = 1;
    }
    // Frontier as data-space [x,y] pairs in canonical-X-ascending order (staircase-ready;
    // x = X*xSign since xSign is ±1). Maps back to point objects by coordinate in the driver.
    function frontierXY() {
        const out = new Array(frP.length);
        for (let i = 0; i < frP.length; i++) out[i] = [frX[i] * xSign, frY[i] * ySign];
        return out;
    }
    return { reset, applyEvent, frontierXY, onFront, get size() { return frP.length; } };
}

const evtClampedDate = (model) => Math.max(0, Math.min(model.numDates - 1, pbpCursorIdx));

// Day-of-year ↔ calendar helpers for the cursor's URL token (YYYYMMDD) and label.
function pbpDayToYmd(year, doy) {
    const d = new Date(Date.UTC(year, 0, doy));
    return `${year}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}
function pbpYmdToDay(ymd) {
    const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8);
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}
// Index into the date table for the day nearest (and <=) a given day-of-year.
function pbpNearestDateIdx(dates, doy) {
    let ans = 0;
    for (let i = 0; i < dates.length; i++) {
        if (dates[i] <= doy) ans = i; else break;
    }
    return ans;
}

Promise.all([loadDataset("batting"), loadDataset("pitching")]).then(async ([batting, pitching]) => {
    datasetState.batting = batting;
    datasetState.pitching = pitching;

    if (!metaFor || metaFor("Barry Bonds") === null) {
        // Multi-file mode: bundle's metaFor wasn't attached; build from CSV.
        const people = await peoplePromise;
        if (people) metaFor = buildMetaFromPeopleCsv(people);
    }

    // Backward-compat alias for the rest of the file (career-trail uses it).
    playerIndex = datasetState[activeDatasetKey].playerIndex;

    const formatStat = (dim, value) => {
        if (typeof value !== "number" || isNaN(value)) return "—";
        if (dim.endsWith("%")) return (value * 100).toFixed(1) + "%";
        const rate = activeDataset().rateStats;
        if (rate.has(dim)) return value.toFixed(dim === "ERA" || dim === "WHIP" || dim.includes("/") ? 2 : 3);
        if (dim === "IP") return value.toFixed(1);
        return value.toLocaleString();
    };

    populateSelectorsForActive();
    populateCountrySelect(datasetState.batting.playerIndex);
    populateFranchiseSelect();
    buildFranchisePicker();
    setupPlayerSearch();
    setupControlsToggle();
    setupPaPresets();
    setupYearPresets();
    setupExplainer();
    setupExportButton();
    setupShareButton();
    setupGlossary();
    setupRendererToggle();
    setupGpustreamToggle();
    applyModeConfig("season");
    setupModeToggle("mode-toggle", () => {
        const mode = getCurrentMode();
        applyModeConfig(mode);
        clearHighlights();
        viewDomain = null;
        syncPlayerHint();
        document.getElementById("mode-hint").textContent =
            mode === "career"
                ? "Each dot is one player's career totals across the selected year window."
                : "Each dot is one player's single season.";
        // Smooth on: the mode picks the engine (career→.evt full-history, season→.bl2p),
        // so re-init to switch. Group-career is its own thing — leave it.
        if (!groupCareerMode && (pbpTimeline || pbpEvt)) { stopAnimation(); disableSmooth(); enableSmooth(); }
        else refreshChart();
    });
    setupModeToggle("stats-toggle", () => {
        // The smooth cursor is tied to one dataset's corpus; switching datasets
        // drops it (the pitching corpus / read path lands in a later phase).
        if (pbpTimeline || pbpEvt) disableSmooth();
        activeDatasetKey = getActiveModeBtnData("stats-toggle", "stats") || "batting";
        playerIndex = datasetState[activeDatasetKey].playerIndex;
        clearHighlights();
        viewDomain = null;
        syncPlayerHint();
        populateSelectorsForActive();
        resetThresholdToDefault();
        applyModeConfig(getCurrentMode());
        // Smooth is the default: re-enable it on the new dataset if its axes are
        // .evt-eligible (pitching now has its own streams), else stay static.
        if (evtEligible(document.getElementById("x-axis-select").value, document.getElementById("y-axis-select").value)) enableSmooth();
        else refreshChart();
    });
    setupSegGroup("league-seg", () => { clearHighlights(); syncPlayerHint(); refreshChart(); });
    setupSegGroup("bats-seg",   () => { clearHighlights(); syncPlayerHint(); refreshChart(); });
    // Color encoding is a display option, not a filter — no need to clear the
    // highlight or touch playing-time; just recolor the cloud + legend.
    setupSegGroup("colorby-seg", () => refreshChart());
    setupSegGroup("depth-seg", () => refreshChart());
    document.getElementById("era-compare-toggle")?.addEventListener("click", (e) => {
        setEraCompareEnabled(!e.currentTarget.classList.contains("active"));
        refreshChart();
    });
    ["sb-year-select", "eb-year-select"].forEach((id) => {
        document.getElementById(id)?.addEventListener("change", () => refreshChart());
    });
    ["country-select", "franchise-select"].forEach((id) => {
        document.getElementById(id)?.addEventListener("change", () => {
            clearHighlights();
            syncPlayerHint();
            refreshChart();
        });
    });


    // Chip remove buttons — delegated listener on the container
    document.getElementById("player-hint")?.addEventListener("click", (e) => {
        const removeBtn = e.target.closest(".player-chip-remove");
        if (!removeBtn) return;
        removeHighlight(removeBtn.closest(".player-chip").dataset.player);
        syncPlayerHint();
        refreshChart();
    });

    // Frontier toggle: Best / Worst
    document.querySelectorAll(".frontier-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            showWorstFrontier = btn.dataset.mode === "worst";
            document.querySelectorAll(".frontier-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === btn.dataset.mode));
            refreshChart();
        });
    });

    const loadingIndicator = document.getElementById("loading-indicator");
    let pendingRender = null;

    // The bridge between the DOM and drawScatterPlot. It is the SINGLE place that reads
    // the current control values (axes, year range, mode, filters), resolves the active
    // dataset/data, decides which animation path is live (static | .bl2p game-by-game |
    // .evt full-history | group-career), assembles the per-mode `filters` bag, and calls
    // drawScatterPlot. Every interaction handler ends in refreshChart() rather than poking
    // the chart directly — so there's exactly one render path to reason about. Reads from
    // the DOM (not a JS state object) so the controls are the source of truth and
    // applyUrlState can drive everything just by setting them.
    function refreshChart() {
        // Drop any draw still queued from a prior call: the guards below early-return
        // to hold the current frame, and a stale rAF would otherwise run against
        // now-mutated cursor/openYearIdx state (e.g. a released season).
        cancelAnimationFrame(pendingRender);
        const xDim = document.getElementById("x-axis-select").value;
        const yDim = document.getElementById("y-axis-select").value;
        const sYear = parseInt(document.getElementById("s-year-select").value);
        const eYear = parseInt(document.getElementById("e-year-select").value);
        const mode = getCurrentMode();
        const league = getSegValue("league-seg", "league") || "all";
        const bats = getSegValue("bats-seg", "bats") || "all";
        const colorBy = getSegValue("colorby-seg", "colorby") || "era";
        const depth = parseInt(getSegValue("depth-seg", "depth")) || 1;
        const compareEras = document.getElementById("era-compare-toggle")?.classList.contains("active") || false;
        const sB = parseInt(document.getElementById("sb-year-select")?.value) || 1900;
        const eB = parseInt(document.getElementById("eb-year-select")?.value) || 1919;
        const country = document.getElementById("country-select").value || "all";
        const franchise = document.getElementById("franchise-select")?.value || "all";
        const def = activeDataset();
        const data = activeData();

        // Smooth (game-by-game) cursor: swap in each player's cumulative stats as
        // of the cursor date and pin the window to that one season. The synthetic
        // points are season-shaped, so the frontier pipeline is otherwise untouched.
        let points = data.points;
        let sY = sYear, eY = eYear;
        let pbpExtent = null;
        let groupCareer = false;
        let evtCareer = false, evtSeason = false;
        if (pbpEvt) {
            const cur = Math.max(pbpEvt.winStart, Math.min(pbpEvt.winEnd, pbpCursorIdx));
            if (mode === "career") {
                // Career: every player's cumulative (xDim,yDim) as of the cursor date —
                // one point per player, all moving each frame. Axes lock to career maxima.
                points = evtPointsAsOf(pbpEvt, cur);
                sY = pbpEvt.minYear; eY = pbpEvt.maxYear;
                pbpExtent = { x: [0, pbpEvt.xMax], y: [0, pbpEvt.yMax] };
                evtCareer = true;
            } else {
                // Season: one point per player per season. Completed seasons (year < open)
                // sit at their full Lahman totals (data.points, static → cached on the bg
                // canvas); the open season's point grows game-by-game from the .evt streams.
                const O = pbpEvt.yearOf[cur];
                const completedKey = `evtS|${activeDatasetKey}|${pbpEvt.winStartYear}|${O}`;
                if (!pbpCompletedCache || pbpCompletedCache.key !== completedKey)
                    pbpCompletedCache = { key: completedKey, points: data.points.filter((p) => p.yearID >= pbpEvt.winStartYear && p.yearID < O) };
                points = pbpCompletedCache.points.concat(evtOpenSeasonPoints(pbpEvt, cur, O));
                sY = pbpEvt.winStartYear; eY = O;          // eY = open year → smooth split caches year<O on bg
                pbpExtent = pbpComputeExtent({ dataset: activeDatasetKey, sYear: pbpEvt.winStartYear, eYear: pbpEvt.winEndYear },
                    xDim, yDim, { league: "all", franchise: "all" }, data.points, "season", activeDatasetKey);
                evtSeason = true;
            }
        } else if (pbpTimeline) {
            const resolved = pbpResolveGlobal(pbpTimeline, pbpCursorIdx);
            const { yearEntry, yearIdx, withinIdx } = resolved;
            pbpTimeline.openYearIdx = yearIdx;
            if (yearEntry.status === "unknown") {
                // Cursor entered a not-yet-loaded season: kick the fetch and redraw
                // when it lands; hold the current frame in the meantime.
                pbpEnsureYearLoaded(pbpTimeline, yearIdx).then(() => { syncScrubber(); refreshChart(); });
                return;
            }
            if (yearEntry.status !== "covered") return;   // transient "loading" — hold frame
            if (!yearEntry.decoded) {
                // Open year's decoded PBP was released to bound memory (a backward
                // scrub landed past the retained window) — re-decode, hold the frame.
                if (!yearEntry.reloading) pbpReloadDecoded(pbpTimeline, yearIdx).then(() => { syncScrubber(); refreshChart(); });
                return;
            }
            if (groupCareerActive()) {
                // Group-career: build one cumulative-career point per selected player.
                const built = pbpBuildGroupCareer(pbpTimeline, resolved, xDim, yDim, { league, franchise }, activeDatasetKey);
                points = built.points;
                sY = built.sY; eY = built.eY; pbpExtent = built.pbpExtent;
                groupCareer = true;
                pbpEnsureAhead(pbpTimeline, yearIdx, 4);   // keep several seasons loaded ahead of the sweep
                pbpReleaseFarYears(pbpTimeline, yearIdx, 2, 6);  // …and drop the rest so a wide span doesn't OOM
            } else {
            // Accumulating multi-year frontier: completed seasons stay on the chart
            // at their full (Lahman) season totals and only the OPEN season grows
            // game-by-game from its PBP partial. The window runs sYear..openYear, so
            // the all-time envelope evolves outward as the cursor sweeps instead of
            // resetting at each year boundary.
            const openYear = yearEntry.year;
            const openPartial = pbpPointsAsOf(yearEntry.decoded, withinIdx, pbpTimeline.dataset);
            // Completed seasons (full totals) only change when the open year does, so
            // cache that slice — otherwise play re-filters all of data.points every
            // frame, which is what locked the main thread on wide windows.
            const completedKey = `${pbpTimeline.dataset}|${pbpTimeline.sYear}|${openYear}`;
            if (!pbpCompletedCache || pbpCompletedCache.key !== completedKey) {
                pbpCompletedCache = { key: completedKey,
                    points: data.points.filter((p) => p.yearID >= pbpTimeline.sYear && p.yearID < openYear) };
            }
            points = pbpCompletedCache.points.concat(openPartial);
            sY = pbpTimeline.sYear;
            eY = openYear;
            pbpExtent = pbpComputeExtent(pbpTimeline, xDim, yDim, { league, franchise }, data.points, mode, activeDatasetKey);
            pbpMaybePrefetch(pbpTimeline, yearIdx, withinIdx);
            pbpReleaseFarYears(pbpTimeline, yearIdx, 2, 6);  // bound memory on long accumulating sweeps too
            window.__bl2d_groupCareerActive = false;
            }
        }

        // The playing-time threshold only matters for rate stats — for counting
        // stats every season qualifies, so we hide the control and apply no
        // minimum. The dropdown's own value is still written to the URL so the
        // user's choice persists when they toggle between stat types.
        const usesRate = def.rateStats?.has(xDim) || def.rateStats?.has(yDim);
        const thresholdValue = parseInt(document.getElementById("pa-min-select").value) || 0;
        const minThreshold = usesRate ? thresholdValue : 0;
        const tSec = document.getElementById("threshold-section");
        const tDiv = document.getElementById("threshold-divider");
        if (tSec) tSec.hidden = !usesRate;
        if (tDiv) tDiv.hidden = !usesRate;

        updateYearHint(sYear, eYear);
        syncPlayerHint();


        // The "Loading data…" indicator is for the initial load and heavy filter
        // changes — NOT the smooth/group-career sweep, where every ~66ms frame would
        // strobe it on and off. Each cursor draw is only a couple of ms, so skip it.
        const showLoader = !pbpTimeline && !pbpEvt;
        if (showLoader) loadingIndicator.classList.add("active");
        cancelAnimationFrame(pendingRender);
        pendingRender = requestAnimationFrame(() => {
            // Group-career: the N points are already aggregated careers, so draw them
            // as-is (season pipeline, no re-aggregation) and neutralize the attribute
            // filters — the selected group IS the filter, and career points carry no
            // single lgID/team, so a league filter would otherwise drop them all.
            // .evt career: points are pre-aggregated careers → draw "season" (no
            // re-aggregation). .evt season + .bl2p use the real mode.
            const drawMode = (groupCareer || evtCareer) ? "season" : mode;
            // .evt as-of points carry only a player + cumulative stat (no per-season
            // team/league), so neutralize league/franchise; bats/country still work via
            // metaFor(name). evtCareer → all-fg moving cloud (`evt`); evtSeason → the
            // static/dynamic split (completed seasons cached on bg, open season on fg).
            const evtFilters = {
                league: "all", bats, colorBy, depth, compareEras: false, country, franchise: "all",
                thresholdField: def.thresholdField, handField: def.handField, dataset: activeDatasetKey,
                pbpExtent, smooth: true, lite: smoothLite,
            };
            const drawFilters = groupCareer
                ? { league: "all", bats: "all", colorBy, depth: 1, compareEras: false, country: "all", franchise: "all",
                    thresholdField: def.thresholdField, handField: def.handField, dataset: activeDatasetKey,
                    pbpExtent, smooth: true, groupCareer: true, group: new Set(careerHighlights.keys()) }
                : evtCareer ? { ...evtFilters, evt: true }
                : evtSeason ? evtFilters
                : { league, bats, colorBy, depth, compareEras, sB, eB, country, franchise, thresholdField: def.thresholdField, handField: def.handField, dataset: activeDatasetKey, pbpExtent, smooth: !!pbpTimeline, lite: smoothLite && !!pbpTimeline };
            drawScatterPlot(points, xDim, yDim, sY, eY, minThreshold, formatStat, drawMode, drawFilters);
            if (showLoader) loadingIndicator.classList.remove("active");
            writeUrlState({ xDim, yDim, sYear, eYear, minPa: thresholdValue, mode, league, bats, colorBy, depth, compareEras, sB, eB, country, franchise });
        });
    }

    renderPresetShelf();

    // Frontier leaderboard interaction: click / Enter pins (toggles) a player's
    // gold career trail; ↑/↓ move between rows. Rows are re-rendered each refresh.
    const fcards = document.getElementById("frontier-cards");
    if (fcards) {
        const togglePin = (pid) => {
            if (!pid) return;
            if (careerHighlights.has(pid)) removeHighlight(pid);
            else addHighlight(pid);
            syncPlayerHint();
            refreshChart();
        };
        fcards.addEventListener("click", (e) => {
            const row = e.target.closest(".frontier-card");
            if (row) togglePin(row.dataset.pid);
        });
        fcards.addEventListener("keydown", (e) => {
            const row = e.target.closest(".frontier-card");
            if (!row) return;
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePin(row.dataset.pid); }
            else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const rows = [...fcards.querySelectorAll(".frontier-card")];
                const i = rows.indexOf(row);
                const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
                if (next) next.focus();
            }
        });
    }

    // Apply the persisted theme before the first render so the chart's color
    // tables (era ramp, league) are themed when drawScatterPlot first runs.
    applyTheme(initialTheme());
    document.querySelectorAll("#theme-switch .theme-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            if (btn.classList.contains("active")) return;
            applyTheme(btn.dataset.theme);
            refreshChart();
        });
    });

    // Restore state from URL hash (if present) before first render so the
    // shareable-URL flow lands on the exact view the link encoded.
    const urlHadPa = "pa" in parseUrlHash();
    applyUrlState();
    if (!urlHadPa) resetThresholdToDefault();
    syncPlayerHint();
    refreshChart();

    // First paint is Canvas 2D (default + fallback); under ?renderer=webgpu this
    // async ladder may swap in the WebGPU backend and redraw. Never blocks first paint.
    chooseRenderer();

    // Lets nested call sites (like the chart's click handler) trigger a
    // refresh without holding a reference to the closure.
    document.addEventListener("bl2d:refresh", refreshChart);

    const filterChanged = () => {
        stopAnimation();
        clearHighlights();
        refreshChart();
    };
    const axisOrViewChanged = () => {
        // Axis dimension changes invalidate any zoom rectangle (the domain
        // values are in the old dimension's units) and any group-career trail
        // (its stored x/y are in the OLD stat dimensions).
        viewDomain = null;
        groupTrailHistory.clear();
        // In group-career mode keep the selected group and just re-plot their
        // careers on the new axes — swapping HR×SB → AVG×OBP keeps them racing.
        if (groupCareerActive()) { refreshChart(); return; }
        // Smooth on: the axes changed, so re-decide the engine (.evt vs .bl2p) and
        // reload the matching streams for the new pair.
        if (pbpTimeline || pbpEvt) { stopAnimation(); disableSmooth(); enableSmooth(); return; }
        filterChanged();
    };
    ["x-axis-select", "y-axis-select"].forEach((id) => {
        document.getElementById(id).addEventListener("change", axisOrViewChanged);
    });
    ["s-year-select", "e-year-select"].forEach((id) => {
        document.getElementById(id).addEventListener("change", () => {
            stopAnimation();
            // Smooth on: the window changed, so rebuild the timeline (re-landing
            // at the new window's last covered season). Otherwise just refilter.
            // (.evt mode spans all history, so the year range is moot there — a
            // rebuild simply re-lands on the present-day frame.)
            if (pbpTimeline || pbpEvt) { disableSmooth(); enableSmooth(); }
            else filterChanged();
        });
    });
    document.getElementById("pa-min-select").addEventListener("change", filterChanged);

    // Frontier animation: advance end year from start → max, redrawing each step.
    function stopAnimation() {
        if (!animTimer) return;
        clearInterval(animTimer);
        animTimer = null;
        const btn = document.getElementById("anim-play-btn");
        btn.classList.remove("playing");
        document.getElementById("anim-icon-play").hidden = false;
        document.getElementById("anim-icon-stop").hidden = true;
    }
    function startAnimation() {
        const sInput = document.getElementById("s-year-select");
        const eInput = document.getElementById("e-year-select");
        const maxYear = parseInt(eInput.max);
        // Reset end year to start year so the evolution plays from scratch.
        eInput.value = sInput.value;
        const btn = document.getElementById("anim-play-btn");
        btn.classList.add("playing");
        document.getElementById("anim-icon-play").hidden = true;
        document.getElementById("anim-icon-stop").hidden = false;
        refreshChart();
        animTimer = setInterval(() => {
            const cur = parseInt(eInput.value);
            if (cur >= maxYear) { stopAnimation(); return; }
            eInput.value = cur + 1;
            refreshChart();
        }, 400);
    }
    document.getElementById("anim-play-btn").addEventListener("click", () => {
        if (pbpTimeline || pbpEvt) { if (pbpRaf) stopPbpPlay(); else startPbpPlay(); return; }
        if (animTimer) stopAnimation(); else startAnimation();
    });

    // ── Play-by-play cursor controls ───────────────────────────────────────
    const granSeg = document.getElementById("pbp-gran-seg");
    const scrubber = document.getElementById("pbp-scrubber");
    const dateLabel = document.getElementById("pbp-date");
    const speedRow = document.getElementById("pbp-speed-row");
    setupSegGroup("pbp-speed-seg", () => { playbackSpeed = parseFloat(getSegValue("pbp-speed-seg", "speed")) || 1; });
    // Fixed-width date readout: separate day / month / year spans so the label never
    // reflows as the cursor sweeps. setPbpDate(year, doy) for a real date; setPbpMsg(txt)
    // for status text ("—", "Loading…") without destroying the span structure.
    const dtD = dateLabel?.querySelector(".pbp-dt-d");
    const dtM = dateLabel?.querySelector(".pbp-dt-m");
    const dtY = dateLabel?.querySelector(".pbp-dt-y");
    const setPbpDate = (year, doy) => {
        if (!dtD) return;
        const dt = new Date(Date.UTC(year, 0, doy));
        dtD.textContent = String(dt.getUTCDate());
        dtM.textContent = dt.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
        dtY.textContent = String(year);
    };
    const setPbpMsg = (txt) => { if (dtD) { dtD.textContent = ""; dtM.textContent = txt; dtY.textContent = ""; } };
    const setPbpYear = (year) => { if (dtD) { dtD.textContent = ""; dtM.textContent = ""; dtY.textContent = String(year); } };
    // Paint the "played" portion of the progress bar (the ::track gradient reads --pct).
    const updateScrubFill = () => {
        const lo = +scrubber.min, hi = +scrubber.max, v = +scrubber.value;
        scrubber.style.setProperty("--pct", (hi > lo ? ((v - lo) / (hi - lo)) * 100 : 0) + "%");
    };

    function syncScrubber() {
        if (pbpEvt) {
            const d = evtClampedDate(pbpEvt);
            scrubber.min = String(pbpEvt.winStart ?? 0);
            scrubber.max = String(pbpEvt.winEnd ?? (pbpEvt.numDates - 1));
            scrubber.value = String(pbpCursorIdx);
            updateScrubFill();
            // Season granularity shows just the year; play-by-play shows the full date.
            if (pbpGranularity === "season") setPbpYear(pbpEvt.yearOf[d]);
            else setPbpDate(pbpEvt.yearOf[d], pbpEvt.doy[d]);
            window.__bl2d_pbpCursorYmd = pbpDayToYmd(pbpEvt.yearOf[d], pbpEvt.doy[d]);
            return;
        }
        if (!pbpTimeline) return;
        const { yearEntry, yearIdx, withinIdx } = pbpResolveGlobal(pbpTimeline, pbpCursorIdx);
        pbpTimeline.openYearIdx = yearIdx;
        scrubber.min = "0";
        scrubber.max = String(Math.max(0, pbpTimeline.totalEstimate - 1));
        scrubber.value = String(pbpCursorIdx);
        updateScrubFill();
        if (yearEntry.status === "covered" && yearEntry.decoded) {
            const doy = yearEntry.decoded.dates[withinIdx];
            setPbpDate(yearEntry.year, doy);
            window.__bl2d_pbpCursorYmd = pbpDayToYmd(yearEntry.year, doy);
        } else {
            setPbpMsg(`Loading ${yearEntry.year}…`);
            window.__bl2d_pbpCursorYmd = "";
        }
    }
    const pbpOverlay = document.getElementById("pbp-overlay");
    function showSmoothControls(on) {
        // The progress bar + date readout live on the chart (pbp-overlay), shown whenever
        // the cursor is active. When off (a non-eligible axis pair → static scatter) the
        // overlay is hidden and the sidebar granularity buttons are disabled.
        granSeg?.classList.toggle("disabled", !on);
        granSeg?.querySelectorAll(".seg-btn").forEach((b) => { b.disabled = !on; });
        if (pbpOverlay) pbpOverlay.hidden = !on;
        if (speedRow) speedRow.hidden = !on;
    }
    // [Play-by-play | Season] granularity. Both keep the .evt cursor on — switching just
    // changes the cursor step (game-by-game vs year-by-year) and the date readout.
    setupSegGroup("pbp-gran-seg", () => {
        pbpGranularity = getSegValue("pbp-gran-seg", "gran") || "pbp";
        if (!pbpEvt && !pbpTimeline) {                 // currently static → turn the cursor on
            const xd = document.getElementById("x-axis-select").value, yd = document.getElementById("y-axis-select").value;
            if (evtEligible(xd, yd)) { enableSmooth(); return; }
        }
        if (pbpEvt && pbpGranularity === "season") pbpCursorIdx = evtSeasonSnap(pbpEvt, pbpCursorIdx);
        syncScrubber();
        refreshChart();
    });
    // ── Phase-5 spring glide loop ───────────────────────────────────────────────
    // A dedicated rAF that calls the cheap GPU present every display refresh, so the spring
    // animates at the panel's full rate (60Hz, or 120Hz on ProMotion — vsync-locked, free)
    // even though refreshChart (the expensive CPU path) only fires ~15fps during playback.
    // Stays alive while playing OR within a short settle tail so the springs visibly come to
    // rest after the cursor stops, exactly like the standalone POC.
    function springLoop(now) {
        springRaf = null;
        if (!(pointRenderer instanceof WebGPURenderer) || !pointRenderer.springMode) { finalizeSpringStop(); return; }
        const alive = !!pbpRaf || now < springLoopUntil;   // playing OR draining the settle tail
        if (!alive) { finalizeSpringStop(); return; }
        // Only present when the last real frame actually drew the GPU spring (a CPU-fallback
        // frame — filters, evt.failed, etc. — parks the loop instead of drawing a stale cloud).
        if (lastGpuSpringFrame && pointRenderer.evt && !pointRenderer.evt.failed) pointRenderer.presentGlide();
        springRaf = requestAnimationFrame(springLoop);
    }
    function startSpringLoop() {
        if (!springRaf && pointRenderer instanceof WebGPURenderer && pointRenderer.springMode) {
            springRaf = requestAnimationFrame(springLoop);
        }
    }
    // hard=true cancels immediately (teardown / filter change); hard=false starts the settle
    // tail and lets the loop drain itself over SPRING_SETTLE_MS.
    function stopSpringLoop(hard) {
        if (hard) {
            if (springRaf) cancelAnimationFrame(springRaf);
            springRaf = null;
            springLoopUntil = 0;
            springFinalPending = false;        // teardown owns its own refreshChart
            smoothLite = false;                // teardown ends playback; restore full interactive frames
        } else {
            springLoopUntil = (typeof performance !== "undefined" ? performance.now() : Date.now()) + SPRING_SETTLE_MS;
        }
    }
    // Once the settle tail drains (or the loop bails), do the single interactive render we
    // deferred so the cards/quadtree/hit-test rebuild on the settled positions.
    function finalizeSpringStop() {
        if (!springFinalPending) return;
        springFinalPending = false;
        if (smoothLite) { smoothLite = false; refreshChart(); }
    }
    function stopPbpPlay() {
        const wasPlaying = !!pbpRaf;
        if (pbpRaf) { cancelAnimationFrame(pbpRaf); pbpRaf = null; }
        const btn = document.getElementById("anim-play-btn");
        btn.classList.remove("playing");
        document.getElementById("anim-icon-play").hidden = false;
        document.getElementById("anim-icon-stop").hidden = true;
        // If a GPU spring was animating, keep gliding through a settle tail and DEFER the
        // final interactive render until it drains (an immediate non-lite refreshChart would
        // repopulate the CPU cloud and flip lastGpuSpringFrame off, cutting the settle short).
        if (wasPlaying && smoothLite && lastGpuSpringFrame &&
            pointRenderer instanceof WebGPURenderer && pointRenderer.springMode) {
            springFinalPending = true;
            stopSpringLoop(false);             // start the tail; springLoop fires finalizeSpringStop when it ends
            startSpringLoop();                 // (no-op if already running) ensure something drives the tail
        } else if (wasPlaying && smoothLite) {
            smoothLite = false; refreshChart();   // non-GPU path: finalize immediately
        }
    }
    function startPbpPlay() {
        if (!pbpTimeline && !pbpEvt) return;
        stopAnimation();
        smoothLite = true;                         // lighten frames during playback
        springFinalPending = false;                // a fresh play cancels any pending settle-finalize from a prior stop
        clearTimeout(smoothLiteTimer);
        const perYearMs = 10000;                   // ~10s per covered season at 1× …
        // .evt sweeps only the selected-year window; .bl2p sweeps its whole timeline.
        const lo = pbpEvt ? pbpEvt.winStart : 0;
        const hi = pbpEvt ? pbpEvt.winEnd : null;
        // Advance the cursor incrementally by elapsed time × speed, so changing the
        // speed mid-play smoothly changes the pace without jumping the cursor.
        let pos = lo, lastNow = performance.now(), lastDraw = 0;
        pbpCursorIdx = lo;
        groupTrailHistory.clear();                 // restart trails from the sweep's origin
        const btn = document.getElementById("anim-play-btn");
        btn.classList.add("playing");
        document.getElementById("anim-icon-play").hidden = true;
        document.getElementById("anim-icon-stop").hidden = false;
        const tick = (now) => {
            // total & covered-count grow as lazy loads land; recompute each frame.
            const end = pbpEvt ? hi : pbpTimeline.totalEstimate - 1;
            const coveredYears = pbpEvt ? (pbpEvt.yearOf[hi] - pbpEvt.yearOf[lo] + 1)
                : Math.max(1, pbpTimeline.years.filter((y) => y.status !== "missing").length);
            const durMs = Math.min(PBP_PLAY_MAX_MS, perYearMs * coveredYears) / playbackSpeed;  // capped, then scaled by speed
            const dt = now - lastNow; lastNow = now;
            pos = Math.min(end, pos + (end - lo) * dt / Math.max(1, durMs));
            pbpCursorIdx = (pbpEvt && pbpGranularity === "season") ? evtSeasonSnap(pbpEvt, pos) : Math.min(end, Math.floor(pos));
            syncScrubber();                         // cheap: scrubber position + date label only
            // Throttle the expensive chart re-render to ~15fps so a wide-window sweep
            // doesn't peg the main thread; always draw the final frame.
            const done = pos >= end;
            if (done || now - lastDraw >= PBP_PLAY_FRAME_MS) { refreshChart(); lastDraw = now; }
            if (!done) pbpRaf = requestAnimationFrame(tick);
            else stopPbpPlay();
        };
        pbpRaf = requestAnimationFrame(tick);
        startSpringLoop();                     // glide the GPU spring at display refresh, independent of the 15fps data tick
    }
    // Decode + hold the two resident streams, then drive the cursor over all history.
    async function enableEvt(startIdx) {
        const xDim = document.getElementById("x-axis-select").value;
        const yDim = document.getElementById("y-axis-select").value;
        setPbpMsg("Loading…");
        const model = await buildEvtModel(xDim, yDim);
        // Guard a rapid axis/dataset change: if the selectors moved while we awaited,
        // a newer enableEvt is in flight — discard this stale model.
        if (document.getElementById("x-axis-select").value !== xDim ||
            document.getElementById("y-axis-select").value !== yDim ||
            !evtEligible(xDim, yDim)) return;
        if (!model) { showSmoothControls(false); setPbpMsg("No streams for these stats"); return; }
        // Clamp the played window to the selected year range (values stay all-time
        // career-cumulative; only the swept dates narrow). Full history if unset.
        const sYear = parseInt(document.getElementById("s-year-select").value) || model.minYear;
        const eYear = parseInt(document.getElementById("e-year-select").value) || model.maxYear;
        let winStart = 0, winEnd = model.numDates - 1;
        for (let i = 0; i < model.numDates; i++) if (model.yearOf[i] >= sYear) { winStart = i; break; }
        for (let i = model.numDates - 1; i >= 0; i--) if (model.yearOf[i] <= eYear) { winEnd = i; break; }
        if (winEnd < winStart) { winStart = 0; winEnd = model.numDates - 1; }
        model.winStart = winStart; model.winEnd = winEnd;
        model.winStartYear = model.yearOf[winStart]; model.winEndYear = model.yearOf[winEnd];
        pbpEvt = model; pbpTimeline = null; pbpExtentCache = null;
        window.__bl2d_pbpFallback = false;
        pbpCursorIdx = (startIdx != null) ? Math.max(winStart, Math.min(winEnd, startIdx)) : winEnd;
        if (pbpGranularity === "season") pbpCursorIdx = evtSeasonSnap(model, pbpCursorIdx);
        showSmoothControls(true);
        syncScrubber();
        refreshChart();
    }
    async function enableSmooth(startIdx, forceBl2p) {
        const xDimNow = document.getElementById("x-axis-select").value;
        const yDimNow = document.getElementById("y-axis-select").value;
        // Counting-stat pair with .evt streams → resident full-history path instead of
        // per-season .bl2p (instant scrub, all of MLB history). Rate stats use .bl2p.
        // Group-career passes forceBl2p: it needs the season timeline (it samples each
        // open season's PBP), so it never takes the all-history .evt path.
        if (!forceBl2p && evtEligible(xDimNow, yDimNow)) { await enableEvt(startIdx); return; }
        const sYear = parseInt(document.getElementById("s-year-select").value);
        const eYear = parseInt(document.getElementById("e-year-select").value);
        const tl = buildPbpTimeline(sYear, eYear, activeDatasetKey);

        // Load from the latest year backward until a covered season is found, so
        // the default view is that season's full (year-end) frontier — matching
        // the single-season behaviour. Only one season decodes on enable.
        let idx = tl.years.length - 1;
        let entry = await pbpEnsureYearLoaded(tl, idx);
        while (entry && entry.status === "missing" && idx > 0) {
            entry = await pbpEnsureYearLoaded(tl, --idx);
        }
        if (!entry || entry.status !== "covered") {   // no PBP anywhere in the range
            window.__bl2d_pbpFallback = true;
            window.__bl2d_pbpGames = 0;
            pbpTimeline = null;
            showSmoothControls(false);
            setPbpMsg(`No data for ${sYear}–${eYear}`);
            return;
        }
        window.__bl2d_pbpFallback = false;
        window.__bl2d_pbpGames = entry.decoded.games;
        pbpTimeline = tl;
        pbpExtentCache = null;
        pbpCompletedCache = null;
        pbpFrontierPrepCache = null;
        evtIncFrontier = null;
        pbpCursorIdx = (startIdx != null)
            ? Math.max(0, Math.min(tl.totalEstimate - 1, startIdx))
            : pbpGlobalFor(tl, idx, entry.decoded.dateCount - 1);
        showSmoothControls(true);
        syncScrubber();
        refreshChart();
    }
    function disableSmooth() {
        stopPbpPlay();
        stopSpringLoop(true); lastGpuSpringFrame = false;   // teardown: hard-cancel the glide loop (no settle tail, no stale cloud)
        pbpTimeline = null;
        pbpEvt = null;
        pbpExtentCache = null;
        pbpCompletedCache = null;
        pbpFrontierPrepCache = null;
        evtIncFrontier = null;
        groupCareerMode = false;
        groupTrailHistory.clear();
        window.__bl2d_groupCareerActive = false;
        syncGroupCareerToggle();
        showSmoothControls(false);
        refreshChart();
    }

    // ── Group-career mode ───────────────────────────────────────────────────
    // Reuses the entire smooth engine; sets the year window to the group's combined
    // career span first, then turns on the cursor with groupCareerMode flagged.
    const groupCareerToggle = document.getElementById("group-career-toggle");
    async function enableGroupCareer() {
        const span = groupCareerSpan(activeDatasetKey);
        if (!span) return;
        const sInput = document.getElementById("s-year-select");
        const eInput = document.getElementById("e-year-select");
        sInput.value = String(Math.max(parseInt(sInput.min) || span.lo, span.lo));
        eInput.value = String(Math.min(parseInt(eInput.max) || span.hi, span.hi));
        groupCareerMode = true;
        groupTrailHistory.clear();
        if (pbpTimeline || pbpEvt) disableSmoothQuiet();
        await enableSmooth(0, true);           // start at the group's earliest debut (.bl2p path)
        // Warm the first few seasons so pressing play from the start doesn't stall on
        // "Loading <year>…"; the per-frame pbpEnsureAhead keeps the rest loaded.
        if (pbpTimeline) pbpEnsureAhead(pbpTimeline, 0, 5);
        syncGroupCareerToggle();
    }
    // Tear down the timeline without resetting groupCareerMode (used when rebuilding
    // the span after the group changes, so the flag survives the rebuild).
    function disableSmoothQuiet() {
        stopPbpPlay();
        stopSpringLoop(true); lastGpuSpringFrame = false;   // teardown: hard-cancel the glide loop
        pbpTimeline = null;
        pbpEvt = null;
        pbpExtentCache = null;
        pbpCompletedCache = null;
        pbpFrontierPrepCache = null;
        evtIncFrontier = null;
    }
    // Rebuild the timeline span after the group membership changes mid-animation.
    window.__bl2d_rebuildGroupCareer = null;
    async function rebuildGroupCareer() {
        groupTrailHistory.clear();
        await enableGroupCareer();
    }
    window.__bl2d_rebuildGroupCareer = rebuildGroupCareer;
    groupCareerToggle?.addEventListener("click", () => {
        if (groupCareerMode) disableSmooth();
        else enableGroupCareer();
    });

    scrubber?.addEventListener("input", () => {
        if (!pbpTimeline && !pbpEvt) return;
        if (pbpRaf) stopPbpPlay();
        const raw = parseInt(scrubber.value) || 0;
        pbpCursorIdx = (pbpEvt && pbpGranularity === "season") ? evtSeasonSnap(pbpEvt, raw) : raw;
        // Keep trails causal on a backward scrub: drop positions recorded ahead of
        // the new cursor so the comet-tail never points "into the future".
        if (groupCareerMode) {
            for (const [pid, hist] of groupTrailHistory) {
                groupTrailHistory.set(pid, hist.filter(e => e.cursor <= pbpCursorIdx));
            }
        }
        // Lite frames while dragging; one full (interactive) render when it settles.
        smoothLite = true;
        syncScrubber();
        refreshChart();
        clearTimeout(smoothLiteTimer);
        smoothLiteTimer = setTimeout(() => { smoothLite = false; refreshChart(); }, 160);
    });
    // Expose for headless verification (scripts/snap.js evalJS). pbpPointsAsOf
    // and pbpActive take/return the OPEN year resolved from the global cursor.
    window.__bl2d_pbpTimeline = () => pbpTimeline;
    window.__bl2d_pbpCursorIdx = () => pbpCursorIdx;
    window.__bl2d_pbpEvt = () => pbpEvt;   // resident .evt model (full-history mode) or null
    window.__bl2d_evtCursorYear = () => pbpEvt ? pbpEvt.yearOf[evtClampedDate(pbpEvt)] : null;
    window.__bl2d_evtPoints = () => pbpEvt ? evtPointsAsOf(pbpEvt, pbpCursorIdx) : null;
    window.__bl2d_pbpOpenYear = () => pbpTimeline ? (pbpTimeline.years[pbpTimeline.openYearIdx]?.year ?? null) : null;
    window.__bl2d_pbpActive = () => pbpTimeline ? (pbpTimeline.years[pbpTimeline.openYearIdx]?.decoded || null) : null;
    window.__bl2d_pbpPointsAsOf = (globalIdx) => {
        if (!pbpTimeline) return null;
        const { yearEntry, withinIdx } = pbpResolveGlobal(pbpTimeline, globalIdx);
        return yearEntry.status === "covered"
            ? pbpPointsAsOf(yearEntry.decoded, withinIdx, pbpTimeline.dataset) : null;
    };
    window.__bl2d_enableSmooth = enableSmooth;

    // Deep-link with t=YYYYMMDD: point the season at that year, load its PBP,
    // and snap the cursor to the nearest game date.
    if (pendingCursorYmd) {
        const ymd = pendingCursorYmd;
        pendingCursorYmd = null;
        const year = parseInt(ymd.slice(0, 4));
        const sSel = document.getElementById("s-year-select");
        const eSel = document.getElementById("e-year-select");
        eSel.value = String(year);                         // open the window on the link's year
        if (parseInt(sSel.value) > year) sSel.value = String(year);
        enableSmooth().then(() => {                        // builds the timeline + lands the year
            if (pbpEvt) {                                  // .evt mode: map the date to a global index
                const day = pbpYmdToDay(ymd);
                let d = -1;
                for (let i = 0; i < pbpEvt.numDates; i++) {
                    if (pbpEvt.yearOf[i] === year) { if (pbpEvt.doy[i] <= day) d = i; else if (d >= 0) break; }
                    else if (pbpEvt.yearOf[i] > year) break;
                }
                if (d >= 0) { pbpCursorIdx = Math.max(pbpEvt.winStart, Math.min(pbpEvt.winEnd, d)); syncScrubber(); refreshChart(); }
                return;
            }
            if (!pbpTimeline) return;
            const yi = pbpTimeline.years.findIndex((e) => e.year === year);
            if (yi < 0 || pbpTimeline.years[yi].status !== "covered" || !pbpTimeline.years[yi].decoded) return;
            const within = pbpNearestDateIdx(pbpTimeline.years[yi].decoded.dates, pbpYmdToDay(ymd));
            pbpCursorIdx = pbpGlobalFor(pbpTimeline, yi, within);
            syncScrubber();
            refreshChart();
        });
    } else if (evtEligible(document.getElementById("x-axis-select").value, document.getElementById("y-axis-select").value)) {
        // Smooth is the default view: auto-enable it on load whenever the axes are
        // .evt-eligible (full-history animation, lands on the present-day frame). The
        // Smooth toggle still turns it off → the static scatter (the fallback for
        // pre-1920-only/pitching/offline/filtered cases the .evt path can't cover).
        enableSmooth();
    }

    setupZoomToolbar();

    // Click on empty chart area, or Escape, clears both the tooltip pin and
    // the career highlight in one motion.
    const clearPinAndHighlight = () => {
        let dirty = false;
        if (tooltipPinned) {
            tooltipPinned = false;
            document.getElementById("tooltip").setAttribute("data-visible", "false");
        }
        if (careerHighlights.size > 0) {
            clearHighlights();
            syncPlayerHint();
            dirty = true;
        }
        if (dirty) refreshChart();
    };
    document.querySelector(".chart-region").addEventListener("click", (e) => {
        if (!e.target.closest("circle")) clearPinAndHighlight();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") clearPinAndHighlight();
    });

    // Re-render when the chart container changes size (window resize, mobile controls toggle).
    let resizeTimer;
    const chartRegion = document.querySelector(".chart-region");
    const resizeObserver = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(refreshChart, 120);
    });
    resizeObserver.observe(chartRegion);
});


// Mirrors the bundle decoder's people-record shape so the rest of the app
// can call metaFor() identically in either deployment. Maps B (both) → S
// since the existing rendering / filter code uses "S" for switch hitters.
function buildMetaFromPeopleCsv(rows) {
    const HAND_MAP = { L: "L", R: "R", B: "S", S: "S" };
    const debutYear = (p) => parseInt((p.debut || "").slice(0, 4)) || 0;

    // Mirror build_display_name_map (Python) so the key used here matches the
    // disambiguated playerID stored in the limits CSVs.
    const plainCounts = new Map();
    for (const p of rows) {
        const plain = `${p.nameFirst} ${p.nameLast}`;
        plainCounts.set(plain, (plainCounts.get(plain) || 0) + 1);
    }
    const displayKey = (p) => {
        const plain = `${p.nameFirst} ${p.nameLast}`;
        if ((plainCounts.get(plain) || 0) <= 1) return plain;
        const birth = (p.birthYear || "").trim();
        const tag = /^\d+$/.test(birth) ? `b.${birth}` : p.playerID;
        return `${plain} (${tag})`;
    };

    const peopleMap = new Map();
    for (const p of rows) {
        peopleMap.set(displayKey(p), p);
    }

    return (playerID) => {
        const p = peopleMap.get(playerID);
        if (!p) return null;
        return {
            birthYear: parseInt(p.birthYear) || null,
            debutYear: debutYear(p) || null,
            country: (p.birthCountry || "").trim() || null,
            bats: HAND_MAP[p.bats] || null,
            throws: HAND_MAP[p.throws] || null,
            heightIn: parseInt(p.height) || null,
            weightLb: parseInt(p.weight) || null,
        };
    };
}


function updateCountrySelection(country) {
    const panel = document.getElementById("country-panel");
    if (!panel) return;
    panel.querySelectorAll(".country-chip").forEach(chip => {
        const selected = (chip.dataset.country || "all") === (country || "all");
        chip.classList.toggle("country-chip--selected", selected);
        chip.setAttribute("aria-selected", selected ? "true" : "false");
    });
}

function populateCountrySelect(playerIdx) {
    const panel = document.getElementById("country-panel");
    const sel   = document.getElementById("country-select");
    if (!panel || !sel) return;

    const counts = new Map();
    for (const playerID of playerIdx.keys()) {
        const m = metaFor(playerID);
        if (!m || !m.country) continue;
        counts.set(m.country, (counts.get(m.country) || 0) + 1);
    }
    // Sort by count descending; show countries with ≥5 players.
    const list = [...counts.entries()]
        .filter(([, n]) => n >= 5)
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => ({ c, n }));

    // Populate hidden <select> for applyUrlState / setSelect compatibility.
    sel.innerHTML = `<option value="all">All</option>` +
        list.map(({ c }) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    sel.value = "all";

    // Build chip panel.
    panel.innerHTML = "";

    const allChip = document.createElement("button");
    allChip.type = "button";
    allChip.className = "country-chip country-chip--all country-chip--selected";
    allChip.setAttribute("role", "option");
    allChip.setAttribute("aria-selected", "true");
    allChip.dataset.country = "all";
    allChip.textContent = "All countries";
    panel.appendChild(allChip);

    const grid = document.createElement("div");
    grid.className = "country-chip-grid";
    for (const { c, n } of list) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "country-chip";
        chip.setAttribute("role", "option");
        chip.setAttribute("aria-selected", "false");
        chip.dataset.country = c;
        const flag = COUNTRY_FLAGS[c] || "";
        const displayName = COUNTRY_DISPLAY[c] || c;
        // Flag-only chips; the country name lives in the tooltip + accessible name.
        chip.setAttribute("aria-label", `${displayName} (${n.toLocaleString()} players)`);
        chip.title = displayName;
        chip.innerHTML = flag
            ? `<span class="country-flag" aria-hidden="true">${flag}</span>`
            : `<span class="country-name country-code">${escapeHtml(c)}</span>`;
        if (flag) chip.classList.add("country-chip--flag");
        grid.appendChild(chip);
    }
    panel.appendChild(grid);

    panel.addEventListener("click", e => {
        const chip = e.target.closest(".country-chip");
        if (!chip) return;
        const val = chip.dataset.country || "all";
        sel.value = val;
        updateCountrySelection(val);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
}


function populateSelectorsForActive() {
    const def = activeDataset();
    const points = activeData().points;
    const years = [...new Set(points.map(p => p.yearID))].sort((a, b) => a - b);
    const minYear = years[0];
    const maxYear = years[years.length - 1];

    const sYear = document.getElementById("s-year-select");
    sYear.min = minYear;
    sYear.max = maxYear;
    sYear.value = Math.max(1920, minYear);

    const eYear = document.getElementById("e-year-select");
    eYear.min = minYear;
    eYear.max = maxYear;
    eYear.value = maxYear;

    const xSelect = document.getElementById("x-axis-select");
    const ySelect = document.getElementById("y-axis-select");
    const lib = def.lowerIsBetter || new Set();
    [xSelect, ySelect].forEach((sel) => {
        sel.innerHTML = "";
        def.dimensions.forEach((dim) => {
            const opt = document.createElement("option");
            opt.value = dim;
            opt.textContent = lib.has(dim) ? `${dim} ↓` : dim;
            sel.appendChild(opt);
        });
    });
    xSelect.value = def.defaultX;
    ySelect.value = def.defaultY;

    document.getElementById("threshold-label").textContent = def.thresholdLabel;

    const isPitching = activeDatasetKey === "pitching";
    // No visible label — keep the distinction available via tooltip / screen reader.
    const batsSeg = document.getElementById("bats-seg");
    if (batsSeg) {
        const handLabel = isPitching ? "Throws" : "Bats";
        batsSeg.setAttribute("aria-label", handLabel);
        batsSeg.setAttribute("title", handLabel);
    }
    const switchBtn = document.getElementById("bats-switch-btn");
    switchBtn.hidden = isPitching;
    if (isPitching && switchBtn.classList.contains("active")) {
        switchBtn.classList.remove("active");
        document.querySelector("#bats-seg .seg-btn[data-bats='all']").classList.add("active");
    }
}

// Mirror the in-drawer axis selects into the mobile axis bar (options + value).
// The bar's selects are display clones; their change handler drives the real
// selects, and this keeps them in sync after dataset swaps / on-chart picks.
function parseUrlHash() {
    const raw = (window.location.hash || "").replace(/^#/, "");
    if (!raw) return {};
    const out = {};
    for (const seg of raw.split("&")) {
        const eq = seg.indexOf("=");
        if (eq < 0) continue;
        const k = decodeURIComponent(seg.slice(0, eq));
        const v = decodeURIComponent(seg.slice(eq + 1));
        out[k] = v;
    }
    return out;
}

// Enable/disable the comparison-era range row: dims it + toggles its inputs, so
// it reads as available-but-off (like the dimmed franchises) until compare is on.
function setEraCompareEnabled(on) {
    const btn = document.getElementById("era-compare-toggle");
    if (btn) { btn.classList.toggle("active", on); btn.setAttribute("aria-pressed", String(on)); }
    const sb = document.getElementById("sb-year-select");
    const eb = document.getElementById("eb-year-select");
    if (sb) sb.disabled = !on;
    if (eb) eb.disabled = !on;
}

// Inverse of writeUrlState: read the hash once at startup and drive the controls to match
// BEFORE the first render, so a deep link lands on the right view with no visible reflow.
// It sets the DOM controls (selects/segmented buttons) rather than internal state, then
// lets the normal change handlers + refreshChart flow from there — one code path, no
// divergence between "user clicked" and "loaded from URL". Order matters (see below): the
// dataset toggle must flip first so the dataset-specific axis options exist to select.
function applyUrlState() {
    const u = parseUrlHash();
    const setSelect = (id, val) => {
        if (val == null) return;
        const sel = document.getElementById(id);
        if (sel && [...sel.options].some(o => o.value === val)) sel.value = val;
    };
    const setSeg = (groupId, dataKey, val) => {
        if (val == null) return;
        const btn = document.querySelector(`#${groupId} .seg-btn[data-${dataKey}="${val}"]`);
        if (!btn) return;
        document.querySelectorAll(`#${groupId} .seg-btn`).forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
    };
    // Dataset must switch first so the right dimension dropdowns exist before we
    // try to select a dataset-specific axis token (e.g. ERA, K/9). Bidirectional
    // so re-applying a preset/deep-link reliably lands on the named dataset.
    if ((u.ds === "batting" || u.ds === "pitching") && u.ds !== activeDatasetKey) {
        const stBtn = document.querySelector(`#stats-toggle .mode-btn[data-stats="${u.ds}"]`);
        if (stBtn) {
            document.querySelectorAll('#stats-toggle .mode-btn').forEach(b => b.classList.remove("active"));
            stBtn.classList.add("active");
        }
        activeDatasetKey = u.ds;
        playerIndex = datasetState[activeDatasetKey].playerIndex;
        populateSelectorsForActive();
        resetThresholdToDefault();
        applyModeConfig("season");
    }
    setSelect("x-axis-select", u.x);
    setSelect("y-axis-select", u.y);
    if (u.sy) document.getElementById("s-year-select").value = u.sy;
    if (u.ey) document.getElementById("e-year-select").value = u.ey;
    // Mode applies before PA so the slider config is right before we set its
    // value. Bidirectional + scoped to #mode-toggle so it doesn't disturb the
    // Best/Worst or Batting/Pitching groups (which also use .mode-btn).
    if (u.m === "career" || u.m === "season") {
        document.querySelectorAll("#mode-toggle .mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === u.m));
        applyModeConfig(u.m);
        document.getElementById("mode-hint").textContent = u.m === "career"
            ? "Each dot is one player's career totals across the selected year window."
            : "Each dot is one player's single season.";
    }
    if (u.pa) document.getElementById("pa-min-select").value = u.pa;
    setSeg("league-seg", "league", u.lg);
    setSeg("bats-seg", "bats", u.bt);
    setSeg("colorby-seg", "colorby", u.cb);
    setSeg("depth-seg", "depth", u.d);
    if (u.sy2) { const e = document.getElementById("sb-year-select"); if (e) e.value = u.sy2; }
    if (u.ey2) { const e = document.getElementById("eb-year-select"); if (e) e.value = u.ey2; }
    if (u.c2 === "1") setEraCompareEnabled(true);
    setSelect("country-select", u.co);
    updateCountrySelection(document.getElementById("country-select")?.value || "all");
    setSelect("franchise-select", u.fr);
    const frVal = document.getElementById("franchise-select")?.value || "all";
    updateFranchiseTrigger(frVal);
    updateChipSelection(frVal);
    updateFranchiseDimming(getSegValue("league-seg", "league") || "all");
    if (u.hl) { u.hl.split(",").forEach(id => addHighlight(id.trim())); }
    // The as-of-date cursor loads async (lazy PBP fetch); stash it and let the
    // bootstrap apply it once the season file is decoded.
    pendingCursorYmd = (u.t && /^\d{8}$/.test(u.t)) ? u.t : null;
}

// ── Curated story presets ───────────────────────────────────────────────
// One tap loads a famous frontier (axes + dataset + a pinned player) through
// the existing URL-hash path. Player keys are the disambiguated display names
// used as playerIDs (see scripts/_display_name.py).
const PRESETS = [
    { label: "Ohtani 50/50",   sub: "HR · SB",    state: { ds: "batting",  m: "season", x: "HR",  y: "SB",   hl: "Shohei Ohtani" } },
    { label: "Bonds' 73",      sub: "HR · AVG",   state: { ds: "batting",  m: "season", x: "HR",  y: "AVG",  hl: "Barry Bonds" } },
    { label: "Henderson 130",  sub: "SB · HR",    state: { ds: "batting",  m: "season", x: "SB",  y: "HR",   hl: "Rickey Henderson" } },
    { label: "Sosa '98",       sub: "HR · RBI",   state: { ds: "batting",  m: "season", x: "HR",  y: "RBI",  hl: "Sammy Sosa" } },
    { label: "Pedro 2000",     sub: "K/9 · K/BB", state: { ds: "pitching", m: "season", x: "K/9", y: "K/BB", hl: "Pedro Martinez (b.1971)" } },
];
function applyPreset(state) {
    clearHighlights();
    const hash = Object.entries(state)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
    history.replaceState(null, "", location.pathname + location.search + "#" + hash);
    applyUrlState();
    document.dispatchEvent(new Event("bl2d:refresh"));
    // Picked from the welcome modal → dismiss it and remember it's been seen.
    const backdrop = document.getElementById("explainer-backdrop");
    if (backdrop && !backdrop.hidden) {
        backdrop.hidden = true;
        try { localStorage.setItem("bl2d_intro_seen", "1"); } catch (e) { /* private mode */ }
    }
}
function renderPresetShelf() {
    const shelf = document.getElementById("preset-shelf");
    if (!shelf) return;
    shelf.innerHTML = PRESETS.map((p, i) =>
        `<button type="button" class="preset-row" data-preset="${i}" title="${p.label} — ${p.sub}">` +
        `<span class="preset-row-title">${p.label}</span>` +
        `<span class="preset-row-stat">${p.sub}</span></button>`
    ).join("");
    shelf.querySelectorAll(".preset-row").forEach((btn) => {
        btn.addEventListener("click", () => applyPreset(PRESETS[+btn.dataset.preset].state));
    });
}

let urlWriteTimer = null;
// Serialize the full view into the URL hash so any view is a shareable/bookmarkable
// deep link, and a reload restores exactly where you were. Debounced 120ms because it's
// called on every refresh (incl. animation frames) — we don't want to thrash
// history.replaceState. Two deliberate choices: (1) params at their DEFAULT value are
// OMITTED (see URL_DEFAULTS) so a fresh view has a clean empty hash and links stay short;
// (2) replaceState (not pushState) so dragging a slider doesn't bury the back button under
// hundreds of history entries. applyUrlState() is the inverse, run once at startup.
function writeUrlState(state) {
    clearTimeout(urlWriteTimer);
    urlWriteTimer = setTimeout(() => {
        const params = {
            ds: activeDatasetKey,
            x: state.xDim,
            y: state.yDim,
            sy: String(state.sYear),
            ey: String(state.eYear),
            pa: String(state.minPa),
            m: state.mode,
            lg: state.league,
            bt: state.bats,
            cb: state.colorBy,
            d: String(state.depth),
            c2: state.compareEras ? "1" : "0",
            sy2: String(state.sB),
            ey2: String(state.eB),
            co: state.country,
            fr: state.franchise,
            hl: [...careerHighlights.keys()].join(","),
            // The as-of-date cursor (smooth game-by-game mode). Absent unless on.
            // Emits the open year's date resolved from the global multi-year cursor.
            t: (() => {
                if (pbpEvt) { const d = evtClampedDate(pbpEvt); return pbpDayToYmd(pbpEvt.yearOf[d], pbpEvt.doy[d]); }
                if (!pbpTimeline) return "";
                const e = pbpTimeline.years[pbpTimeline.openYearIdx];
                if (!e || e.status !== "covered" || !e.decoded) return "";   // decoded may be released to bound memory
                const { withinIdx } = pbpResolveGlobal(pbpTimeline, pbpCursorIdx);
                return pbpDayToYmd(e.year, e.decoded.dates[withinIdx]);
            })(),
        };
        // Drop defaults to keep the URL short.
        const parts = [];
        for (const [k, v] of Object.entries(params)) {
            if (v === URL_DEFAULTS[k] || v === "") continue;
            parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
        }
        const hash = parts.length ? "#" + parts.join("&") : "";
        // replaceState avoids polluting browser history with every change.
        if (hash !== window.location.hash) {
            history.replaceState(null, "", window.location.pathname + window.location.search + hash);
        }
    }, 120);
}

function getCurrentMode() {
    return getActiveModeBtnData("mode-toggle", "mode") || "season";
}

function getSegValue(groupId, dataKey) {
    const active = document.querySelector(`#${groupId} .seg-btn.active`);
    return active ? active.dataset[dataKey] : null;
}

function setupSegGroup(groupId, onChange) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll(".seg-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            if (btn.classList.contains("active")) return;
            group.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            onChange();
        });
    });
}

function setupModeToggle(containerId, onChange) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll(".mode-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            if (btn.classList.contains("active")) return;
            container.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            onChange();
        });
    });
}

function getActiveModeBtnData(containerId, attr) {
    const active = document.querySelector(`#${containerId} .mode-btn.active`);
    return active ? active.dataset[attr] : null;
}

function setupZoomToolbar() {
    document.querySelectorAll("#chart-toolbar .chart-tool[data-zoom-mode]").forEach(btn => {
        btn.addEventListener("click", () => {
            if (btn.classList.contains("active")) return;
            document.querySelectorAll("#chart-toolbar .chart-tool[data-zoom-mode]")
                .forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            // Switching to pan-zoom resets the view because d3.zoom uses a
            // single scale factor for both axes and can't faithfully restart
            // from a brush-selected aspect ratio. Switching to brush keeps
            // the current view so the user can brush *into* a panned view.
            if (btn.dataset.zoomMode === "pan") viewDomain = null;
            zoomMode = btn.dataset.zoomMode;
            document.dispatchEvent(new CustomEvent("bl2d:refresh"));
        });
    });
    document.getElementById("zoom-reset").addEventListener("click", () => {
        if (!viewDomain) return;
        viewDomain = null;
        document.dispatchEvent(new CustomEvent("bl2d:refresh"));
    });
}

function updateZoomResetEnabled() {
    const btn = document.getElementById("zoom-reset");
    if (btn) btn.disabled = !viewDomain;
}

function resetThresholdToDefault() {
    const cfg = activeDataset().thresholdConfig[getCurrentMode()];
    if (!cfg) return;
    document.getElementById("pa-min-select").value = cfg.default ?? 0;
}

function applyModeConfig(mode) {
    const cfg = activeDataset().thresholdConfig[mode];
    if (!cfg) return;
    // The threshold is a free-entry number input backed by a <datalist> of
    // presets: the user can type any exact value or pick a suggested one.
    const input = document.getElementById("pa-min-select");
    if (!input) return;
    input.min = 0;
    input.max = cfg.max;
    input.step = cfg.step;

    const list = document.getElementById("pa-presets");
    if (list) {
        list.innerHTML = "";
        cfg.presets.forEach((p) => {
            const opt = document.createElement("option");
            opt.value = String(p.val);
            opt.label = p.val === 0
                ? "No minimum"
                : (p.val === cfg.default ? `${p.val} (qualified)` : String(p.val));
            list.appendChild(opt);
        });
    }

    // Keep a still-valid prior value; otherwise land on the mode default.
    const cur = parseInt(input.value);
    if (isNaN(cur) || cur < 0 || cur > cfg.max) input.value = cfg.default ?? 0;
}

// Aggregate one player's selected seasons into a single career-totals row.
// Counting stats sum; rate stats (AVG/OBP/SLG for batting, ERA/WHIP/K9 for
// pitching) are recomputed from the summed components — averaging the season
// rates would over-weight short seasons.
function aggregateCareer(seasons, dataset = "batting") {
    const out = {
        playerID: seasons[0].playerID,
        teamID: "—",
        lgID: "—",
        yearFirst: seasons[0].yearID,
        yearLast: seasons[seasons.length - 1].yearID,
        seasonsCount: seasons.length,
    };
    const sumKeys = dataset === "pitching"
        ? ["W", "L", "G", "GS", "CG", "SHO", "SV", "IPouts",
           "H", "ER", "HR", "BB", "SO", "IBB", "WP", "HBP", "BK",
           "BFP", "GF", "R", "SH", "SF", "GIDP"]
        : ["G", "AB", "R", "H", "2B", "3B", "HR", "RBI", "SB", "CS",
           "BB", "SO", "IBB", "HBP", "SH", "SF", "GIDP", "PA", "TB"];
    for (const k of sumKeys) {
        let s = 0;
        for (const sn of seasons) {
            const v = sn[k];
            if (!isNaN(v)) s += v;
        }
        out[k] = s;
    }
    if (dataset === "pitching") {
        const ip = out.IPouts / 3;
        out.IP    = out.IPouts > 0 ? ip : NaN;
        out.ERA   = out.IPouts > 0 ? (9 * out.ER) / ip : NaN;
        out.WHIP  = out.IPouts > 0 ? (out.BB + out.H) / ip : NaN;
        out["K/9"]  = out.IPouts > 0 ? (9 * out.SO) / ip : NaN;
        out["BB/9"] = out.IPouts > 0 ? (9 * out.BB) / ip : NaN;
        out["H/9"]  = out.IPouts > 0 ? (9 * out.H)  / ip : NaN;
        out["K/BB"]  = out.BB > 0 ? out.SO / out.BB : NaN;
        out["HR/9"]  = out.IPouts > 0 ? (9 * out.HR) / ip : NaN;
        out["K%"]    = out.BFP > 0 ? out.SO / out.BFP : NaN;
        out["BB%"]   = out.BFP > 0 ? out.BB / out.BFP : NaN;
        out["K-BB%"] = out.BFP > 0 ? (out.SO - out.BB) / out.BFP : NaN;
        const abFacedC = out.BFP - out.BB - z(out.HBP) - z(out.SH) - z(out.SF);
        out.BAOpp = abFacedC > 0 ? out.H / abFacedC : NaN;
    } else {
        out.AVG = out.AB > 0 ? out.H / out.AB : NaN;
        const obpDen = out.AB + out.BB + out.HBP + out.SF;
        out.OBP = obpDen > 0 ? (out.H + out.BB + out.HBP) / obpDen : NaN;
        out.SLG = out.AB > 0 ? out.TB / out.AB : NaN;
        out.OPS  = isFinite(out.OBP) && isFinite(out.SLG) ? out.OBP + out.SLG : NaN;
        out.ISO  = out.AB > 0 ? (out.TB - out.H) / out.AB : NaN;
        const babipDen = out.AB - z(out.SO) - z(out.HR) + z(out.SF);
        out.BABIP  = babipDen > 0 ? (out.H - z(out.HR)) / babipDen : NaN;
        out["BB%"] = out.PA > 0 ? out.BB / out.PA : NaN;
        out["K%"]  = out.PA > 0 ? z(out.SO) / out.PA : NaN;
        const rcDen = z(out.AB) + z(out.BB);
        out.RC = rcDen > 0 ? (z(out.H) + z(out.BB)) * z(out.TB) / rcDen : NaN;
    }
    out.yearID = out.yearFirst;
    return out;
}

function setupControlsToggle() {
    const toggle = document.getElementById("controls-toggle");
    const panel = document.getElementById("controls-panel");
    toggle.addEventListener("click", () => {
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!expanded));
        panel.classList.toggle("collapsed", expanded);
    });
}

let glossaryShow = null;
let glossaryHide = null;

const GLOSSARY = {
    PA:   { name: "Plate Appearances",     formula: "AB + BB + HBP + SH + SF" },
    G:    { name: "Games Played",          formula: "Games in which the player appeared" },
    AB:   { name: "At Bats",               formula: "PA minus walks, HBP, and sacrifices" },
    R:    { name: "Runs Scored",           formula: "Times the batter crossed home plate" },
    H:    { name: "Hits",                  formula: "Singles + doubles + triples + home runs" },
    "2B": { name: "Doubles",               formula: "Two-base hits" },
    "3B": { name: "Triples",               formula: "Three-base hits" },
    HR:   { name: "Home Runs",             formula: "Four-base hits" },
    TB:   { name: "Total Bases",           formula: "H + 2B + 2·3B + 3·HR" },
    RBI:  { name: "Runs Batted In",        formula: "Runners scored on the batter's plate appearances" },
    SB:   { name: "Stolen Bases",          formula: "Bases stolen successfully" },
    CS:   { name: "Caught Stealing",       formula: "Failed stolen-base attempts" },
    BB:   { name: "Walks (Bases on Balls)", formula: "Times awarded first base on 4 balls" },
    SO:   { name: "Strikeouts",            formula: "Times struck out at the plate" },
    IBB:  { name: "Intentional Walks",     formula: "Walks deliberately issued by the pitcher" },
    HBP:  { name: "Hit By Pitch",          formula: "Times hit by a pitched ball, awarded first base" },
    SH:   { name: "Sacrifice Hits",        formula: "Sacrifice bunts that advanced a runner" },
    SF:   { name: "Sacrifice Flies",       formula: "Fly balls deep enough to score a runner from third" },
    GIDP: { name: "Grounded Into Double Play", formula: "Ground balls that became a double play" },
    AVG:  { name: "Batting Average",       formula: "H ÷ AB" },
    OBP:  { name: "On-Base Percentage",    formula: "(H + BB + HBP) ÷ (AB + BB + HBP + SF)" },
    SLG:  { name: "Slugging Percentage",   formula: "TB ÷ AB" },
    OPS:  { name: "On-Base Plus Slugging", formula: "OBP + SLG" },
    ISO:  { name: "Isolated Power",        formula: "(TB − H) ÷ AB — raw extra-base power" },
    BABIP:{ name: "Batting Avg on Balls in Play", formula: "(H − HR) ÷ (AB − SO − HR + SF)" },
    "BB%":{ name: "Walk Rate",             formula: "BB ÷ PA (batters) · BB ÷ BFP (pitchers)" },
    "K%": { name: "Strikeout Rate",        formula: "SO ÷ PA (batters) · SO ÷ BFP (pitchers)" },
    RC:   { name: "Runs Created",          formula: "(H + BB) × TB ÷ (AB + BB) — Bill James" },

    // Pitching dimensions (some share names with batting: G, BB, SO, HR, etc.
    // — those entries above already cover them, so we don't redeclare.)
    W:      { name: "Wins (pitcher)",       formula: "Decisions credited to the pitcher when their team wins" },
    L:      { name: "Losses (pitcher)",     formula: "Decisions credited to the pitcher when their team loses" },
    GS:     { name: "Games Started",        formula: "Games started by the pitcher" },
    CG:     { name: "Complete Games",       formula: "Games pitched fully by one pitcher" },
    SHO:    { name: "Shutouts",             formula: "Complete games with zero earned runs allowed" },
    SV:     { name: "Saves",                formula: "Late-inning leads preserved by the relief pitcher" },
    IPouts: { name: "Outs Recorded",        formula: "IP × 3 (Lahman's raw storage)" },
    IP:     { name: "Innings Pitched",      formula: "IPouts ÷ 3" },
    ER:     { name: "Earned Runs",          formula: "Runs allowed not due to fielding errors" },
    BFP:    { name: "Batters Faced",        formula: "Plate appearances against this pitcher" },
    ERA:    { name: "Earned Run Average",   formula: "9 × ER ÷ IP — lower is better" },
    WHIP:   { name: "Walks + Hits per IP",  formula: "(BB + H) ÷ IP — lower is better" },
    "K/9":   { name: "Strikeouts per 9 IP",     formula: "9 × SO ÷ IP" },
    "BB/9":  { name: "Walks per 9 IP",          formula: "9 × BB ÷ IP — lower is better" },
    "K/BB":  { name: "Strikeout-to-Walk",       formula: "SO ÷ BB" },
    "H/9":   { name: "Hits per 9 IP",           formula: "9 × H ÷ IP — lower is better" },
    "HR/9":  { name: "Home Runs per 9 IP",      formula: "9 × HR ÷ IP — lower is better" },
    "K-BB%": { name: "Strikeout minus Walk %",  formula: "(SO − BB) ÷ BFP — higher is better" },
    BAOpp:   { name: "Batting Avg Against",     formula: "H ÷ AB-faced — lower is better" },
};

function chartExportFilename(ext) {
    const xDim = document.getElementById("x-axis-select")?.value || "x";
    const yDim = document.getElementById("y-axis-select")?.value || "y";
    const mode = document.querySelector("#mode-toggle .mode-btn.active")?.dataset.mode || "season";
    return `baseball-limits-2d_${xDim}-${yDim}_${mode}.${ext}`;
}

// ── On-chart axis stat picker ──────────────────────────────────────
// Clicking an axis title opens a small menu of the active dataset's stats,
// mirrored from the sidebar <select> (which stays the single source of truth).
let _axisMenuEl = null;
let _axisMenuCleanup = null;

function closeAxisStatMenu() {
    if (_axisMenuEl) { _axisMenuEl.remove(); _axisMenuEl = null; }
    if (_axisMenuCleanup) { _axisMenuCleanup(); _axisMenuCleanup = null; }
}

function openAxisStatMenu(anchorEl, selectId, placement) {
    closeAxisStatMenu();
    const select = document.getElementById(selectId);
    const region = document.querySelector(".chart-region");
    if (!select || !region) return;

    const menu = document.createElement("div");
    menu.className = "axis-stat-menu";
    menu.setAttribute("role", "listbox");

    Array.from(select.options).forEach((opt) => {
        const item = document.createElement("div");
        item.className = "axis-stat-item";
        item.setAttribute("role", "option");
        item.textContent = opt.textContent;
        if (opt.value === select.value) {
            item.classList.add("axis-stat-item--active");
            item.setAttribute("aria-selected", "true");
        }
        item.addEventListener("click", (e) => {
            e.stopPropagation();
            if (select.value !== opt.value) {
                select.value = opt.value;
                // Reuse the sidebar select's change wiring (refresh + URL write).
                select.dispatchEvent(new Event("change", { bubbles: true }));
            }
            closeAxisStatMenu();
        });
        menu.appendChild(item);
    });

    region.appendChild(menu);

    // Position relative to the chart region, opening inward so the region's
    // overflow:hidden doesn't clip the menu.
    const a = anchorEl.getBoundingClientRect();
    const r = region.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left, top;
    if (placement === "right") {           // y-axis title (left edge) → open right
        left = (a.right - r.left) + 6;
        top  = (a.top - r.top) + a.height / 2 - mh / 2;
    } else {                               // x-axis title (bottom) → open upward
        left = (a.left - r.left) + a.width / 2 - mw / 2;
        top  = (a.top - r.top) - mh - 6;
    }
    left = Math.max(4, Math.min(left, r.width - mw - 4));
    top  = Math.max(4, Math.min(top, r.height - mh - 4));
    menu.style.left = `${left}px`;
    menu.style.top  = `${top}px`;

    _axisMenuEl = menu;

    // Dismiss on outside-click / Escape.
    const onDocClick = (e) => { if (_axisMenuEl && !_axisMenuEl.contains(e.target)) closeAxisStatMenu(); };
    const onKey = (e) => { if (e.key === "Escape") closeAxisStatMenu(); };
    setTimeout(() => document.addEventListener("click", onDocClick), 0);
    document.addEventListener("keydown", onKey);
    _axisMenuCleanup = () => {
        document.removeEventListener("click", onDocClick);
        document.removeEventListener("keydown", onKey);
    };
}

function buildExportSvgString(dataUrls) {
    const svg = document.getElementById("scatter-plot");
    if (!svg) return null;

    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#f4f5f7";

    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    // Explicit dimensions are required for canvas rasterisation; without them
    // the browser uses the SVG default (300×150) when drawing to a canvas.
    const { width, height } = svg.getBoundingClientRect();
    clone.setAttribute("width", Math.round(width));
    clone.setAttribute("height", Math.round(height));
    clone.removeAttribute("role");
    clone.removeAttribute("aria-label");

    // Faithfully reproduce the on-screen look by inlining each node's *computed*
    // presentation properties. This is drift-proof: whatever the live chart
    // renders (stylesheet, class, or inline) is what the export gets — no
    // hand-maintained per-class style block to fall out of sync. (The old block
    // still styled the long-renamed `.frontier-line`, so the red Pareto
    // staircase — now `.frontier-staircase` — vanished from share previews.)
    // computed values also resolve CSS custom properties to concrete colors, so
    // the standalone SVG no longer depends on :root variables.
    const PROPS = [
        "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity",
        "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity",
        "paint-order", "font-family", "font-size", "font-weight", "text-anchor",
    ];
    // Interaction-only / affordance layers don't belong in a static image.
    const DROP = ".hit, .hit-surface, .zoom-overlay, .brush, .axis-caret, .isolation-ring-group, .regret-line-group";
    const srcNodes = [svg, ...svg.querySelectorAll("*")];
    const dstNodes = [clone, ...clone.querySelectorAll("*")];
    const toRemove = [];
    for (let i = 0; i < dstNodes.length; i++) {
        const dst = dstNodes[i];
        if (dst.matches && dst.matches(DROP)) { toRemove.push(dst); continue; }
        const cs = getComputedStyle(srcNodes[i]);
        let inline = dst.getAttribute("style") || "";
        for (const p of PROPS) {
            const val = cs.getPropertyValue(p);
            if (val) inline += `${p}:${val};`;
        }
        dst.setAttribute("style", inline);
    }
    toRemove.forEach((n) => n.remove());

    // Canvas carries the high-cardinality point layers. Embed transparent PNGs
    // behind the SVG overlay so SVG download and share-preview rasterisation keep
    // the complete chart instead of labels/axes only. `dataUrls` comes from the
    // active renderer's exportDataURLs() (Canvas 2D: [bg,fg]; WebGPU: one readback
    // composite) — kept here as a param so this stays synchronous.
    const urls = dataUrls || (pointRenderer.bgCanvas ? [pointRenderer.bgCanvas, pointRenderer.fgCanvas].filter(Boolean).map((c) => c.toDataURL("image/png")) : []);
    const firstChild = clone.firstChild;
    for (const href of urls) {
        if (!href) continue;
        const img = document.createElementNS("http://www.w3.org/2000/svg", "image");
        img.setAttribute("x", "0");
        img.setAttribute("y", "0");
        img.setAttribute("width", Math.round(width));
        img.setAttribute("height", Math.round(height));
        img.setAttribute("href", href);
        clone.insertBefore(img, firstChild);
    }

    let svgStr = new XMLSerializer().serializeToString(clone);
    // The SVG's own background can't be captured as a presentation property.
    return svgStr.replace(/(<svg[^>]*>)/, `$1<style>svg{background:${bg};}</style>`);
}

// PointRenderer seam (docs/webgpu-main-app-integration-design.md §A): the high-
// cardinality point cloud is drawn through this object so a future WebGPU backend
// can slot in behind the same method surface. Canvas2DRenderer is the only
// implementation (the default + the offline bundle's only renderer). It owns the two
// <canvas> layers under the SVG overlay (bg = key-cached completed-season cloud, fg =
// per-frame open cloud + group-career trails + frontier dots), their DPR/sizes, and
// the background-layer cache key. Method surface (the "interface" a WebGPURenderer
// must match): resize(w,h)→layers|null; clear(); drawBackground(points,opts);
// drawForeground(points,opts); drawTrails(trails,opts); drawFrontierDots(points,opts);
// get dpr/bgCanvas/fgCanvas; get/set bgCacheKey; destroy().
class Canvas2DRenderer {
    constructor() { this.layers = null; this.bgCacheKey = null; }
    get dpr() { return this.layers?.dpr || 1; }
    get bgCanvas() { return this.layers?.bg || null; }
    get fgCanvas() { return this.layers?.fg || null; }

    // Lazily create the bg+fg canvases under the SVG overlay; size both to
    // width*dpr × height*dpr (dpr clamped to [1,3]). Returns the layer handle, or
    // null if the chart region / SVG isn't in the DOM yet.
    resize(width, height) {
        const region = document.querySelector(".chart-region");
        const svg = document.getElementById("scatter-plot");
        if (!region || !svg) return null;
        if (!this.layers) {
            const bg = document.createElement("canvas");
            const fg = document.createElement("canvas");
            bg.className = "plot-canvas plot-canvas--background";
            fg.className = "plot-canvas plot-canvas--foreground";
            bg.setAttribute("aria-hidden", "true");
            fg.setAttribute("aria-hidden", "true");
            region.insertBefore(bg, svg);
            region.insertBefore(fg, svg);
            this.layers = { bg, fg };
        }
        const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
        for (const canvas of [this.layers.bg, this.layers.fg]) {
            const bw = Math.max(1, Math.round(width * dpr));
            const bh = Math.max(1, Math.round(height * dpr));
            if (canvas.width !== bw || canvas.height !== bh) {
                canvas.width = bw;
                canvas.height = bh;
            }
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
        }
        this.layers.dpr = dpr;
        this.layers.width = width;
        this.layers.height = height;
        return this.layers;
    }

    clear() {
        if (!this.layers) return;
        this.bgCacheKey = null;
        for (const canvas of [this.layers.bg, this.layers.fg]) {
            const ctx = canvas.getContext("2d");
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }

    drawBackground(points, opts) { this._drawPoints(this.bgCanvas, points, opts); }
    drawForeground(points, opts) { this._drawPoints(this.fgCanvas, points, opts); }

    _drawPoints(canvas, points, opts) {
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        const dpr = this.dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const { margin, xScale, yScale, radius, fillFor, alpha = 1, alphaFor = null, strokeFor = null, strokeWidth = 0, clear = true } = opts;
        // clear=false lets a caller composite dots ON TOP of an under-layer it already
        // drew on this same canvas (group-career: trails first, then head-dots).
        if (clear) ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
        if (!points || !points.length) return;
        for (const d of points) {
            const cx = margin.left + xScale(d.x);
            const cy = margin.top + yScale(d.y);
            if (!isFinite(cx) || !isFinite(cy)) continue;
            ctx.globalAlpha = alphaFor ? alphaFor(d) : alpha;
            ctx.beginPath();
            ctx.arc(cx, cy, typeof radius === "function" ? radius(d) : radius, 0, Math.PI * 2);
            ctx.fillStyle = fillFor(d);
            ctx.fill();
            const stroke = strokeFor && strokeFor(d);
            if (stroke && strokeWidth > 0) {
                ctx.globalAlpha = 1;
                ctx.lineWidth = strokeWidth;
                ctx.strokeStyle = stroke;
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
    }

    // Group-career trails: clears the fg, then for each player strokes their recent
    // career positions as a poly-line whose alpha ramps 0→1 from oldest to newest, so
    // the head pulls a short fading comet-tail. Positions are DATA coords (so zoom/pan
    // re-projects). The caller follows this with drawForeground(clear:false) so the
    // head-dots composite over the tails on the same canvas.
    drawTrails(trails, opts) {
        const canvas = this.fgCanvas;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        const dpr = this.dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
        const { margin, xScale, yScale, width = 2 } = opts;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = width;
        for (const { color, points } of trails) {
            if (!points || points.length < 2) continue;
            const n = points.length;
            for (let i = 1; i < n; i++) {
                const a = points[i - 1], b = points[i];
                const ax = margin.left + xScale(a.x), ay = margin.top + yScale(a.y);
                const bx = margin.left + xScale(b.x), by = margin.top + yScale(b.y);
                if (![ax, ay, bx, by].every(isFinite)) continue;
                ctx.globalAlpha = (i / (n - 1)) * 0.85;   // oldest faint → newest near-opaque
                ctx.strokeStyle = color;
                ctx.beginPath();
                ctx.moveTo(ax, ay);
                ctx.lineTo(bx, by);
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
    }

    // Frontier (special) dots, composited over the fg cloud with NO clear (they sit on
    // top of drawForeground's output). fillFor resolves the career/worst/encoding colour
    // in the caller's scope; radiusFor sizes by the active size-by stat.
    drawFrontierDots(points, opts) {
        const canvas = this.fgCanvas;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        const dpr = this.dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const { margin, xScale, yScale, radiusFor, fillFor, strokeColor = "#ffffff", strokeWidth = 1.5 } = opts;
        for (const d of points) {
            const cx = margin.left + xScale(d.x);
            const cy = margin.top + yScale(d.y);
            if (!isFinite(cx) || !isFinite(cy)) continue;
            ctx.beginPath();
            ctx.arc(cx, cy, radiusFor(d), 0, Math.PI * 2);
            ctx.fillStyle = fillFor(d);
            ctx.fill();
            ctx.lineWidth = strokeWidth;
            ctx.strokeStyle = strokeColor;
            ctx.stroke();
        }
    }

    // Canvas 2D paints immediately in each draw* call, so compositing is already done.
    present() { /* no-op — the WebGPU backend submits its single render pass here */ }

    // Export source: the two layer PNGs, bg first (same z-order exportChartSVG embeds).
    exportDataURLs() {
        return [this.bgCanvas, this.fgCanvas].filter(Boolean).map((c) => c.toDataURL("image/png"));
    }

    destroy() {
        if (!this.layers) return;
        for (const canvas of [this.layers.bg, this.layers.fg]) canvas.remove();
        this.layers = null;
        this.bgCacheKey = null;
    }
}

// Pack a CSS colour (era/league/handedness palette, tiny → memoized) + an extra alpha
// multiplier into a little-endian RGBA8 u32 the WGSL shaders unpack byte-by-byte.
const _rgbaPackCache = new Map();
function packColorRGBA(css, alpha = 1) {
    const key = css + "|" + alpha;
    let v = _rgbaPackCache.get(key);
    if (v !== undefined) return v;
    let r = 0, g = 0, b = 0, a = 255;
    const c = d3.color(css);
    if (c) { const rc = c.rgb(); r = rc.r & 255; g = rc.g & 255; b = rc.b & 255;
        a = Math.max(0, Math.min(255, Math.round(255 * (rc.opacity ?? 1) * alpha))); }
    v = ((r | (g << 8) | (b << 16) | (a << 24)) >>> 0);
    _rgbaPackCache.set(key, v);
    return v;
}

// WGSL: instanced-quad point cloud. Per-instance (px,py,radius,ring,fill,stroke) is
// vertex-pulled from a storage buffer; positions are CSS px → NDC (+Y up, so a Y flip);
// the fragment does the round-disc test + an optional white ring, with a ~1px AA edge.
const WEBGPU_POINTS_WGSL = `
struct U { vp: vec2<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct Inst { px: f32, py: f32, radius: f32, ring: f32, fill: u32, stroke: u32 };
@group(0) @binding(1) var<storage, read> inst: array<Inst>;
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) off: vec2<f32>,
  @location(1) @interpolate(flat) fill: u32,
  @location(2) @interpolate(flat) stroke: u32,
  @location(3) @interpolate(flat) radius: f32,
  @location(4) @interpolate(flat) ring: f32,
};
const C = array<vec2<f32>, 6>(
  vec2<f32>(-1.0,-1.0), vec2<f32>(1.0,-1.0), vec2<f32>(-1.0,1.0),
  vec2<f32>(-1.0, 1.0), vec2<f32>(1.0,-1.0), vec2<f32>( 1.0,1.0));
fn unpack(c: u32) -> vec4<f32> {
  return vec4<f32>(f32(c & 0xffu), f32((c >> 8u) & 0xffu), f32((c >> 16u) & 0xffu), f32((c >> 24u) & 0xffu)) / 255.0;
}
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let d = inst[ii];
  let corner = C[vi];
  let ext = d.radius + d.ring;                 // grow the quad so the rim isn't clipped
  let cx = d.px / u.vp.x * 2.0 - 1.0;
  let cy = 1.0 - d.py / u.vp.y * 2.0;          // pixel-down → NDC-up
  var o: VSOut;
  o.pos = vec4<f32>(cx + corner.x * ext / u.vp.x * 2.0, cy + corner.y * ext / u.vp.y * 2.0, 0.0, 1.0);
  o.off = corner * ext;                        // px offset from centre (interpolated)
  o.fill = d.fill; o.stroke = d.stroke; o.radius = d.radius; o.ring = d.ring;
  return o;
}
@fragment
fn fs(i: VSOut) -> @location(0) vec4<f32> {
  let dist = length(i.off);
  let outer = i.radius + i.ring * 0.5;
  let aa = 1.0 - smoothstep(outer - 0.75, outer + 0.75, dist);
  if (aa <= 0.0) { discard; }
  var col: vec4<f32>;
  if (i.ring > 0.0 && dist > i.radius - i.ring * 0.5) { col = unpack(i.stroke); }
  else { col = unpack(i.fill); }
  return vec4<f32>(col.rgb, col.a * aa);
}`;

// WGSL: group-career trail segments as instanced thin quads (line-strip can't vary
// width/alpha per segment). Per-instance (x0,y0,x1,y1,width,color); alpha is baked into
// the colour (the oldest→newest ramp), so the comet-tail matches the Canvas-2D path.
const WEBGPU_LINE_WGSL = `
struct U { vp: vec2<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct Seg { x0: f32, y0: f32, x1: f32, y1: f32, width: f32, color: u32 };
@group(0) @binding(1) var<storage, read> seg: array<Seg>;
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) @interpolate(flat) color: u32 };
const TS = array<vec2<f32>, 6>(
  vec2<f32>(0.0,-1.0), vec2<f32>(1.0,-1.0), vec2<f32>(0.0,1.0),
  vec2<f32>(0.0, 1.0), vec2<f32>(1.0,-1.0), vec2<f32>(1.0,1.0));
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let s = seg[ii];
  let ts = TS[vi];
  let p0 = vec2<f32>(s.x0, s.y0);
  let p1 = vec2<f32>(s.x1, s.y1);
  let dir = normalize(p1 - p0 + vec2<f32>(1e-5, 0.0));
  let nrm = vec2<f32>(-dir.y, dir.x);
  let px = mix(p0, p1, ts.x) + nrm * (ts.y * s.width * 0.5);
  var o: VSOut;
  o.pos = vec4<f32>(px.x / u.vp.x * 2.0 - 1.0, 1.0 - px.y / u.vp.y * 2.0, 0.0, 1.0);
  o.color = s.color;
  return o;
}
@fragment
fn fs(i: VSOut) -> @location(0) vec4<f32> {
  let c = vec4<f32>(f32(i.color & 0xffu), f32((i.color >> 8u) & 0xffu), f32((i.color >> 16u) & 0xffu), f32((i.color >> 24u) & 0xffu)) / 255.0;
  return c;
}`;

// ─────────────────────────────────────────────────────────────────────────────
// GPU compute-accumulate path (the ?renderer=webgpu .evt-career scaling track).
//
// Background — what problem this solves. In the play-by-play CAREER animation the
// CPU otherwise rebuilds EVERY player's point object each frame (evtPointsAsOf:
// one binary-search-per-stat per player, ~11 k players) and then re-flattens all
// of them into a GPU instance buffer (_uploadPoints). That O(players) per-frame
// churn is the cost the README's "scaling path toward pitch-by-pitch volumes"
// item targets. The POC (poc-webgpu/) proved a better shape: upload the flat,
// date-sorted EVENT STREAM to the GPU ONCE, and each frame dispatch a compute
// shader only over the NEW events since the last cursor — accumulating per-player
// running totals into two storage buffers — then render the cloud by reading those
// totals straight out of the buffers in the vertex shader (no CPU readback, no
// per-frame point rebuild). This is the in-app adaptation of that approach.
//
// TWO GPU buffer "roles" appear below and it's worth fixing the distinction now,
// because every WebGPU pipeline is built around it:
//   • UNIFORM buffer  — small, read-only, the SAME value for every shader
//     invocation this frame (e.g. the event window {lo,count}, or the axis scale).
//     Think "per-frame constants". Bound with buffer:{type:"uniform"}.
//   • STORAGE buffer  — large, indexable like an array, one element per player /
//     per event; can be read-write in compute (atomic counters) or read-only in
//     the vertex shader (vertex-pull). Bound with type "storage" / "read-only-
//     storage". Think "the data arrays".
// ─────────────────────────────────────────────────────────────────────────────

// WGSL (compute): accumulate one event per invocation into per-player running
// AXIS totals. The CPU advances a cursor over the date-sorted event stream and
// dispatches us ONLY over the new [lo, lo+count) slice each frame — we never
// rescan history. xcount[] holds the running X-AXIS VALUE per player, ycount[] the
// Y-axis value. atomicAdd (not a plain `+=`) because the 64 threads in a workgroup
// run concurrently and several events in one slice can target the SAME player (e.g.
// a multi-hit game) — without the atomic those adds would race and lose updates.
//
// Generalisation beyond the POC's fixed HR/SB: each axis stat is a LINEAR, monotone-
// nondecreasing combination of streamed counting components (HR and SB are the trivial
// 1-component case; TB = 1·H + 2·2B + 3·3B + 4·HR is a 4-component case — it still only
// ever grows). The CPU pre-multiplies each event's raw component delta by that axis's
// coefficient for the component, so each event already carries the X-axis delta and the
// Y-axis delta directly: {player, xAdd, yAdd}. The shader just adds them. This is why
// the same atomicAdd works for HR, SB, TB, PA, … — but NOT for rate stats (AVG/OBP/SLG),
// which can DECREASE frame-to-frame and so can't be maintained by a monotone running
// sum (those stay on the CPU cloud; see evtGpuMonotone).
const WEBGPU_ACCUM_WGSL = `
struct Win { lo: u32, count: u32 };
@group(0) @binding(0) var<uniform> W: Win;
@group(0) @binding(1) var<storage, read>       events: array<u32>;   // {player,xAdd,yAdd} ×3 per event
@group(0) @binding(2) var<storage, read_write> xcount: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> ycount: array<atomic<u32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let g = gid.x;
  if (g >= W.count) { return; }          // the last workgroup is usually partial — guard it
  let e = (W.lo + g) * 3u;               // 3 u32 stride into the flat event array
  let player = events[e + 0u];
  let xAdd   = events[e + 1u];           // this date's X-axis delta for that player (≥ 0)
  let yAdd   = events[e + 2u];           // this date's Y-axis delta (≥ 0; usually one of the two is 0)
  if (xAdd != 0u) { atomicAdd(&xcount[player], xAdd); }
  if (yAdd != 0u) { atomicAdd(&ycount[player], yAdd); }
}`;

// WGSL (render): the vertex-PULL point cloud. There is no vertex/instance buffer of
// positions — instead instance_index IS the player index, and the vertex shader
// reads that player's accumulated (xcount, ycount) directly from the storage buffers
// the compute pass just wrote. That "vertex-pull, no readback" is the whole point:
// the data never round-trips back to the CPU between accumulate and draw.
//
// Coordinate mapping (the load-bearing bit — it MUST match the CPU/SVG axes pixel
// for pixel, or the GPU cloud drifts off the D3 axes). The CPU path computes a dot's
// screen position as `px = margin.left + xScale(value)` where xScale is a D3 LINEAR
// scale. Any linear scale is `xScale(v) = xScale(0) + slope*v`, so we can reproduce
// it on the GPU with just two numbers per axis: slope and intercept, passed in the
// uScale uniform (interceptX = margin.left + xScale(0); slopeX = xScale(1)-xScale(0)).
// Because this path is gated to single-dep "passthrough" counting axes, the stat
// VALUE equals the accumulated COUNTER, so `px = interceptX + slopeX*xcount` is the
// exact same pixel the CPU produces. The yScale's slope is negative (its range runs
// [plotHeight, 0]), so high Y maps to a small py — no separate Y flip is needed
// beyond the standard pixel→NDC flip below.
//
// CSS-px vs NDC vs DPR: positions are in CSS pixels (vpX,vpY = the CSS chart size,
// same as the Canvas-2D path and the instanced pPoints shader). The offscreen
// texture may be larger (devicePixelRatio), but NDC always spans the whole texture,
// so mapping in CSS px and letting the rasteriser scale to texels keeps DPR handling
// identical to pPoints. The +Y-up flip `1 - py/vp*2` converts pixel-down to NDC-up.
//
// Colour: we DON'T recompute the era ramp here — the CPU packs each player's era
// colour (which is per-theme) into the col[] buffer once, and we just unpack it.
// Frontier emphasis is NOT done in this shader: the app draws frontier dots as a
// separate, larger, white-ringed era-coloured layer on top (drawFrontierDots), so
// the cloud is a uniform era cloud for ALL players — exactly what the CPU cloud is.
// (0,0) points — players with no events yet at this cursor — are dropped to match
// evtPointsAsOf, by emitting an off-screen degenerate quad.
const WEBGPU_EVTCLOUD_WGSL = `
struct S { slopeX: f32, interceptX: f32, slopeY: f32, interceptY: f32, vpX: f32, vpY: f32, radius: f32, alpha: f32 };
@group(0) @binding(0) var<uniform> u: S;
@group(0) @binding(1) var<storage, read> xc:  array<u32>;
@group(0) @binding(2) var<storage, read> yc:  array<u32>;
@group(0) @binding(3) var<storage, read> col: array<u32>;   // packed RGBA8 era colour per player
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) off: vec2<f32>,
  @location(1) @interpolate(flat) fill: vec4<f32>,
  @location(2) @interpolate(flat) radius: f32,
};
const C = array<vec2<f32>, 6>(
  vec2<f32>(-1.0,-1.0), vec2<f32>(1.0,-1.0), vec2<f32>(-1.0,1.0),
  vec2<f32>(-1.0, 1.0), vec2<f32>(1.0,-1.0), vec2<f32>( 1.0,1.0));
fn unpack(c: u32) -> vec4<f32> {
  return vec4<f32>(f32(c & 0xffu), f32((c >> 8u) & 0xffu), f32((c >> 16u) & 0xffu), f32((c >> 24u) & 0xffu)) / 255.0;
}
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  var o: VSOut;
  let vx = f32(xc[ii]);
  let vy = f32(yc[ii]);
  if (vx == 0.0 && vy == 0.0) {          // no events yet → drop (matches evtPointsAsOf)
    o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);   // outside the clip cube → discarded by the rasteriser
    o.off = vec2<f32>(0.0); o.fill = vec4<f32>(0.0); o.radius = 0.0;
    return o;
  }
  let px = u.interceptX + u.slopeX * vx;     // counter → data value → CSS px (== D3 xScale)
  let py = u.interceptY + u.slopeY * vy;
  let r = u.radius;
  let corner = C[vi];
  let cx = px / u.vpX * 2.0 - 1.0;            // CSS px → NDC, +Y-up flip
  let cy = 1.0 - py / u.vpY * 2.0;
  o.pos = vec4<f32>(cx + corner.x * r / u.vpX * 2.0, cy + corner.y * r / u.vpY * 2.0, 0.0, 1.0);
  o.off = corner * r;                         // px offset from centre, for the disc test
  o.radius = r;
  o.fill = vec4<f32>(unpack(col[ii]).rgb, u.alpha);
  return o;
}
@fragment
fn fs(i: VSOut) -> @location(0) vec4<f32> {
  let dist = length(i.off);                   // distance from the dot centre, in px
  let aa = 1.0 - smoothstep(i.radius - 0.75, i.radius + 0.75, dist);   // ~1px soft edge (matches pPoints)
  if (aa <= 0.0) { discard; }
  return vec4<f32>(i.fill.rgb, i.fill.a * aa);
}`;

// ═════════════════════════════════════════════════════════════════════════════
// Phase 5 — the `gpuStreaming` ENGINE: GPU spring motion + GPU Pareto skyline +
// a fully-GPU staircase (port of poc-webgpu-spring/). This is a SECOND, explicit
// streaming engine, selected by ?renderer=webgpu&gpustream=1. The shipped Phase-4
// path (?renderer=webgpu alone) is a HYBRID: GPU accumulates the cloud but the JS
// incremental frontier stays authoritative and the staircase is SVG. Phase 5 moves
// the WHOLE picture onto the GPU — positions glide (spring), the frontier is
// recomputed on the GPU each frame (skyline), and the red staircase is built and
// drawn entirely on the GPU (compact→rank-sort→emit→drawIndirect). The CPU keeps
// the cheap incremental frontier ONLY to feed DOM/interaction (cards, quadtree,
// labels); it no longer drives the GPU picture. Full design + the "why two engines,
// not a hybrid" rationale: docs/webgpu-main-app-integration-design.md §"Phase 5".
//
// The frame graph (one command encoder; separate compute passes serialize):
//   accumulate (Phase-4, reused) → spring → skyline → reset/compact/ranksort/emit
//   → render: spring-cloud (vertex-pull from pos[]) + staircase via drawIndirect.
//
// MINIMIZING CPU↔GPU TRAFFIC (the design's core question): the event stream is
// uploaded ONCE (uploadEvtStream, reused from Phase 4); per frame only tiny
// uniforms cross the bus ({lo,count} window + {dt,omega} spring), and there is
// ZERO per-frame GPU→CPU readback (a per-frame mapAsync is the documented headless
// device-loss trigger). The frontier/positions are read back ONCE, only in the
// __bl2d_verify* hooks, never in the render loop.
// ═════════════════════════════════════════════════════════════════════════════

// Frontier-size bound for the GPU staircase scratch buffers (matches the POC's
// MAX_FRONT). The compact pass guards writes against this; the verify hook asserts
// the real frontier never approaches it (this dataset's all-time frontier is ~2).
const WEBGPU_MAX_FRONT = 2048;

// Spring stiffness ω (rad/s): ~0.3 s critically-damped settle, matching the POC. Higher
// ⇒ snappier; the integrator is stable for any value/Δt.
const WEBGPU_SPRING_OMEGA = 12;

// WGSL (compute): critically-damped spring. Glides pos[] toward the integer counters
// (xcount,ycount) — which Phase-4's accumulate already maintains — with NO overshoot,
// using the unconditionally-stable polynomial-e integrator (Game Programming Gems 4 /
// SmoothDamp). Derivation: the offset (x−target) obeys x'' + 2ζω·x' + ω²(x−target)=0;
// at the critical ratio ζ=1 there is no overshoot, and replacing the exact decay e^{−ωΔt}
// with the polynomial 1/(1+wd+½wd²+…) keeps it in (0,1] for ANY Δt, so a frame-time spike
// can't blow it up. The counters are declared atomic for accumulate; here there are no
// concurrent writers, so we bind the SAME buffers through a plain read-only array<u32> view
// (a well-defined non-atomic read of atomic storage).
const WEBGPU_SPRING_WGSL = `
struct Spring { dt: f32, omega: f32, n: u32, _pad: u32 };
@group(0) @binding(0) var<uniform>             S:   Spring;
@group(0) @binding(1) var<storage, read>       hr:  array<u32>;        // target X (the accumulated counter)
@group(0) @binding(2) var<storage, read>       sb:  array<u32>;        // target Y
@group(0) @binding(3) var<storage, read_write> pos: array<vec2<f32>>;  // rendered position (data units)
@group(0) @binding(4) var<storage, read_write> vel: array<vec2<f32>>;  // motion state
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= S.n) { return; }
  let tgt = vec2<f32>(f32(hr[i]), f32(sb[i]));   // 'target' is reserved in WGSL → tgt
  let x = pos[i];
  let v = vel[i];
  let wd = S.omega * S.dt;
  let e  = 1.0 / (1.0 + wd + 0.5*wd*wd + (1.0/6.0)*wd*wd*wd + (1.0/24.0)*wd*wd*wd*wd);
  let change = x - tgt;
  let temp   = (v + S.omega * change) * S.dt;
  pos[i] = tgt + (change + temp) * e;            // decays toward target, no overshoot
  vel[i] = (v - S.omega * temp) * e;
}`;

// WGSL (compute): per-frame GPU Pareto skyline. onFront[i]=1 iff no j STRICTLY dominates
// pos[i] (pj ≥ pi on both axes, strictly greater on one). Brute-force O(n²) over the
// smoothed positions — n≈11k ⇒ ~124M comparisons/frame, sub-ms on real hardware. We use
// brute force (not spatial tiling) because tiling's "influence is local" premise is FALSE
// for Pareto domination: one high point dominates an entire lower-left quadrant spanning
// arbitrarily many tiles. Same strict tie-break as core.c's verify_career oracle, so settled
// positions (pos ≈ integer) reproduce the CPU frontier exactly. The (0,0) "no events yet"
// players are dominated by everyone ⇒ onFront=0 ⇒ not drawn as frontier (matches the cloud's
// (0,0) drop).
const WEBGPU_SKYLINE_WGSL = `
struct Spring { dt: f32, omega: f32, n: u32, _pad: u32 };
@group(0) @binding(0) var<uniform>             S:       Spring;
@group(0) @binding(1) var<storage, read_write> onFront: array<u32>;
@group(0) @binding(2) var<storage, read>       pos:     array<vec2<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= S.n) { return; }
  let pi = pos[i];
  if (pi.x == 0.0 && pi.y == 0.0) { onFront[i] = 0u; return; }   // no events yet → off-front
  var dom = 0u;
  for (var j = 0u; j < S.n; j = j + 1u) {
    let pj = pos[j];
    if (pj.x >= pi.x && pj.y >= pi.y && (pj.x > pi.x || pj.y > pi.y)) { dom = 1u; break; }
  }
  onFront[i] = select(1u, 0u, dom == 1u);
}`;

// WGSL (compute): the fully-GPU staircase — three @compute entry points in one module,
// sharing one (superset) bind-group layout. WHY fully-GPU (vs the Vulkan twin's cheap CPU
// staircase): WebGPU can't read pos[]/onFront[] back per frame (async mapAsync = the headless
// device-loss trigger), so we turn onFront[] into an ordered line-strip + a GPU-written draw
// count without ever touching the CPU. The frontier size K is tiny (≤ WEBGPU_MAX_FRONT):
//   1. compact  — one thread/player; append on-front ids into frontIdx[0..K), K via atomicAdd.
//   2. ranksort — one thread/frontier-slot; O(K²) rank (count smaller-x, ties by index),
//                 scatter pos into frontSorted[rank]. Trivial at this K.
//   3. emit     — one thread/sorted-slot; write the two step vertices (corner + vertical drop);
//                 thread 0 writes the left cap and indirect.vertexCount = 1 + 2K.
// Separate compute passes in one encoder serialize, so each pass sees the prior's writes. The
// host resets count→0 and indirect→{0,1,0,0} each frame, so K==0 draws nothing.
const WEBGPU_STAIRCASE_WGSL = `
const MAX_FRONT : u32 = ${WEBGPU_MAX_FRONT}u;
struct Spring   { dt: f32, omega: f32, n: u32, _pad: u32 };
struct DrawArgs { vertexCount: u32, instanceCount: u32, firstVertex: u32, firstInstance: u32 };
@group(0) @binding(0) var<uniform>             S:           Spring;
@group(0) @binding(1) var<storage, read>       onFront:     array<u32>;
@group(0) @binding(2) var<storage, read>       pos:         array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> frontIdx:    array<u32>;
@group(0) @binding(4) var<storage, read_write> frontSorted: array<vec2<f32>>;
@group(0) @binding(5) var<storage, read_write> count:       array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> staircase:   array<vec2<f32>>;
@group(0) @binding(7) var<storage, read_write> indirect:    DrawArgs;
@compute @workgroup_size(64)
fn compact(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= S.n) { return; }
  if (onFront[i] != 0u) {
    let k = atomicAdd(&count[0], 1u);
    if (k < MAX_FRONT) { frontIdx[k] = i; }
  }
}
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
    if (qx < pp.x || (qx == pp.x && q < p)) { rank = rank + 1u; }
  }
  frontSorted[rank] = pp;
}
@compute @workgroup_size(64)
fn emit(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  let K = atomicLoad(&count[0]);
  if (r >= K) { return; }
  if (r == 0u) {
    staircase[0] = vec2<f32>(0.0, frontSorted[0].y);   // left cap on the y-axis
    indirect.vertexCount   = 1u + 2u * K;
    indirect.instanceCount = 1u;
    indirect.firstVertex   = 0u;
    indirect.firstInstance = 0u;
  }
  let here = frontSorted[r];
  let next = r + 1u;
  let hasNext = next < K;
  let safe = select(0u, next, hasNext);
  let dropY = select(0.0, frontSorted[safe].y, hasNext);   // last point drops to the x-axis
  staircase[1u + 2u*r]      = here;
  staircase[1u + 2u*r + 1u] = vec2<f32>(here.x, dropY);
}`;

// WGSL (render): the spring CLOUD. Like WEBGPU_EVTCLOUD_WGSL but vertex-pulls the smoothed
// vec2 pos[] (not the raw u32 counters) and reads onFront[] so the GPU draws the frontier
// emphasis itself (bigger radius + white ring) — no CPU frontier dots in this engine. To keep
// the frontier dots strictly ON TOP of the cloud (instanced draw order ≠ depth), present()
// draws this pipeline TWICE with two bind groups differing only in `frontierPass`: pass 0 draws
// the non-front cloud (front instances degenerate), pass 1 draws only the front dots over it.
// Coordinate mapping is identical to the Phase-4 cloud (slope/intercept = the D3 linear scale),
// so the GPU picture lands pixel-for-pixel on the SVG axes.
const WEBGPU_SPRINGCLOUD_WGSL = `
struct S { slopeX: f32, interceptX: f32, slopeY: f32, interceptY: f32, vpX: f32, vpY: f32,
           radius: f32, alpha: f32, frontierRadius: f32, ring: f32, frontierPass: f32, _pad: f32 };
@group(0) @binding(0) var<uniform> u: S;
@group(0) @binding(1) var<storage, read> pos:     array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> col:     array<u32>;   // packed RGBA8 era colour per player
@group(0) @binding(3) var<storage, read> onFront: array<u32>;
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) off: vec2<f32>,
  @location(1) @interpolate(flat) fill: vec4<f32>,
  @location(2) @interpolate(flat) stroke: vec4<f32>,
  @location(3) @interpolate(flat) radius: f32,
  @location(4) @interpolate(flat) ring: f32,
};
const C = array<vec2<f32>, 6>(
  vec2<f32>(-1.0,-1.0), vec2<f32>(1.0,-1.0), vec2<f32>(-1.0,1.0),
  vec2<f32>(-1.0, 1.0), vec2<f32>(1.0,-1.0), vec2<f32>( 1.0,1.0));
fn unpack(c: u32) -> vec4<f32> {
  return vec4<f32>(f32(c & 0xffu), f32((c >> 8u) & 0xffu), f32((c >> 16u) & 0xffu), f32((c >> 24u) & 0xffu)) / 255.0;
}
fn degenerate() -> VSOut {
  var o: VSOut;
  o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);   // outside the clip cube → discarded
  o.off = vec2<f32>(0.0); o.fill = vec4<f32>(0.0); o.stroke = vec4<f32>(0.0); o.radius = 0.0; o.ring = 0.0;
  return o;
}
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let p = pos[ii];
  if (p.x == 0.0 && p.y == 0.0) { return degenerate(); }      // no events yet → drop
  let front = onFront[ii] != 0u;
  if (u.frontierPass > 0.5 && !front) { return degenerate(); } // front pass: only frontier dots
  if (u.frontierPass < 0.5 &&  front) { return degenerate(); } // cloud pass: skip frontier dots
  let r    = select(u.radius, u.frontierRadius, front);
  let ring = select(0.0, u.ring, front);
  let ext  = r + ring;
  let px = u.interceptX + u.slopeX * p.x;
  let py = u.interceptY + u.slopeY * p.y;
  let cx = px / u.vpX * 2.0 - 1.0;
  let cy = 1.0 - py / u.vpY * 2.0;            // pixel-down → NDC-up
  let corner = C[vi];
  var o: VSOut;
  o.pos = vec4<f32>(cx + corner.x * ext / u.vpX * 2.0, cy + corner.y * ext / u.vpY * 2.0, 0.0, 1.0);
  o.off = corner * ext;
  o.radius = r; o.ring = ring;
  o.fill = vec4<f32>(unpack(col[ii]).rgb, select(u.alpha, 1.0, front));  // frontier dots are opaque
  o.stroke = vec4<f32>(1.0, 1.0, 1.0, 1.0);                              // white ring
  return o;
}
@fragment
fn fs(i: VSOut) -> @location(0) vec4<f32> {
  let dist = length(i.off);
  let outer = i.radius + i.ring * 0.5;
  let aa = 1.0 - smoothstep(outer - 0.75, outer + 0.75, dist);
  if (aa <= 0.0) { discard; }
  var col: vec4<f32>;
  if (i.ring > 0.0 && dist > i.radius - i.ring * 0.5) { col = i.stroke; }
  else { col = i.fill; }
  return vec4<f32>(col.rgb, col.a * aa);
}`;

// WGSL (render): the GPU staircase line. Vertex-pulls the staircase[] vertices the emit pass
// wrote (in data units), maps them with the SAME slope/intercept as the cloud so the red step
// line sits exactly on the axes, and draws them as a line-strip via drawIndirect — the vertex
// count came from the GPU (emit wrote indirect.vertexCount), never plumbed through JS. Reuses
// the spring-cloud's S uniform (only the first six scale fields matter here).
const WEBGPU_STAIRLINE_WGSL = `
struct S { slopeX: f32, interceptX: f32, slopeY: f32, interceptY: f32, vpX: f32, vpY: f32,
           radius: f32, alpha: f32, frontierRadius: f32, ring: f32, frontierPass: f32, _pad: f32 };
@group(0) @binding(0) var<uniform> u: S;
@group(0) @binding(1) var<storage, read> staircase: array<vec2<f32>>;
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let p = staircase[vi];
  let px = u.interceptX + u.slopeX * p.x;
  let py = u.interceptY + u.slopeY * p.y;
  return vec4<f32>(px / u.vpX * 2.0 - 1.0, 1.0 - py / u.vpY * 2.0, 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.85, 0.12, 0.20, 1.0);   // MLB red — the frontier staircase
}`;

// WebGPURenderer — the experimental ?renderer=webgpu backend (a learning/headroom
// track; never the default, gated so it can never regress production). Implements the
// same PointRenderer surface as Canvas2DRenderer but accumulates each draw* call into a
// resident GPU instance buffer and submits ONE render pass in present(). One <canvas> +
// one offscreen texture; the frontier staircase, axes, labels all stay SVG. See
// docs/webgpu-main-app-integration-design.md §"Phase 3".
class WebGPURenderer {
    constructor(device, adapter) {
        this.device = device;
        this.adapter = adapter;            // retained: headless Dawn GCs the instance otherwise
        this.canvas = null;
        this.ctx = null;
        this.canvasOk = true;
        this.layers = null;                // { width, height, dpr } — mirrors the 2D shape for the bgKey
        this.bgCacheKey = null;
        this.offTex = null; this.offW = 0; this.offH = 0;
        this.format = navigator.gpu.getPreferredCanvasFormat();
        // resident instance buffers + counts (grown on demand)
        this.buf = { bg: null, fg: null, frontier: null, trail: null };
        this.count = { bg: 0, fg: 0, frontier: 0, trail: 0 };
        this._scratch = new ArrayBuffer(0);
        // GPU compute-accumulate state (the .evt-career scaling path). null until the
        // first eligible frame uploads the event stream via uploadEvtStream(); see the
        // WEBGPU_ACCUM_WGSL / WEBGPU_EVTCLOUD_WGSL block above for the why.
        this.evt = null;
        // Phase-5 gpuStreaming engine: ?renderer=webgpu&gpustream=1 turns the hybrid
        // Phase-4 cloud into the FULL-GPU pipeline (spring + skyline + GPU staircase).
        // Without the flag this stays the shipped Phase-4 hybrid. Explicit, opt-in, never
        // the default. See docs/webgpu-main-app-integration-design.md §"Phase 5".
        this.springMode = new URLSearchParams(location.search).has("gpustream");
        this.lastSpringT = 0;   // wall-clock of the previous spring frame (for dt)
    }
    get dpr() { return this.layers?.dpr || 1; }
    get bgCanvas() { return this.canvas; }   // truthy → drawScatterPlot's fg-gated blocks run
    get fgCanvas() { return this.canvas; }

    async init() {
        const dev = this.device;
        this.uViewport = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const bgl = dev.createBindGroupLayout({ entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        ] });
        this.bgl = bgl;
        const layout = dev.createPipelineLayout({ bindGroupLayouts: [bgl] });
        // Alpha blending so overlapping dots accumulate like the Canvas-2D cloud. The
        // colour channels use straight src-over (src·a + dst·(1−a)); the ALPHA channel
        // uses one·(1−a) so the result is correctly PREMULTIPLIED — which is what the
        // canvas context expects (alphaMode "premultiplied" in resize()). Shared by every
        // render pipeline below (points, lines, the evt cloud) so they composite uniformly.
        const blend = {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        };
        const ptMod = dev.createShaderModule({ code: WEBGPU_POINTS_WGSL });
        const lnMod = dev.createShaderModule({ code: WEBGPU_LINE_WGSL });
        this.pPoints = dev.createRenderPipeline({ layout,
            vertex: { module: ptMod, entryPoint: "vs" },
            fragment: { module: ptMod, entryPoint: "fs", targets: [{ format: this.format, blend }] },
            primitive: { topology: "triangle-list" } });
        this.pLine = dev.createRenderPipeline({ layout,
            vertex: { module: lnMod, entryPoint: "vs" },
            fragment: { module: lnMod, entryPoint: "fs", targets: [{ format: this.format, blend }] },
            primitive: { topology: "triangle-list" } });

        // GPU compute-accumulate pipelines (the .evt-career path). Two more pipelines,
        // each with its OWN bind-group layout because they bind different buffers:
        //
        //  • pAccum (COMPUTE): {uWin uniform, events ro-storage, xcount rw-storage,
        //    ycount rw-storage}. read_write storage in WGSL ⇒ buffer type "storage";
        //    read-only ⇒ "read-only-storage". This is the only place we declare a
        //    compute stage, so it needs its own layout (the point/line pipelines are
        //    vertex+fragment only).
        const accumBgl = dev.createBindGroupLayout({ entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ] });
        this.accumBgl = accumBgl;
        const accumMod = dev.createShaderModule({ code: WEBGPU_ACCUM_WGSL });
        this.pAccum = dev.createComputePipeline({
            layout: dev.createPipelineLayout({ bindGroupLayouts: [accumBgl] }),
            compute: { module: accumMod, entryPoint: "main" } });

        //  • pCloud (VERTEX-pull render): {uScale uniform, xcount ro-storage, ycount
        //    ro-storage, col ro-storage}. The compute pass writes xcount/ycount; here we
        //    READ them (read-only-storage) — the same physical buffers, different access.
        const cloudBgl = dev.createBindGroupLayout({ entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        ] });
        this.cloudBgl = cloudBgl;
        const cloudMod = dev.createShaderModule({ code: WEBGPU_EVTCLOUD_WGSL });
        this.pCloud = dev.createRenderPipeline({
            layout: dev.createPipelineLayout({ bindGroupLayouts: [cloudBgl] }),
            vertex: { module: cloudMod, entryPoint: "vs" },
            fragment: { module: cloudMod, entryPoint: "fs", targets: [{ format: this.format, blend }] },
            primitive: { topology: "triangle-list" } });

        // ── Phase-5 gpuStreaming pipelines (only built when ?gpustream=1) ──────────
        // Skipped entirely in the shipped Phase-4 hybrid so it carries zero extra cost.
        if (this.springMode) this._initSpring(dev, blend);

        // clear colour = the chart background (transparent so the page/SVG shows through;
        // dots blend over it). Premultiplied alpha mode → clear to 0.
        this.clearValue = { r: 0, g: 0, b: 0, a: 0 };
    }

    // Build the full-GPU streaming pipelines: spring + skyline (compute), the 3-entry-point
    // GPU staircase (compute), the spring cloud + staircase line (render). Each compute pass
    // gets its own bind-group layout (it binds different buffers); the staircase's three
    // entry points SHARE one superset layout (a pass using a subset of the bindings is legal).
    _initSpring(dev, blend) {
        const C = GPUShaderStage.COMPUTE, V = GPUShaderStage.VERTEX;
        const ro = (b, vis) => ({ binding: b, visibility: vis, buffer: { type: "read-only-storage" } });
        const rw = (b, vis) => ({ binding: b, visibility: vis, buffer: { type: "storage" } });
        const un = (b, vis) => ({ binding: b, visibility: vis, buffer: { type: "uniform" } });
        const mkPipe = (code, layout, entry) => dev.createComputePipeline({
            layout: dev.createPipelineLayout({ bindGroupLayouts: [layout] }),
            compute: { module: dev.createShaderModule({ code }), entryPoint: entry } });

        // spring: {uSpring, hr ro, sb ro, pos rw, vel rw}
        this.springBgl = dev.createBindGroupLayout({ entries: [
            un(0, C), ro(1, C), ro(2, C), rw(3, C), rw(4, C) ] });
        this.pSpring = mkPipe(WEBGPU_SPRING_WGSL, this.springBgl, "main");
        // skyline: {uSpring, onFront rw, pos ro}
        this.skylineBgl = dev.createBindGroupLayout({ entries: [ un(0, C), rw(1, C), ro(2, C) ] });
        this.pSkyline = mkPipe(WEBGPU_SKYLINE_WGSL, this.skylineBgl, "main");
        // staircase (shared layout for compact/ranksort/emit):
        //   {uSpring, onFront ro, pos ro, frontIdx rw, frontSorted rw, count rw, staircase rw, indirect rw}
        this.stairBgl = dev.createBindGroupLayout({ entries: [
            un(0, C), ro(1, C), ro(2, C), rw(3, C), rw(4, C), rw(5, C), rw(6, C), rw(7, C) ] });
        const stairLayout = dev.createPipelineLayout({ bindGroupLayouts: [this.stairBgl] });
        const stairMod = dev.createShaderModule({ code: WEBGPU_STAIRCASE_WGSL });
        const mkStair = (entry) => dev.createComputePipeline({ layout: stairLayout, compute: { module: stairMod, entryPoint: entry } });
        this.pStairCompact = mkStair("compact");
        this.pStairRanksort = mkStair("ranksort");
        this.pStairEmit = mkStair("emit");
        // spring cloud (render): {uSpringScale, pos ro, col ro, onFront ro}
        this.springCloudBgl = dev.createBindGroupLayout({ entries: [
            un(0, V), ro(1, V), ro(2, V), ro(3, V) ] });
        this.pSpringCloud = dev.createRenderPipeline({
            layout: dev.createPipelineLayout({ bindGroupLayouts: [this.springCloudBgl] }),
            vertex: { module: dev.createShaderModule({ code: WEBGPU_SPRINGCLOUD_WGSL }), entryPoint: "vs" },
            fragment: { module: dev.createShaderModule({ code: WEBGPU_SPRINGCLOUD_WGSL }), entryPoint: "fs", targets: [{ format: this.format, blend }] },
            primitive: { topology: "triangle-list" } });
        // staircase line (render, line-strip via drawIndirect): {uSpringScale, staircase ro}
        this.stairLineBgl = dev.createBindGroupLayout({ entries: [ un(0, V), ro(1, V) ] });
        this.pStairLine = dev.createRenderPipeline({
            layout: dev.createPipelineLayout({ bindGroupLayouts: [this.stairLineBgl] }),
            vertex: { module: dev.createShaderModule({ code: WEBGPU_STAIRLINE_WGSL }), entryPoint: "vs" },
            fragment: { module: dev.createShaderModule({ code: WEBGPU_STAIRLINE_WGSL }), entryPoint: "fs", targets: [{ format: this.format, blend }] },
            primitive: { topology: "line-strip" } });
    }

    // Lazily create + size the single canvas (same .plot-canvas slot as the 2D layers)
    // and the offscreen render target. Never configures the canvas under headless.
    resize(width, height) {
        const region = document.querySelector(".chart-region");
        const svg = document.getElementById("scatter-plot");
        if (!region || !svg) return null;
        if (!this.canvas) {
            const c = document.createElement("canvas");
            c.className = "plot-canvas plot-canvas--webgpu";
            c.setAttribute("aria-hidden", "true");
            region.insertBefore(c, svg);
            this.canvas = c;
            this.canvasOk = !navigator.webdriver && !/HeadlessChrome/i.test(navigator.userAgent);
            if (this.canvasOk) {
                try {
                    this.ctx = c.getContext("webgpu");
                    this.ctx.configure({ device: this.device, format: this.format, alphaMode: "premultiplied",
                        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST });
                } catch (e) { this.canvasOk = false; console.warn("[webgpu] canvas configure failed (offscreen-only):", e.message); }
            }
        }
        const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
        const bw = Math.max(1, Math.round(width * dpr)), bh = Math.max(1, Math.round(height * dpr));
        if (this.canvas.width !== bw || this.canvas.height !== bh) { this.canvas.width = bw; this.canvas.height = bh; }
        this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
        if (bw !== this.offW || bh !== this.offH) {
            this.offTex?.destroy();
            this.offTex = this.device.createTexture({ size: [bw, bh], format: this.format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
            this.offW = bw; this.offH = bh;
        }
        // NDC mapping uses CSS px (dpr only sets texture resolution).
        this.device.queue.writeBuffer(this.uViewport, 0, new Float32Array([width, height, 0, 0]));
        this.layers = { width, height, dpr };
        return this.layers;
    }

    // Flatten point objects + the opts callbacks into the named instance buffer (24-byte
    // records) and upload. radiusForName picks radius vs radiusFor; ringFor yields the
    // white-ring width. Returns nothing; present() reads this.count.
    _uploadPoints(name, points, opts) {
        const { margin, xScale, yScale } = opts;
        const radius = opts.radius, radiusFor = opts.radiusFor;
        const fillFor = opts.fillFor, alphaFor = opts.alphaFor, alpha = opts.alpha ?? 1;
        const strokeFor = opts.strokeFor, strokeWidth = opts.strokeWidth || 0;
        const n = points ? points.length : 0;
        const need = Math.max(1, n) * 24;
        if (this._scratch.byteLength < need) this._scratch = new ArrayBuffer(need);
        const dv = new DataView(this._scratch);
        let w = 0;
        for (let k = 0; k < n; k++) {
            const d = points[k];
            const px = margin.left + xScale(d.x), py = margin.top + yScale(d.y);
            if (!isFinite(px) || !isFinite(py)) continue;
            const r = radiusFor ? radiusFor(d) : (typeof radius === "function" ? radius(d) : radius);
            const stroke = strokeFor ? strokeFor(d) : null;
            const ring = stroke ? strokeWidth : 0;
            const a = alphaFor ? alphaFor(d) : alpha;
            dv.setFloat32(w, px, true); dv.setFloat32(w + 4, py, true);
            dv.setFloat32(w + 8, r, true); dv.setFloat32(w + 12, ring, true);
            dv.setUint32(w + 16, packColorRGBA(fillFor(d), a), true);
            dv.setUint32(w + 20, packColorRGBA(stroke || "#ffffff", 1), true);
            w += 24;
        }
        this.count[name] = w / 24;
        this.buf[name] = this._ensureBuffer(this.buf[name], w);
        if (w > 0) this.device.queue.writeBuffer(this.buf[name], 0, this._scratch, 0, w);
    }

    _ensureBuffer(buf, bytes) {
        const size = Math.max(256, (bytes + 255) & ~255);
        if (buf && buf.size >= size) return buf;
        buf?.destroy();
        return this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }

    drawBackground(points, opts) { this._uploadPoints("bg", points, opts); }
    drawForeground(points, opts) { this._uploadPoints("fg", points, opts); }
    drawFrontierDots(points, opts) {
        // strokeFor/strokeWidth come through as strokeColor/strokeWidth here; normalise.
        this._uploadPoints("frontier", points, { ...opts, strokeFor: () => opts.strokeColor || "#ffffff", strokeWidth: opts.strokeWidth ?? 1.5 });
    }

    drawTrails(trails, opts) {
        const { margin, xScale, yScale, width = 2 } = opts;
        // count segments
        let segs = 0;
        for (const t of trails) { const p = t.points; if (p && p.length >= 2) segs += p.length - 1; }
        const need = Math.max(1, segs) * 24;
        if (this._scratch.byteLength < need) this._scratch = new ArrayBuffer(need);
        const dv = new DataView(this._scratch);
        let w = 0;
        for (const { color, points } of trails) {
            if (!points || points.length < 2) continue;
            const m = points.length;
            for (let i = 1; i < m; i++) {
                const a = points[i - 1], b = points[i];
                const ax = margin.left + xScale(a.x), ay = margin.top + yScale(a.y);
                const bx = margin.left + xScale(b.x), by = margin.top + yScale(b.y);
                if (![ax, ay, bx, by].every(isFinite)) continue;
                dv.setFloat32(w, ax, true); dv.setFloat32(w + 4, ay, true);
                dv.setFloat32(w + 8, bx, true); dv.setFloat32(w + 12, by, true);
                dv.setFloat32(w + 16, width, true);
                dv.setUint32(w + 20, packColorRGBA(color, (i / (m - 1)) * 0.85), true);
                w += 24;
            }
        }
        this.count.trail = w / 24;
        this.buf.trail = this._ensureBuffer(this.buf.trail, w);
        if (w > 0) this.device.queue.writeBuffer(this.buf.trail, 0, this._scratch, 0, w);
    }

    clear() {
        this.count.bg = this.count.fg = this.count.frontier = this.count.trail = 0;
        this.bgCacheKey = null;
        this.present();
    }

    _bindGroup(buffer) {
        return this.device.createBindGroup({ layout: this.bgl, entries: [
            { binding: 0, resource: { buffer: this.uViewport } },
            { binding: 1, resource: { buffer: buffer || this.uViewport } },
        ] });
    }

    // ── GPU compute-accumulate (the .evt-career cloud) ──────────────────────────
    // Upload the flat, date-sorted event stream + the per-player era colours ONCE per
    // model, and allocate the per-player running-total buffers. Idempotent: re-uploads
    // only when the model identity (axes / player count / stream length) changes, so the
    // first eligible frame pays the cost and every later frame is just a uniform write +
    // a compute dispatch. Returns false (→ caller falls back to the CPU cloud) if the
    // stream isn't the single-counter-per-axis shape this GPU path requires.
    uploadEvtStream(model) {
        const dev = this.device;
        const stream = model.evStream || buildEvtEventStream(model);
        const players = model.players.length;
        // Discover the per-component axis coefficients (handles single-component HR/SB and
        // monotone composites like TB). false ⇒ not GPU-accumulable (rate stat / negative
        // coefficient) → caller falls back to the CPU cloud.
        const mono = evtGpuMonotone(model);
        if (!mono.ok) return false;
        const cx = mono.cx, cy = mono.cy;
        const token = `${model.xDim}|${model.yDim}|${players}|${stream.n}`;
        if (this.evt && this.evt.token === token) { this._refreshEvtColors(model); return true; }
        try {
            this._destroyEvt();
            const BU = GPUBufferUsage;
            // events: {player, xAdd, yAdd} ×3 u32 per stream row. The CPU bakes the axis
            // coefficient in here (xAdd = cx[dep]·delta), so each event already carries its
            // X- and Y-axis deltas — usually one is 0 (the component belongs to one axis).
            // Deltas are ≥ 0 for counting components, so the u32 cast is lossless.
            const ev = new Uint32Array(stream.n * 3);
            const { player, dep, delta } = stream;
            for (let i = 0; i < stream.n; i++) {
                const d = dep[i], dl = delta[i];
                ev[i * 3] = player[i];
                ev[i * 3 + 1] = (cx[d] * dl) >>> 0;
                ev[i * 3 + 2] = (cy[d] * dl) >>> 0;
            }
            const bEvents = dev.createBuffer({ size: Math.max(16, ev.byteLength), usage: BU.STORAGE | BU.COPY_DST });
            dev.queue.writeBuffer(bEvents, 0, ev);
            // per-player running totals. COPY_SRC so __bl2d_gpuCounters can read them back
            // for the counterMis invariant check.
            const pbytes = Math.max(16, players * 4);
            const mkCounter = () => dev.createBuffer({ size: pbytes, usage: BU.STORAGE | BU.COPY_DST | BU.COPY_SRC });
            const bX = mkCounter(), bY = mkCounter();
            const bColor = dev.createBuffer({ size: pbytes, usage: BU.STORAGE | BU.COPY_DST });
            // small per-frame uniforms: the event window, and the axis scale + viewport.
            const uWin = dev.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
            const uScale = dev.createBuffer({ size: 32, usage: BU.UNIFORM | BU.COPY_DST });
            const bgAccum = dev.createBindGroup({ layout: this.accumBgl, entries: [
                { binding: 0, resource: { buffer: uWin } }, { binding: 1, resource: { buffer: bEvents } },
                { binding: 2, resource: { buffer: bX } }, { binding: 3, resource: { buffer: bY } } ] });
            const bgCloud = dev.createBindGroup({ layout: this.cloudBgl, entries: [
                { binding: 0, resource: { buffer: uScale } }, { binding: 1, resource: { buffer: bX } },
                { binding: 2, resource: { buffer: bY } }, { binding: 3, resource: { buffer: bColor } } ] });
            // debut year per player → packed era colour (rebuilt on a theme change).
            const debut = new Uint32Array(players);
            for (let i = 0; i < players; i++) debut[i] = model.players[i].debutYear | 0;
            this.evt = { token, players, streamN: stream.n,
                bEvents, bX, bY, bColor, uWin, uScale, bgAccum, bgCloud,
                debut, colorTheme: null, zeros: new Uint32Array(players),
                gpuApplied: null,   // how many stream events the counters reflect (null = none yet)
                pending: null, failed: false, spring: null };
            if (this.springMode) this._initSpringBuffers(model, players);
            this._refreshEvtColors(model);
            return true;
        } catch (e) {
            console.warn("[webgpu] evt stream upload failed → CPU cloud:", e.message);
            this._destroyEvt();
            return false;
        }
    }

    // Allocate the Phase-5 full-GPU buffers + bind groups (only under ?gpustream=1). The
    // spring TARGET is the Phase-4 counters bX/bY (bound here read-only); pos/vel are the
    // smoothed motion state; onFront + the staircase scratch hold the GPU frontier. All are
    // GPU-resident — nothing here re-uploads per frame; the live loop only writes the tiny
    // uSpring/uSpringScale uniforms (see springStep/present).
    _initSpringBuffers(model, players) {
        const dev = this.device, BU = GPUBufferUsage;
        const e = this.evt;
        const pos2 = Math.max(16, players * 8);                 // vec2<f32> per player
        const stor = BU.STORAGE | BU.COPY_DST;
        const bPos = dev.createBuffer({ size: pos2, usage: stor | BU.COPY_SRC });   // COPY_SRC: verify readback
        const bVel = dev.createBuffer({ size: pos2, usage: stor });
        const bOnFront = dev.createBuffer({ size: Math.max(16, players * 4), usage: stor | BU.COPY_SRC });
        // GPU-staircase scratch (frontier size bounded by WEBGPU_MAX_FRONT).
        const MF = WEBGPU_MAX_FRONT;
        const bFrontIdx = dev.createBuffer({ size: MF * 4, usage: stor });
        const bFrontSorted = dev.createBuffer({ size: MF * 8, usage: stor });
        const bCount = dev.createBuffer({ size: 16, usage: stor | BU.COPY_SRC });    // atomic K (reset each frame; COPY_SRC for verify)
        const bStaircase = dev.createBuffer({ size: (1 + 2 * MF) * 8, usage: stor | BU.COPY_SRC });
        const bIndirect = dev.createBuffer({ size: 16, usage: BU.INDIRECT | BU.STORAGE | BU.COPY_DST | BU.COPY_SRC });
        // small per-frame uniforms (the only things that cross the bus each frame).
        const uSpring = dev.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
        const uSpringScale0 = dev.createBuffer({ size: 48, usage: BU.UNIFORM | BU.COPY_DST });
        const uSpringScale1 = dev.createBuffer({ size: 48, usage: BU.UNIFORM | BU.COPY_DST });
        const bg = (layout, buffers) => dev.createBindGroup({ layout,
            entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
        e.spring = {
            bPos, bVel, bOnFront, bFrontIdx, bFrontSorted, bCount, bStaircase, bIndirect,
            uSpring, uSpringScale0, uSpringScale1,
            zerosVec2: new Float32Array(players * 2),
            bgSpring:       bg(this.springBgl,      [uSpring, e.bX, e.bY, bPos, bVel]),
            bgSkyline:      bg(this.skylineBgl,     [uSpring, bOnFront, bPos]),
            bgStair:        bg(this.stairBgl,       [uSpring, bOnFront, bPos, bFrontIdx, bFrontSorted, bCount, bStaircase, bIndirect]),
            bgSpringCloud0: bg(this.springCloudBgl, [uSpringScale0, bPos, e.bColor, bOnFront]),
            bgSpringCloud1: bg(this.springCloudBgl, [uSpringScale1, bPos, e.bColor, bOnFront]),
            bgStairLine:    bg(this.stairLineBgl,   [uSpringScale0, bStaircase]),
        };
    }

    // Pack each player's era colour into the col[] buffer. Era colours are per-theme
    // (eraFor reads the live ramp), so re-pack whenever the document theme changes —
    // cheap, and far simpler/more exact than re-deriving the banded ramp in WGSL.
    _refreshEvtColors(model) {
        const e = this.evt; if (!e) return;
        const theme = document.documentElement.dataset.theme || "";
        if (e.colorTheme === theme) return;
        const col = new Uint32Array(e.players);
        for (let i = 0; i < e.players; i++) col[i] = packColorRGBA((eraFor(e.debut[i]) || { color: "#4a6fa5" }).color, 1);
        this.device.queue.writeBuffer(e.bColor, 0, col);
        e.colorTheme = theme;
    }

    // Queue this frame's GPU cloud: figure out the catch-up window, write the uniforms,
    // and stash the dispatch params for present() to run inside the single per-frame
    // command encoder.
    //
    // Why the GPU tracks its OWN cursor (gpuApplied) rather than using the engine's
    // per-frame {lo,count}: the JS incremental frontier consumes event windows on EVERY
    // refresh (lite or not), but the GPU only accumulates on the lite playback frames the
    // gate allows. So the GPU can fall "behind" the engine's `applied` count. Each GPU
    // frame therefore replays exactly the events the engine has consumed but the GPU
    // hasn't: [gpuApplied, applied). `win` = { applied, zero } from the engine — `applied`
    // is its total consumed-event count, `zero` means it restarted from 0 this frame (new
    // model / backward seek), in which case the GPU zeroes its counters and replays
    // [0, applied) too. This keeps GPU counters == the JS shadow regardless of how many
    // non-lite frames slipped between GPU frames.
    accumulateCloud({ win, instanceCount, scales }) {
        const e = this.evt;
        if (!e || e.failed) return;
        const dev = this.device;
        const target = win.applied >>> 0;
        let lo, count;
        const didZero = win.zero || e.gpuApplied == null || e.gpuApplied > target;
        if (didZero) {
            dev.queue.writeBuffer(e.bX, 0, e.zeros);   // restart the running sums at 0
            dev.queue.writeBuffer(e.bY, 0, e.zeros);
            lo = 0; count = target;
        } else {
            lo = e.gpuApplied; count = target - e.gpuApplied;
        }
        e.gpuApplied = target;
        dev.queue.writeBuffer(e.uWin, 0, new Uint32Array([lo, count, 0, 0]));
        dev.queue.writeBuffer(e.uScale, 0, new Float32Array([
            scales.slopeX, scales.interceptX, scales.slopeY, scales.interceptY,
            scales.vpX, scales.vpY, scales.radius, scales.alpha ]));
        e.pending = { count, instanceCount, spring: false };
        e.lastInstanceCount = instanceCount;   // cached so presentGlide can re-present without a refreshChart
        // ── Phase-5: queue the spring/skyline/staircase uniforms for this frame ──────
        // Only the tiny uniforms cross the bus here (dt/omega + the axis scale). On a
        // wrap/backward-seek we ALSO zero pos/vel so the cloud snaps back to the origin
        // for a clean replay. The staircase scratch (count, indirect) is reset every
        // frame so a frame with K==0 draws nothing.
        if (this.springMode && e.spring) {
            const s = e.spring;
            const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
            let dt = this.lastSpringT ? (now - this.lastSpringT) / 1000 : 1 / 60;
            this.lastSpringT = now;
            if (!isFinite(dt) || dt <= 0) dt = 1 / 60;
            dt = Math.min(dt, 0.05);                    // clamp a stall/tab-switch spike
            if (didZero) {
                dev.queue.writeBuffer(s.bPos, 0, s.zerosVec2);
                dev.queue.writeBuffer(s.bVel, 0, s.zerosVec2);
            }
            dev.queue.writeBuffer(s.bCount, 0, new Uint32Array([0]));
            dev.queue.writeBuffer(s.bIndirect, 0, new Uint32Array([0, 1, 0, 0]));
            const uSpring = new ArrayBuffer(16);
            new Float32Array(uSpring, 0, 2).set([dt, WEBGPU_SPRING_OMEGA]);
            new Uint32Array(uSpring, 8, 2).set([e.players, 0]);
            dev.queue.writeBuffer(s.uSpring, 0, uSpring);
            // The frontier dots inherit the cloud's era colour but are drawn bigger + ringed.
            const fr = Math.max((scales.radius || 2.5) + 3, 6), ring = 1.5;
            const base = [scales.slopeX, scales.interceptX, scales.slopeY, scales.interceptY,
                scales.vpX, scales.vpY, scales.radius, scales.alpha, fr, ring];
            dev.queue.writeBuffer(s.uSpringScale0, 0, new Float32Array([...base, 0, 0]));  // cloud pass
            dev.queue.writeBuffer(s.uSpringScale1, 0, new Float32Array([...base, 1, 0]));  // frontier pass
            e.pending.spring = true;
        }
    }

    // Read the per-player counters back to the CPU (buffer→buffer copy → MAP_READ). Used
    // by the __bl2d_gpuCounters invariant probe. NOTE: buffer-to-buffer copies have NO
    // row-alignment rule — unlike the texture readback in exportDataURLs(), which must
    // round bytesPerRow up to 256. Returns { x, y } as Uint32Arrays of length players.
    async readbackCounters() {
        const e = this.evt; if (!e) return null;
        const bytes = e.players * 4;
        const stage = (n) => this.device.createBuffer({ size: Math.max(16, n), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const sx = stage(bytes), sy = stage(bytes);
        const enc = this.device.createCommandEncoder();
        enc.copyBufferToBuffer(e.bX, 0, sx, 0, bytes);
        enc.copyBufferToBuffer(e.bY, 0, sy, 0, bytes);
        this.device.queue.submit([enc.finish()]);
        await Promise.all([sx.mapAsync(GPUMapMode.READ), sy.mapAsync(GPUMapMode.READ)]);
        const x = new Uint32Array(sx.getMappedRange().slice(0, bytes));
        const y = new Uint32Array(sy.getMappedRange().slice(0, bytes));
        sx.unmap(); sy.unmap(); sx.destroy(); sy.destroy();
        return { x, y, players: e.players };
    }

    // Generic one-shot buffer→CPU readbacks (verify hooks ONLY — never the render loop).
    async _readback(buf, byteLen, Ctor) {
        const st = this.device.createBuffer({ size: Math.max(16, byteLen), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const enc = this.device.createCommandEncoder();
        enc.copyBufferToBuffer(buf, 0, st, 0, byteLen);
        this.device.queue.submit([enc.finish()]);
        await st.mapAsync(GPUMapMode.READ);
        const out = new Ctor(st.getMappedRange().slice(0, byteLen));
        st.unmap(); st.destroy();
        return out;
    }

    // ── Phase-5 verification (the gpuStreaming oracle; one-shot, never in renderAt) ──────
    // Mirrors poc-webgpu-spring's verify_career. Drives the GPU to END-OF-HISTORY and settles
    // the springs in ONE huge-Δt step (e≈0 ⇒ pos snaps to the integer target — the gliding is a
    // live-only effect, the END state is what's verified), runs the GPU skyline + staircase, then
    // reads pos/onFront/counters back ONCE and compares to a CPU brute-force Pareto over the
    // integer counters (same strict tie-break as the shader). Returns the two invariants:
    //   springMis  — settled pos != integer counter (±0.5) ⇒ the spring integrator diverged.
    //   skylineMis — GPU onFront != CPU brute-force ⇒ the GPU frontier kernel is wrong.
    async verifySpring() {
        const e = this.evt, s = e && e.spring;
        if (!e || !s) return null;
        const dev = this.device, n = e.players;
        // 1. one dedicated encoder: zero state, accumulate ALL events, settle, skyline, staircase.
        dev.queue.writeBuffer(e.bX, 0, e.zeros);
        dev.queue.writeBuffer(e.bY, 0, e.zeros);
        dev.queue.writeBuffer(s.bPos, 0, s.zerosVec2);
        dev.queue.writeBuffer(s.bVel, 0, s.zerosVec2);
        dev.queue.writeBuffer(s.bCount, 0, new Uint32Array([0]));
        dev.queue.writeBuffer(s.bIndirect, 0, new Uint32Array([0, 1, 0, 0]));
        dev.queue.writeBuffer(e.uWin, 0, new Uint32Array([0, e.streamN, 0, 0]));
        const us = new ArrayBuffer(16);
        new Float32Array(us, 0, 2).set([1000, WEBGPU_SPRING_OMEGA]);   // huge dt ⇒ pos snaps to target
        new Uint32Array(us, 8, 2).set([n, 0]);
        dev.queue.writeBuffer(s.uSpring, 0, us);
        const enc = dev.createCommandEncoder();
        const pass = (pipe, bg, wg) => { const cp = enc.beginComputePass(); cp.setPipeline(pipe); cp.setBindGroup(0, bg); cp.dispatchWorkgroups(wg); cp.end(); };
        pass(this.pAccum, e.bgAccum, Math.ceil(e.streamN / 64));
        const wgN = Math.ceil(n / 64), wgK = Math.ceil(WEBGPU_MAX_FRONT / 64);
        pass(this.pSpring, s.bgSpring, wgN);
        pass(this.pSkyline, s.bgSkyline, wgN);
        pass(this.pStairCompact, s.bgStair, wgN);
        pass(this.pStairRanksort, s.bgStair, wgK);
        pass(this.pStairEmit, s.bgStair, wgK);
        dev.queue.submit([enc.finish()]);
        e.gpuApplied = e.streamN;   // keep live bookkeeping consistent after the forced accumulate
        // 2. read back once.
        const x = await this._readback(e.bX, n * 4, Uint32Array);
        const y = await this._readback(e.bY, n * 4, Uint32Array);
        const pos = await this._readback(s.bPos, n * 8, Float32Array);
        const onFront = await this._readback(s.bOnFront, n * 4, Uint32Array);
        // 3. spring convergence + 4. skyline vs CPU brute force.
        let springMis = 0, skylineMis = 0, frontierSize = 0, maxX = 0, maxY = 0;
        for (let i = 0; i < n; i++) { if (x[i] > maxX) maxX = x[i]; if (y[i] > maxY) maxY = y[i]; }
        for (let i = 0; i < n; i++) {
            if (Math.abs(pos[i * 2] - x[i]) > 0.5 || Math.abs(pos[i * 2 + 1] - y[i]) > 0.5) springMis++;
            const xi = x[i], yi = y[i];
            let dom = (xi === 0 && yi === 0) ? 1 : 0;     // origin players are off-front (match the shader)
            if (!dom) for (let j = 0; j < n; j++) { if (x[j] >= xi && y[j] >= yi && (x[j] > xi || y[j] > yi)) { dom = 1; break; } }
            const cpuFront = dom ? 0 : 1;
            if ((onFront[i] ? 1 : 0) !== cpuFront) skylineMis++;
            if (cpuFront) frontierSize++;
        }
        return { springMis, skylineMis, frontierSize, maxX, maxY, x, y, pos, onFront, players: n };
    }

    _destroyEvt() {
        const e = this.evt; if (!e) return;
        for (const k of ["bEvents", "bX", "bY", "bColor", "uWin", "uScale"]) e[k]?.destroy();
        if (e.spring) {
            for (const k of ["bPos", "bVel", "bOnFront", "bFrontIdx", "bFrontSorted", "bCount",
                "bStaircase", "bIndirect", "uSpring", "uSpringScale0", "uSpringScale1"]) e.spring[k]?.destroy();
        }
        this.evt = null;
    }

    // One render pass: clear → completed cloud → [GPU-accumulated cloud] → trails →
    // open cloud + heads → frontier dots (the Canvas-2D layer order), into the offscreen
    // texture, then blit to canvas. When a GPU cloud is pending, its compute pass runs
    // first (in the SAME encoder) so the counters are current before the cloud draw.
    present() {
        if (!this.offTex) return;
        const enc = this.device.createCommandEncoder();
        const evt = this.evt;
        const gpuCloud = evt && evt.pending && !evt.failed;
        // Compute pass FIRST (a separate pass before the render pass): accumulate this
        // frame's new events into the per-player counters. ceil(count/64) workgroups,
        // 64 threads each (one per event). Skipped when count is 0 (a paused/idle frame
        // that still re-presents the existing counters).
        if (gpuCloud && evt.pending.count > 0) {
            try {
                const cp = enc.beginComputePass();
                cp.setPipeline(this.pAccum);
                cp.setBindGroup(0, evt.bgAccum);
                cp.dispatchWorkgroups(Math.ceil(evt.pending.count / 64));
                cp.end();
            } catch (e2) { evt.failed = true; console.warn("[webgpu] accumulate pass failed → CPU cloud:", e2.message); }
        }
        // ── Phase-5 compute passes (the gpuStreaming frame graph) ───────────────────
        // Run EVERY gpu frame (even count==0) so points keep gliding and the frontier
        // updates. Separate compute passes in one encoder serialize, so spring sees the
        // accumulate writes, skyline sees spring's pos, and the staircase passes chain
        // compact→ranksort→emit. ranksort/emit over-dispatch to MAX_FRONT and self-guard
        // against the GPU-side K (the host can't know K without a readback).
        const springOn = gpuCloud && !evt.failed && evt.pending.spring && evt.spring;
        if (springOn) {
            try {
                const s = evt.spring;
                const wgN = Math.ceil(evt.players / 64), wgK = Math.ceil(WEBGPU_MAX_FRONT / 64);
                const pass = (pipe, bg, wg) => { const cp = enc.beginComputePass(); cp.setPipeline(pipe); cp.setBindGroup(0, bg); cp.dispatchWorkgroups(wg); cp.end(); };
                pass(this.pSpring, s.bgSpring, wgN);          // glide pos toward the counters
                pass(this.pSkyline, s.bgSkyline, wgN);        // onFront = GPU Pareto frontier
                pass(this.pStairCompact, s.bgStair, wgN);     // gather on-front ids
                pass(this.pStairRanksort, s.bgStair, wgK);    // rank-sort by x
                pass(this.pStairEmit, s.bgStair, wgK);        // emit step verts + indirect count
            } catch (e3) { evt.failed = true; console.warn("[webgpu] spring passes failed → CPU cloud:", e3.message); }
        }
        const rp = enc.beginRenderPass({ colorAttachments: [{
            view: this.offTex.createView(), clearValue: this.clearValue, loadOp: "clear", storeOp: "store" }] });
        const drawPts = (name) => { if (this.count[name] > 0) { rp.setBindGroup(0, this._bindGroup(this.buf[name])); rp.draw(6, this.count[name]); } };
        rp.setPipeline(this.pPoints); drawPts("bg");
        // The cloud sits at the background layer (behind trails, heads, frontier dots).
        // Phase-5 spring path: vertex-pull the SMOOTHED pos[] (pass 0 = non-front cloud);
        // the frontier dots (pass 1) + the GPU staircase are drawn LAST, on top. Phase-4
        // hybrid path: the original counter-pull cloud.
        if (springOn && evt.pending.instanceCount > 0) {
            rp.setPipeline(this.pSpringCloud);
            rp.setBindGroup(0, evt.spring.bgSpringCloud0);
            rp.draw(6, evt.pending.instanceCount);
            rp.setPipeline(this.pPoints);
        } else if (gpuCloud && !evt.failed && evt.pending.instanceCount > 0) {
            rp.setPipeline(this.pCloud);
            rp.setBindGroup(0, evt.bgCloud);
            rp.draw(6, evt.pending.instanceCount);
            rp.setPipeline(this.pPoints);
        }
        if (this.count.trail > 0) { rp.setPipeline(this.pLine); rp.setBindGroup(0, this._bindGroup(this.buf.trail)); rp.draw(6, this.count.trail); rp.setPipeline(this.pPoints); }
        drawPts("fg");
        drawPts("frontier");   // Phase-4 hybrid frontier dots (no-op in spring mode — GPU owns them)
        // Phase-5: frontier dots (pass 1, front-only) + the red staircase via drawIndirect,
        // both on top of the cloud/heads. The staircase's vertex count was written by the
        // GPU emit pass into bIndirect — it never round-tripped through JS.
        if (springOn && evt.pending.instanceCount > 0) {
            const s = evt.spring;
            rp.setPipeline(this.pSpringCloud);
            rp.setBindGroup(0, s.bgSpringCloud1);
            rp.draw(6, evt.pending.instanceCount);
            rp.setPipeline(this.pStairLine);
            rp.setBindGroup(0, s.bgStairLine);
            rp.drawIndirect(s.bIndirect, 0);
        }
        rp.end();
        this.device.queue.submit([enc.finish()]);
        if (evt) evt.pending = null;   // consume the request; the next GPU frame re-stashes it
        if (this.canvasOk && this.ctx) {
            try {
                const e2 = this.device.createCommandEncoder();
                e2.copyTextureToTexture({ texture: this.offTex }, { texture: this.ctx.getCurrentTexture() }, [this.offW, this.offH]);
                this.device.queue.submit([e2.finish()]);
            } catch (e) { this.canvasOk = false; console.warn("[webgpu] present blit failed (offscreen-only):", e.message); }
        }
    }

    // Phase-5 GLIDE frame: re-present at display refresh between the throttled refreshChart
    // calls so the spring animates smoothly. Self-contained — it rebuilds a count==0 pending
    // (no new events: the GPU counters/targets stay put; the spring just keeps gliding toward
    // them) with a FRESH dt and the staircase scratch reset, then reuses present()'s existing
    // compute+draw chain. Never zeroes pos/vel (that would snap the cloud). No-op unless the
    // last real frame was a successful GPU spring frame.
    presentGlide() {
        const e = this.evt;
        if (!this.springMode || !e || e.failed || !e.spring || !(e.lastInstanceCount > 0)) return;
        const s = e.spring;
        const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
        let dt = this.lastSpringT ? (now - this.lastSpringT) / 1000 : 1 / 60;
        this.lastSpringT = now;
        if (!isFinite(dt) || dt <= 0) dt = 1 / 60;
        dt = Math.min(dt, 0.05);                       // clamp a stall/tab-switch spike
        // Reset the staircase scratch every frame (a frame with K==0 must draw nothing); the
        // axis-scale uniforms (uScale, uSpringScale0/1) persist on-GPU from the last real frame.
        this.device.queue.writeBuffer(s.bCount, 0, new Uint32Array([0]));
        this.device.queue.writeBuffer(s.bIndirect, 0, new Uint32Array([0, 1, 0, 0]));
        const uSpring = new ArrayBuffer(16);
        new Float32Array(uSpring, 0, 2).set([dt, WEBGPU_SPRING_OMEGA]);
        new Uint32Array(uSpring, 8, 2).set([e.players, 0]);
        this.device.queue.writeBuffer(s.uSpring, 0, uSpring);
        e.pending = { count: 0, instanceCount: e.lastInstanceCount, spring: true };
        this.present();
    }

    // Export: read the offscreen texture back, un-premultiply to straight alpha, return a
    // single composited PNG (the design accepts visual — not byte — equivalence here).
    async exportDataURLs() {
        if (!this.offTex) return [];
        // bytesPerRow MUST be a multiple of 256 for copyTextureToBuffer (a hard WebGPU
        // alignment rule for TEXTURE→buffer copies — note the buffer→buffer counter
        // readback in readbackCounters() has no such rule). So each row is padded up to
        // the next 256 and we skip the padding when un-premultiplying below.
        const bpr = Math.ceil(this.offW * 4 / 256) * 256;
        const staging = this.device.createBuffer({ size: bpr * this.offH, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const enc = this.device.createCommandEncoder();
        enc.copyTextureToBuffer({ texture: this.offTex }, { buffer: staging, bytesPerRow: bpr }, [this.offW, this.offH]);
        this.device.queue.submit([enc.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const src = new Uint8Array(staging.getMappedRange());
        const cv = document.createElement("canvas"); cv.width = this.offW; cv.height = this.offH;
        const c2d = cv.getContext("2d"); const img = c2d.createImageData(this.offW, this.offH);
        const bgra = this.format.startsWith("bgra");
        for (let y = 0; y < this.offH; y++) for (let x = 0; x < this.offW; x++) {
            const s = y * bpr + x * 4, d = (y * this.offW + x) * 4;
            const a = src[s + 3];
            const r = bgra ? src[s + 2] : src[s], g = src[s + 1], b = bgra ? src[s] : src[s + 2];
            const inv = a > 0 ? 255 / a : 0;     // un-premultiply
            img.data[d] = Math.min(255, r * inv); img.data[d + 1] = Math.min(255, g * inv);
            img.data[d + 2] = Math.min(255, b * inv); img.data[d + 3] = a;
        }
        staging.unmap(); staging.destroy();
        c2d.putImageData(img, 0, 0);
        return [cv.toDataURL("image/png")];
    }

    destroy() {
        this.canvas?.remove(); this.canvas = null; this.ctx = null;
        this.offTex?.destroy(); this.offTex = null; this.offW = this.offH = 0;
        for (const k of Object.keys(this.buf)) { this.buf[k]?.destroy(); this.buf[k] = null; this.count[k] = 0; }
        this._destroyEvt();
        this.layers = null; this.bgCacheKey = null;
    }
}

// The active point-cloud renderer. Starts as Canvas 2D (the default + fallback); the
// selection ladder below may swap in WebGPU under ?renderer=webgpu.
let pointRenderer = new Canvas2DRenderer();
window.__bl2d_renderer = "canvas2d";

// Renderer selection ladder (docs/webgpu-main-app-integration-design.md §"Phase 3 …
// selection ladder"). The app always renders Canvas 2D first; this only swaps to WebGPU
// when ?renderer=webgpu AND every capability rung passes. Never blocks first paint;
// falls back to Canvas 2D on any failure or device loss.
function swapRenderer(next) {
    const prev = pointRenderer;
    pointRenderer = next;
    next.bgCacheKey = null;
    if (prev && prev !== next) prev.destroy();
    window.__bl2d_renderer = next instanceof WebGPURenderer ? "webgpu" : "canvas2d";
    syncRendererToggle();
    syncGpustreamToggle();   // reflect spring-streaming state (also after an auto device-loss fallback)
    if (typeof refreshChart === "function") refreshChart();
}
function swapToCanvas2D(reason) {
    if (pointRenderer instanceof Canvas2DRenderer) return;
    console.warn("[renderer] → Canvas 2D fallback:", reason);
    swapRenderer(new Canvas2DRenderer());
}
// Build + swap in the WebGPU backend on demand (the URL flag at startup AND the header
// toggle both call this). Resolves true on success, false on any failed rung — leaving
// the working Canvas-2D render in place. The canvas-configure headless guard lives in
// WebGPURenderer.resize(), so this is safe to call from an explicit user action.
async function enableWebGPU() {
    if (pointRenderer instanceof WebGPURenderer) return true;
    if (!navigator.gpu) { console.warn("[renderer] navigator.gpu missing → Canvas 2D"); return false; }
    try {
        let adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!adapter) adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
        if (!adapter) { console.warn("[renderer] no WebGPU adapter → Canvas 2D"); return false; }
        const device = await adapter.requestDevice();
        const webgpu = new WebGPURenderer(device, adapter);
        await webgpu.init();
        device.lost.then((info) => { window.__bl2d_deviceLost = info.message; swapToCanvas2D("device lost: " + info.message); });
        device.addEventListener?.("uncapturederror", (e) => { window.__bl2d_gpuError = e.error?.message; });
        swapRenderer(webgpu);
        console.log("[renderer] WebGPU active");
        return true;
    } catch (e) {
        console.warn("[renderer] WebGPU init failed → Canvas 2D:", e?.message || e);
        return false;
    }
}
// Startup ladder: only auto-enables WebGPU under ?renderer=webgpu, and never under
// headless (so the default app's snap.js checks stay on Canvas 2D). The header toggle is
// the interactive entry point for everyone else.
async function chooseRenderer() {
    const params = new URLSearchParams(location.search);
    if (params.get("renderer") !== "webgpu") return;        // default path untouched
    const headless = /HeadlessChrome/i.test(navigator.userAgent) || navigator.webdriver;
    if (headless && !params.has("webgpuHeadless")) { console.log("[renderer] headless → staying Canvas 2D"); return; }
    await enableWebGPU();
}

// Persist the choice in the ?renderer query param (preserving the hash) so it survives a
// reload and is shareable — the same flag chooseRenderer reads at startup.
function writeRendererParam(on) {
    const url = new URL(location.href);
    if (on) url.searchParams.set("renderer", "webgpu"); else url.searchParams.delete("renderer");
    history.replaceState(null, "", url.pathname + url.search + location.hash);
}

// Reflect the live backend on the header toggle (also called after an automatic
// device-loss fallback, so the button can't lie about what's active).
function syncRendererToggle() {
    const btn = document.getElementById("renderer-toggle");
    if (!btn) return;
    const on = pointRenderer instanceof WebGPURenderer;
    const available = !!navigator.gpu;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.disabled = !available && !on;
    btn.title = !available
        ? "WebGPU not available in this browser"
        : on ? "GPU rendering on — click for Canvas 2D" : "Render the point cloud on the GPU (experimental)";
}

function setupRendererToggle() {
    const btn = document.getElementById("renderer-toggle");
    if (!btn) return;
    btn.addEventListener("click", async () => {
        if (pointRenderer instanceof WebGPURenderer) {
            swapToCanvas2D("user toggle");
            writeRendererParam(false);
        } else {
            btn.disabled = true;                            // brief guard while the device spins up
            const ok = await enableWebGPU();
            writeRendererParam(ok);
            if (!ok) { btn.title = "WebGPU unavailable — staying on Canvas 2D"; setTimeout(syncRendererToggle, 2000); }
        }
        syncRendererToggle();
    });
    syncRendererToggle();
}

// Persist the Phase-5 spring-streaming choice in ?gpustream=1 (preserving hash) so it
// survives a reload and is shareable — WebGPURenderer reads it at construction (springMode).
function writeGpustreamParam(on) {
    const url = new URL(location.href);
    if (on) url.searchParams.set("gpustream", "1"); else url.searchParams.delete("gpustream");
    history.replaceState(null, "", url.pathname + url.search + location.hash);
}

// Reflect the spring-streaming state on its toggle. The button only makes sense while a
// WebGPU renderer is live (gpustream needs renderer=webgpu), so it's hidden under Canvas 2D.
function syncGpustreamToggle() {
    const btn = document.getElementById("gpustream-toggle");
    if (!btn) return;
    const onGpu = pointRenderer instanceof WebGPURenderer;
    const on = onGpu && !!pointRenderer.springMode;
    btn.hidden = !onGpu;                                 // only relevant when the GPU backend is active
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? "Spring streaming on — click for the hybrid GPU cloud"
                   : "Full-GPU spring streaming (experimental)";
}

function setupGpustreamToggle() {
    const btn = document.getElementById("gpustream-toggle");
    if (!btn) return;
    btn.addEventListener("click", async () => {
        if (!(pointRenderer instanceof WebGPURenderer)) return;   // hidden anyway; guard double-clicks
        const turningOn = !pointRenderer.springMode;
        btn.disabled = true;
        // springMode + the Phase-5 pipelines are fixed at renderer construction, so flip the
        // URL flag then REBUILD the WebGPU renderer (hop through Canvas 2D so enableWebGPU's
        // "already WebGPU" early-return doesn't skip the rebuild). The fresh renderer re-reads
        // ?gpustream at construction.
        writeGpustreamParam(turningOn);
        swapToCanvas2D("rebuild for gpustream toggle");
        await enableWebGPU();
        btn.disabled = false;
        syncRendererToggle();
        syncGpustreamToggle();
    });
    syncGpustreamToggle();
}
window.__bl2d_chooseRenderer = chooseRenderer;
window.__bl2d_exportDataURLs = () => pointRenderer.exportDataURLs();   // headless WebGPU readback probe

// GPU compute-accumulate invariant probe: read the per-player counters back and compare
// to the JS incremental-frontier shadow (comp[]) — they MUST match exactly when the GPU
// cloud is active (counterMis 0), mirroring the POC's `counterMis` check. Returns null
// when WebGPU/the evt path isn't active.
window.__bl2d_gpuCounters = async (names = []) => {
    if (!(pointRenderer instanceof WebGPURenderer)) return null;
    const c = await pointRenderer.readbackCounters();
    if (!c || !evtIncFrontier || !pbpEvt) return null;
    // GPU counters hold the AXIS VALUE per player; recompute the same value from the JS
    // shadow's per-component totals via the model's coefficients (cx/cy) and compare.
    const mono = evtGpuMonotone(pbpEvt);
    const comp = evtIncFrontier.comp, dl = pbpEvt.depList;
    const expect = (coef, p) => { let v = 0; for (let d = 0; d < dl.length; d++) v += coef[d] * comp[d][p]; return v; };
    let counterMis = 0;
    for (let i = 0; i < c.players; i++) { if (c.x[i] !== expect(mono.cx, i)) counterMis++; if (c.y[i] !== expect(mono.cy, i)) counterMis++; }
    // A few named players' GPU axis values straight from the readback (record check).
    const records = {};
    for (const nm of names) { const i = pbpEvt.players.findIndex((p) => p.name === nm); if (i >= 0) records[nm] = { x: c.x[i], y: c.y[i] }; }
    return { counterMis, players: c.players, applied: evtIncFrontier.applied, lastCursor: evtIncFrontier.lastCursor, records };
};
// Player-name → resident-model index (so a headless probe can read a specific player's
// GPU counter, e.g. Bonds / Henderson record spot-checks).
window.__bl2d_evtPlayerIndex = (name) => pbpEvt ? pbpEvt.players.findIndex((p) => p.name === name) : -1;

// Phase-5 gpuStreaming invariant probe (the spring + GPU skyline oracle). Requires
// ?renderer=webgpu&gpustream=1 and an active .evt-career model. One-shot: drives the GPU to
// end-of-history, settles, reads back once, and compares to a CPU brute-force frontier.
// Returns {springMis, skylineMis, frontierSize, maxX, maxY, records{name:{x,y,onFront}}}.
window.__bl2d_verifySpring = async (names = ["Barry Bonds", "Rickey Henderson"]) => {
    if (!(pointRenderer instanceof WebGPURenderer) || !pointRenderer.springMode || !pbpEvt) return null;
    pointRenderer.uploadEvtStream(pbpEvt);
    const r = await pointRenderer.verifySpring();
    if (!r) return null;
    const records = {};
    for (const nm of names) { const i = pbpEvt.players.findIndex((p) => p.name === nm); if (i >= 0) records[nm] = { x: r.x[i], y: r.y[i], onFront: !!r.onFront[i] }; }
    return { springMis: r.springMis, skylineMis: r.skylineMis, frontierSize: r.frontierSize, maxX: r.maxX, maxY: r.maxY, players: r.players, records };
};
window.__bl2d_springMode = () => pointRenderer instanceof WebGPURenderer && !!pointRenderer.springMode;

function recordPbpFrameTiming(totalMs, modelMs, renderMs, enabled) {
    if (!enabled) return;
    const samples = (window.__bl2d_pbpFrameMs?.samples || []).slice(-179);
    samples.push(totalMs);
    const sorted = [...samples].sort((a, b) => a - b);
    const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : 0;
    window.__bl2d_pbpFrameMs = {
        samples,
        p50: pct(0.50),
        p95: pct(0.95),
        last: totalMs,
        lastModel: modelMs,
        lastRender: renderMs,
    };
}

async function exportChartSVG() {
    const svgStr = buildExportSvgString(await pointRenderer.exportDataURLs());
    if (!svgStr) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([svgStr], { type: "image/svg+xml" }));
    a.download = chartExportFilename("svg");
    a.click();
    URL.revokeObjectURL(a.href);
}

function svgToPngBlob(svgStr, width, height) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
        const url = URL.createObjectURL(svgBlob);
        img.onload = () => {
            const scale = Math.min(window.devicePixelRatio || 2, 3);
            const canvas = document.createElement("canvas");
            canvas.width  = Math.round(width  * scale);
            canvas.height = Math.round(height * scale);
            const ctx = canvas.getContext("2d");
            ctx.scale(scale, scale);
            const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#f4f5f7";
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);
            URL.revokeObjectURL(url);
            canvas.toBlob(resolve, "image/png");
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("SVG render failed")); };
        img.src = url;
    });
}


function setupExportButton() {
    const btn = document.getElementById("export-btn");
    if (!btn) return;
    btn.addEventListener("click", () => {
        exportChartSVG();
        btn.classList.add("share-btn--copied");
        setTimeout(() => btn.classList.remove("share-btn--copied"), 1500);
    });
}

let _sharePngBlob = null;

function _shareModalText() {
    const xDim = document.getElementById("x-axis-select")?.value || "x";
    const yDim = document.getElementById("y-axis-select")?.value || "y";
    const mode = document.querySelector("#mode-toggle .mode-btn.active")?.dataset.mode || "season";
    return `${xDim} vs ${yDim} (${mode}) — Baseball Limits 2D`;
}

function _updateSharePlatformLinks(url) {
    const text = encodeURIComponent(_shareModalText());
    const enc  = encodeURIComponent(url);
    const set  = (id, href) => { const el = document.getElementById(id); if (el) el.href = href; };
    set("share-x",        `https://twitter.com/intent/tweet?text=${text}&url=${enc}`);
    set("share-bluesky",  `https://bsky.app/intent/compose?text=${text}%20${enc}`);
    set("share-linkedin", `https://www.linkedin.com/sharing/share-offsite/?url=${enc}`);
    set("share-facebook", `https://www.facebook.com/sharer/sharer.php?u=${enc}`);
    set("share-whatsapp", `https://wa.me/?text=${text}%20${enc}`);
    set("share-reddit",   `https://www.reddit.com/submit?url=${enc}&title=${text}`);
}

async function openShareModal() {
    const backdrop  = document.getElementById("share-backdrop");
    const spinner   = document.getElementById("share-preview-spinner");
    const img       = document.getElementById("share-preview-img");
    const copyImage = document.getElementById("share-modal-copy-image");
    if (!backdrop) return;

    // Reset image state and open
    _sharePngBlob = null;
    if (img.src) { URL.revokeObjectURL(img.src); img.src = ""; }
    img.hidden = true;
    spinner.hidden = false;
    if (copyImage) copyImage.disabled = true;
    backdrop.hidden = false;
    _updateSharePlatformLinks(window.location.href);

    // Generate PNG preview in the background
    try {
        const svgStr = buildExportSvgString(await pointRenderer.exportDataURLs());
        if (svgStr) {
            const svgEl = document.getElementById("scatter-plot");
            const { width, height } = svgEl.getBoundingClientRect();
            _sharePngBlob = await svgToPngBlob(svgStr, width, height);
            await new Promise((res) => {
                img.onload  = res;
                img.onerror = res;
                img.src = URL.createObjectURL(_sharePngBlob);
            });
            img.hidden = false;
        }
    } catch (_) { /* preview fails silently; copy/download still work */ }
    spinner.hidden = true;
    if (copyImage) copyImage.disabled = !_sharePngBlob;
}

function closeShareModal() {
    const backdrop = document.getElementById("share-backdrop");
    if (backdrop) backdrop.hidden = true;
}

function setupShareButton() {
    const shareBtn   = document.getElementById("share-btn");
    const backdrop   = document.getElementById("share-backdrop");
    const closeBtn   = document.getElementById("share-modal-close");
    const copyLink   = document.getElementById("share-modal-copy-link");
    const copyImage  = document.getElementById("share-modal-copy-image");
    if (!shareBtn || !backdrop) return;

    shareBtn.addEventListener("click", openShareModal);

    closeBtn?.addEventListener("click", closeShareModal);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeShareModal(); });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !backdrop.hidden) closeShareModal();
    });

    copyLink?.addEventListener("click", async () => {
        const url = window.location.href;
        try {
            await navigator.clipboard.writeText(url);
        } catch {
            const ta = document.createElement("textarea");
            ta.value = url;
            ta.style.cssText = "position:fixed;opacity:0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
        }
        copyLink.classList.add("share-action-btn--done");
        const origText = copyLink.innerHTML;
        copyLink.textContent = "Copied!";
        setTimeout(() => { copyLink.innerHTML = origText; copyLink.classList.remove("share-action-btn--done"); }, 1800);
    });

    copyImage?.addEventListener("click", async () => {
        if (!_sharePngBlob) return;
        const filename = chartExportFilename("png");

        // Mobile with Web Share API file support
        const pngFile = new File([_sharePngBlob], filename, { type: "image/png" });
        if (navigator.share && navigator.canShare?.({ files: [pngFile] })) {
            try {
                await navigator.share({
                    title: "Baseball Limits 2D",
                    text: _shareModalText(),
                    files: [pngFile],
                    url: window.location.href,
                });
                return;
            } catch (e) {
                if (e.name === "AbortError") return;
            }
        }

        // Desktop: copy to clipboard
        const origHTML = copyImage.innerHTML;
        try {
            await navigator.clipboard.write([new ClipboardItem({ "image/png": _sharePngBlob })]);
            copyImage.classList.add("share-action-btn--done");
            copyImage.textContent = "Copied!";
            setTimeout(() => { copyImage.innerHTML = origHTML; copyImage.classList.remove("share-action-btn--done"); }, 1800);
        } catch {
            // Fallback: download PNG
            const a = document.createElement("a");
            a.href = URL.createObjectURL(_sharePngBlob);
            a.download = filename;
            a.click();
            URL.revokeObjectURL(a.href);
        }
    });
}

const EXPLAINER_KEY = "bl2d_intro_seen";

function setupExplainer() {
    const backdrop = document.getElementById("explainer-backdrop");
    const dismiss = document.getElementById("explainer-dismiss");
    const helpBtn = document.getElementById("help-btn");
    if (!backdrop || !dismiss || !helpBtn) return;

    // preventScroll so focusing the button doesn't scroll a tall modal past
    // its heading on short phone screens.
    const show = () => { backdrop.hidden = false; dismiss.focus({ preventScroll: true }); };
    const hide = () => {
        backdrop.hidden = true;
        try { localStorage.setItem(EXPLAINER_KEY, "1"); } catch (_) { /* private mode */ }
    };

    let seen = false;
    try { seen = localStorage.getItem(EXPLAINER_KEY) === "1"; } catch (_) { /* ignore */ }
    if (!seen) show();

    dismiss.addEventListener("click", hide);
    helpBtn.addEventListener("click", show);
    backdrop.addEventListener("click", (e) => {
        // Click on the dimmed area (not the card) closes too.
        if (e.target === backdrop) hide();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !backdrop.hidden) hide();
    });
}

function setupGlossary() {
    const popover = document.createElement("div");
    popover.className = "glossary-popover";
    popover.setAttribute("data-visible", "false");
    document.body.appendChild(popover);

    let activeBtn = null;

    const positionNear = (btn) => {
        const r = btn.getBoundingClientRect();
        const popW = popover.offsetWidth;
        const popH = popover.offsetHeight;
        let left = r.left;
        if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
        if (left < 8) left = 8;
        let top = r.bottom + 6;
        if (top + popH > window.innerHeight - 8) top = r.top - popH - 6;
        popover.style.left = left + "px";
        popover.style.top = top + "px";
    };

    const show = (btn, dim) => {
        const def = GLOSSARY[dim];
        if (!def) return hide();
        popover.innerHTML = `
            <div class="glossary-popover-name">${escapeHtml(dim)} — ${escapeHtml(def.name)}</div>
            <div class="glossary-popover-formula">${escapeHtml(def.formula)}</div>
        `;
        popover.setAttribute("data-visible", "true");
        if (activeBtn && activeBtn !== btn) activeBtn.setAttribute("aria-expanded", "false");
        btn.setAttribute("aria-expanded", "true");
        activeBtn = btn;
        // Two-pass position: render first so we know the popover's size, then place it.
        requestAnimationFrame(() => positionNear(btn));
    };
    const hide = () => {
        popover.setAttribute("data-visible", "false");
        if (activeBtn) activeBtn.setAttribute("aria-expanded", "false");
        activeBtn = null;
    };

    document.querySelectorAll(".glossary-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const selectId = btn.dataset.target;
            const dim = document.getElementById(selectId).value;
            if (activeBtn === btn) hide(); else show(btn, dim);
        });
    });

    // Click anywhere outside the popover or trigger closes it.
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".glossary-popover, .glossary-btn")) hide();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && activeBtn) hide();
    });

    // If the user changes the selection while a popover is open for that
    // axis, refresh it to the new dimension's definition.
    ["x-axis-select", "y-axis-select"].forEach(id => {
        document.getElementById(id).addEventListener("change", () => {
            if (activeBtn && activeBtn.dataset.target === id) {
                show(activeBtn, document.getElementById(id).value);
            }
        });
    });

    glossaryShow = show;
    glossaryHide = hide;
}



function updateYearHint(sYear, eYear) {
    const hint = document.getElementById("year-hint");
    if (!hint) return;
    const era = ERAS.find(e => e.start === sYear && (e.end === eYear || (e.end === 2099 && eYear >= 2006)));
    if (era) {
        hint.textContent = `${era.name} era`;
        hint.hidden = false;
    } else if (sYear === 1920 && eYear >= 2006) {
        hint.textContent = "Live Ball era to present (default)";
        hint.hidden = false;
    } else if (sYear === 1871 && eYear >= 2006) {
        hint.textContent = "All eras";
        hint.hidden = false;
    } else {
        hint.hidden = true;
    }
}


function populateFranchiseSelect() {
    const sel = document.getElementById("franchise-select");
    if (!sel) return;
    sel.innerHTML = `<option value="all">All franchises</option>` +
        FRANCHISES.map(f => {
            const note = f.note ? ` (${f.note})` : "";
            return `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}${escapeHtml(note)}</option>`;
        }).join("");
}

function updateFranchiseDimming(league) {
    document.querySelectorAll("#franchise-panel .franchise-division-cell").forEach(cell => {
        const label = cell.querySelector(".franchise-division-label")?.textContent || "";
        const dim = (league === "AL" && label.startsWith("NL ")) ||
                    (league === "NL" && label.startsWith("AL "));
        cell.classList.toggle("franchise-division-cell--dimmed", dim);
    });
}


function updateFranchiseTrigger(id) {
    const trigger = document.getElementById("franchise-trigger");
    if (!trigger) return;
    const f = FRANCHISE_BY_ID.get(id);
    trigger.querySelector(".franchise-trigger-label").textContent = f ? f.name : "All franchises";
}

function updateChipSelection(id) {
    const panel = document.getElementById("franchise-panel");
    if (!panel) return;
    panel.querySelectorAll(".franchise-chip").forEach(chip => {
        const selected = (chip.dataset.id || "all") === (id || "all");
        chip.classList.toggle("franchise-chip--selected", selected);
        chip.setAttribute("aria-selected", selected ? "true" : "false");
    });
}

function buildFranchisePicker() {
    const panel = document.getElementById("franchise-panel");
    if (!panel) return;

    // League filter (All / AL / NL) at top of panel
    const leagueRow = document.createElement("div");
    leagueRow.className = "franchise-league-row";
    const leagueSeg = document.createElement("div");
    leagueSeg.className = "seg-group";
    leagueSeg.id = "league-seg";
    leagueSeg.setAttribute("role", "group");
    leagueSeg.setAttribute("aria-label", "League");
    [["all","All"],["AL","AL"],["NL","NL"]].forEach(([val, label], i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "seg-btn" + (i === 0 ? " active" : "");
        btn.dataset.league = val;
        btn.textContent = label;
        leagueSeg.appendChild(btn);
    });
    leagueRow.appendChild(leagueSeg);
    panel.appendChild(leagueRow);

    // Division grid
    const grid = document.createElement("div");
    grid.className = "franchise-division-grid";
    for (const div of DIVISIONS) {
        const cell = document.createElement("div");
        cell.className = "franchise-division-cell";
        const label = document.createElement("span");
        label.className = "franchise-division-label";
        label.textContent = div.label;
        cell.appendChild(label);
        const row = document.createElement("div");
        row.className = "franchise-chips-row";
        // Sort each division's teams lexicographically by abbreviation.
        const sortedIds = [...div.ids].sort((a, b) =>
            (FRANCHISE_BY_ID.get(a)?.abbr || "").localeCompare(FRANCHISE_BY_ID.get(b)?.abbr || ""));
        for (const fid of sortedIds) {
            const f = FRANCHISE_BY_ID.get(fid);
            if (!f) continue;
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "franchise-chip";
            chip.setAttribute("role", "option");
            chip.setAttribute("aria-selected", "false");
            chip.setAttribute("aria-label", f.name);
            chip.dataset.id = f.id;
            chip.innerHTML =
                `<span class="franchise-swatch" style="background:${f.color}" aria-hidden="true"></span>` +
                `<span class="franchise-abbr">${escapeHtml(f.abbr)}</span>`;
            row.appendChild(chip);
        }
        cell.appendChild(row);
        grid.appendChild(cell);
    }
    panel.appendChild(grid);

    function setFranchise(id) {
        const sel = document.getElementById("franchise-select");
        if (!sel) return;
        sel.value = id;
        updateFranchiseTrigger(id);
        updateChipSelection(id);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
    }

    panel.addEventListener("click", e => {
        const chip = e.target.closest(".franchise-chip");
        if (!chip) return;
        const current = document.getElementById("franchise-select")?.value || "all";
        // Toggle: clicking the selected chip deselects (= all franchises)
        setFranchise(chip.dataset.id === current ? "all" : chip.dataset.id);
    });

    // Attach dimming to each league button (in addition to the seg-group refresh wiring).
    panel.querySelectorAll(".seg-btn[data-league]").forEach(btn => {
        btn.addEventListener("click", () => {
            const league = btn.dataset.league;
            updateFranchiseDimming(league);
            // Auto-reset franchise if its division is now dimmed.
            const currentFr = FRANCHISE_BY_ID.get(document.getElementById("franchise-select")?.value);
            if (currentFr && league !== "all") {
                const frLeague = currentFr.division.startsWith("AL") ? "AL" : "NL";
                if (frLeague !== league) setFranchise("all");
            }
        });
    });
    updateFranchiseDimming("all");
}

function setupPlayerSearch() {
    const input = document.getElementById("player-search");
    const box   = document.getElementById("player-suggestions");
    if (!input || !box) return;

    let activeIdx = -1;

    function getSuggestions(q) {
        if (!q || !playerIndex) return [];
        const lq = q.toLowerCase();
        const starts   = [];
        const contains = [];
        for (const name of playerIndex.keys()) {
            const ln = name.toLowerCase();
            if (ln.startsWith(lq)) starts.push(name);
            else if (ln.includes(lq)) contains.push(name);
        }
        return [...starts.sort(), ...contains.sort()].slice(0, 8);
    }

    function render(matches, q) {
        box.innerHTML = "";
        if (!matches.length) { box.hidden = true; return; }
        const lq = q.toLowerCase();
        matches.forEach((name) => {
            const el = document.createElement("div");
            el.className = "player-suggestion-item";
            el.setAttribute("role", "option");
            const already = careerHighlights.has(name);
            if (already) el.classList.add("player-suggestion-item--added");
            el.setAttribute("aria-selected", already ? "true" : "false");
            // Bold the matching portion
            const lo = name.toLowerCase().indexOf(lq);
            if (lo >= 0) {
                el.appendChild(document.createTextNode(name.slice(0, lo)));
                const mark = document.createElement("mark");
                mark.textContent = name.slice(lo, lo + lq.length);
                el.appendChild(mark);
                el.appendChild(document.createTextNode(name.slice(lo + lq.length)));
            } else {
                el.textContent = name;
            }
            el.addEventListener("mousedown", e => { e.preventDefault(); if (!already) pick(name); });
            box.appendChild(el);
        });
        box.hidden = false;
        activeIdx = -1;
    }

    function hide() { box.hidden = true; activeIdx = -1; }

    function pick(name) {
        if (playerIndex?.has(name)) {
            addHighlight(name);
            syncPlayerHint();
            // refreshChart is closure-scoped in the init function; top-level
            // call sites refresh via this event (see the bl2d:refresh listener).
            document.dispatchEvent(new Event("bl2d:refresh"));
        }
        input.value = "";
        hide();
    }

    function setActive(idx) {
        const items = box.querySelectorAll(".player-suggestion-item");
        activeIdx = Math.max(-1, Math.min(idx, items.length - 1));
        items.forEach((el, i) => el.classList.toggle("player-suggestion-item--active", i === activeIdx));
    }

    function refresh() { const q = input.value.trim(); render(getSuggestions(q), q); }
    input.addEventListener("input", refresh);
    input.addEventListener("blur", () => setTimeout(hide, 150));
    input.addEventListener("focus", () => { if (input.value.trim()) refresh(); });
    input.addEventListener("keydown", e => {
        const items = box.querySelectorAll(".player-suggestion-item");
        if (e.key === "ArrowDown") { e.preventDefault(); setActive(activeIdx + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setActive(activeIdx - 1); }
        else if (e.key === "Enter") {
            if (activeIdx >= 0 && items[activeIdx]) { pick(items[activeIdx].textContent); }
            else {
                const exact = [...(playerIndex?.keys() || [])].find(n => n.toLowerCase() === input.value.trim().toLowerCase());
                if (exact) pick(exact);
            }
        }
        else if (e.key === "Escape") hide();
    });
}

function syncPlayerHint() {
    const hint   = document.getElementById("player-hint");
    const search = document.getElementById("player-search");
    if (!hint) return;
    if (careerHighlights.size > 0) {
        hint.innerHTML = [...careerHighlights.entries()].map(([pid, color]) =>
            `<span class="player-chip" data-player="${escapeHtml(pid)}" style="--chip-color:${color}">` +
            `<span class="player-chip-dot"></span>` +
            `<span class="player-chip-name">${escapeHtml(pid)}</span>` +
            `<button type="button" class="player-chip-remove" aria-label="Remove ${escapeHtml(pid)}">×</button>` +
            `</span>`
        ).join("");
        hint.hidden = false;
    } else {
        hint.innerHTML = "";
        hint.hidden = true;
    }
    if (search) {
        const full = careerHighlights.size >= HIGHLIGHT_COLORS.length;
        search.disabled = full;
        search.placeholder = full ? "Max 6 players" : "Search…";
        search.value = "";
    }
    syncGroupCareerToggle();
}

// Show the "Group careers" toggle only once the user has selected ≥1 player (the
// group to animate); reflect the on/off state. Top-level so syncPlayerHint (called
// on every group change) keeps it in sync.
function syncGroupCareerToggle() {
    const btn = document.getElementById("group-career-toggle");
    if (!btn) return;
    btn.hidden = careerHighlights.size < 1;
    btn.classList.toggle("active", groupCareerMode);
    btn.setAttribute("aria-pressed", String(groupCareerMode));
}

function setupPaPresets() {
    const slider = document.getElementById("pa-min-select");
    document.querySelectorAll(".preset[data-pa]").forEach((btn) => {
        btn.addEventListener("click", () => {
            slider.value = btn.dataset.pa;
            slider.dispatchEvent(new Event("input", { bubbles: true }));
        });
    });
}

function setupYearPresets() {
    const sInput = document.getElementById("s-year-select");
    const eInput = document.getElementById("e-year-select");
    document.querySelectorAll(".preset[data-sy]").forEach((btn) => {
        btn.addEventListener("click", () => {
            sInput.value = btn.dataset.sy;
            eInput.value = btn.dataset.ey ?? eInput.max;
            sInput.dispatchEvent(new Event("change", { bubbles: true }));
        });
    });
}


// The single render entry point — called by refreshChart on every state change and on
// every animation frame. It is one big function (not split) on purpose: it runs per
// frame, so it avoids re-deriving shared locals across helper-call boundaries, and the
// FLIP morph needs the before/after DOM state in one scope. Rough phases, in order:
//   1. FLIP snapshot     — record current dot screen positions to tween FROM.
//   2. filter + extent   — apply year/league/bats/country/threshold; lock or fit axes.
//   3. frontier          — buildSmoothActiveFrontier | buildEvtIncrementalFrontier |
//                          buildFrontier (the static O(n) sweep); plus onion-peel layers.
//   4. hypervolume       — per-point contributions (skipped on "lite" playback frames).
//   5. render cloud      — through pointRenderer (Canvas2D paints / WebGPU submits).
//   6. render chrome     — axes, the dashed staircase, frontier dots, labels, isolation
//                          rings, legend, leaderboard cards (the interaction-only bits are
//                          skipped on lite frames and done on the settle/full frame).
//   7. FLIP play         — tween dots from the snapshot positions to the new layout.
// `filters` is the per-mode bag refreshChart assembles; `mode` is "season"/"career"
// (note: evt-career passes "season" with filters.evt — see refreshChart).
function drawScatterPlot(points, xDim, yDim, sYear, eYear, minPa, formatStat, mode = "season", filters = {}) {
    const frameStart = performance.now();
    // Any open axis-stat menu is anchored to the (about to be replaced) titles.
    closeAxisStatMenu();
    const svg = d3.select("#scatter-plot");
    // FLIP: snapshot current dot positions so we can morph to the new layout.
    // During animation playback (400ms ticks), use a shorter duration so transitions
    // complete before the next tick; D3 interrupts gracefully if they overlap.
    // prefers-reduced-motion → 0 (snap to the end state, no tween).
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const FLIP_DURATION = reduceMotion ? 0 : (animTimer ? 350 : 280);
    const flipPos = new Map();
    if (FLIP_DURATION > 0) {
        svg.selectAll(".regular-point, .special-point").each(function(d) {
            if (!d || !d.playerID) return;
            const key = d.playerID + "|" + (d.year ?? d.yearID ?? "");
            flipPos.set(key, { cx: +this.getAttribute("cx"), cy: +this.getAttribute("cy") });
        });
    }
    // Capture the outgoing frontier staircase so we can ghost it out while the
    // new one fades in — the "frontier rewrites itself" effect. Read via node()
    // so an empty selection (first render) yields null instead of throwing.
    const oldStairNode = FLIP_DURATION > 0 ? svg.select("path.frontier-staircase").node() : null;
    const oldStairD = oldStairNode ? oldStairNode.getAttribute("d") : null;
    svg.selectAll("*").remove();
    d3.select("#tooltip").attr("data-visible", "false");

    const league = filters.league || "all";
    const bats = filters.bats || "all";
    const country   = filters.country   || "all";
    const franchise = filters.franchise || "all";
    const handField = filters.handField || "bats";
    const colorBy = filters.colorBy || "era";
    renderLegend(colorBy);

    // Cache meta lookups per playerID across the filter pass.
    const metaCache = new Map();
    const getMeta = (id) => {
        if (metaCache.has(id)) return metaCache.get(id);
        const m = metaFor(id);
        metaCache.set(id, m);
        return m;
    };

    // Attribute filters without the year window — reused for the era-vs-era
    // comparison frontier, which applies the same filters over a second range.
    const attrMatches = (p) => {
        if (league !== "all" && p.lgID !== league) return false;
        if (franchise !== "all" && FRANCHISE_BY_TEAM.get(p.teamID) !== franchise) return false;
        if (bats !== "all" || country !== "all") {
            const m = getMeta(p.playerID);
            if (!m) return false;
            if (bats !== "all" && m[handField] !== bats) return false;
            if (country !== "all" && m.country !== country) return false;
        }
        return true;
    };
    const seasonMatches = (p) =>
        p.yearID >= sYear && p.yearID <= eYear && attrMatches(p);

    const thresholdField = filters.thresholdField || "PA";
    const datasetKey = filters.dataset || "batting";

    // For "lower is better" axes, negate the value for sorting and sweep so the
    // algorithm always maximises — finding the best (lowest) value on that axis.
    // When showWorstFrontier is true, invert the signs to find the lower-left envelope.
    const datasetDef = DATASETS[filters.dataset || "batting"];
    let xSign = datasetDef.lowerIsBetter?.has(xDim) ? -1 : 1;
    let ySign = datasetDef.lowerIsBetter?.has(yDim) ? -1 : 1;
    if (showWorstFrontier) { xSign *= -1; ySign *= -1; }
    // Park the date watermark in the frontier's "ideal" (empty) corner — where both
    // axes are best, beyond the staircase. Flips with the stats' direction (lower-is-
    // better) and best/worst. ySign>0 → higher is better → top; xSign>0 → right.
    const pbpDateEl = document.getElementById("pbp-date");
    if (pbpDateEl) pbpDateEl.dataset.corner = (ySign > 0 ? "t" : "b") + (xSign > 0 ? "r" : "l");

    const sortFrontierRows = (a, b) => {
        const ax = a.x * xSign, bx = b.x * xSign;
        const ay = a.y * ySign, by = b.y * ySign;
        if (ax !== bx) return ax - bx;
        if (ay !== by) return ay - by;
        return b.year - a.year; // prefer more recent on ties
    };

    const toFrontierRow = (p) => {
        const x = p[xDim];
        const y = p[yDim];
        if (isNaN(x) || isNaN(y)) return null;
        if (p[thresholdField] < minPa) return null;
        return {
            x, y,
            year: p.yearID,
            yearLast: p.yearLast || p.yearID,
            seasonsCount: p.seasonsCount || 1,
            PA: p[thresholdField],
            playerID: p.playerID,
            teamID: p.teamID,
            lgID: p.lgID,
            orig: p,  // for size-by lookups (PA / G / AB)
        };
    };

    // Full pipeline — filter → (career aggregate) → threshold → sort → dedup →
    // Pareto sweep — parameterised by a season-match predicate, so we can build
    // both the active (attribute-filtered) frontier and the "global" reference
    // frontier from the same code.
    function buildFrontier(matchFn) {
        let workingPoints;
        if (mode === "career") {
            const byPlayer = new Map();
            for (const p of points) {
                if (!matchFn(p)) continue;
                let arr = byPlayer.get(p.playerID);
                if (!arr) { arr = []; byPlayer.set(p.playerID, arr); }
                arr.push(p);
            }
            workingPoints = [];
            for (const seasons of byPlayer.values()) {
                seasons.sort((a, b) => a.yearID - b.yearID);
                workingPoints.push(aggregateCareer(seasons, datasetKey));
            }
        } else {
            workingPoints = points.filter(matchFn);
        }

        const flt = [];
        for (const p of workingPoints) {
            const row = toFrontierRow(p);
            if (row) flt.push(row);
        }

        flt.sort(sortFrontierRows);

        // Deduplicate exact (x, y) collisions for the rendering pass.
        const uniq = [];
        for (let i = 0; i < flt.length; i++) {
            const p = flt[i];
            if (i === 0 || p.x !== flt[i - 1].x || p.y !== flt[i - 1].y) uniq.push(p);
        }

        // Pareto frontier via the shared sweep (keeps onion-peeling layer 0
        // byte-identical to the single frontier).
        const fr = sweepFrontier(uniq);

        return { filtered: flt, unique: uniq, frontier: fr };
    }

    function mergeSortedFrontierRows(a, b) {
        const out = [];
        let i = 0, j = 0;
        while (i < a.length || j < b.length) {
            if (j >= b.length || (i < a.length && sortFrontierRows(a[i], b[j]) <= 0)) out.push(a[i++]);
            else out.push(b[j++]);
        }
        return out;
    }

    function frontierFromSortedRows(flt) {
        const uniq = [];
        for (let i = 0; i < flt.length; i++) {
            const p = flt[i];
            if (i === 0 || p.x !== flt[i - 1].x || p.y !== flt[i - 1].y) uniq.push(p);
        }
        return { filtered: flt, unique: uniq, frontier: sweepFrontier(uniq) };
    }

    // Incremental frontier for the season-accumulating sweep (.bl2p and .evt-season):
    // completed seasons (year < open) are static, so cache their sorted rows per open
    // year and only sort+merge the open season each frame — avoids re-sorting ~100k
    // completed player-seasons every frame. Not for career / group-career / evt-career
    // (their points aren't a completed-vs-open-season split).
    function buildSmoothActiveFrontier() {
        if (mode !== "season" || !filters.smooth || filters.groupCareer || filters.evt) return null;
        const openYear = eYear;
        const prepKey = [
            datasetKey, sYear, openYear, xDim, yDim, minPa,
            league, bats, country, franchise, handField, xSign, ySign,
        ].join("|");
        let completedRows;
        if (pbpFrontierPrepCache?.key === prepKey) {
            completedRows = pbpFrontierPrepCache.filtered;
        } else {
            completedRows = [];
            for (const p of points) {
                if (p.yearID < sYear || p.yearID >= openYear) continue;
                if (!attrMatches(p)) continue;
                const row = toFrontierRow(p);
                if (row) completedRows.push(row);
            }
            completedRows.sort(sortFrontierRows);
            pbpFrontierPrepCache = { key: prepKey, filtered: completedRows };
        }
        const openRows = [];
        for (const p of points) {
            if (p.yearID !== openYear) continue;
            if (!attrMatches(p)) continue;
            const row = toFrontierRow(p);
            if (row) openRows.push(row);
        }
        openRows.sort(sortFrontierRows);
        return frontierFromSortedRows(mergeSortedFrontierRows(completedRows, openRows));
    }

    // .evt CAREER frontier maintained incrementally instead of swept full each frame
    // (docs/webgpu-main-app-integration-design.md §C; JS port of poc-webgpu/core.c
    // step_career). The cursor advances a small event window per frame, so only the
    // touched players move the frontier — O(window + frontier) vs the O(N log N) sweep.
    // Returns null (→ fall through to the full sweep) unless the gate holds:
    //   • evt career mode, model matches the active axes,
    //   • both axes are counting (non-rate, monotone) stats.
    // Attribute filters (bats/country — league/franchise are forced "all" for evt) are
    // honored via a static per-player eligibility mask that gates which players' events
    // feed the engine; the cloud (filtered/unique) already filters via seasonMatches. The
    // threshold isn't a factor here (counting axes ⇒ minPa is always 0). The full point
    // cloud is still built exactly as buildFrontier's else-branch; only the frontier
    // *subset* comes from the engine, selected back out of `unique` by coordinate so
    // downstream identity holds.
    function buildEvtIncrementalFrontier() {
        if (!filters.evt) return null;
        const model = pbpEvt;
        if (!model || model.xDim !== xDim || model.yDim !== yDim) return null;
        if (model.xs.rate || model.ys.rate) return null;

        // Cloud: same map → sort → dedup as buildFrontier (mode is "season" for evt career).
        const flt = [];
        for (const p of points) { if (!seasonMatches(p)) continue; const row = toFrontierRow(p); if (row) flt.push(row); }
        flt.sort(sortFrontierRows);
        const uniq = [];
        for (let i = 0; i < flt.length; i++) { const p = flt[i]; if (i === 0 || p.x !== flt[i - 1].x || p.y !== flt[i - 1].y) uniq.push(p); }
        const pointByXY = new Map();
        for (const u of uniq) pointByXY.set(u.x + "|" + u.y, u);

        // Replay the date-sorted event stream up to the cursor, advancing the resident
        // engine (reset + replay-forward on backward seek / new model / sign flip).
        const stream = buildEvtEventStream(model);
        const cur = Math.max(model.winStart, Math.min(model.winEnd, pbpCursorIdx)); // matches refreshChart's evt-career clamp
        let st = evtIncFrontier;
        // Did this call restart the replay from 0 (fresh engine OR backward seek)? The
        // GPU counters must be zeroed in lockstep with the JS shadow when it does, so the
        // GPU stash below reports it as `zero`.
        let didReset = false;
        // A new model / sign flip / filter change invalidates the replay → fresh engine
        // (the eligibility mask changes which players are admitted, so the state can't be
        // patched incrementally — reset and replay forward from 0).
        if (!st || st.stream !== stream || st.xSign !== xSign || st.ySign !== ySign ||
            st.bats !== bats || st.country !== country) {
            didReset = true;
            const players = model.players, elig = new Uint8Array(players.length);
            const all = bats === "all" && country === "all";
            for (let i = 0; i < players.length; i++) {
                if (all) { elig[i] = 1; continue; }
                const m = getMeta(players[i].name);
                elig[i] = (m && (bats === "all" || m[handField] === bats) && (country === "all" || m.country === country)) ? 1 : 0;
            }
            st = evtIncFrontier = { stream, xSign, ySign, bats, country, elig,
                engine: createIncrementalFrontier(players.length, xSign, ySign),
                comp: model.depList.map(() => new Float64Array(players.length)),
                applied: 0, lastCursor: -1 };
        }
        if (cur < st.lastCursor) { st.engine.reset(); for (const c of st.comp) c.fill(0); st.applied = 0; didReset = true; }
        const { date, player, dep, delta, n } = stream;
        const depList = model.depList, comp = st.comp, elig = st.elig, cobj = {};
        let a = st.applied;
        while (a < n && date[a] <= cur) {
            const p = player[a];
            if (elig[p]) {                         // skip events of players excluded by the bats/country filter
                comp[dep[a]][p] += delta[a];
                for (let di = 0; di < depList.length; di++) cobj[depList[di]] = comp[di][p];
                st.engine.applyEvent(p, model.xs.fn(cobj), model.ys.fn(cobj));
            }
            a++;
        }
        st.applied = a; st.lastCursor = cur;

        // Select the frontier objects back out of `unique` by coordinate (every engine
        // frontier point's (x,y) is a deduped cloud point), preserving canonical-X order.
        const frontier = [];
        for (const [x, y] of st.engine.frontierXY()) { const pt = pointByXY.get(x + "|" + y); if (pt) frontier.push(pt); }
        // GPU compute-accumulate stash. We expose the engine's TOTAL consumed-event count
        // (`applied` = a) and whether it restarted this frame (`zero`), NOT a per-frame
        // window — the GPU computes its own catch-up window from these (see
        // accumulateCloud), so it stays correct even across non-lite frames it skipped. No
        // frontier logic moves to the GPU; we only hand off bookkeeping it already did.
        const gpu = { applied: a, zero: didReset };
        return { filtered: flt, unique: uniq, frontier, gpu };
    }

    // Left-to-right best-in-class envelope over an already-sorted, deduped array.
    // Signed values handle "lower is better" axes. Shared by buildFrontier and
    // the onion-peeling layers so layer 0 == the single frontier.
    function sweepFrontier(sortedUniq) {
        const fr = [];
        for (const p of sortedUniq) {
            const py = p.y * ySign;
            while (fr.length && fr[fr.length - 1].y * ySign < py) fr.pop();
            if (fr.length && fr[fr.length - 1].y === p.y &&
                fr[fr.length - 1].x * xSign < p.x * xSign) fr.pop();
            fr.push(p);
        }
        return fr;
    }

    // Pareto depth (onion peeling): peel the frontier, re-sweep the remainder,
    // repeat up to maxDepth. layers[0] is the live frontier. The remainder stays
    // sorted, so each peel is O(pool), bounding total cost at depth × N.
    function paretoLayers(sortedUniq, maxDepth) {
        const layers = [];
        let pool = sortedUniq;
        for (let i = 0; i < maxDepth && pool.length; i++) {
            const fr = sweepFrontier(pool);
            const set = new Set(fr);
            layers.push(fr);
            pool = pool.filter(p => !set.has(p));
        }
        return layers;
    }

    const frontierResult =
        buildSmoothActiveFrontier() || buildEvtIncrementalFrontier() || buildFrontier(seasonMatches);
    const { filtered, unique, frontier } = frontierResult;
    const frontierSet = new Set(frontier);
    // Headless-verification hook: the current frontier's player keys + (x,y).
    window.__bl2d_frontierPids = frontier.map(d => d.playerID);
    window.__bl2d_frontierXY = frontier.map(d => [d.x, d.y]);
    // Dev assert (?verifyFrontier=1): the incremental frontier must equal a full sweep
    // of the same cloud, compared as an (x,y) coordinate multiset (tie-breaks may pick a
    // different equal-(x,y) object) — mirrors core.c verify_career/verify_season. A no-op
    // on the non-incremental path (frontier already == sweep there).
    if (VERIFY_FRONTIER) {
        const ref = sweepFrontier(unique);
        const tally = (arr) => { const m = new Map(); for (const d of arr) { const k = d.x + "|" + d.y; m.set(k, (m.get(k) || 0) + 1); } return m; };
        const refM = tally(ref), gotM = tally(frontier);
        let mis = 0;
        for (const [k, v] of refM) mis += Math.abs(v - (gotM.get(k) || 0));
        for (const [k, v] of gotM) if (!refM.has(k)) mis += v;
        window.__bl2d_verifyFrontier = { mis, size: frontier.length, refSize: ref.length, cursor: pbpCursorIdx };
        if (mis > 0) console.warn(`[verifyFrontier] incremental≠sweep: ${mis} coord mismatch(es) at cursor ${pbpCursorIdx} (incremental ${frontier.length} vs sweep ${ref.length})`);
    }

    // Onion-peeling layers (layer 0 == frontier). depth=1 is the default and is
    // a no-op visually. Exposed for the headless invariant checks.
    const peelDepth = Math.max(1, Math.min(5, filters.depth || 1));
    const depthLayers = peelDepth > 1 ? paretoLayers(unique, peelDepth) : [frontier];
    window.__bl2d_depthLayers = depthLayers.map(l => l.length);

    // Era-vs-era: a second frontier over a different year window (same attribute
    // filters), used to overlay and quantify how much the primary era dominates.
    const compareEras = !!filters.compareEras && !animTimer;
    const sB = filters.sB | 0, eB = filters.eB | 0;
    const eraB = compareEras
        ? buildFrontier(p => p.yearID >= sB && p.yearID <= eB && attrMatches(p))
        : null;

    // "Global" reference frontier: same universe (year range + threshold) but
    // ignoring the attribute filters (league, team, country, handedness). Lets a
    // filtered view keep perspective on the all-MLB limit — drawn as a faint
    // dashed staircase, and used to freeze the axes so filtered points hold their
    // absolute position instead of rescaling to the subset.
    const attributeFiltered = league !== "all" || franchise !== "all" || country !== "all" || bats !== "all";
    const globalResult = (attributeFiltered && !animTimer)
        ? buildFrontier((p) => p.yearID >= sYear && p.yearID <= eYear)
        : null;
    const legendGlobalEl = document.getElementById("legend-global");
    if (legendGlobalEl) legendGlobalEl.hidden = true;

    // Lite frame (playing/scrubbing): skip the interaction-only work — hypervolume
    // contributions, frontier cards, spotlight, isolation rings, regret/HV overlays,
    // and the hover quadtree — so the moving frame is as cheap as the standalone demo.
    // A full (interactive) render fires when the cursor goes idle (see refreshChart).
    const lite = !!filters.lite;
    const hvInfo = lite
        ? { items: [], totalHv: 0, refPoint: { x: 0, y: 0 }, playerContribs: new Map() }
        : computeHvContributions(frontier, xSign, ySign, unique);
    const hvByPoint = new Map(hvInfo.items.map(it => [it.point, it]));
    if (!lite) {
        window.__bl2d_hv = {
            contributions: hvInfo.items.map(it => ({
                playerID: it.point.playerID, year: it.point.year,
                x: it.point.x, y: it.point.y,
                contribution: it.contribution, fraction: it.fraction,
            })),
            total: hvInfo.totalHv,
            reference: hvInfo.refPoint,
            xSign, ySign, xDim, yDim,
        };
        window.__bl2d_computeHv = computeHvContributions;
    }

    if (!lite) renderFrontierCards(frontier, xDim, yDim, formatStat, filtered.length, mode, hvByPoint);
    // Group-career: hide the auto-spotlight cards — with every group member "on the
    // frontier" they stack and overlap; the on-chart trails + labels are the story.
    if (filters.groupCareer || lite) {
        const psLayer = document.getElementById("player-spotlight");
        if (psLayer && filters.groupCareer) { psLayer.innerHTML = ""; psLayer.hidden = true; }
    } else {
        renderPlayerSpotlight(frontier, hvByPoint, xDim, yDim, formatStat, mode);
    }

    const svgEl = document.getElementById("scatter-plot");
    const rect = svgEl.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    pointRenderer.resize(width, height);

    if (unique.length === 0) {
        pointRenderer.clear();
        svg.append("text")
            .attr("x", "50%").attr("y", "50%")
            .attr("text-anchor", "middle").attr("dominant-baseline", "middle")
            .attr("font-family", "var(--font-sans, sans-serif)")
            .attr("font-size", 14)
            .attr("fill", "#5a6478")
            .text("No seasons match these filters — try widening the year range or lowering the minimum.");
        return;
    }

    // Reserve a strip at the bottom for the play-by-play progress bar when the overlay
    // is on, so the bar sits below the x-axis title instead of over it.
    const margin = { top: 24, right: 24, bottom: filters.smooth ? 66 : 44, left: 56 };
    const plotW = Math.max(40, width - margin.left - margin.right);
    const plotH = Math.max(40, height - margin.top - margin.bottom);

    // Data extents are computed up front so brush coordinates always resolve
    // against the full universe. The visible scale domain is either the
    // current viewDomain (brush result) or the data extent.
    // During animation, lock axes to the full-range extents so the frontier grows
    // visibly outward. Season mode uses raw points (all years). Career mode must
    // aggregate careers for ALL years first — that result is cached per session
    // so it only runs once, not on every 400ms tick.
    let xExtent, yExtent;
    if (animTimer) {
        const animKey = `${xDim}|${yDim}|${mode}|${league}|${bats}|${country}|${franchise}`;
        if (animExtentCache?.key !== animKey) animExtentCache = null;
        if (!animExtentCache) {
            let ex, ey;
            if (mode === "career") {
                // Aggregate every player's full career (all years, current non-year filters).
                const allByPlayer = new Map();
                for (const p of points) {
                    if (league !== "all" && p.lgID !== league) continue;
                    if (franchise !== "all" && FRANCHISE_BY_TEAM.get(p.teamID) !== franchise) continue;
                    if (bats !== "all" || country !== "all") {
                        const m = getMeta(p.playerID);
                        if (!m) continue;
                        if (bats !== "all" && m[handField] !== bats) continue;
                        if (country !== "all" && m.country !== country) continue;
                    }
                    let arr = allByPlayer.get(p.playerID);
                    if (!arr) { arr = []; allByPlayer.set(p.playerID, arr); }
                    arr.push(p);
                }
                const fullCareer = [];
                for (const seasons of allByPlayer.values()) {
                    seasons.sort((a, b) => a.yearID - b.yearID);
                    const agg = aggregateCareer(seasons, datasetKey);
                    agg.x = agg[xDim]; agg.y = agg[yDim];
                    if (!isNaN(agg.x) && !isNaN(agg.y)) fullCareer.push(agg);
                }
                ex = d3.extent(fullCareer, d => d.x);
                ey = d3.extent(fullCareer, d => d.y);
            } else {
                ex = d3.extent(points, d => { const v = +d[xDim]; return isFinite(v) ? v : undefined; });
                ey = d3.extent(points, d => { const v = +d[yDim]; return isFinite(v) ? v : undefined; });
            }
            animExtentCache = { key: animKey, x: ex, y: ey };
        }
        xExtent = animExtentCache.x;
        yExtent = animExtentCache.y;
    } else {
        animExtentCache = null;
        // When a global reference frontier is shown, scale to its (broader) extent
        // so filtered points keep their absolute position and the ghost line fits.
        const extentSource = globalResult ? globalResult.unique : unique;
        xExtent = d3.extent(extentSource, d => d.x);
        yExtent = d3.extent(extentSource, d => d.y);
    }
    // Smooth (game-by-game) sweep: lock the axes to the window's year-end envelope
    // (computed once per covered-year set) so the frontier grows into a fixed frame
    // instead of the axes jittering as cumulative totals climb.
    if (filters.pbpExtent) {
        if (filters.pbpExtent.x) xExtent = filters.pbpExtent.x;
        if (filters.pbpExtent.y) yExtent = filters.pbpExtent.y;
    }
    // Widen the domain so the comparison era's frontier isn't clipped.
    if (eraB && eraB.frontier.length && xExtent[0] != null) {
        xExtent = [Math.min(xExtent[0], d3.min(eraB.frontier, d => d.x)),
                   Math.max(xExtent[1], d3.max(eraB.frontier, d => d.x))];
        yExtent = [Math.min(yExtent[0], d3.min(eraB.frontier, d => d.y)),
                   Math.max(yExtent[1], d3.max(eraB.frontier, d => d.y))];
    }
    const xDomain = (viewDomain && viewDomain.x) || xExtent;
    const yDomain = (viewDomain && viewDomain.y) || yExtent;
    const xScale = d3.scaleLinear().domain(xDomain).nice().range([0, plotW]);
    const yScale = d3.scaleLinear().domain(yDomain).nice().range([plotH, 0]);
    updateZoomResetEnabled();
    const modelReady = performance.now();

    const g = svg.append("g")
        .attr("transform", `translate(${margin.left}, ${margin.top})`);

    g.append("g")
        .attr("class", "axis axis-x")
        .attr("transform", `translate(0, ${plotH})`)
        .call(d3.axisBottom(xScale).ticks(Math.max(4, Math.floor(plotW / 80))));

    g.append("g")
        .attr("class", "axis axis-y")
        .call(d3.axisLeft(yScale).ticks(Math.max(4, Math.floor(plotH / 50))));

    const xTitleEl = g.append("text")
        .attr("class", "axis-title")
        .attr("x", plotW / 2)
        .attr("y", plotH + 36)
        .attr("text-anchor", "middle")
        .style("cursor", "pointer")
        .on("click", function(event) { event.stopPropagation(); openAxisStatMenu(this, "x-axis-select", "up"); });
    xTitleEl.append("tspan").text(xSign === -1 ? `${xDim} ↓` : xDim);
    xTitleEl.append("tspan").attr("class", "axis-caret").text("  ▾");

    const yTitleEl = g.append("text")
        .attr("class", "axis-title")
        .attr("transform", `rotate(-90)`)
        .attr("x", -plotH / 2)
        .attr("y", -38)
        .attr("text-anchor", "middle")
        .style("cursor", "pointer")
        .on("click", function(event) { event.stopPropagation(); openAxisStatMenu(this, "y-axis-select", "right"); });
    yTitleEl.append("tspan").text(ySign === -1 ? `${yDim} ↓` : yDim);
    yTitleEl.append("tspan").attr("class", "axis-caret").text("  ▾");

    // Hover still surfaces the glossary definition; click opens the stat picker.
    if (GLOSSARY[xDim]) {
        xTitleEl.on("mouseenter", function() { if (glossaryShow) glossaryShow(this, xDim); })
            .on("mouseleave", function() { if (glossaryHide) glossaryHide(); });
    }
    if (GLOSSARY[yDim]) {
        yTitleEl.on("mouseenter", function() { if (glossaryShow) glossaryShow(this, yDim); })
            .on("mouseleave", function() { if (glossaryHide) glossaryHide(); });
    }

    // Frontier staircase: the true Pareto boundary — horizontal and vertical
    // segments only. Drawn sign-aware so the shaded "dominated" region always
    // falls toward the anti-ideal corner, even when an axis is lower-is-better
    // (e.g. SO vs TB) or the Worst-frontier toggle has flipped both signs.
    //
    // Approach: reflect each frontier vertex's screen point into the canonical
    // "both higher-is-better" orientation (ideal = top-right), run the standard
    // step construction there, then reflect the vertices back. For the common
    // (+,+) case `reflectScreen` is the identity, so this stays byte-identical
    // to the previous drawing.
    const xAnti = xSign > 0 ? 0 : plotW;            // screen x of the worst-x edge
    const yAnti = ySign > 0 ? plotH : 0;            // screen y of the worst-y edge
    const idealCorner = [xSign > 0 ? plotW : 0, ySign > 0 ? 0 : plotH];
    const reflectScreen = ([sx, sy]) => [xSign > 0 ? sx : plotW - sx, ySign > 0 ? sy : plotH - sy];
    function staircaseScreen(fr) {
        if (!fr.length) return [[xAnti, yAnti]];
        // fr is sorted by x*xSign ascending, so reflected x is ascending too.
        const P = fr.map(p => reflectScreen([xScale(p.x), yScale(p.y)]));
        const R = [[0, P[0][1]]];                   // left cap at first point's y
        for (let i = 0; i < P.length; i++) {
            R.push([P[i][0], P[i][1]]);
            if (i < P.length - 1) R.push([P[i][0], P[i + 1][1]]);  // drop to next y
        }
        R.push([P[P.length - 1][0], plotH]);        // bottom drop at last x
        return R.map(reflectScreen);                // involution: reflect back
    }

    // Global reference frontier (drawn first so it sits behind the active frontier
    // and the cloud): a faint dashed staircase + muted dots marking the all-MLB
    // limit for the current universe, ignoring the attribute filters.
    if (globalResult && globalResult.frontier.length) {
        const gLine = staircaseScreen(globalResult.frontier);
        g.append("path")
            .attr("class", "global-frontier-ghost")
            .attr("d", "M " + gLine.map(p => p.join(",")).join(" L "))
            .style("fill", "none")
            .style("stroke", "#8a93a6")
            .style("stroke-width", 1.5)
            .style("stroke-dasharray", "5 4")
            .style("opacity", 0.7);
        g.selectAll("circle.global-frontier-ghost-dot")
            .data(globalResult.frontier)
            .join("circle")
            .attr("class", "global-frontier-ghost-dot")
            .attr("cx", d => xScale(d.x))
            .attr("cy", d => yScale(d.y))
            .attr("r", 2.5)
            .style("fill", "#8a93a6")
            .style("opacity", 0.65);
        if (legendGlobalEl) legendGlobalEl.hidden = false;
    }

    // Onion-peeling: draw the deeper Pareto layers (1…n) behind the live
    // frontier, fading outward. Non-interactive so the real frontier keeps its
    // clicks, tooltips, and cards. Deepest first so layer 0 ends up on top.
    if (depthLayers.length > 1) {
        const dg = g.append("g").attr("class", "depth-layers");
        for (let i = depthLayers.length - 1; i >= 1; i--) {
            const layer = depthLayers[i];
            if (!layer.length) continue;
            const pts = staircaseScreen(layer);
            const poly = "M " + pts.map(p => p.join(",")).join(" L ");
            // Dominated-region fill — nested layers stack so the tone deepens
            // toward the inner layers, making the topographic depth read clearly.
            dg.append("path")
                .attr("class", "depth-shade")
                .attr("d", poly + " L " + xAnti + "," + yAnti + " Z");
            // Staircase + dots; gentle fade so each layer's boundary still reads.
            const op = Math.max(0.3, 0.9 * Math.pow(0.72, i));
            dg.append("path")
                .attr("class", "depth-staircase")
                .attr("d", poly)
                .style("opacity", op);
            dg.append("g").selectAll("circle")
                .data(layer).enter().append("circle")
                .attr("class", "depth-dot")
                .attr("cx", d => xScale(d.x))
                .attr("cy", d => yScale(d.y))
                .attr("r", 3)
                .style("opacity", op);
        }
    }

    // ── Optional GPU compute-accumulate cloud gate ──────────────────────────────
    // When ALL of these hold, the high-cardinality .evt-career cloud is accumulated +
    // drawn on the GPU (see the WEBGPU_ACCUM_WGSL block) instead of rebuilt on the CPU
    // each frame. Any miss falls back to the existing CPU instanced cloud with NO visual
    // change — the gate is a strict subset of the conditions under which the JS
    // incremental frontier ran, so frontierResult.gpu is guaranteed present when true:
    //   1. the active backend is WebGPU;
    //   2. this is the .evt play-by-play CAREER cloud (filters.evt is set only for the
    //      evt-career path — evt-season omits it; note drawMode is "season" for both,
    //      so we key off filters.evt, NOT the mode argument);
    //   3. the resident model matches the active axes;
    //   4. both axes are counting (non-rate) …
    //   5. … AND a monotone-nondecreasing linear combination of streamed components, so a
    //      per-player running sum is exact — single (HR, SB) OR composite (TB, PA), but
    //      never a stat that can decrease (evtGpuMonotone);
    //   6. the era colour encoding (the GPU cloud only paints era — others fall back);
    //   7. no sign inversion (worst-frontier flips the [0,max] mapping);
    //   8. no bats/country filter (an eligibility mask would desync GPU counters from
    //      the JS shadow, breaking the counterMis invariant — fall back instead);
    //   9. a "lite" (playback/scrub) frame only — paused/idle frames keep the CPU cloud
    //      so hover hit-testing + the quadtree still work on real point objects;
    //  10. the event stream uploaded OK for this model (idempotent; first frame pays it).
    // Computed HERE (before the staircase/frontier-dot rendering) because gpuSpring gates
    // whether those CPU draws are suppressed in favour of the GPU's own frontier output.
    const gpuCloud = !!(
        pointRenderer instanceof WebGPURenderer &&
        filters.evt &&
        pbpEvt && pbpEvt.xDim === xDim && pbpEvt.yDim === yDim &&
        !pbpEvt.xs.rate && !pbpEvt.ys.rate &&
        evtGpuMonotone(pbpEvt).ok &&
        colorBy === "era" &&
        xSign === 1 && ySign === 1 && !showWorstFrontier &&
        bats === "all" && country === "all" &&
        filters.lite &&
        frontierResult.gpu &&
        pointRenderer.uploadEvtStream(pbpEvt)
    );
    window.__bl2d_evtGpuCloud = gpuCloud;
    // Phase-5 gpuStreaming engine active this frame (?gpustream=1 + a GPU cloud frame):
    // the GPU owns the WHOLE picture — spring-smoothed cloud, the GPU skyline frontier
    // dots, and the GPU staircase — so we suppress the CPU frontier dots AND the SVG
    // staircase below (the cheap JS incremental frontier still runs, but only to feed
    // DOM/interaction: cards, the quadtree hit-test, labels). See §"Phase 5".
    const gpuSpring = gpuCloud && pointRenderer.springMode;
    window.__bl2d_gpuSpring = gpuSpring;
    lastGpuSpringFrame = gpuSpring;   // gate the glide loop: a CPU-fallback frame parks it

    // Group-career suppresses the staircase + HV shade: with only a handful of
    // career dots tracing trajectories, the Pareto envelope clutters more than it
    // clarifies — the focus is the trails + heads.
    // Under gpuSpring the GPU owns BOTH the red staircase line (drawIndirect) AND the cloud,
    // drawn from the spring-animated pos[] that lag the true values during a glide. The HV
    // shade + SVG line here are built from the CPU frontier's *settled* values, so drawing
    // them would put the shaded area (and a duplicate line) AHEAD of the gliding red line.
    // Skip both while the GPU spring animates; a paused/idle frame is a CPU frame where the
    // line and fill agree, so the shade returns the instant playback stops.
    if (frontier.length > 0 && !filters.groupCareer && !gpuSpring) {
        const line = staircaseScreen(frontier);

        // Hypervolume shading: gradient fill of the dominated region beneath the
        // staircase, fading from the ideal corner toward the anti-ideal corner.
        const hvColor = showWorstFrontier ? "#8b5cf6" : "#002D72";
        const defs = svg.select("defs").empty() ? svg.append("defs") : svg.select("defs");
        defs.select("#hv-shade-grad").remove();
        const grad = defs.append("linearGradient")
            .attr("id", "hv-shade-grad")
            .attr("gradientUnits", "userSpaceOnUse")
            .attr("x1", idealCorner[0]).attr("y1", idealCorner[1])
            .attr("x2", xAnti).attr("y2", yAnti);
        grad.append("stop").attr("offset", "0%").attr("stop-color", hvColor).attr("stop-opacity", 0.10);
        grad.append("stop").attr("offset", "100%").attr("stop-color", hvColor).attr("stop-opacity", 0.01);

        g.append("path")
            .attr("class", "hv-shade")
            .attr("d", "M " + xAnti + "," + yAnti + " L " + line.map(p => p.join(",")).join(" L ") + " Z")
            .style("fill", "url(#hv-shade-grad)");

        g.append("path")
            .attr("class", "frontier-staircase")
            .attr("d", "M " + line.map(p => p.join(",")).join(" L "))
            .style("stroke", showWorstFrontier ? "#8b5cf6" : null);
    }

    // Era-vs-era overlay: the comparison frontier (teal) + its dominated region,
    // plus a coverage headline = how much of B's objective space the primary era
    // also dominates (grid-sampled, sign-aware so "lower is better" axes work).
    if (eraB && eraB.frontier.length) {
        const bPts = staircaseScreen(eraB.frontier);
        const eg = g.append("g").attr("class", "era-b-layer");
        eg.append("path")
            .attr("class", "era-b-shade")
            .attr("d", "M " + xAnti + "," + yAnti + " L " + bPts.map(p => p.join(",")).join(" L ") + " Z");
        eg.append("path")
            .attr("class", "era-b-staircase")
            .attr("d", "M " + bPts.map(p => p.join(",")).join(" L "));
        eg.selectAll("circle.era-b-dot")
            .data(eraB.frontier).enter().append("circle")
            .attr("class", "era-b-dot")
            .attr("cx", d => xScale(d.x)).attr("cy", d => yScale(d.y)).attr("r", 3.5);

        const domBy = (fr, cx, cy) => fr.some(a => a.x * xSign >= cx * xSign && a.y * ySign >= cy * ySign);
        let covNum = 0, covDen = 0;
        const N = 48;
        for (let i = 0; i < N; i++) {
            for (let j = 0; j < N; j++) {
                const cx = xExtent[0] + (i + 0.5) / N * (xExtent[1] - xExtent[0]);
                const cy = yExtent[0] + (j + 0.5) / N * (yExtent[1] - yExtent[0]);
                if (domBy(eraB.frontier, cx, cy)) { covDen++; if (domBy(frontier, cx, cy)) covNum++; }
            }
        }
        const coverage = covDen ? Math.round(covNum / covDen * 100) : 0;
        window.__bl2d_eraCoverage = coverage;
        eg.append("text")
            .attr("class", "era-b-label")
            .attr("x", 8).attr("y", 16)
            .text(`${sYear}–${eYear} dominates ${coverage}% of ${sB}–${eB}`);
    } else {
        window.__bl2d_eraCoverage = null;
    }

    // Overlay group for HV contribution polygons (hover + pinned player).
    const hvRectGroup = g.append("g").attr("class", "hv-contrib-overlay");

    const hvPlayerMap = hvInfo.playerContribs || new Map();
    const frontierSeasonCount = new Map();
    for (const p of frontier) frontierSeasonCount.set(p.playerID, (frontierSeasonCount.get(p.playerID) || 0) + 1);

    // Staircase path helper (screen coords) shared by hover and pinned overlays.
    // Reuses the sign-aware staircase, then appends the anti-ideal corner so two
    // staircases (frontier vs alt-frontier) enclose a well-defined ribbon — the
    // exclusive dominated area — for any axis orientation.
    function staircasePts(fr) {
        if (!fr.length) return [[xAnti, yAnti], [xAnti, yAnti]];
        return [...staircaseScreen(fr), [xAnti, yAnti]];
    }

    // Draw alt-frontier line + shaded polygon + label into hvRectGroup.
    function drawHvOverlay(altFr, suffix, labelX, labelY, fraction) {
        const fPts  = staircasePts(frontier);
        const afPts = staircasePts(altFr);
        hvRectGroup.append("path")
            .attr("class", `hv-alt-frontier hv-contrib-overlay--${suffix}`)
            .attr("d", "M " + afPts.map(p => p.join(",")).join(" L "));
        hvRectGroup.append("polygon")
            .attr("class", `hv-contrib-poly hv-contrib-overlay--${suffix}`)
            .attr("points", [...fPts, ...[...afPts].reverse()].map(p => p.join(",")).join(" "));
        if (fraction != null) {
            hvRectGroup.append("text")
                .attr("class", `hv-contrib-label hv-contrib-overlay--${suffix}`)
                .attr("x", labelX + 8)
                .attr("y", labelY - 8)
                .attr("text-anchor", "start")
                .text(`−${(fraction * 100).toFixed(2)}% of frontier area`);
        }
    }

    // Re-sweep unique excluding all points satisfying the predicate.
    function sweepExcluding(exclude) {
        const fr = [];
        for (const p of unique) {
            if (exclude(p)) continue;
            const py = p.y * ySign;
            while (fr.length && fr[fr.length - 1].y * ySign < py) fr.pop();
            if (fr.length && fr[fr.length - 1].y === p.y &&
                fr[fr.length - 1].x * xSign < p.x * xSign) fr.pop();
            fr.push(p);
        }
        return fr;
    }

    // HV of a frontier using the same reference point as computeHvContributions.
    const Rx_s = hvInfo.refPoint.x * xSign;
    const Ry_s = hvInfo.refPoint.y * ySign;
    function hvOf(fr) {
        let hv = 0, xPrev = Rx_s;
        for (const p of fr) { hv += (p.x * xSign - xPrev) * (p.y * ySign - Ry_s); xPrev = p.x * xSign; }
        return hv;
    }

    const pointRadius = unique.length > 2000 ? 3 : (unique.length > 500 ? 4 : 5);
    const frontierRadius = 6;
    const FRONTIER_R_MIN = 4, FRONTIER_R_MAX = 11;
    const maxContrib = hvInfo.items.reduce((m, it) => it.contribution > m ? it.contribution : m, 0) || 1;
    const radiusFor = d => {
        if (!hvEncodingEnabled) return frontierRadius;
        const it = hvByPoint.get(d);
        if (!it) return frontierRadius;
        return FRONTIER_R_MIN + (FRONTIER_R_MAX - FRONTIER_R_MIN) * Math.sqrt(it.contribution / maxContrib);
    };
    const hoverRadius = Math.max(pointRadius + 4, hvEncodingEnabled ? FRONTIER_R_MAX + 4 : 8);

    const regular = unique.filter(d => !frontierSet.has(d));
    const special = unique.filter(d => frontierSet.has(d));

    const cloudOpacity = careerHighlights.size > 0 ? 0.1 : themeCloudOpacity;
    const smoothOpenYear = filters.smooth ? eYear : null;

    // .evt: every point's (x,y) moves each frame (cumulative grows), so the whole cloud
    // goes on the redrawn-every-frame foreground; the cached background would freeze it.
    // .bl2p accumulating: completed seasons are static → cache them on the background.
    const backgroundPoints = (filters.groupCareer || filters.evt)
        ? []
        : filters.smooth
        ? unique.filter(d => d.year < smoothOpenYear)
        : regular;
    // When the GPU cloud is active it draws the regular .evt cloud itself, so keep the
    // CPU foreground cloud empty (highlight heads still flow through it below).
    const foregroundCloudPoints = gpuCloud
        ? []
        : filters.evt
        ? regular
        : filters.smooth
        ? regular.filter(d => d.year >= smoothOpenYear)
        : [];
    const bgKey = [
        filters.smooth ? "smooth" : "static",
        smoothOpenYear ?? "all",
        document.documentElement.dataset.theme || "",
        sYear, eYear, mode, datasetKey, minPa, league, bats, country, franchise,
        xDim, yDim, colorBy, cloudOpacity, pointRadius,
        xScale.domain().join(","), yScale.domain().join(","),
        width, height, pointRenderer.dpr,
        backgroundPoints.length,
    ].join("|");
    if (pointRenderer.bgCacheKey !== bgKey) {
        pointRenderer.drawBackground(backgroundPoints, {
            margin, xScale, yScale,
            radius: pointRadius,
            fillFor: d => colorOf(d, colorBy, getMeta),
            alpha: cloudOpacity,
        });
        pointRenderer.bgCacheKey = bgKey;
    }

    // Career-highlight layer: dots only (no connecting line — the
    // year-order trail tended to add zigzag noise more than it clarified
    // the trajectory). Rendered BEFORE the red frontier dots so the
    // clicked-on frontier point keeps its red marker on top.
    // During the smooth sweep we highlight each selected player's CURRENT points
    // (their as-of-date seasons in the active window, so the open season's dot
    // grows with the cursor) and pin a name label to the live (latest) one — so a
    // selected player like Ohtani is highlighted and named the moment their season
    // opens, even before they reach the frontier. (On-frontier seasons already get
    // their highlight colour + a frontier label, so we skip the extra label there.)
    // Outside smooth mode we fall back to the player's full-career season dots.
    const highlightLabels = [];
    const highlightDrawPoints = [];
    if (careerHighlights.size > 0) {
        for (const [pid, hcolor] of careerHighlights) {
            let pts;
            if (filters.smooth) {
                // buildFrontier points carry `.year` (not `.yearID`), `.x`, `.y`.
                pts = filtered.filter(d => d.playerID === pid && !isNaN(d.x) && !isNaN(d.y));
                if (pts.length) {
                    const live = pts.reduce((a, b) => (b.year >= a.year ? b : a));
                    // Group-career: every member always carries a name label (there's
                    // no red frontier to label them) and records a trail position.
                    const onFrontier = frontier.some(fp => fp.playerID === pid && fp.year === live.year);
                    if (filters.groupCareer || !onFrontier) highlightLabels.push({ x: xScale(live.x), y: yScale(live.y), text: lastNameOf(pid), color: hcolor });
                    if (filters.groupCareer) {
                        // Append the player's current career position to its trail, but
                        // only when the cursor has strictly advanced — the play loop and
                        // FLIP both re-draw the same cursor, which would dup points.
                        const hist = groupTrailHistory.get(pid) || [];
                        const last = hist[hist.length - 1];
                        if (!last || pbpCursorIdx > last.cursor) {
                            hist.push({ x: live.x, y: live.y, cursor: pbpCursorIdx });
                            if (hist.length > GROUP_TRAIL_LEN) hist.shift();
                            groupTrailHistory.set(pid, hist);
                        }
                    }
                }
            } else if (playerIndex && playerIndex.has(pid)) {
                pts = playerIndex.get(pid)
                    .map(p => ({ x: p[xDim], y: p[yDim], year: p.yearID }))
                    .filter(s => !isNaN(s.x) && !isNaN(s.y));
            } else {
                pts = [];
            }
            if (!pts.length) continue;
            for (const p of pts) highlightDrawPoints.push({ ...p, _highlightColor: hcolor });
        }
    }

    const frontierColor = showWorstFrontier ? "#8b5cf6" : null;  // purple for worst, red (CSS) for best
    // Group-career: paint the fading trails on the fg canvas FIRST (drawTrails clears
    // it), then composite the head-dots on top (clear:false) so heads always sit over
    // their tails.
    if (filters.groupCareer && pointRenderer.fgCanvas) {
        const trails = [...careerHighlights].map(([pid, color]) => ({ color, points: groupTrailHistory.get(pid) || [] }));
        pointRenderer.drawTrails(trails, { margin, xScale, yScale, width: 2.5 });
    }
    const foregroundDrawPoints = foregroundCloudPoints.map(d => ({ ...d, _regularCloud: true }))
        .concat(highlightDrawPoints);
    const headRadius = filters.groupCareer ? 7 : Math.max(pointRadius + 3, 6);
    pointRenderer.drawForeground(foregroundDrawPoints, {
        margin, xScale, yScale,
        radius: d => d._regularCloud ? pointRadius : headRadius,
        fillFor: d => d._regularCloud ? colorOf(d, colorBy, getMeta) : d._highlightColor,
        alpha: 1,
        alphaFor: d => d._regularCloud ? cloudOpacity : 1,
        strokeFor: d => d._regularCloud ? null : "#ffffff",
        strokeWidth: 1.5,
        clear: !filters.groupCareer,               // keep the trails drawn just above
    });
    if (!filters.groupCareer && pointRenderer.fgCanvas && !gpuSpring) {
        // Frontier dots composite over the fg cloud (no clear). They follow the active
        // Color-by encoding (era / league / bats), same as the cloud — staying distinct
        // via size + the white ring, not a fixed colour, so the encoding isn't
        // misrepresented; career/worst colours win when set. Skipped under gpuSpring —
        // the GPU skyline draws the frontier dots itself (from onFront[]).
        pointRenderer.drawFrontierDots(special, {
            margin, xScale, yScale, radiusFor,
            fillFor: d => careerHighlights.get(d.playerID) || frontierColor || colorOf(d, colorBy, getMeta),
            strokeColor: "#ffffff", strokeWidth: 1.5,
        });
    }
    // GPU compute-accumulate cloud: hand the renderer this frame's event window (from the
    // JS incremental frontier) + the D3-linear axis mapping, so present() runs the compute
    // dispatch and draws the cloud vertex-pulled from the per-player counters.
    if (gpuCloud) {
        pointRenderer.accumulateCloud({
            win: frontierResult.gpu,
            instanceCount: pbpEvt.players.length,
            scales: gpuScaleUniform(xScale, yScale, margin, width, height, pointRadius, cloudOpacity),
        });
    }
    // Composite the accumulated layers (no-op for Canvas 2D, which painted as it went;
    // the WebGPU backend submits its single render pass here).
    pointRenderer.present();

    // FLIP: animate dots from their previous screen positions to the new ones.
    // Hit circles (tooltip targets) are updated instantly — they must match the
    // final dot positions, not the animated intermediate ones.
    // Performance guard: tweening tens of thousands of SVG circles is the lag the
    // Canvas-migration backlog item describes. Above this many dots, snap them
    // (the staircase + shade still morph cheaply below).
    const FLIP_DOT_CAP = 6000;
    if (FLIP_DURATION > 0 && flipPos.size > 0 && flipPos.size <= FLIP_DOT_CAP) {
        svg.selectAll(".regular-point, .special-point").each(function(d) {
            if (!d || !d.playerID) return;
            const key = d.playerID + "|" + (d.year ?? d.yearID ?? "");
            const old = flipPos.get(key);
            if (!old) return;
            const newCx = +this.getAttribute("cx");
            const newCy = +this.getAttribute("cy");
            if (Math.abs(newCx - old.cx) < 0.5 && Math.abs(newCy - old.cy) < 0.5) return;
            d3.select(this)
                .attr("cx", old.cx).attr("cy", old.cy)
                .transition().duration(FLIP_DURATION).ease(d3.easeCubicOut)
                .attr("cx", newCx).attr("cy", newCy);
        });
    }

    // Fade in staircase and shade on interactive changes only — during animation
    // playback the boundary updates every tick, so fading from 0 each time strobes.
    // This applies to BOTH the old ▶ animation (animTimer) and the smooth/group-career
    // cursor (filters.smooth, driven by pbpRaf) — suppress the fade in either.
    if (FLIP_DURATION > 0 && !animTimer && !filters.smooth) {
        const newStair = svg.select("path.frontier-staircase");
        const newStairD = newStair.node() ? newStair.node().getAttribute("d") : null;
        newStair
            .style("opacity", 0)
            .transition().duration(FLIP_DURATION).ease(d3.easeCubicOut)
            .style("opacity", 0.55);
        svg.selectAll("path.hv-shade")
            .style("opacity", 0)
            .transition().duration(FLIP_DURATION).ease(d3.easeCubicOut)
            .style("opacity", 1);
        // Ghost the outgoing staircase: a dashed copy of the old path that fades
        // and clears, so the frontier visibly "redraws" rather than snapping.
        if (oldStairD && newStairD && oldStairD !== newStairD) {
            newStair.node().parentNode.insertBefore(
                (() => {
                    const g = document.createElementNS("http://www.w3.org/2000/svg", "path");
                    g.setAttribute("d", oldStairD);
                    g.setAttribute("class", "frontier-staircase-ghost");
                    return g;
                })(),
                newStair.node()
            );
            svg.select("path.frontier-staircase-ghost")
                .style("opacity", 0.5)
                .transition().duration(FLIP_DURATION).ease(d3.easeCubicOut)
                .style("opacity", 0)
                .remove();
        }
    }

    // On-chart frontier labels: greedy collision avoidance, mobile shows
    // only the two extreme endpoints so small viewports stay readable.
    // HV radius applies only to .special-point; career-trail dots stay at the
    // constant size set by pointRadius+3 so the gold layer remains a clean
    // per-season encoding.
    const labelRadius = hvEncodingEnabled ? FRONTIER_R_MAX : frontierRadius;
    // Group-career members are labelled by their own persistent name labels below,
    // so skip the frontier-label layout (there's no visible frontier in this mode).
    const labels = filters.groupCareer ? [] : layoutFrontierLabels(frontier, xScale, yScale, plotW, plotH, labelRadius, width < 480);
    // Leader lines for dodged labels (drawn under the text).
    g.append("g")
        .attr("class", "frontier-leaders")
        .selectAll("line")
        .data(labels.filter(d => d.leader)).enter()
        .append("line")
        .attr("class", "frontier-leader")
        .attr("x1", d => d.leader.x1)
        .attr("y1", d => d.leader.y1)
        .attr("x2", d => d.leader.x2)
        .attr("y2", d => d.leader.y2);
    g.append("g")
        .attr("class", "frontier-labels")
        .selectAll("text")
        .data(labels).enter()
        .append("text")
        .attr("class", d => d.small ? "frontier-label frontier-label--mobile" : "frontier-label")
        .attr("x", d => d.x)
        .attr("y", d => d.y)
        .attr("text-anchor", d => d.anchor)
        .text(d => d.text);

    // Persistent name labels for selected players during the smooth sweep (their
    // live, off-frontier point). White halo via paint-order so they read over the
    // dimmed cloud; coloured to match the player's highlight.
    if (highlightLabels.length) {
        g.append("g").attr("class", "highlight-labels")
            .selectAll("text")
            .data(highlightLabels).enter()
            .append("text")
            .attr("class", "frontier-label")
            .attr("x", d => d.x + 9)
            .attr("y", d => d.y + 4)
            .attr("text-anchor", "start")
            .style("fill", d => d.color)
            .style("paint-order", "stroke")
            .style("stroke", "#ffffff")
            .style("stroke-width", "3px")
            .text(d => d.text);
    }

    // Isolation ring: precompute nearest-neighbour distance (pixel space) for each
    // frontier point. Drawn on hover; locked in place by click.
    const isoRingColor = d => showWorstFrontier ? "#8b5cf6"
        : (COLOR_PALETTES.league[d.lgID] || COLOR_PALETTES.league.unknown).dark;
    const isolationMap = new Map();
    if (!lite) for (const fp of frontier) {
        const fpx = xScale(fp.x), fpy = yScale(fp.y);
        let minDist = Infinity, nearestPoint = null;
        for (const q of unique) {
            if (q === fp) continue;
            const dx = xScale(q.x) - fpx, dy = yScale(q.y) - fpy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) { minDist = dist; nearestPoint = q; }
        }
        const nx = nearestPoint ? xScale(nearestPoint.x) : fpx;
        const ny = nearestPoint ? yScale(nearestPoint.y) : fpy;
        isolationMap.set(fp, { cx: fpx, cy: fpy, r: isFinite(minDist) ? minDist : 0, nx, ny });
    }

    const ringGroup = g.append("g").attr("class", "isolation-ring-group");
    const regretGroup = g.append("g").attr("class", "regret-line-group");

    // When players are career-highlighted, show the combined polygon for what
    // the frontier loses if all their seasons were removed. Skipped in group-career
    // mode — there's no background frontier to measure "loss" against there.
    if (careerHighlights.size > 0 && !filters.groupCareer && !lite) {
        const highlightedPids = new Set(careerHighlights.keys());
        const frSeasons = frontier.filter(p => highlightedPids.has(p.playerID));
        if (frSeasons.length > 0) {
            const altFr = sweepExcluding(p => highlightedPids.has(p.playerID));
            const combinedFrac = hvInfo.totalHv > 0
                ? (hvInfo.totalHv - hvOf(altFr)) / hvInfo.totalHv : 0;
            const lx = frSeasons.reduce((s, p) => s + xScale(p.x), 0) / frSeasons.length;
            const ly = frSeasons.reduce((s, p) => s + yScale(p.y), 0) / frSeasons.length;
            drawHvOverlay(altFr, "pinned", lx, ly, combinedFrac);
        }
    }

    // Tooltip targets: invisible larger circles to ease hover/tap on every point.
    const tooltip = document.getElementById("tooltip");
    const showTooltip = (event, d) => {
        const seasons = filtered.filter(p => p.x === d.x && p.y === d.y);
        const head = `<div class="tooltip-header">${xDim} ${formatStat(xDim, d.x)} · ${yDim} ${formatStat(yDim, d.y)}</div>`;
        let hvLine = "";
        if (frontierSet.has(d) && hvByPoint.has(d)) {
            const it = hvByPoint.get(d);
            hvLine = `<div class="tooltip-subheader">Controls ${(it.fraction * 100).toFixed(2)}% of the frontier area</div>`;
            const nSeasons = frontierSeasonCount.get(d.playerID) || 0;
            if (nSeasons > 1) {
                const pi = hvPlayerMap.get(d.playerID);
                if (pi) hvLine += `<div class="tooltip-subheader">All ${nSeasons} seasons combined: ${(pi.fraction * 100).toFixed(2)}%</div>`;
            }
        }
        let regretLine = "";
        let regretInfo = null;
        if (!frontierSet.has(d)) {
            regretInfo = computeDistToFrontier([d], frontier, xSign, ySign, xExtent, yExtent).get(d);
            if (regretInfo) regretLine = `<div class="tooltip-subheader">${(regretInfo.dist * 100).toFixed(1)}% from the limit</div>`;
        }
        const visible = seasons.slice(0, 6);
        const body = visible.map(s => {
            const meta = mode === "career"
                ? `${s.year}–${s.yearLast} (${s.seasonsCount})`
                : `${escapeHtml(s.teamID)} ${escapeHtml(s.lgID)} ${s.year}`;
            return `
                <div class="tooltip-row">
                    <span class="tooltip-name">${escapeHtml(s.playerID)}</span>
                    <span class="tooltip-meta">${meta}</span>
                </div>
            `;
        }).join("");
        const more = seasons.length > visible.length
            ? `<div class="tooltip-more">+${seasons.length - visible.length} more season${seasons.length - visible.length === 1 ? "" : "s"}</div>`
            : "";
        tooltip.innerHTML = head + hvLine + regretLine + body + more;
        tooltip.setAttribute("data-visible", "true");
        positionTooltip(event, tooltip);
        // Show hover ring for frontier points (hover only, not when tooltip is pinned by click)
        ringGroup.select(".isolation-ring--hover").remove();
        hvRectGroup.selectAll(".hv-contrib-overlay--hover").remove();
        regretGroup.selectAll(".regret-line--hover").remove();
        if (!tooltipPinned && frontierSet.has(d)) {
            const iso = isolationMap.get(d);
            if (iso && iso.r > 0) {
                ringGroup.append("circle")
                    .attr("class", "isolation-ring isolation-ring--hover")
                    .attr("cx", iso.cx).attr("cy", iso.cy).attr("r", iso.r)
                    .style("stroke", isoRingColor(d));
            }
            // Re-sweep without d, shade the polygon of area d exclusively controls.
            if (hvByPoint.has(d)) {
                const altFr = sweepExcluding(p => p === d);
                drawHvOverlay(altFr, "hover", xScale(d.x), yScale(d.y), hvByPoint.get(d).fraction);
            }
        }
        if (!tooltipPinned && !frontierSet.has(d)) {
            if (regretInfo && regretInfo.dist > 0) {
                regretGroup.append("line")
                    .attr("class", "regret-line regret-line--hover")
                    .attr("x1", xScale(d.x)).attr("y1", yScale(d.y))
                    .attr("x2", xScale(regretInfo.targetX)).attr("y2", yScale(regretInfo.targetY));
            }
            // Ring to nearest frontier corner in screen space.
            let minPx = Infinity;
            for (const fp of frontier) {
                const dx = xScale(fp.x) - xScale(d.x), dy = yScale(fp.y) - yScale(d.y);
                const px = Math.sqrt(dx * dx + dy * dy);
                if (px < minPx) minPx = px;
            }
            if (isFinite(minPx) && minPx > 0) {
                regretGroup.append("circle")
                    .attr("class", "regret-ring regret-line--hover")
                    .attr("cx", xScale(d.x)).attr("cy", yScale(d.y))
                    .attr("r", minPx);
            }
        }
    };
    const hideTooltip = (force = false) => {
        if (tooltipPinned && !force) return;
        tooltip.setAttribute("data-visible", "false");
        ringGroup.select(".isolation-ring--hover").remove();
        hvRectGroup.selectAll(".hv-contrib-overlay--hover").remove();
        regretGroup.selectAll(".regret-line--hover").remove();
    };

    // Brush layer: drag a rectangle on empty chart area to zoom in. Mounted
    // BEFORE the hit circles so dot clicks still go to their handlers
    // (hit circles cover the dot area; the brush only sees mousedown on
    // empty space). Brush is only active in "brush" zoom mode.
    if (zoomMode === "brush") {
        const brush = d3.brush()
            .extent([[0, 0], [plotW, plotH]])
            .on("end", (event) => {
                if (!event.selection) return;
                const [[x0, y0], [x1, y1]] = event.selection;
                const dx = [xScale.invert(x0), xScale.invert(x1)];
                const dy = [yScale.invert(y1), yScale.invert(y0)];
                if (dx[0] >= dx[1] || dy[0] >= dy[1]) return;
                viewDomain = { x: dx, y: dy };
                // Clear the brush selection rectangle before redrawing so it
                // doesn't visually persist on top of the new view.
                d3.select(event.sourceEvent.currentTarget).call(brush.move, null);
                document.dispatchEvent(new CustomEvent("bl2d:refresh"));
            });
        g.append("g")
            .attr("class", "brush")
            .call(brush);
    } else if (zoomMode === "pan") {
        // Wheel zooms, drag pans. d3.zoom emits many events during a wheel
        // tick or pan drag; coalesce via requestAnimationFrame to keep the
        // ~5–50k filtered-point redraw responsive.
        const baseX = d3.scaleLinear().domain(xExtent).nice().range([0, plotW]);
        const baseY = d3.scaleLinear().domain(yExtent).nice().range([plotH, 0]);
        let rafPending = false;
        const zoom = d3.zoom()
            .scaleExtent([1, 80])
            .translateExtent([[0, 0], [plotW, plotH]])
            .extent([[0, 0], [plotW, plotH]])
            .filter((event) => {
                // Allow wheel + primary-button drag; ignore right-click + ctrl-wheel
                // (page zoom shortcut on Mac).
                if (event.type === "wheel") return !event.ctrlKey;
                return !event.button;
            })
            .on("zoom", (event) => {
                const t = event.transform;
                viewDomain = {
                    x: t.rescaleX(baseX).domain(),
                    y: t.rescaleY(baseY).domain(),
                };
                if (rafPending) return;
                rafPending = true;
                requestAnimationFrame(() => {
                    rafPending = false;
                    document.dispatchEvent(new CustomEvent("bl2d:refresh"));
                });
            });
        g.append("rect")
            .attr("class", "zoom-overlay")
            .attr("width", plotW)
            .attr("height", plotH)
            .attr("fill", "transparent")
            .style("cursor", "grab")
            .call(zoom)
            .on("mousedown.cursor", function() { this.style.cursor = "grabbing"; })
            .on("mouseup.cursor",   function() { this.style.cursor = "grab"; });
    }

    // Hover/click hit-testing — skipped on lite (animation) frames; rebuilt on the
    // idle full render so tooltips and click-to-pin work once the cursor settles.
    if (!lite) {
    const hitPoints = unique.map(d => ({ ...d, sx: xScale(d.x), sy: yScale(d.y), ref: d }));
    const hitTree = d3.quadtree()
        .x(d => d.sx)
        .y(d => d.sy)
        .addAll(hitPoints);
    let hoverTarget = null;
    const nearestHit = (event, node) => {
        const [mx, my] = d3.pointer(event, node);
        const hit = hitTree.find(mx, my, hoverRadius);
        return hit ? hit.ref : null;
    };
    const hitSurface = g.append("rect")
        .attr("class", "hit-surface")
        .attr("width", plotW)
        .attr("height", plotH)
        .attr("fill", "transparent")
        .style("cursor", "default")
        .on("mousemove", function(event) {
            const d = nearestHit(event, this);
            hoverTarget = d;
            this.style.cursor = d ? "pointer" : "default";
            if (d) showTooltip(event, d);
            else hideTooltip();
        })
        .on("mouseleave", () => {
            hoverTarget = null;
            hideTooltip();
        })
        .on("touchstart", function(event) {
            const d = nearestHit(event, this);
            if (d) showTooltip(event, d);
            else hideTooltip();
        }, { passive: true })
        .on("click", function(event) {
            const d = nearestHit(event, this) || hoverTarget;
            if (!d) {
                hideTooltip(true);
                return;
            }
            tooltipPinned = true;
            event.stopPropagation();
            if (frontierSet.has(d)) {
                // Clear any hover ring when clicking
                ringGroup.selectAll(".isolation-ring--hover").remove();
                // Season mode: also add career highlight (not in group-career —
                // the clicked head is already a member; tooltip is enough there).
                if (mode === "season" && !filters.groupCareer) {
                    const seasons = filtered
                        .filter(p => p.x === d.x && p.y === d.y)
                        .sort((a, b) => b.year - a.year);
                    const target = seasons[0] || d;
                    addHighlight(target.playerID);
                    syncPlayerHint();
                    document.dispatchEvent(new CustomEvent("bl2d:refresh"));
                }
            }
            showTooltip(event, d);
        });
    }

    // Hide tooltip on any tap outside a point (mobile).
    if (!lite) document.addEventListener("touchstart", (event) => {
        if (!event.target.closest("#scatter-plot")) hideTooltip();
    }, { passive: true });
    const frameEnd = performance.now();
    recordPbpFrameTiming(frameEnd - frameStart, modelReady - frameStart, frameEnd - modelReady, !!filters.smooth);
}


function positionTooltip(event, tooltip) {
    const pad = 12;
    const ttRect = tooltip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = event.clientX + pad;
    let y = event.clientY - ttRect.height - pad;
    if (x + ttRect.width + pad > vw) x = event.clientX - ttRect.width - pad;
    if (y < pad) y = event.clientY + pad;
    if (x < pad) x = pad;
    if (y + ttRect.height + pad > vh) y = vh - ttRect.height - pad;
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
}

function lastNameOf(playerID) {
    // Strip any disambiguator suffix like " (b.1969)" added for same-name
    // players, then take the last whitespace-separated token. The sidebar
    // cards and tooltip keep the full disambiguated name; only the compact
    // on-chart label uses just the last name.
    const stripped = String(playerID).replace(/\s*\([^)]*\)\s*$/, "");
    const m = stripped.match(/[^\s]+$/);
    return m ? m[0] : stripped;
}

function layoutFrontierLabels(frontier, xScale, yScale, plotW, plotH, pointR, isSmall) {
    if (!frontier.length) { window.__bl2d_labelOverlaps = 0; return []; }

    const overlap = (a, b) =>
        !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
    // Count post-layout overlaps among the placed boxes — the T3 invariant
    // (must be 0). Read headlessly via window.__bl2d_labelOverlaps.
    const recordOverlaps = (boxes) => {
        let n = 0;
        for (let i = 0; i < boxes.length; i++)
            for (let j = i + 1; j < boxes.length; j++)
                if (overlap(boxes[i], boxes[j])) n++;
        window.__bl2d_labelOverlaps = n;
    };

    // Measure real text width with a hidden <text> in the live SVG, so collision
    // boxes match what actually renders (replaces the old per-char estimate that
    // could under/over-shoot and let labels overlap).
    const svgNode = document.getElementById("scatter-plot");
    const measurer = document.createElementNS("http://www.w3.org/2000/svg", "text");
    measurer.setAttribute("class", isSmall ? "frontier-label frontier-label--mobile" : "frontier-label");
    measurer.setAttribute("visibility", "hidden");
    svgNode.appendChild(measurer);
    const measureW = (t) => { measurer.textContent = t; return measurer.getComputedTextLength(); };

    // On narrow phones: show full last names below each dot, laid out
    // left-to-right across two staggered rows, skipping a label only when it
    // would still collide horizontally with an already-placed one in both rows.
    if (isSmall) {
        const ROW_DY = 11, H = 10;
        const sorted = [...frontier].sort((a, b) => xScale(a.x) - xScale(b.x));
        const rowRight = [-Infinity, -Infinity];
        const out = [], boxes = [];
        for (const p of sorted) {
            const text = lastNameOf(p.playerID);
            const halfW = measureW(text) / 2;
            const cx = xScale(p.x);
            const left = cx - halfW;
            const row = left >= rowRight[0] + 2 ? 0 : (left >= rowRight[1] + 2 ? 1 : -1);
            if (row === -1) continue;   // too crowded here → drop this label
            const y = yScale(p.y) + pointR + 10 + row * ROW_DY;
            out.push({ text, x: cx, y, anchor: "middle", small: true });
            boxes.push({ x: left, y: y - H, w: halfW * 2, h: H });
            rowRight[row] = cx + halfW;
        }
        svgNode.removeChild(measurer);
        recordOverlaps(boxes);
        return out;
    }

    const H = 12;
    const GAP = 5;

    const pointBoxes = frontier.map(p => ({
        x: xScale(p.x) - pointR,
        y: yScale(p.y) - pointR,
        w: pointR * 2,
        h: pointR * 2,
    }));
    const placed = [];

    const out = [];
    for (const p of frontier) {
        const text = `${lastNameOf(p.playerID)} ${p.year}`;
        const w = measureW(text);
        const cx = xScale(p.x);
        const cy = yScale(p.y);

        // Try cardinal positions first, then diagonal corners as fallbacks
        // for points near the plot edges (e.g. the topmost frontier point).
        // `far` positions (index ≥ 2) sit off the dot and get a leader line.
        const positions = [
            // right
            { x: cx + pointR + GAP, y: cy + H / 3, anchor: "start",
              bx: cx + pointR + GAP, by: cy - H / 2 },
            // left
            { x: cx - pointR - GAP, y: cy + H / 3, anchor: "end",
              bx: cx - pointR - GAP - w, by: cy - H / 2 },
            // above
            { x: cx, y: cy - pointR - GAP, anchor: "middle",
              bx: cx - w / 2, by: cy - pointR - GAP - H },
            // below
            { x: cx, y: cy + pointR + GAP + H, anchor: "middle",
              bx: cx - w / 2, by: cy + pointR + GAP },
            // below-right
            { x: cx + pointR + GAP, y: cy + pointR + GAP + H, anchor: "start",
              bx: cx + pointR + GAP, by: cy + pointR + GAP },
            // below-left
            { x: cx - pointR - GAP, y: cy + pointR + GAP + H, anchor: "end",
              bx: cx - pointR - GAP - w, by: cy + pointR + GAP },
            // above-right
            { x: cx + pointR + GAP, y: cy - pointR - GAP, anchor: "start",
              bx: cx + pointR + GAP, by: cy - pointR - GAP - H },
            // above-left
            { x: cx - pointR - GAP, y: cy - pointR - GAP, anchor: "end",
              bx: cx - pointR - GAP - w, by: cy - pointR - GAP - H },
        ];

        for (let idx = 0; idx < positions.length; idx++) {
            const pos = positions[idx];
            const bbox = { x: pos.bx, y: pos.by, w, h: H };
            if (bbox.x < 0 || bbox.y < 0 || bbox.x + bbox.w > plotW || bbox.y + bbox.h > plotH) continue;
            if (placed.some(b => overlap(b, bbox))) continue;
            if (pointBoxes.some(b => overlap(b, bbox))) continue;
            placed.push(bbox);
            // Leader line for dodged (non-adjacent) placements: connect the dot
            // to the label box edge so a pushed-away label still reads as its dot's.
            const leader = idx >= 2
                ? { x1: cx, y1: cy, x2: bbox.x + bbox.w / 2, y2: bbox.y + (pos.by < cy ? bbox.h : 0) }
                : null;
            out.push({ text, x: pos.x, y: pos.y, anchor: pos.anchor, leader });
            break;
        }
    }
    svgNode.removeChild(measurer);
    recordOverlaps(placed);
    return out;
}


function renderFrontierCards(frontier, xDim, yDim, formatStat, totalUnits, mode = "season", hvByPoint = null) {
    const countEl = document.getElementById("frontier-count");
    const cardsEl = document.getElementById("frontier-cards");
    if (!countEl || !cardsEl) return;

    const unit = mode === "career" ? "careers" : "seasons";
    countEl.textContent = `${frontier.length} of ${totalUnits.toLocaleString()} ${unit}`;

    if (frontier.length === 0) {
        cardsEl.innerHTML = `<div class="frontier-empty">No ${unit} match the current filters.</div>`;
        return;
    }

    const ordered = [...frontier].sort((a, b) => b.x - a.x);

    cardsEl.innerHTML = ordered.map((p, i) => {
        const isCareer = mode === "career";
        const yearLabel = isCareer ? `${p.year}–${p.yearLast}` : String(p.year);
        const pinned = careerHighlights.has(p.playerID);
        const hv = hvByPoint && hvByPoint.has(p) ? hvByPoint.get(p).fraction : null;
        return `
            <div class="frontier-card${pinned ? " frontier-card--pinned" : ""}" role="listitem"
                 tabindex="0" data-pid="${escapeHtml(p.playerID)}"
                 aria-label="${escapeHtml(p.playerID)}, ${yearLabel}. ${xDim} ${formatStat(xDim, p.x)}, ${yDim} ${formatStat(yDim, p.y)}. Click to pin career.">
                <span class="frontier-rank">${i + 1}</span>
                <div class="frontier-card-main">
                    <div class="frontier-card-name">${escapeHtml(p.playerID)}</div>
                    <div class="frontier-card-sub">${yearLabel} · ${xDim} ${formatStat(xDim, p.x)} / ${yDim} ${formatStat(yDim, p.y)}${hv != null ? ` · <span class="frontier-card-hv">${(hv * 100).toFixed(0)}% area</span>` : ""}</div>
                </div>
            </div>
        `;
    }).join("");
}

// Career mini-plots for the spotlight card: two stacked sparklines — the X-axis
// stat and the Y-axis stat, each over the player's career — sharing one year
// timeline so they line up vertically and the time progression is clear. The
// frontier seasons are marked on both. Each stat is scaled to its own range.
function careerDualPlot(playerID, xDim, yDim, frontierYears) {
    if (!playerIndex || !playerIndex.has(playerID)) return "";
    const seasons = playerIndex.get(playerID)
        .map(s => ({ year: s.yearID, x: s[xDim], y: s[yDim] }))
        .filter(s => s.x != null && s.y != null && !isNaN(s.x) && !isNaN(s.y))
        .sort((a, b) => a.year - b.year);
    if (!seasons.length) return `<span class="frontier-spark-empty" aria-hidden="true"></span>`;
    const yMin = seasons[0].year, yMax = seasons[seasons.length - 1].year;
    const W = 100, H = 26;   // viewBox; stretched to row width (shared timeline)
    const X = (yr) => yMax === yMin ? W / 2 : ((yr - yMin) / (yMax - yMin)) * W;
    const row = (dim, key) => {
        const vals = seasons.map(s => s[key]);
        const mn = Math.min(...vals), mx = Math.max(...vals), range = mx - mn || 1;
        const Y = (v) => (H - 2) - ((v - mn) / range) * (H - 4);
        const pts = seasons.map(s => `${X(s.year).toFixed(1)},${Y(s[key]).toFixed(1)}`).join(" ");
        // Mark frontier seasons with a full-height tick (undistorted by the
        // non-uniform stretch, and aligned across both panels).
        const recs = seasons.filter(s => frontierYears.has(s.year))
            .map(s => `<line class="ps-mini-mark" x1="${X(s.year).toFixed(1)}" y1="0" x2="${X(s.year).toFixed(1)}" y2="${H}"/>`).join("");
        return `<div class="ps-dual-row"><span class="ps-dual-tag">${escapeHtml(dim)}</span>` +
            `<svg class="ps-mini" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" aria-hidden="true">` +
            `${recs}<polyline class="ps-mini-path" points="${pts}"/></svg></div>`;
    };
    return row(xDim, "x") + row(yDim, "y") +
        `<div class="ps-dual-years"><span>${yMin}</span><span>${yMax}</span></div>`;
}

// Player spotlight cards — one per pinned player. Each turns the pin into a
// moment: meta, a career sparkline (in the player's highlight color), how many
// frontier seasons they own and what share of the frontier area (summed
// hypervolume contribution), and the record seasons. Cards sit opposite the
// frontier, cascade when there are several, and are draggable.
function renderPlayerSpotlight(frontier, hvByPoint, xDim, yDim, formatStat, mode) {
    const layer = document.getElementById("player-spotlight");
    if (!layer) return;
    layer.innerHTML = "";
    if (careerHighlights.size === 0) { layer.hidden = true; return; }
    layer.hidden = false;
    // Forget drag positions for players no longer pinned.
    for (const k of [...spotlightPos.keys()]) if (!careerHighlights.has(k)) spotlightPos.delete(k);

    const unit = mode === "career" ? "careers" : "seasons";
    let idx = 0;
    for (const [pid, color] of careerHighlights) {
        const mine = frontier.filter(p => p.playerID === pid).sort((a, b) => b.year - a.year);
        const areaPct = hvByPoint
            ? mine.reduce((s, p) => s + (hvByPoint.has(p) ? hvByPoint.get(p).fraction : 0), 0) * 100
            : 0;
        const meta = metaFor(pid) || {};
        const nm = pid.replace(/\s*\(b\.\d+\)\s*/, "").trim();
        const initials = nm.split(/\s+/).map(w => w[0] || "").slice(0, 2).join("").toUpperCase();
        let span = "";
        if (playerIndex && playerIndex.has(pid)) {
            const yrs = playerIndex.get(pid).map(s => s.yearID);
            span = `${Math.min(...yrs)}–${Math.max(...yrs)}`;
        }
        const hand = activeDatasetKey === "pitching" ? meta.throws : meta.bats;
        const handLabel = hand ? `${activeDatasetKey === "pitching" ? "throws" : "bats"} ${hand}` : "";
        const sub = [span, handLabel, meta.country].filter(Boolean).join(" · ");
        const seasonRows = mine.slice(0, 5).map(p => {
            const yl = mode === "career" ? `${p.year}–${p.yearLast}` : String(p.year);
            return `<div class="ps-season"><span class="ps-season-yr">${yl}</span><span class="ps-season-val">${xDim} ${formatStat(xDim, p.x)} · ${yDim} ${formatStat(yDim, p.y)}</span></div>`;
        }).join("");

        const card = document.createElement("div");
        card.className = "ps-card";
        card.style.setProperty("--accent", color);
        // Dragged → honor; else cascade from the corner opposite the frontier
        // (bottom-left for Best, top-left for Worst) so cards don't cover it.
        const pos = spotlightPos.get(pid);
        if (pos) {
            card.style.left = pos.left + "px"; card.style.top = pos.top + "px";
        } else {
            // Top corner, opposite the bottom-left legend; cascades when several.
            // Best frontier's ideal corner (top-right) is usually empty → safe.
            const off = 12 + idx * 24;
            card.style.top = off + "px";
            card.style[showWorstFrontier ? "left" : "right"] = off + "px";
        }
        card.innerHTML =
            `<button type="button" class="ps-close" aria-label="Close player card" title="Close">` +
            `<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 2l10 10M12 2L2 12"/></svg></button>` +
            `<div class="ps-head"><div class="ps-mono" aria-hidden="true">${initials}</div>` +
            `<div class="ps-id"><div class="ps-name">${escapeHtml(nm)}</div><div class="ps-sub">${escapeHtml(sub)}</div></div></div>` +
            `<div class="ps-tiles">` +
            `<div class="ps-tile"><div class="ps-tile-num">${mine.length}</div><div class="ps-tile-lab">frontier ${unit}</div></div>` +
            `<div class="ps-tile"><div class="ps-tile-num">${areaPct.toFixed(areaPct < 10 ? 1 : 0)}%</div><div class="ps-tile-lab">of frontier area</div></div>` +
            `</div>` +
            (playerIndex && playerIndex.has(pid)
                ? `<div class="ps-spark-lab">Career by year</div>` +
                  `<div class="ps-dual">${careerDualPlot(pid, xDim, yDim, new Set(mine.map(p => p.year)))}</div>`
                : "") +
            (seasonRows ? `<div class="ps-seasons">${seasonRows}</div>` : "");
        // Don't let card clicks/drags bubble to the chart-region empty-click
        // handler (which clears highlights — that was hiding the card).
        card.addEventListener("mousedown", (e) => e.stopPropagation());
        card.addEventListener("click", (e) => e.stopPropagation());
        card.querySelector(".ps-close").addEventListener("click", (e) => {
            e.stopPropagation();
            removeHighlight(pid);
            spotlightPos.delete(pid);
            syncPlayerHint();
            document.dispatchEvent(new CustomEvent("bl2d:refresh"));
        });
        enableSpotlightDrag(card, card.querySelector(".ps-head"), pid);
        layer.appendChild(card);
        idx++;
    }
}

// Let the user drag a spotlight card by its header (within the chart region).
// The position persists across redraws via spotlightPos (keyed by playerID).
function enableSpotlightDrag(card, handle, pid) {
    if (!handle) return;
    handle.style.cursor = "move";
    const onDown = (e) => {
        if (e.target.closest(".ps-close")) return;   // let the close button work
        const pt = e.touches ? e.touches[0] : e;
        const parent = card.offsetParent || card.parentNode;
        const pr = parent.getBoundingClientRect();
        const cr = card.getBoundingClientRect();
        const grabX = pt.clientX - cr.left, grabY = pt.clientY - cr.top;
        const onMove = (ev) => {
            const p = ev.touches ? ev.touches[0] : ev;
            const left = Math.max(0, Math.min(pr.width - cr.width, p.clientX - pr.left - grabX));
            const top = Math.max(0, Math.min(pr.height - cr.height, p.clientY - pr.top - grabY));
            spotlightPos.set(pid, { left, top });
            card.style.left = left + "px"; card.style.top = top + "px";
            card.style.right = "auto"; card.style.bottom = "auto";
            if (ev.cancelable) ev.preventDefault();
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            window.removeEventListener("touchmove", onMove);
            window.removeEventListener("touchend", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        window.addEventListener("touchmove", onMove, { passive: false });
        window.addEventListener("touchend", onUp);
        e.preventDefault();
        e.stopPropagation();
    };
    handle.addEventListener("mousedown", onDown);
    handle.addEventListener("touchstart", onDown, { passive: false });
}

// Exact leave-one-out hypervolume contribution for a 2D Pareto frontier.
// For each frontier point, re-sweeps `unique` excluding that point to find
// the actual replacement frontier (cloud points may fill in), then takes
// ΔHV = totalHv − altHv. O(F × N), F = frontier length, N = unique points.
// Hypervolume (HV) and per-point HV CONTRIBUTION — the numbers that size the frontier
// dots and rank the leaderboard. HV is the area of the region dominated by the frontier,
// measured from a reference point R just below-left of the whole cloud: a frontier that
// pushes further out (more HR AND more SB) dominates more area, so HV is a single scalar
// for "how good is this frontier overall". A point's CONTRIBUTION is how much HV would be
// LOST if it were removed (HV(frontier) − HV(frontier without it)) — i.e. the area only
// IT dominates. That's the principled way to say which frontier members are most
// singular (a lopsided record-holder contributes a lot; a point hugging its neighbours
// contributes little). All math is in canonical (sign-folded) space so "more is better".
function computeHvContributions(frontier, xSign, ySign, unique) {
    if (!frontier || frontier.length === 0) {
        return { refPoint: { x: 0, y: 0 }, totalHv: 0, items: [] };
    }
    const universe = (unique && unique.length) ? unique : frontier;
    let xMinS = Infinity, yMinS = Infinity, xMaxS = -Infinity, yMaxS = -Infinity;
    for (const p of universe) {
        const sx = p.x * xSign, sy = p.y * ySign;
        if (sx < xMinS) xMinS = sx;
        if (sy < yMinS) yMinS = sy;
        if (sx > xMaxS) xMaxS = sx;
        if (sy > yMaxS) yMaxS = sy;
    }
    // Reference point R: nudged just BELOW-LEFT of the universe's min corner (by a tiny
    // epsilon) so even the lowest frontier point encloses a sliver of positive area —
    // otherwise a point sitting exactly on the min edge would contribute 0 and vanish.
    const epsX = Math.max(1e-9, (xMaxS - xMinS) * 1e-6);
    const epsY = Math.max(1e-9, (yMaxS - yMinS) * 1e-6);
    const Rx = xMinS - epsX;
    const Ry = yMinS - epsY;
    const refPoint = { x: Rx * xSign, y: Ry * ySign };

    // 2D hypervolume via vertical-strip decomposition. With the frontier sorted by
    // canonical X ascending (Y therefore descending), each point owns a strip from the
    // previous point's X to its own, of height (its Y − R.y). Summing the strips gives the
    // total dominated area in one O(frontier) pass — no overlap, no double-counting,
    // because the staircase is monotone. (fr must be in canonical-X-ascending order.)
    function hvOf(fr) {
        let hv = 0, xPrev = Rx;
        for (const p of fr) {
            hv += (p.x * xSign - xPrev) * (p.y * ySign - Ry);   // strip width × height
            xPrev = p.x * xSign;
        }
        return hv;
    }

    // Re-sweep universe excluding `skip` — same algorithm as the main sweep.
    function sweepExcluding(skip) {
        const fr = [];
        for (const p of universe) {
            if (p === skip) continue;
            const py = p.y * ySign;
            while (fr.length && fr[fr.length - 1].y * ySign < py) fr.pop();
            if (fr.length && fr[fr.length - 1].y === p.y &&
                fr[fr.length - 1].x * xSign < p.x * xSign) fr.pop();
            fr.push(p);
        }
        return fr;
    }

    const totalHv = hvOf(frontier);
    const n = frontier.length;
    const items = new Array(n);
    for (let i = 0; i < n; i++) {
        const p = frontier[i];
        const altFrontier = sweepExcluding(p);
        const contribution = totalHv - hvOf(altFrontier);
        items[i] = { point: p, contribution, fraction: 0 };
    }
    if (totalHv > 0) {
        for (const it of items) it.fraction = it.contribution / totalHv;
    }

    // Per-player contributions: re-sweep excluding ALL seasons of each player.
    const playerContribs = new Map();
    const playerIds = new Set(frontier.map(p => p.playerID));
    for (const pid of playerIds) {
        const altFr = [];
        for (const p of universe) {
            if (p.playerID === pid) continue;
            const py = p.y * ySign;
            while (altFr.length && altFr[altFr.length - 1].y * ySign < py) altFr.pop();
            if (altFr.length && altFr[altFr.length - 1].y === p.y &&
                altFr[altFr.length - 1].x * xSign < p.x * xSign) altFr.pop();
            altFr.push(p);
        }
        const contribution = totalHv - hvOf(altFr);
        playerContribs.set(pid, { contribution, fraction: totalHv > 0 ? contribution / totalHv : 0 });
    }

    return { refPoint, totalHv, items, playerContribs };
}

// Euclidean distance in normalized signed space from each non-frontier point
// to the nearest point on the Pareto staircase boundary.
// "Signed" coordinates (x*xSign, y*ySign) make "higher always better" on both
// axes regardless of which direction the stat improves, so the staircase is
// always the upper-right boundary. Normalization by the full data extent keeps
// the metric zoom-stable.
// Returns Map<point, { dist, targetX, targetY }> where:
//   dist      — [0, ~√2] in normalized space (× 100 = "% from the limit")
//   targetX/Y — nearest staircase point in data coordinates (for guide line)
function computeDistToFrontier(nonFrontierPoints, frontierPoints, xSign, ySign, xExtent, yExtent) {
    const out = new Map();
    if (!frontierPoints.length || !nonFrontierPoints.length) return out;

    const sxA = xExtent[0] * xSign, sxB = xExtent[1] * xSign;
    const syA = yExtent[0] * ySign, syB = yExtent[1] * ySign;
    const [sxLo, sxHi] = sxA < sxB ? [sxA, sxB] : [sxB, sxA];
    const [syLo, syHi] = syA < syB ? [syA, syB] : [syB, syA];
    const sxSpan = (sxHi - sxLo) || 1;
    const sySpan = (syHi - syLo) || 1;

    const nsx = p => (p.x * xSign - sxLo) / sxSpan;
    const nsy = p => (p.y * ySign - syLo) / sySpan;

    // Staircase vertices in normalized signed space.
    // frontier is sorted ascending by x*xSign; frontier[0] is top-left corner.
    // Left cap extends to nsx=0; bottom drop extends to nsy=0.
    const verts = [];
    verts.push([0, nsy(frontierPoints[0])]);
    for (let i = 0; i < frontierPoints.length; i++) {
        verts.push([nsx(frontierPoints[i]), nsy(frontierPoints[i])]);
        const nextNsy = i < frontierPoints.length - 1 ? nsy(frontierPoints[i + 1]) : 0;
        verts.push([nsx(frontierPoints[i]), nextNsy]);
    }

    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    for (const p of nonFrontierPoints) {
        const px = nsx(p), py = nsy(p);
        let best = Infinity, bx = px, by = py;
        for (let s = 0; s < verts.length - 1; s++) {
            const [ax, ay] = verts[s], [cx, cy] = verts[s + 1];
            let qx, qy;
            if (Math.abs(ax - cx) < 1e-12) {        // vertical segment
                qx = ax;
                qy = clamp(py, Math.min(ay, cy), Math.max(ay, cy));
            } else {                                  // horizontal segment
                qy = ay;
                qx = clamp(px, Math.min(ax, cx), Math.max(ax, cx));
            }
            const dd = (px - qx) * (px - qx) + (py - qy) * (py - qy);
            if (dd < best) { best = dd; bx = qx; by = qy; }
        }
        // Back-convert from normalized signed space to data coordinates.
        const targetX = (bx * sxSpan + sxLo) * xSign;
        const targetY = (by * sySpan + syLo) * ySign;
        out.set(p, { dist: Math.sqrt(best), targetX, targetY });
    }
    return out;
}
