# Claude Design — Professional Design Review Brief

A playbook for running a professional design review of **Baseball Limits 2D** through
[Claude Design](https://www.anthropic.com/news/claude-design-anthropic-labs) (Anthropic
Labs' visual-canvas workspace). Scope this pass: **review only** — prioritized critique
plus mockup options, no implementation. **Brand is open** — fresh palette directions are
welcome, not bound to the current MLB blue/red.

> Note: Claude Design reviews **visual design and UX** — the shell (header, controls
> sidebar, modals, tooltips, legend), color/type/spacing tokens, hierarchy, mobile layout,
> and chart *styling*. It does **not** evaluate the Pareto algorithm or the D3 rendering
> logic in `script.js`. Keep the critique aimed at visuals, not chart correctness.

## 1. What to feed Claude Design (onboarding)

1. The **repo**, or at minimum `styles.css` + `index.html` (the design-bearing files).
2. The **baseline screenshot set** as "current state":
   - `01-season-batting.png` — desktop, season batting (HR vs SB frontier)
   - `02-career.png` — desktop, career mode
   - `03-pitching.png` — desktop, pitching dataset
   - `04-explainer.png` — first-load welcome modal
   - `05-share.png` — share modal
   - `06-mobile-chart.png` — mobile chart (390×844)
   - `07-mobile-drawer.png` — mobile with the Controls drawer expanded
   - (Regenerate anytime with `scripts/snap.js` — see the repo's CLAUDE.md "Headless
     verification" section.)
3. Live URL: <https://eliogovea.github.io/baseball-limits-2d/>

After onboarding, confirm Claude Design extracted the real design system; correct it if it
drifts:

```
Brand:    --mlb-blue #002d72 · --mlb-red #c8102e · frontier #0f172a · career gold #f59e0b
Neutrals: --bg #f6f7f9 · --panel #fff · --border #e3e6ea · --text #1a1f2e · --text-muted #5a6478
Radius:   8px / 6px      Header: 56 → 64px      Sidebar: 300 → 320px (≥1200px)
Type:     system-font stack, 14px base, uppercase 10–11px labels with letter-spacing
Layout:   mobile-first column (header / chart / collapsible "Controls" drawer)
          → at 768px flips to row (chart left, fixed sidebar right);
          body overflow:hidden, sub-regions scroll independently.
```

Components in scope: app header (brand + data attribution + icon buttons + help), segmented
toggles (Best/Worst, Batting/Pitching, Season/Career), axis selects, year-range + animate
button, 30-team franchise picker grid, country chips, player search + chips, threshold
input, chart legend, loading/spinner, tooltip, glossary popover, share modal, welcome
explainer modal.

## 2. The review brief (paste into Claude Design)

> You're doing a **professional design review** of Baseball Limits 2D, a static D3 site that
> scatter-plots 150 years of MLB stats and highlights the 2-D Pareto frontier (the red
> staircase). Review **visual design and UX only** — not the chart algorithm. Cover:
>
> 1. **Visual hierarchy & critique** of the header, the 300px controls sidebar, the chart
>    chrome (legend, axis labels, frontier labels), and the modals.
> 2. **Information density** — the sidebar stacks many segmented toggles (Best/Worst,
>    Batting/Pitching, Season/Career), axis selects, a year range, a 30-team franchise grid,
>    country chips, and player search in a narrow column. Is it scannable? What's the
>    hierarchy problem?
> 3. **Accessibility** — contrast on muted text (#5a6478 on #fff) and 10–11px uppercase
>    labels; focus states; and whether the AL-red / NL-blue and era color encodings are
>    color-blind safe.
> 4. **Mobile** — the collapsed "Controls" drawer pattern; are key controls reachable?
> 5. **Data-viz craft** — frontier red vs. the faded background cloud, legend clarity,
>    tooltip layout, on-chart label collisions, the gold career trail.
> 6. **Fresh palette exploration** — the MLB blue/red brand is **not fixed**. Propose
>    **2–3 distinct color directions** (e.g. modern sports-data, editorial/analytical,
>    high-contrast dark), each mocked on the **same 2–3 representative screens** (desktop
>    season chart, mobile drawer, share modal), with rationale and contrast notes. Include
>    the current MLB-faithful look as a control.
> 7. Deliver a **prioritized findings list (P0/P1/P2)**, each item tied to a concrete
>    component or token with an implementable recommendation. No vague "make it more modern."

Use Claude Design's refinement loop (chat, inline comments, sliders) to push on the
directions worth seeing in more detail.

## 3. Capturing the output

- Export the findings + chosen mockup directions from Claude Design (Markdown / PDF / HTML).
- Save the writeup as `docs/design-review.md`; drop exported mockups in
  `docs/design-review-assets/`.
- Add an open item under **Ideas & future work** in `README.md` pointing to the review —
  keep it as `- [ ]` (design-only this pass, no implementation).

## 4. Sanity-check the results

1. Every baseline screenshot rendered the intended state before hand-off (no stray modal
   overlay, chart populated).
2. Contrast/accessibility claims match the real tokens (e.g. `--text-muted #5a6478` on
   `--panel #fff`).
3. Each palette direction is mocked on the **same** representative screens, and a
   brand-faithful control is included.
4. Every finding is prioritized (P0/P1/P2) and maps to a concrete component/token.
