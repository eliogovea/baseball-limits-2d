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
const COLOR_PALETTES = {
    bats: {
        L: { color: "#c8102e", name: "Left" },
        R: { color: "#002d72", name: "Right" },
        S: { color: "#7a3f5f", name: "Switch" },
        unknown: { color: "#94a3b8", name: "Unknown" },
    },
    league: {
        AL: { color: "#c8102e", dark: "#c8102e", name: "American" },
        NL: { color: "#002d72", dark: "#002d72", name: "National" },
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
    const t = THEMES[name] || THEMES.classic;
    const root = document.documentElement;
    Object.entries(t.vars).forEach(([k, v]) => root.style.setProperty(k, v));
    root.setAttribute("data-theme", name);
    // Re-skin the D3-painted chart by mutating the in-place color tables.
    t.cloud.forEach((c, i) => { if (ERAS[i]) ERAS[i].color = c; });
    COLOR_PALETTES.league.AL.color = COLOR_PALETTES.league.AL.dark = t.league.AL;
    COLOR_PALETTES.league.NL.color = COLOR_PALETTES.league.NL.dark = t.league.NL;
    COLOR_PALETTES.bats.L.color = t.league.AL;
    COLOR_PALETTES.bats.R.color = t.league.NL;
    COLOR_PALETTES.bats.S.color = t.switchColor;
    themeCloudOpacity = t.cloudOpacity;
    try { localStorage.setItem("bl2d-theme", name); } catch (e) {}
    // Reflect the choice in the header switcher.
    document.querySelectorAll("#theme-switch .theme-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.theme === name));
}

function initialTheme() {
    try { return localStorage.getItem("bl2d-theme") || "classic"; } catch (e) { return "classic"; }
}

function colorOf(p, colorBy, getMeta) {
    if (colorBy === "era") {
        return (eraFor(p.year ?? p.yearID) || { color: "#4a6fa5" }).color;
    }
    if (colorBy === "bats") {
        const m = getMeta(p.playerID);
        const k = m && m.bats;
        return (COLOR_PALETTES.bats[k] || COLOR_PALETTES.bats.unknown).color;
    }
    if (colorBy === "league") {
        const k = p.lgID;
        return (COLOR_PALETTES.league[k] || COLOR_PALETTES.league.unknown).color;
    }
    return "#4a6fa5";
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
// Fast lookups
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

function addHighlight(playerID) {
    if (!playerID || careerHighlights.has(playerID)) return;
    if (careerHighlights.size >= HIGHLIGHT_COLORS.length) return;
    const used = new Set(careerHighlights.values());
    const color = HIGHLIGHT_COLORS.find(c => !used.has(c));
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
let hvEncodingEnabled = true;  // scale frontier dot radius by hypervolume contribution (always on)
let isolationPinned = null;     // data-point reference for the pinned isolation ring, or null
let animTimer = null;           // setInterval handle while frontier animation is running
let animExtentCache = null;     // { key, x, y } — full-range axis extents cached per animation session

// URL state defaults — params at their default value are omitted from the
// hash to keep it short.
const URL_DEFAULTS = {
    ds: "batting",
    x: "HR", y: "SB", sy: "1920", ey: "2024", pa: "502",
    m: "season", lg: "all", bt: "all", cb: "era", co: "all",
    fr: "all", hl: "",
};

// Per-dataset metadata. The Stats toggle in the UI switches `activeDataset`;
// every read of selectors / threshold field / dimensions goes through here.
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

function buildPlayerIndex(points) {
    const idx = new Map();
    for (const p of points) {
        let arr = idx.get(p.playerID);
        if (!arr) { arr = []; idx.set(p.playerID, arr); }
        arr.push(p);
    }
    return idx;
}

async function loadDataset(key) {
    // The bundler swaps these two d3.csv() calls for the inline decoders.
    const rawPoints = key === "pitching"
        ? await d3.csv("data/pitching_limits_1871-2025.csv")
        : await d3.csv("data/batting_limits_1871-2025.csv");
    if (typeof rawPoints.metaFor === "function") metaFor = rawPoints.metaFor;
    const points = key === "pitching" ? parsePitchingRows(rawPoints) : parseBattingRows(rawPoints);
    return { points, playerIndex: buildPlayerIndex(points) };
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
        refreshChart();
    });
    setupModeToggle("stats-toggle", () => {
        activeDatasetKey = getActiveModeBtnData("stats-toggle", "stats") || "batting";
        playerIndex = datasetState[activeDatasetKey].playerIndex;
        clearHighlights();
        viewDomain = null;
        syncPlayerHint();
        populateSelectorsForActive();
        resetThresholdToDefault();
        applyModeConfig(getCurrentMode());
        refreshChart();
    });
    setupSegGroup("league-seg", () => { clearHighlights(); syncPlayerHint(); refreshChart(); });
    setupSegGroup("bats-seg",   () => { clearHighlights(); syncPlayerHint(); refreshChart(); });
    // Color encoding is a display option, not a filter — no need to clear the
    // highlight or touch playing-time; just recolor the cloud + legend.
    setupSegGroup("colorby-seg", () => refreshChart());
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

    function refreshChart() {
        const xDim = document.getElementById("x-axis-select").value;
        const yDim = document.getElementById("y-axis-select").value;
        const sYear = parseInt(document.getElementById("s-year-select").value);
        const eYear = parseInt(document.getElementById("e-year-select").value);
        const mode = getCurrentMode();
        const league = getSegValue("league-seg", "league") || "all";
        const bats = getSegValue("bats-seg", "bats") || "all";
        const colorBy = getSegValue("colorby-seg", "colorby") || "era";
        const country = document.getElementById("country-select").value || "all";
        const franchise = document.getElementById("franchise-select")?.value || "all";
        const def = activeDataset();
        const data = activeData();

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
        syncMobileAxisBar();


        loadingIndicator.classList.add("active");
        cancelAnimationFrame(pendingRender);
        pendingRender = requestAnimationFrame(() => {
            drawScatterPlot(data.points, xDim, yDim, sYear, eYear, minThreshold, formatStat, mode,
                { league, bats, colorBy, country, franchise, thresholdField: def.thresholdField, handField: def.handField, dataset: activeDatasetKey });
            loadingIndicator.classList.remove("active");
            writeUrlState({ xDim, yDim, sYear, eYear, minPa: thresholdValue, mode, league, bats, colorBy, country, franchise });
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
        // values are in the old dimension's units).
        viewDomain = null;
        filterChanged();
    };
    ["x-axis-select", "y-axis-select"].forEach((id) => {
        document.getElementById(id).addEventListener("change", axisOrViewChanged);
    });
    // Mobile axis bar: forward its changes to the real selects (which fire the
    // handler above). The bar stays in sync via syncMobileAxisBar() in refreshChart.
    ["x", "y"].forEach((ax) => {
        document.getElementById(`${ax}-axis-mobile`)?.addEventListener("change", (e) => {
            const main = document.getElementById(`${ax}-axis-select`);
            main.value = e.target.value;
            main.dispatchEvent(new Event("change"));
        });
    });
    ["s-year-select", "e-year-select"].forEach((id) => {
        document.getElementById(id).addEventListener("change", () => {
            stopAnimation();
            filterChanged();
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
        if (animTimer) stopAnimation(); else startAnimation();
    });

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
    syncMobileAxisBar();

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
function syncMobileAxisBar() {
    ["x", "y"].forEach((ax) => {
        const main = document.getElementById(`${ax}-axis-select`);
        const mob = document.getElementById(`${ax}-axis-mobile`);
        if (!main || !mob) return;
        if (mob.innerHTML !== main.innerHTML) mob.innerHTML = main.innerHTML;
        mob.value = main.value;
    });
}

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
    // Dataset must switch first so the pitching dimension dropdowns exist
    // before we try to select a pitching-only axis token (e.g. ERA, K/9).
    if (u.ds === "pitching" && activeDatasetKey !== "pitching") {
        const stBtn = document.querySelector('#stats-toggle .mode-btn[data-stats="pitching"]');
        if (stBtn) {
            document.querySelectorAll('#stats-toggle .mode-btn').forEach(b => b.classList.remove("active"));
            stBtn.classList.add("active");
        }
        activeDatasetKey = "pitching";
        playerIndex = datasetState[activeDatasetKey].playerIndex;
        populateSelectorsForActive();
        resetThresholdToDefault();
        applyModeConfig("season");
    }
    setSelect("x-axis-select", u.x);
    setSelect("y-axis-select", u.y);
    if (u.sy) document.getElementById("s-year-select").value = u.sy;
    if (u.ey) document.getElementById("e-year-select").value = u.ey;
    // Mode applies first so PA slider config is right before we set its value.
    if (u.m === "career") {
        document.querySelectorAll(".mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === "career"));
        applyModeConfig("career");
        document.getElementById("mode-hint").textContent =
            "Each dot is one player's career totals across the selected year window.";
    }
    if (u.pa) document.getElementById("pa-min-select").value = u.pa;
    setSeg("league-seg", "league", u.lg);
    setSeg("bats-seg", "bats", u.bt);
    setSeg("colorby-seg", "colorby", u.cb);
    setSelect("country-select", u.co);
    updateCountrySelection(document.getElementById("country-select")?.value || "all");
    setSelect("franchise-select", u.fr);
    const frVal = document.getElementById("franchise-select")?.value || "all";
    updateFranchiseTrigger(frVal);
    updateChipSelection(frVal);
    updateFranchiseDimming(getSegValue("league-seg", "league") || "all");
    if (u.hl) { u.hl.split(",").forEach(id => addHighlight(id.trim())); }
}

let urlWriteTimer = null;
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
            co: state.country,
            fr: state.franchise,
            hl: [...careerHighlights.keys()].join(","),
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

function buildExportSvgString() {
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
    const DROP = ".hit, .zoom-overlay, .brush, .axis-caret, .isolation-ring-group, .regret-line-group";
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

    let svgStr = new XMLSerializer().serializeToString(clone);
    // The SVG's own background can't be captured as a presentation property.
    return svgStr.replace(/(<svg[^>]*>)/, `$1<style>svg{background:${bg};}</style>`);
}

function exportChartSVG() {
    const svgStr = buildExportSvgString();
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
        const svgStr = buildExportSvgString();
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

function _flashActionBtn(btn, label, doneLabel = "Done!") {
    const orig = btn.textContent.trim();
    btn.classList.add("share-action-btn--done");
    btn.textContent = doneLabel;
    setTimeout(() => {
        btn.classList.remove("share-action-btn--done");
        btn.textContent = orig;
        // Restore the icon that was stripped by textContent assignment
        btn.dispatchEvent(new Event("_restoreicon"));
    }, 1800);
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

function populatePlayerDatalist() { /* replaced by setupPlayerSearch — no-op */ }

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

function syncPresetActive(value) {
    document.querySelectorAll(".preset[data-pa]").forEach((btn) => {
        btn.classList.toggle("active", parseInt(btn.dataset.pa) === value);
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


function drawScatterPlot(points, xDim, yDim, sYear, eYear, minPa, formatStat, mode = "season", filters = {}) {
    // Any open axis-stat menu is anchored to the (about to be replaced) titles.
    closeAxisStatMenu();
    const svg = d3.select("#scatter-plot");
    // FLIP: snapshot current dot positions so we can morph to the new layout.
    // During animation playback (400ms ticks), use a shorter duration so transitions
    // complete before the next tick; D3 interrupts gracefully if they overlap.
    const FLIP_DURATION = animTimer ? 350 : 280;
    const flipPos = new Map();
    if (FLIP_DURATION > 0) {
        svg.selectAll(".regular-point, .special-point").each(function(d) {
            if (!d || !d.playerID) return;
            const key = d.playerID + "|" + (d.year ?? d.yearID ?? "");
            flipPos.set(key, { cx: +this.getAttribute("cx"), cy: +this.getAttribute("cy") });
        });
    }
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

    const seasonMatches = (p) => {
        if (p.yearID < sYear || p.yearID > eYear) return false;
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

    const thresholdField = filters.thresholdField || "PA";
    const datasetKey = filters.dataset || "batting";

    // For "lower is better" axes, negate the value for sorting and sweep so the
    // algorithm always maximises — finding the best (lowest) value on that axis.
    // When showWorstFrontier is true, invert the signs to find the lower-left envelope.
    const datasetDef = DATASETS[filters.dataset || "batting"];
    let xSign = datasetDef.lowerIsBetter?.has(xDim) ? -1 : 1;
    let ySign = datasetDef.lowerIsBetter?.has(yDim) ? -1 : 1;
    if (showWorstFrontier) { xSign *= -1; ySign *= -1; }

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
            const x = p[xDim];
            const y = p[yDim];
            if (isNaN(x) || isNaN(y)) continue;
            if (p[thresholdField] < minPa) continue;
            flt.push({
                x, y,
                year: p.yearID,
                yearLast: p.yearLast || p.yearID,
                seasonsCount: p.seasonsCount || 1,
                PA: p[thresholdField],
                playerID: p.playerID,
                teamID: p.teamID,
                lgID: p.lgID,
                orig: p,  // for size-by lookups (PA / G / AB)
            });
        }

        flt.sort((a, b) => {
            const ax = a.x * xSign, bx = b.x * xSign;
            const ay = a.y * ySign, by = b.y * ySign;
            if (ax !== bx) return ax - bx;
            if (ay !== by) return ay - by;
            return b.year - a.year; // prefer more recent on ties
        });

        // Deduplicate exact (x, y) collisions for the rendering pass.
        const uniq = [];
        for (let i = 0; i < flt.length; i++) {
            const p = flt[i];
            if (i === 0 || p.x !== flt[i - 1].x || p.y !== flt[i - 1].y) uniq.push(p);
        }

        // Pareto frontier: sweep left-to-right keeping the best-in-class envelope.
        // Signed values ensure "lower is better" axes are treated correctly.
        const fr = [];
        for (const p of uniq) {
            const py = p.y * ySign;
            while (fr.length && fr[fr.length - 1].y * ySign < py) fr.pop();
            if (fr.length && fr[fr.length - 1].y === p.y &&
                fr[fr.length - 1].x * xSign < p.x * xSign) fr.pop();
            fr.push(p);
        }

        return { filtered: flt, unique: uniq, frontier: fr };
    }

    const { filtered, unique, frontier } = buildFrontier(seasonMatches);
    const frontierSet = new Set(frontier);

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

    const hvInfo = computeHvContributions(frontier, xSign, ySign, unique);
    const hvByPoint = new Map(hvInfo.items.map(it => [it.point, it]));
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

    renderFrontierCards(frontier, xDim, yDim, formatStat, filtered.length, mode, hvByPoint);

    if (unique.length === 0) {
        svg.append("text")
            .attr("x", "50%").attr("y", "50%")
            .attr("text-anchor", "middle").attr("dominant-baseline", "middle")
            .attr("font-family", "var(--font-sans, sans-serif)")
            .attr("font-size", 14)
            .attr("fill", "#5a6478")
            .text("No seasons match these filters — try widening the year range or lowering the minimum.");
        return;
    }

    const svgEl = document.getElementById("scatter-plot");
    const rect = svgEl.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    const margin = { top: 24, right: 24, bottom: 44, left: 56 };
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
    const xDomain = (viewDomain && viewDomain.x) || xExtent;
    const yDomain = (viewDomain && viewDomain.y) || yExtent;
    const xScale = d3.scaleLinear().domain(xDomain).nice().range([0, plotW]);
    const yScale = d3.scaleLinear().domain(yDomain).nice().range([plotH, 0]);
    updateZoomResetEnabled();

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

    if (frontier.length > 0) {
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
    g.append("g").selectAll("circle.regular-point")
        .data(regular).enter()
        .append("circle")
        .attr("class", "regular-point")
        .attr("cx", d => xScale(d.x))
        .attr("cy", d => yScale(d.y))
        .attr("r", pointRadius)
        .attr("fill", d => colorOf(d, colorBy, getMeta))
        .style("fill-opacity", cloudOpacity);

    // Career-highlight layer: dots only (no connecting line — the
    // year-order trail tended to add zigzag noise more than it clarified
    // the trajectory). Rendered BEFORE the red frontier dots so the
    // clicked-on frontier point keeps its red marker on top.
    if (careerHighlights.size > 0 && playerIndex) {
        for (const [pid, hcolor] of careerHighlights) {
            if (!playerIndex.has(pid)) continue;
            const allSeasons = playerIndex.get(pid)
                .map(p => ({ x: p[xDim], y: p[yDim], year: p.yearID }))
                .filter(s => !isNaN(s.x) && !isNaN(s.y));
            if (!allSeasons.length) continue;
            g.append("g").attr("class", "career-trail")
                .selectAll("circle")
                .data(allSeasons).enter()
                .append("circle")
                .attr("class", "career-point")
                .attr("cx", d => xScale(d.x))
                .attr("cy", d => yScale(d.y))
                .attr("r", Math.max(pointRadius + 3, 6))
                .style("fill", hcolor)
                .style("stroke", "#ffffff");
        }
    }

    const frontierColor = showWorstFrontier ? "#8b5cf6" : null;  // purple for worst, red (CSS) for best
    g.append("g").selectAll("circle.special-point")
        .data(special).enter()
        .append("circle")
        .attr("class", "special-point")
        .attr("cx", d => xScale(d.x))
        .attr("cy", d => yScale(d.y))
        .attr("r", radiusFor)
        .style("fill", d => {
            const careerColor = careerHighlights.get(d.playerID);
            if (careerColor) return careerColor;
            if (frontierColor) return frontierColor;
            return (COLOR_PALETTES.league[d.lgID] || COLOR_PALETTES.league.unknown).dark;
        });

    // FLIP: animate dots from their previous screen positions to the new ones.
    // Hit circles (tooltip targets) are updated instantly — they must match the
    // final dot positions, not the animated intermediate ones.
    if (FLIP_DURATION > 0 && flipPos.size > 0) {
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
    // playback the boundary updates every 400ms so fading from 0 each tick strobe.
    if (FLIP_DURATION > 0 && !animTimer) {
        svg.selectAll("path.frontier-staircase")
            .style("opacity", 0)
            .transition().duration(FLIP_DURATION).ease(d3.easeCubicOut)
            .style("opacity", 0.55);
        svg.selectAll("path.hv-shade")
            .style("opacity", 0)
            .transition().duration(FLIP_DURATION).ease(d3.easeCubicOut)
            .style("opacity", 1);
    }

    // On-chart frontier labels: greedy collision avoidance, mobile shows
    // only the two extreme endpoints so small viewports stay readable.
    // HV radius applies only to .special-point; career-trail dots stay at the
    // constant size set by pointRadius+3 so the gold layer remains a clean
    // per-season encoding.
    const labelRadius = hvEncodingEnabled ? FRONTIER_R_MAX : frontierRadius;
    const labels = layoutFrontierLabels(frontier, xScale, yScale, plotW, plotH, labelRadius, width < 480);
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

    // Isolation ring: precompute nearest-neighbour distance (pixel space) for each
    // frontier point. Drawn on hover; locked in place by click.
    const isoRingColor = d => showWorstFrontier ? "#8b5cf6"
        : (COLOR_PALETTES.league[d.lgID] || COLOR_PALETTES.league.unknown).dark;
    const isolationMap = new Map();
    for (const fp of frontier) {
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
    // the frontier loses if all their seasons were removed.
    if (careerHighlights.size > 0) {
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

    g.append("g").selectAll("circle.hit")
        .data(unique).enter()
        .append("circle")
        .attr("class", "hit")
        .attr("cx", d => xScale(d.x))
        .attr("cy", d => yScale(d.y))
        .attr("r", hoverRadius)
        .attr("fill", "transparent")
        .style("cursor", "pointer")
        .on("mouseover", showTooltip)
        .on("mousemove", (event) => positionTooltip(event, tooltip))
        .on("mouseout", hideTooltip)
        .on("touchstart", showTooltip, { passive: true })
        .on("click", (event, d) => {
            tooltipPinned = true;
            event.stopPropagation();
            if (frontierSet.has(d)) {
                // Clear any hover ring when clicking
                ringGroup.selectAll(".isolation-ring--hover").remove();
                // Season mode: also add career highlight
                if (mode === "season") {
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

    // Hide tooltip on any tap outside a point (mobile).
    document.addEventListener("touchstart", (event) => {
        if (!event.target.closest("#scatter-plot")) hideTooltip();
    }, { passive: true });
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

function drawIsolationRingPinned(ringGroup, iso, color, plotW, plotH) {
    // Thin line from frontier centre to nearest neighbour
    ringGroup.append("line")
        .attr("class", "isolation-ring-spoke")
        .attr("x1", iso.cx).attr("y1", iso.cy)
        .attr("x2", iso.nx).attr("y2", iso.ny)
        .style("stroke", color);
    // The ring itself
    ringGroup.append("circle")
        .attr("class", "isolation-ring isolation-ring--pinned")
        .attr("cx", iso.cx).attr("cy", iso.cy).attr("r", iso.r)
        .style("stroke", color);
    // Small marker dot at the nearest neighbour
    ringGroup.append("circle")
        .attr("class", "isolation-ring-neighbour")
        .attr("cx", iso.nx).attr("cy", iso.ny).attr("r", 4)
        .style("fill", color);
    // // "Loneliness Radius" label: place along the spoke, clamped inside the chart.
    // const labelAngle = -Math.PI / 4; // 45° top-right
    // const lx = Math.min(Math.max(iso.cx + iso.r * Math.cos(labelAngle), 4), plotW - 4);
    // const ly = Math.min(Math.max(iso.cy + iso.r * Math.sin(labelAngle), 14), plotH - 4);
    // ringGroup.append("text")
    //     .attr("class", "isolation-ring-label")
    //     .attr("x", lx).attr("y", ly)
    //     .style("fill", color)
    //     .text("Loneliness Radius");
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

    cardsEl.innerHTML = ordered.map(p => {
        const era = eraFor(p.year);
        const isCareer = mode === "career";
        const yearLabel = isCareer
            ? `${p.year}–${p.yearLast}`
            : String(p.year);
        const subLine = isCareer
            ? `${p.seasonsCount} season${p.seasonsCount === 1 ? "" : "s"}`
            : `${escapeHtml(p.teamID)} · ${escapeHtml(p.lgID)}`;
        return `
            <article class="frontier-card">
                <div class="frontier-card-name">${escapeHtml(p.playerID)}</div>
                <div class="frontier-card-year">${yearLabel}</div>
                <div class="frontier-card-team">${subLine}</div>
                <div class="frontier-card-stats">${xDim} ${formatStat(xDim, p.x)} · ${yDim} ${formatStat(yDim, p.y)}</div>
                ${hvByPoint && hvByPoint.has(p) ? `<div class="frontier-card-hv">Controls ${(hvByPoint.get(p).fraction * 100).toFixed(2)}% of the frontier area</div>` : ""}
                <div class="frontier-card-era">${era ? era.name : "—"}</div>
            </article>
        `;
    }).join("");
}

// Exact leave-one-out hypervolume contribution for a 2D Pareto frontier.
// For each frontier point, re-sweeps `unique` excluding that point to find
// the actual replacement frontier (cloud points may fill in), then takes
// ΔHV = totalHv − altHv. O(F × N), F = frontier length, N = unique points.
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
    const epsX = Math.max(1e-9, (xMaxS - xMinS) * 1e-6);
    const epsY = Math.max(1e-9, (yMaxS - yMinS) * 1e-6);
    const Rx = xMinS - epsX;
    const Ry = yMinS - epsY;
    const refPoint = { x: Rx * xSign, y: Ry * ySign };

    // 2D hypervolume via vertical strip decomposition.
    // fr must be sorted by x*xSign ascending, y*ySign non-increasing.
    function hvOf(fr) {
        let hv = 0, xPrev = Rx;
        for (const p of fr) {
            hv += (p.x * xSign - xPrev) * (p.y * ySign - Ry);
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
