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


d3.csv("data/batting_limits_1871-2024.csv").then((points) => {
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
    setupControlsToggle();
    setupPaPresets();

    const loadingIndicator = document.getElementById("loading-indicator");
    let pendingRender = null;

    function refreshChart() {
        const xDim = document.getElementById("x-axis-select").value;
        const yDim = document.getElementById("y-axis-select").value;
        const sYear = parseInt(document.getElementById("s-year-select").value);
        const eYear = parseInt(document.getElementById("e-year-select").value);
        const minPa = parseInt(document.getElementById("pa-min-select").value);

        document.getElementById("pa-min-value").textContent = minPa.toLocaleString();
        syncPresetActive(minPa);

        loadingIndicator.classList.add("active");
        // Yield so the spinner can paint before the (synchronous) D3 work.
        cancelAnimationFrame(pendingRender);
        pendingRender = requestAnimationFrame(() => {
            drawScatterPlot(points, xDim, yDim, sYear, eYear, minPa, formatStat);
            loadingIndicator.classList.remove("active");
        });
    }

    refreshChart();

    ["x-axis-select", "y-axis-select", "s-year-select", "e-year-select"].forEach((id) => {
        document.getElementById(id).addEventListener("change", refreshChart);
    });
    // Slider: live preview while dragging.
    document.getElementById("pa-min-select").addEventListener("input", refreshChart);

    // Re-render when the chart container changes size (window resize, mobile controls toggle).
    let resizeTimer;
    const chartRegion = document.querySelector(".chart-region");
    const resizeObserver = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(refreshChart, 120);
    });
    resizeObserver.observe(chartRegion);
});


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

function setupControlsToggle() {
    const toggle = document.getElementById("controls-toggle");
    const panel = document.getElementById("controls-panel");
    toggle.addEventListener("click", () => {
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!expanded));
        panel.classList.toggle("collapsed", expanded);
    });
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


function drawScatterPlot(points, xDim, yDim, sYear, eYear, minPa, formatStat) {
    const svg = d3.select("#scatter-plot");
    svg.selectAll("*").remove();
    d3.select("#tooltip").attr("data-visible", "false");

    const filtered = [];
    for (const p of points) {
        const x = p[xDim];
        const y = p[yDim];
        if (isNaN(x) || isNaN(y)) continue;
        if (p.yearID < sYear || p.yearID > eYear) continue;
        if (p.PA < minPa) continue;
        filtered.push({
            x, y,
            year: p.yearID,
            PA: p.PA,
            playerID: p.playerID,
            teamID: p.teamID,
            lgID: p.lgID,
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

    renderFrontierCards(frontier, xDim, yDim, formatStat, filtered.length);

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

    g.append("g").selectAll("circle.regular-point")
        .data(regular).enter()
        .append("circle")
        .attr("class", "regular-point")
        .attr("cx", d => xScale(d.x))
        .attr("cy", d => yScale(d.y))
        .attr("r", pointRadius);

    g.append("g").selectAll("circle.special-point")
        .data(special).enter()
        .append("circle")
        .attr("class", "special-point")
        .attr("cx", d => xScale(d.x))
        .attr("cy", d => yScale(d.y))
        .attr("r", frontierRadius);

    // Tooltip targets: invisible larger circles to ease hover/tap on every point.
    const tooltip = document.getElementById("tooltip");
    const showTooltip = (event, d) => {
        const seasons = filtered.filter(p => p.x === d.x && p.y === d.y);
        const head = `<div class="tooltip-header">${xDim} ${formatStat(xDim, d.x)} · ${yDim} ${formatStat(yDim, d.y)}</div>`;
        const visible = seasons.slice(0, 6);
        const body = visible.map(s => `
            <div class="tooltip-row">
                <span class="tooltip-name">${escapeHtml(s.playerID)}</span>
                <span class="tooltip-meta">${escapeHtml(s.teamID)} ${escapeHtml(s.lgID)} ${s.year}</span>
            </div>
        `).join("");
        const more = seasons.length > visible.length
            ? `<div class="tooltip-more">+${seasons.length - visible.length} more season${seasons.length - visible.length === 1 ? "" : "s"}</div>`
            : "";
        tooltip.innerHTML = head + body + more;
        tooltip.setAttribute("data-visible", "true");
        positionTooltip(event, tooltip);
    };
    const hideTooltip = () => tooltip.setAttribute("data-visible", "false");

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
        .on("touchstart", showTooltip, { passive: true });

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

function renderFrontierCards(frontier, xDim, yDim, formatStat, totalSeasons) {
    const countEl = document.getElementById("frontier-count");
    const cardsEl = document.getElementById("frontier-cards");
    if (!countEl || !cardsEl) return;

    countEl.textContent = `${frontier.length} of ${totalSeasons.toLocaleString()} seasons`;

    if (frontier.length === 0) {
        cardsEl.innerHTML = `<div class="frontier-empty">No seasons match the current filters.</div>`;
        return;
    }

    // Order so the highest-X (rightmost extreme) appears first — that's
    // usually the more famous record for "X-leaning" axes like HR.
    const ordered = [...frontier].sort((a, b) => b.x - a.x);

    cardsEl.innerHTML = ordered.map(p => {
        const era = eraFor(p.year);
        return `
            <article class="frontier-card">
                <div class="frontier-card-name">${escapeHtml(p.playerID)}</div>
                <div class="frontier-card-year">${p.year}</div>
                <div class="frontier-card-team">${escapeHtml(p.teamID)} · ${escapeHtml(p.lgID)}</div>
                <div class="frontier-card-stats">${xDim} ${formatStat(xDim, p.x)} · ${yDim} ${formatStat(yDim, p.y)}</div>
                <div class="frontier-card-era">${era ? era.name : "—"}</div>
            </article>
        `;
    }).join("");
}
