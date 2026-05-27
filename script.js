const ERAS = [
    { start: 1871, end: 1899, name: "Pre-modern",   color: "#a89a7e" },
    { start: 1900, end: 1919, name: "Dead Ball",    color: "#8a7456" },
    { start: 1920, end: 1941, name: "Live Ball",    color: "#4a6fa5" },
    { start: 1942, end: 1968, name: "Integration",  color: "#2f5b8a" },
    { start: 1969, end: 1992, name: "Free Agency",  color: "#1f4570" },
    { start: 1993, end: 2005, name: "Steroid",      color: "#7a3f5f" },
    { start: 2006, end: 2099, name: "Modern",       color: "#005a8a" },
];
function eraFor(year) {
    for (const e of ERAS) if (year >= e.start && year <= e.end) return e;
    return null;
}

// Color palettes per encoding mode. Keep deliberate — Red/Blue echo MLB.
const COLOR_PALETTES = {
    bats: {
        L: { color: "#c8102e", name: "Left" },
        R: { color: "#002d72", name: "Right" },
        S: { color: "#7a3f5f", name: "Switch" },
        unknown: { color: "#94a3b8", name: "Unknown" },
    },
    league: {
        AL: { color: "#c8102e", name: "American" },
        NL: { color: "#002d72", name: "National" },
        unknown: { color: "#94a3b8", name: "Other" },
    },
};

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

// Career-highlight state. Set when the user clicks a frontier point; cleared
// on outside click, Escape, or any filter change.
let playerIndex = null;       // Map<playerID, Point[]>  (all seasons per player)
let careerHighlight = null;   // playerID being highlighted, or null
let metaFor = () => null;     // populated after decode: (playerID) -> {bats, throws, country, ...} | null

// Pin state for the tooltip (UX only; not serialized to URL — the career
// highlight, which IS in the URL, plays the role of "sharable focus").
let tooltipPinned = false;

// URL state defaults — params at their default value are omitted from the
// hash to keep it short.
const URL_DEFAULTS = {
    x: "HR", y: "SB", sy: "1920", ey: "2024", pa: "0",
    m: "season", lg: "all", bt: "all", co: "all",
    cb: "era", sb: "none", hl: "",
};

// PA slider config differs by mode: per-season values cluster under ~700, but
// career totals span 0 to ~16,000. Adjusting max + step + presets keeps the
// slider usable in both modes.
const PA_MODE_CONFIG = {
    season: {
        max: 600, step: 1,
        presets: [
            { val: 0,   label: "All" },
            { val: 100, label: "100" },
            { val: 300, label: "300" },
            { val: 502, label: "502" },
        ],
        hint: "502 PA qualifies for the batting title.",
    },
    career: {
        max: 16000, step: 100,
        presets: [
            { val: 0,     label: "All" },
            { val: 1000,  label: "1k" },
            { val: 5000,  label: "5k" },
            { val: 10000, label: "10k" },
        ],
        hint: "10,000+ PA marks a long full career.",
    },
};


// People CSV is loaded in parallel for the multi-file site (the bundle's
// decoder already attaches metaFor to the points array and the bundler
// short-circuits this fetch to a Promise.resolve(null)).
const peoplePromise = d3.csv("data/people_lahman_1871-2023.csv").catch(() => null);

