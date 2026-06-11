/* tour.js — zero-dependency guided spotlight tour. Dims the app and lights up
   one region at a time with a one-line coachmark, teaching the core concepts in
   context. Launched on demand from the welcome modal ("Take the tour"); exposes
   window.startTour(). No build step, no external libraries (matches the site's
   static ethos). */
(function () {
    const STEPS = [
        { sel: ".chart-region", title: "The chart", body: "Each dot is one MLB season (a career in Career mode), colored by era.", place: "center" },
        { sel: ".special-point", title: "The frontier", body: "This staircase is the Pareto frontier — no season ever did more on both stats at once.", place: "right" },
        { sel: ".axis-title", title: "Pick any two stats", body: "Tap an axis label (or use the selectors) to plot a different pairing.", place: "bottom" },
        { sel: "#preset-shelf", title: "Famous frontiers", body: "Or jump straight into a story — Ohtani's 50/50, Bonds' 73 — with one tap.", place: "bottom" },
        { sel: ".controls-region", title: "Explore", body: "Filter by team, era, handedness, or birthplace; pin a player to trace their career.", place: "left" },
    ];

    let root = null, ring = null, card = null, idx = 0, live = null;

    const reduceMotion = () =>
        window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2 && r.bottom > 4 && r.right > 4 &&
            r.top < innerHeight - 4 && r.left < innerWidth - 4;
    };

    function build() {
        root = document.createElement("div");
        root.className = "bl-tour";
        root.setAttribute("role", "dialog");
        root.setAttribute("aria-label", "Guided tour");

        ring = document.createElement("div");
        ring.className = "bl-tour-ring";

        card = document.createElement("div");
        card.className = "bl-tour-card";

        live = document.createElement("div");
        live.className = "sr-only";
        live.setAttribute("aria-live", "polite");

        root.appendChild(ring);
        root.appendChild(card);
        root.appendChild(live);
        document.body.appendChild(root);

        if (reduceMotion()) ring.classList.add("bl-tour-ring--still");

        // Clicking the dimmed area (not the card) advances.
        root.addEventListener("click", (e) => {
            if (e.target === root || e.target === ring) next();
        });
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("resize", position);
        window.addEventListener("scroll", position, true);
    }

    function onKey(e) {
        if (!root) return;
        if (e.key === "Escape") { e.preventDefault(); end(); }
        else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
    }

    // Resolve the target for a step, skipping ones whose element is missing or
    // hidden (e.g. sidebar controls behind the collapsed mobile drawer).
    function targetFor(i) {
        const el = document.querySelector(STEPS[i].sel);
        return isVisible(el) ? el : null;
    }
    function nextVisible(from, dir) {
        let i = from;
        while (i >= 0 && i < STEPS.length) {
            if (targetFor(i)) return i;
            i += dir;
        }
        return -1;
    }

    function render() {
        const step = STEPS[idx];
        const el = targetFor(idx);
        if (!el) { // current step's target vanished — find another
            const j = nextVisible(idx, 1);
            if (j === -1) { end(); return; }
            idx = j;
            render();
            return;
        }
        position();
        // Build the coachmark.
        const total = STEPS.length;
        const dots = STEPS.map((_, i) => `<span class="bl-tour-dot${i === idx ? " is-on" : ""}"></span>`).join("");
        card.innerHTML =
            `<div class="bl-tour-title">${step.title}</div>` +
            `<div class="bl-tour-body">${step.body}</div>` +
            `<div class="bl-tour-foot">` +
            `<div class="bl-tour-dots">${dots}</div>` +
            `<div class="bl-tour-btns">` +
            `<button type="button" class="bl-tour-skip">Skip</button>` +
            (idx > 0 ? `<button type="button" class="bl-tour-prev">Back</button>` : "") +
            `<button type="button" class="bl-tour-next">${idx === total - 1 ? "Done" : "Next"}</button>` +
            `</div></div>`;
        card.querySelector(".bl-tour-skip").addEventListener("click", end);
        card.querySelector(".bl-tour-next").addEventListener("click", next);
        const prevBtn = card.querySelector(".bl-tour-prev");
        if (prevBtn) prevBtn.addEventListener("click", prev);
        live.textContent = `Step ${idx + 1} of ${total}. ${step.title}. ${step.body}`;
        card.querySelector(".bl-tour-next").focus({ preventScroll: true });
    }

    function position() {
        if (!root) return;
        const el = targetFor(idx);
        if (!el) return;
        const r = el.getBoundingClientRect();
        const pad = STEPS[idx].place === "center" ? -6 : 8;
        const x = Math.max(4, r.left - pad), y = Math.max(4, r.top - pad);
        const w = Math.min(innerWidth - 8, r.width + pad * 2);
        const h = Math.min(innerHeight - 8, r.height + pad * 2);
        Object.assign(ring.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });

        // Place the coachmark adjacent to the hole, clamped to the viewport.
        const cw = 248, gap = 12;
        let cx, cy;
        const place = STEPS[idx].place;
        if (place === "left") { cx = x - cw - gap; cy = y; }
        else if (place === "right") { cx = x + w + gap; cy = y; }
        else if (place === "top") { cx = x; cy = y - gap - 120; }
        else if (place === "bottom") { cx = x; cy = y + h + gap; }
        else { cx = (innerWidth - cw) / 2; cy = innerHeight / 2 - 40; } // center
        cx = Math.max(8, Math.min(innerWidth - cw - 8, cx));
        cy = Math.max(8, Math.min(innerHeight - 150, cy));
        Object.assign(card.style, { left: cx + "px", top: cy + "px", width: cw + "px" });
    }

    function next() {
        const j = nextVisible(idx + 1, 1);
        if (j === -1) { end(); return; }
        idx = j; render();
    }
    function prev() {
        const j = nextVisible(idx - 1, -1);
        if (j === -1) return;
        idx = j; render();
    }
    function end() {
        if (!root) return;
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", position);
        window.removeEventListener("scroll", position, true);
        root.remove();
        root = ring = card = live = null;
        try { localStorage.setItem("bl2d_tour_done", "1"); } catch (_) { /* private mode */ }
    }

    function start() {
        if (root) return;
        build();
        const first = nextVisible(0, 1);
        if (first === -1) { end(); return; }
        idx = first;
        render();
    }

    window.startTour = start;

    // Wire the "Take the tour" launcher in the welcome modal once the DOM is ready.
    function wire() {
        const btn = document.getElementById("take-tour-btn");
        if (!btn) return;
        btn.addEventListener("click", () => {
            const backdrop = document.getElementById("explainer-backdrop");
            if (backdrop) backdrop.hidden = true;
            try { localStorage.setItem("bl2d_intro_seen", "1"); } catch (_) { /* ignore */ }
            // let the modal close before measuring targets
            requestAnimationFrame(() => requestAnimationFrame(start));
        });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
    else wire();
})();