d3.csv("data/batting_limits_1871-2024.csv").then(async (points) => {
    if (typeof points.metaFor === "function") {
        metaFor = points.metaFor;
    } else {
        const people = await peoplePromise;
        if (people) metaFor = buildMetaFromPeopleCsv(people);
    }
    const parsedPoints = [];
    points.forEach((point) => {
        parsedPoints.push({
            playerID: point["playerID"],
            yearID: parseInt(point["yearID"]),
            teamID: point["teamID"],
            lgID: point["lgID"],
            G: parseInt(point["G"]),
            AB: parseInt(point["AB"]),
            R: parseInt(point["R"]),
            H: parseInt(point["H"]),
            "2B": parseInt(point["2B"]),
            "3B": parseInt(point["3B"]),
            HR: parseInt(point["HR"]),
            RBI: parseInt(point["RBI"]),
            SB: parseInt(point["SB"]),
            CS: parseInt(point["CS"]),
            BB: parseInt(point["BB"]),
            SO: parseInt(point["SO"]),
            IBB: parseInt(point["IBB"]),
            HBP: parseInt(point["HBP"]),
            SH: parseInt(point["SH"]),
            SF: parseInt(point["SF"]),
            GIDP: parseInt(point["GIDP"]),
        });
    });
    return parsedPoints;
})
.then((points) => {
    points.forEach((point) => {
        point["PA"] = point["AB"] + point["BB"] + point["HBP"] + point["SH"] + point["SF"];
        point["TB"] = point["H"] + point["2B"] + 2 * point["3B"] + 3 * point["HR"];
        point["AVG"] = point["H"] / point["AB"];
        point["OBP"] = (point["H"] + point["BB"] + point["HBP"]) / (point["AB"] + point["BB"] + point["HBP"] + point["SF"]);
        point["SLG"] = point["TB"] / point["AB"];
    });
    // Build the player index once for career-trail lookups (B3).
    playerIndex = new Map();
    for (const p of points) {
        let arr = playerIndex.get(p.playerID);
        if (!arr) { arr = []; playerIndex.set(p.playerID, arr); }
        arr.push(p);
    }
    return points;
})
.then((points) => {
    const dimensions = ["PA", "G", "AB", "R", "H", "2B", "3B", "HR", "TB", "RBI", "SB", "CS", "BB", "SO", "IBB", "HBP", "SH", "SF", "GIDP", "AVG", "OBP", "SLG"];
    const rateStats = new Set(["AVG", "OBP", "SLG"]);

    const formatStat = (dim, value) => {
        if (typeof value !== "number" || isNaN(value)) return "—";
        if (rateStats.has(dim)) return value.toFixed(3);
        return value.toLocaleString();
    };

    populateSelectors(points, dimensions);
    populateCountrySelect(playerIndex);
    setupControlsToggle();
    setupPaPresets();
    populateEraLegend();
    setupExplainer();
    setupGlossary();
    applyModeConfig("season");
    setupModeToggle(() => {
        const mode = getCurrentMode();
        applyModeConfig(mode);
        careerHighlight = null;
        document.getElementById("mode-hint").textContent =
            mode === "career"
                ? "Each dot is one player's career totals over the year window."
                : "Each dot is one player-season.";
        refreshChart();
    });
    setupSegGroup("league-seg", () => { careerHighlight = null; refreshChart(); });
    setupSegGroup("bats-seg",   () => { careerHighlight = null; refreshChart(); });
    ["country-select", "color-by-select", "size-by-select"].forEach((id) => {
        document.getElementById(id).addEventListener("change", () => {
            careerHighlight = null;
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
        const minPa = parseInt(document.getElementById("pa-min-select").value);
        const mode = getCurrentMode();
        const league = getSegValue("league-seg", "league") || "all";
        const bats = getSegValue("bats-seg", "bats") || "all";
        const country = document.getElementById("country-select").value || "all";
        const colorBy = document.getElementById("color-by-select").value;
        const sizeBy = document.getElementById("size-by-select").value;

        updateColorLegend(colorBy);

        document.getElementById("pa-min-value").textContent = minPa.toLocaleString();
        syncPresetActive(minPa);

        loadingIndicator.classList.add("active");
        cancelAnimationFrame(pendingRender);
        pendingRender = requestAnimationFrame(() => {
            drawScatterPlot(points, xDim, yDim, sYear, eYear, minPa, formatStat, mode,
                { league, bats, country, colorBy, sizeBy });
            loadingIndicator.classList.remove("active");
            writeUrlState({ xDim, yDim, sYear, eYear, minPa, mode, league, bats, country, colorBy, sizeBy });
        });
    }

    // Restore state from URL hash (if present) before first render so the
    // shareable-URL flow lands on the exact view the link encoded.
    applyUrlState();
    refreshChart();

    // Lets nested call sites (like the chart's click handler) trigger a
    // refresh without holding a reference to the closure.
    document.addEventListener("bl2d:refresh", refreshChart);

    const filterChanged = () => {
        // Any filter change resets the career-highlight pin so the visible
        // trail doesn't outlive the view it was set in.
        careerHighlight = null;
        refreshChart();
    };
    ["x-axis-select", "y-axis-select", "s-year-select", "e-year-select"].forEach((id) => {
        document.getElementById(id).addEventListener("change", filterChanged);
    });
    document.getElementById("pa-min-select").addEventListener("input", filterChanged);

    // Click on empty chart area, or Escape, clears both the tooltip pin and
    // the career highlight in one motion.
    const clearPinAndHighlight = () => {
        let dirty = false;
        if (tooltipPinned) {
            tooltipPinned = false;
            document.getElementById("tooltip").setAttribute("data-visible", "false");
        }
        if (careerHighlight) {
            careerHighlight = null;
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

    // Latest-debut wins on name collisions ("Luis Garcia" x5 etc.), matching
    // the bundle's tie-break in build_bundle.py:load_people.
    const peopleMap = new Map();
    for (const p of rows) {
        const key = `${p.nameFirst} ${p.nameLast}`;
        const prior = peopleMap.get(key);
        if (prior && debutYear(prior) >= debutYear(p)) continue;
        peopleMap.set(key, p);
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


function populateCountrySelect(playerIdx) {
    const sel = document.getElementById("country-select");
    if (!sel) return;
    const counts = new Map();
    for (const playerID of playerIdx.keys()) {
        const m = metaFor(playerID);
        if (!m || !m.country) continue;
        counts.set(m.country, (counts.get(m.country) || 0) + 1);
    }
    // Show "All" first, then countries with at least 5 players, sorted alphabetically.
    const list = [...counts.entries()]
        .filter(([, n]) => n >= 5)
        .map(([c, n]) => ({ c, n }))
        .sort((a, b) => a.c.localeCompare(b.c));
    sel.innerHTML = `<option value="all">All countries</option>` +
        list.map(({ c, n }) => `<option value="${escapeHtml(c)}">${escapeHtml(c)} (${n.toLocaleString()})</option>`).join("");
    sel.value = "all";
}


function populateSelectors(points, dimensions) {
    const years = [...new Set(points.map(p => p.yearID))].sort((a, b) => a - b);
    const minYear = years[0];
    const maxYear = years[years.length - 1];

    const sYear = document.getElementById("s-year-select");
    sYear.min = minYear;
    sYear.max = maxYear;
    sYear.value = Math.max(1920, minYear); // start of live-ball era

    const eYear = document.getElementById("e-year-select");
    eYear.min = minYear;
    eYear.max = maxYear;
    eYear.value = maxYear;

    const xSelect = document.getElementById("x-axis-select");
    const ySelect = document.getElementById("y-axis-select");
    [xSelect, ySelect].forEach((sel) => {
        sel.innerHTML = "";
        dimensions.forEach((dim) => {
            const opt = document.createElement("option");
            opt.value = dim;
            opt.textContent = dim;
            sel.appendChild(opt);
        });
    });
    xSelect.value = "HR";
    ySelect.value = "SB";

    const pa = document.getElementById("pa-min-select");
    pa.min = 0;
    pa.max = 600;
    pa.value = 0;
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
    setSelect("x-axis-select", u.x);
    setSelect("y-axis-select", u.y);
    if (u.sy) document.getElementById("s-year-select").value = u.sy;
    if (u.ey) document.getElementById("e-year-select").value = u.ey;
    // Mode applies first so PA slider config is right before we set its value.
    if (u.m === "career") {
        document.querySelectorAll(".mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === "career"));
        applyModeConfig("career");
        document.getElementById("mode-hint").textContent =
            "Each dot is one player's career totals over the year window.";
    }
    if (u.pa) document.getElementById("pa-min-select").value = u.pa;
    setSeg("league-seg", "league", u.lg);
    setSeg("bats-seg", "bats", u.bt);
    setSelect("country-select", u.co);
    setSelect("color-by-select", u.cb);
    setSelect("size-by-select", u.sb);
    if (u.hl) careerHighlight = u.hl;
}

let urlWriteTimer = null;
function writeUrlState(state) {
    clearTimeout(urlWriteTimer);
    urlWriteTimer = setTimeout(() => {
        const params = {
            x: state.xDim,
            y: state.yDim,
            sy: String(state.sYear),
            ey: String(state.eYear),
            pa: String(state.minPa),
            m: state.mode,
            lg: state.league,
            bt: state.bats,
            co: state.country,
            cb: state.colorBy,
            sb: state.sizeBy,
            hl: careerHighlight || "",
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
    const active = document.querySelector(".mode-btn.active");
    return active ? active.dataset.mode : "season";
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

function setupModeToggle(onChange) {
    document.querySelectorAll(".mode-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            if (btn.classList.contains("active")) return;
            document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            onChange();
        });
    });
}

function applyModeConfig(mode) {
    const cfg = PA_MODE_CONFIG[mode];
    if (!cfg) return;
    const slider = document.getElementById("pa-min-select");
    slider.max = cfg.max;
    slider.step = cfg.step;
    // Snap value if it now exceeds the new max.
    if (parseInt(slider.value) > cfg.max) slider.value = 0;
    document.getElementById("pa-min-value").textContent = parseInt(slider.value).toLocaleString();

    const row = document.querySelector(".preset-row");
    row.innerHTML = cfg.presets
        .map(p => `<button type="button" class="preset" data-pa="${p.val}">${p.label}</button>`)
        .join("");
    setupPaPresets(); // rewire fresh buttons
    syncPresetActive(parseInt(slider.value));

    const hintEl = document.querySelector("#mode-toggle + .control-hint");
    // The preset section's own hint sits below the preset row.
    const presetHint = document.querySelectorAll(".control-group .control-hint");
    // Update the PA-section hint (the second one — first is the mode hint).
    if (presetHint.length >= 2) presetHint[1].textContent = cfg.hint;
}

// Aggregate one player's selected seasons into a single career-totals row.
// Counting stats sum; rate stats (AVG/OBP/SLG) are recomputed from the summed
// components — averaging the season AVGs would over-weight short seasons.
function aggregateCareer(seasons) {
    const out = {
        playerID: seasons[0].playerID,
        teamID: "—",
        lgID: "—",
        yearFirst: seasons[0].yearID,
        yearLast: seasons[seasons.length - 1].yearID,
        seasonsCount: seasons.length,
    };
    const sumKeys = ["G", "AB", "R", "H", "2B", "3B", "HR", "RBI", "SB", "CS",
                     "BB", "SO", "IBB", "HBP", "SH", "SF", "GIDP", "PA", "TB"];
    for (const k of sumKeys) {
        let s = 0;
        for (const sn of seasons) {
            const v = sn[k];
            if (!isNaN(v)) s += v;
        }
        out[k] = s;
    }
    // Recompute rate stats from career-aggregate components.
    out.AVG = out.AB > 0 ? out.H / out.AB : NaN;
    const obpDen = out.AB + out.BB + out.HBP + out.SF;
    out.OBP = obpDen > 0 ? (out.H + out.BB + out.HBP) / obpDen : NaN;
    out.SLG = out.AB > 0 ? out.TB / out.AB : NaN;
    // yearID kept for code that touches a single year (era classification,
    // sort, label). Use debut year as the career's "anchor" era.
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
};

const EXPLAINER_KEY = "bl2d_intro_seen";

function setupExplainer() {
    const backdrop = document.getElementById("explainer-backdrop");
    const dismiss = document.getElementById("explainer-dismiss");
    const helpBtn = document.getElementById("help-btn");
    if (!backdrop || !dismiss || !helpBtn) return;

    const show = () => { backdrop.hidden = false; dismiss.focus(); };
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
}


function populateEraLegend() {
    updateColorLegend("era");
}

function updateColorLegend(colorBy) {
    const el = document.getElementById("legend-eras");
    if (!el) return;
    if (colorBy === "era") {
        el.innerHTML = ERAS.map(e =>
            `<span class="legend-era" style="background:${e.color}" title="${e.name} (${e.start}–${e.end === 2099 ? "present" : e.end})"></span>`
        ).join("");
    } else if (colorBy === "bats" || colorBy === "league") {
        const palette = COLOR_PALETTES[colorBy];
        const keys = colorBy === "bats" ? ["L", "R", "S"] : ["AL", "NL"];
        el.innerHTML = keys.map(k => {
            const e = palette[k];
            return `<span class="legend-era" style="background:${e.color}" title="${escapeHtml(e.name)}"></span>`;
        }).join("");
    } else {
        el.innerHTML = "";
    }
}

function setupPaPresets() {
    const slider = document.getElementById("pa-min-select");
    document.querySelectorAll(".preset").forEach((btn) => {
        btn.addEventListener("click", () => {
            slider.value = btn.dataset.pa;
            slider.dispatchEvent(new Event("input", { bubbles: true }));
        });
    });
}

function syncPresetActive(value) {
    document.querySelectorAll(".preset").forEach((btn) => {
        btn.classList.toggle("active", parseInt(btn.dataset.pa) === value);
    });
}


function drawScatterPlot(points, xDim, yDim, sYear, eYear, minPa, formatStat, mode = "season", filters = {}) {
    const svg = d3.select("#scatter-plot");
    svg.selectAll("*").remove();
    d3.select("#tooltip").attr("data-visible", "false");

    const league = filters.league || "all";
    const bats = filters.bats || "all";
    const country = filters.country || "all";

    // Cache meta lookups per playerID across the filter pass.
    const metaCache = new Map();
    const getMeta = (id) => {
        if (metaCache.has(id)) return metaCache.get(id);
        const m = metaFor(id);
        metaCache.set(id, m);
        return m;
    };

    // Row-level predicate, applied before any aggregation. In Career mode
    // this also gates which seasons contribute to the aggregate — so
    // "League: AL + Bats: L + Career" yields each player's AL lefty-only
    // career totals (Bonds' regular-season AL totals would be empty; his NL
    // career sums alone in NL/L mode).
    const seasonMatches = (p) => {
        if (p.yearID < sYear || p.yearID > eYear) return false;
        if (league !== "all" && p.lgID !== league) return false;
        if (bats !== "all" || country !== "all") {
            const m = getMeta(p.playerID);
            // Strict: rows for players with no Lahman metadata (mostly 2024
            // BBRef entries with handedness suffixes) are dropped here.
            if (!m) return false;
            if (bats !== "all" && m.bats !== bats) return false;
            if (country !== "all" && m.country !== country) return false;
        }
        return true;
    };

    let workingPoints;
    if (mode === "career") {
        const byPlayer = new Map();
        for (const p of points) {
            if (!seasonMatches(p)) continue;
            let arr = byPlayer.get(p.playerID);
            if (!arr) { arr = []; byPlayer.set(p.playerID, arr); }
            arr.push(p);
        }
        workingPoints = [];
        for (const seasons of byPlayer.values()) {
            seasons.sort((a, b) => a.yearID - b.yearID);
            workingPoints.push(aggregateCareer(seasons));
        }
    } else {
        workingPoints = points.filter(seasonMatches);
    }

    const filtered = [];
    for (const p of workingPoints) {
        const x = p[xDim];
        const y = p[yDim];
        if (isNaN(x) || isNaN(y)) continue;
        if (p.PA < minPa) continue;
        filtered.push({
            x, y,
            year: p.yearID,
            yearLast: p.yearLast || p.yearID,
            seasonsCount: p.seasonsCount || 1,
            PA: p.PA,
            playerID: p.playerID,
            teamID: p.teamID,
            lgID: p.lgID,
            orig: p,  // for size-by lookups (PA / G / AB)
        });
    }

    filtered.sort((a, b) => {
        if (a.x !== b.x) return a.x - b.x;
        if (a.y !== b.y) return a.y - b.y;
        return b.year - a.year; // prefer more recent on ties
    });

    // Deduplicate exact (x, y) collisions for the rendering pass.
    const unique = [];
    for (let i = 0; i < filtered.length; i++) {
        const p = filtered[i];
        if (i === 0 || p.x !== filtered[i - 1].x || p.y !== filtered[i - 1].y) {
            unique.push(p);
        }
    }

    // Pareto frontier: sweep left-to-right, keep upper-right envelope.
    const frontier = [];
    for (const p of unique) {
        while (frontier.length && frontier[frontier.length - 1].y < p.y) frontier.pop();
        if (frontier.length && frontier[frontier.length - 1].y === p.y && frontier[frontier.length - 1].x < p.x) {
            frontier.pop();
        }
        frontier.push(p);
    }
    const frontierSet = new Set(frontier);

    renderFrontierCards(frontier, xDim, yDim, formatStat, filtered.length, mode);

    if (unique.length === 0) {
        svg.append("text")
            .attr("x", "50%").attr("y", "50%")
            .attr("text-anchor", "middle").attr("dominant-baseline", "middle")
            .attr("font-family", "var(--font-sans, sans-serif)")
            .attr("font-size", 14)
            .attr("fill", "#5a6478")
            .text("No seasons match the current filters.");
        return;
    }

    const svgEl = document.getElementById("scatter-plot");
    const rect = svgEl.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    const margin = { top: 24, right: 24, bottom: 44, left: 56 };
    const plotW = Math.max(40, width - margin.left - margin.right);
    const plotH = Math.max(40, height - margin.top - margin.bottom);

    const xExtent = d3.extent(unique, d => d.x);
    const yExtent = d3.extent(unique, d => d.y);
    const xScale = d3.scaleLinear().domain(xExtent).nice().range([0, plotW]);
    const yScale = d3.scaleLinear().domain(yExtent).nice().range([plotH, 0]);

    const g = svg.append("g")
        .attr("transform", `translate(${margin.left}, ${margin.top})`);

    g.append("g")
        .attr("class", "axis axis-x")
        .attr("transform", `translate(0, ${plotH})`)
        .call(d3.axisBottom(xScale).ticks(Math.max(4, Math.floor(plotW / 80))));

    g.append("g")
        .attr("class", "axis axis-y")
        .call(d3.axisLeft(yScale).ticks(Math.max(4, Math.floor(plotH / 50))));

    g.append("text")
        .attr("class", "axis-title")
        .attr("x", plotW / 2)
        .attr("y", plotH + 36)
        .attr("text-anchor", "middle")
        .text(xDim);
    g.append("text")
        .attr("class", "axis-title")
        .attr("transform", `rotate(-90)`)
        .attr("x", -plotH / 2)
        .attr("y", -38)
        .attr("text-anchor", "middle")
        .text(yDim);

    // Frontier connecting line first (under points).
    if (frontier.length > 1) {
        const line = d3.line().x(d => xScale(d.x)).y(d => yScale(d.y));
        g.append("path")
            .datum(frontier)
            .attr("class", "frontier-line")
            .attr("d", line);
    }

    const pointRadius = unique.length > 2000 ? 3 : (unique.length > 500 ? 4 : 5);
    const frontierRadius = 6;
    const hoverRadius = Math.max(pointRadius + 4, 8);

    const regular = unique.filter(d => !frontierSet.has(d));
    const special = unique.filter(d => frontierSet.has(d));

    const colorBy = filters.colorBy || "era";
    const sizeBy = filters.sizeBy || "none";
    // Build a size scale only if needed — radius range chosen to keep frontier
    // (r=6) visually dominant; size-by tops out near it but never larger.
    let sizeScale = null;
    if (sizeBy !== "none") {
        const vals = regular.map(d => d.orig && !isNaN(d.orig[sizeBy]) ? d.orig[sizeBy] : NaN)
            .filter(v => !isNaN(v));
        if (vals.length > 0) {
            const lo = d3.min(vals);
            const hi = d3.max(vals);
            sizeScale = d3.scaleSqrt().domain([lo, hi]).range([2, Math.max(pointRadius + 1, 5)]);
        }
    }

    g.append("g").selectAll("circle.regular-point")
        .data(regular).enter()
        .append("circle")
        .attr("class", "regular-point")
        .attr("cx", d => xScale(d.x))
        .attr("cy", d => yScale(d.y))
        .attr("r", d => {
            if (!sizeScale) return pointRadius;
            const v = d.orig && d.orig[sizeBy];
            return isNaN(v) ? 2 : sizeScale(v);
        })
        .attr("fill", d => colorOf(d, colorBy, getMeta));

    // Career-trail layer: rendered BEFORE the red frontier dots so the
    // clicked-on frontier point keeps its red marker on top.
    if (careerHighlight && playerIndex && playerIndex.has(careerHighlight)) {
        const allSeasons = playerIndex.get(careerHighlight)
            .map(p => ({ x: p[xDim], y: p[yDim], year: p.yearID }))
            .filter(s => !isNaN(s.x) && !isNaN(s.y))
            .sort((a, b) => a.year - b.year);
        if (allSeasons.length > 0) {
            const trailLine = d3.line().x(d => xScale(d.x)).y(d => yScale(d.y));
            const careerG = g.append("g").attr("class", "career-trail");
            if (allSeasons.length > 1) {
                careerG.append("path")
                    .attr("class", "career-line")
                    .attr("d", trailLine(allSeasons));
            }
            careerG.selectAll("circle")
                .data(allSeasons).enter()
                .append("circle")
                .attr("class", "career-point")
                .attr("cx", d => xScale(d.x))
                .attr("cy", d => yScale(d.y))
                .attr("r", Math.max(pointRadius + 1, 4));
        }
    }

    g.append("g").selectAll("circle.special-point")
        .data(special).enter()
        .append("circle")
        .attr("class", "special-point")
        .attr("cx", d => xScale(d.x))
        .attr("cy", d => yScale(d.y))
        .attr("r", frontierRadius);

    // On-chart frontier labels: greedy collision avoidance, mobile shows
    // only the two extreme endpoints so small viewports stay readable.
    const labels = layoutFrontierLabels(frontier, xScale, yScale, plotW, plotH, frontierRadius, width < 480);
    g.append("g")
        .attr("class", "frontier-labels")
        .selectAll("text")
        .data(labels).enter()
        .append("text")
        .attr("class", "frontier-label")
        .attr("x", d => d.x)
        .attr("y", d => d.y)
        .attr("text-anchor", d => d.anchor)
        .text(d => d.text);

    // Tooltip targets: invisible larger circles to ease hover/tap on every point.
    const tooltip = document.getElementById("tooltip");
    const showTooltip = (event, d) => {
        const seasons = filtered.filter(p => p.x === d.x && p.y === d.y);
        const head = `<div class="tooltip-header">${xDim} ${formatStat(xDim, d.x)} · ${yDim} ${formatStat(yDim, d.y)}</div>`;
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
        tooltip.innerHTML = head + body + more;
        tooltip.setAttribute("data-visible", "true");
        positionTooltip(event, tooltip);
    };
    const hideTooltip = (force = false) => {
        if (tooltipPinned && !force) return;
        tooltip.setAttribute("data-visible", "false");
    };

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
            // Any click on any point pins the tooltip there so the user can
            // read it without holding the mouse still. Click empty area or
            // Escape unpins.
            tooltipPinned = true;
            showTooltip(event, d);
            event.stopPropagation();
            // Click a frontier point (in season mode only) also triggers the
            // career-arc highlight. Career mode skips this — each dot IS
            // already the career, so an overlay would be noise.
            if (mode === "season" && frontierSet.has(d)) {
                const seasons = filtered
                    .filter(p => p.x === d.x && p.y === d.y)
                    .sort((a, b) => b.year - a.year);
                const target = seasons[0] || d;
                careerHighlight = target.playerID;
                // Dispatch via the same change-pipeline so the URL hash
                // (which carries the highlight id) stays in sync.
                document.dispatchEvent(new CustomEvent("bl2d:refresh"));
            }
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
    let y = event.clientY + pad;
    if (x + ttRect.width + pad > vw) x = event.clientX - ttRect.width - pad;
    if (y + ttRect.height + pad > vh) y = event.clientY - ttRect.height - pad;
    if (x < pad) x = pad;
    if (y < pad) y = pad;
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
}

function lastNameOf(playerID) {
    const m = String(playerID).match(/[^\s]+$/);
    return m ? m[0] : String(playerID);
}

function layoutFrontierLabels(frontier, xScale, yScale, plotW, plotH, pointR, isSmall) {
    if (!frontier.length) return [];

    // On narrow phones, only label the two extreme endpoints to avoid clutter.
    let candidates;
    if (isSmall && frontier.length > 2) {
        candidates = [frontier[0], frontier[frontier.length - 1]];
    } else {
        candidates = frontier;
    }

    const CHAR_W = 6.2;
    const H = 12;
    const GAP = 5;

    const pointBoxes = frontier.map(p => ({
        x: xScale(p.x) - pointR,
        y: yScale(p.y) - pointR,
        w: pointR * 2,
        h: pointR * 2,
    }));
    const placed = [];
    const overlap = (a, b) =>
        !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

    const out = [];
    for (const p of candidates) {
        const text = `${lastNameOf(p.playerID)} ${p.year}`;
        const w = text.length * CHAR_W;
        const cx = xScale(p.x);
        const cy = yScale(p.y);

        // Try cardinal positions first, then diagonal corners as fallbacks
        // for points near the plot edges (e.g. the topmost frontier point).
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

        for (const pos of positions) {
            const bbox = { x: pos.bx, y: pos.by, w, h: H };
            if (bbox.x < 0 || bbox.y < 0 || bbox.x + bbox.w > plotW || bbox.y + bbox.h > plotH) continue;
            if (placed.some(b => overlap(b, bbox))) continue;
            if (pointBoxes.some(b => overlap(b, bbox))) continue;
            placed.push(bbox);
            out.push({ text, x: pos.x, y: pos.y, anchor: pos.anchor });
            break;
        }
    }
    return out;
}


function renderFrontierCards(frontier, xDim, yDim, formatStat, totalUnits, mode = "season") {
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
                <div class="frontier-card-era">${era ? era.name : "—"}</div>
            </article>
        `;
    }).join("");
}
