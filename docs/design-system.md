# Baseball Limits 2D — Design System

> A reusable design system distilled from **[Baseball Limits 2D](https://eliogovea.github.io/baseball-limits-2d/)**, a static D3.js single-page app that scatter-plots ~150 years of MLB batting and pitching statistics and highlights the 2-D **Pareto frontier** — the outer edge of what's ever been done.

This folder lets a design agent (or a human) produce on-brand Baseball Limits 2D screens, components, and assets without re-deriving the tokens each time. It was built by reading the production source, not by guessing from screenshots.

> **Provenance.** Distilled from a Claude Design review of this repo (see [`docs/claude-design-review-brief.md`](claude-design-review-brief.md)) and preserved as a living style guide. The review's recommendations shipped in commit `e9eec27` (theme system, CVD-safe era encoding, a11y, brand), so the **tokens below describe the shipped Classic theme**; the Editorial / Night variants live in the `THEMES` table in `script.js`. Asset-path references elsewhere in this doc point at the original export layout — in this repo the chosen mark + favicons are in `icons/` and the other logo concepts are in `icons/alternates/`.

---

## Product context

**What it does.** Pick any two batting or pitching dimensions (HR vs SB, ERA vs K/9, …) and the app scatter-plots every qualifying player-season — each dot one season, colored by era. A red-free dark **staircase** traces the Pareto frontier: no season in history achieved more in *both* stats at once. The step shape is exact; each edge marks where a record changes hands.

**Core interactions**
- **Best / Worst** frontier direction (upper-right vs lower-left envelope).
- **Batting / Pitching** dataset toggle, **Season / Career** aggregation toggle.
- **X / Y axis** stat selectors (also clickable directly on-chart via the axis title).
- **Year range** with a ▶ animation that advances the end year so you can watch the frontier evolve.
- **Filters**: a 30-team franchise grid (grouped by AL/NL division), handedness (Bats: All/L/R/S), country-of-birth chips, and a minimum plate-appearances / innings-pitched threshold.
- **Player search** typeahead — highlights a player's seasons and pins them as a colored chip.
- **Click a frontier dot** → traces that player's full career arc in gold and shades the area their seasons collectively own.
- **Hover a frontier dot** → shows its exclusive "hypervolume contribution" area + a dashed isolation ring to the nearest rival season.
- **Share** modal (server-rendered preview image + per-platform deep links + copy-link / copy-image), **Download SVG**, and a first-visit **welcome** explainer modal.

**Surface.** One responsive web app. Desktop = chart left + fixed 300/320px controls sidebar right. Mobile = chart fills, controls collapse into a bottom "Controls" drawer. There is no native app, no marketing site, no docs site — so this design system documents **one product surface**.

**Tech.** Pure static site: `index.html` + `script.js` (~131 KB) + `styles.css`, D3 v7 from CDN, GitHub Pages, no build step. Data is the [SABR Lahman Baseball Database](https://sabr.org/lahman-database/) (1871–2025), CC BY-SA 3.0.

---

## Sources used to build this system

All values here were lifted from the live source. If you have access, explore these to do an even better job:

- **GitHub repo:** https://github.com/eliogovea/baseball-limits-2d
  - `styles.css` — the entire token system (`:root` vars), component CSS, responsive breakpoints. **Primary source of truth.**
  - `script.js` — the `ERAS`, `COLOR_PALETTES`, `FRANCHISES`, and `GLOSSARY` data tables; all the data-viz color/size encodings.
  - `index.html` — DOM structure of the header, modals, chart chrome, and controls sidebar; all the inline SVG icons.
  - `CLAUDE.md` — architecture, layout, and the team's working/verification methodology.
  - `README.md` (theirs) — product overview, data pipeline, and a long backlog of analytical / visual ideas.
  - `og-image.png` — the social-share hero (and the most faithful single image of the real UI). Copied to `assets/og-image.png`.
- **Live site:** https://eliogovea.github.io/baseball-limits-2d/

Reading these repositories directly will always beat this snapshot for pixel fidelity — treat this design system as a fast-start, not a replacement.

---

## CONTENT FUNDAMENTALS

The voice is **knowledgeable enthusiast** — a stats-literate baseball fan explaining the chart to another fan. Confident, precise, lightly reverent toward the records themselves. Never marketing-y, never cute.

- **Person.** Mostly **imperative second-person** for instructions ("Hover a red dot", "Press ▶", "Pick any two stats"). The product describes its own behavior in third person ("each dot is one MLB season"). First-person "we"/"I" appears only in dev docs, never in the UI.
- **Casing.** **Sentence case** for headings and body ("Welcome to Baseball Limits 2D", "Share this view"). **UPPERCASE micro-labels** with letter-spacing for control labels, legends, and the tooltip header ("DATA", "AL EAST", "Min PA", "SHARE ON"). Stat abbreviations are canonical baseball casing (HR, SB, ERA, K/9, WHIP, OPS).
- **Tone & vibe.** Authoritative but warm. Uses concrete record examples as proof points rather than adjectives: *"Ohtani's 50/50, Bonds' 73, Henderson's 130 steals."* Explains *mechanism* ("the step shape is exact — each edge marks where the record changes"). Comfortable with light stats jargon (Pareto frontier, hypervolume, isolation radius) but always glosses it.
- **Numbers.** Tabular figures everywhere (`font-variant-numeric: tabular-nums`). Years are bare 4-digit (1920 – 2025). Player-season records read as "Henderson 1982". Same-name players get a `(b.YYYY)` disambiguator.
- **Emoji.** **None in the chrome.** The only emoji are **country flags** 🇺🇸🇩🇴🇻🇪 used as compact identifiers in the country-of-birth filter chips. No decorative emoji anywhere else.
- **Punctuation.** Em dashes for asides, middot `·` as a separator in the attribution nav, the play glyph ▶ referenced in prose, ✓ check appended to selected/added items.

**Representative copy (verbatim from the app):**
> *"The red staircase is the Pareto frontier: no season in history has ever achieved more in both stats at once."*
> *"Hover a red dot to see the shaded area that season exclusively controls — the region the frontier would lose if it were removed."*
> *"Frontier size = area owned"* (legend note)
> *"After copying the image, paste it into your post on any platform."* (share hint)

Button labels are terse verbs or nouns: **Start exploring**, **Copy link**, **Copy image**, **Best / Worst**, **Batting / Pitching**, **Season / Career**, **All / L / R / S**.

---

## VISUAL FOUNDATIONS

The aesthetic is **clean analytical dashboard** — a data tool, not a marketing page. Restrained, dense, neutral surfaces with two saturated brand colors used sparingly. Think Bloomberg-terminal-meets-baseball-reference, softened.

### Color
- **Two-color brand:** deep **MLB navy `#002d72`** (primary — header wordmark, all active controls, links, focus rings) and **MLB red `#c8102e`** (accent — the "2D" in the wordmark, the AL league dot, left-handed encoding). These echo MLB's own identity but the brief explicitly says they're **not fixed** — see the palette-exploration deliverable.
- **Neutral foundation:** warm-cool-neutral greys — app `#f6f7f9`, panels pure white `#ffffff`, hairline borders `#e3e6ea` / `#cdd2d8`, ink `#1a1f2e`, muted `#5a6478`.
- **Functional accents:** career-trail **gold `#f59e0b`**, success **green `#1a9e5a`**, unknown-grey `#94a3b8`.
- **The frontier is NOT red.** Despite the brief calling it "the red staircase," the production frontier staircase + dots are **slate `#0f172a`**; size (not color) encodes "area owned." Background-cloud dots are colored by **era** on a 7-stop warm-tan → navy → plum → teal scale. League (AL red / NL blue) and handedness are alternative cloud encodings.
- **Era scale** (background cloud): Pre-modern `#a89a7e` → Dead Ball `#8a7456` → Live Ball `#4a6fa5` → Integration `#2f5b8a` → Free Agency `#1f4570` → Steroid `#7a3f5f` → Modern `#005a8a`. A sepia-to-blue ramp, roughly chronological warmth-to-coolness.

### Type
- **No custom font.** Pure **system sans stack** (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, …`). This is deliberate — zero web-font payload on a data-heavy page. There are no fonts to ship; any environment renders in its native UI font.
- Base **14px / 1.45**. Hierarchy comes from **size + weight + case + tracking**, not from typeface contrast. The signature move is the **10–11px uppercase micro-label** with `0.04–0.05em` tracking in muted grey.
- Numbers are **tabular** everywhere.
- See `colors_and_type.css` for the full role scale.

### Spacing, radius, elevation
- Tight, consistent **8px-ish rhythm**; control sections pad `6–10px` vertically, gaps of `2–12px`.
- **Radii:** `8px` (fields, cards, panels), `6px` (segmented controls, chips, small buttons), `20px` pill (player chips), `14px` (share modal), circular (icon buttons, legend dots, slider thumbs).
- **Two-tier shadow system:** `--shadow-sm` (barely-there 1px card lift) and `--shadow-md` (12px tooltip/popover float), plus heavier modal shadows. Shadows are **cool slate-tinted**, low opacity (4–8%), never dramatic.

### Backgrounds, texture, imagery
- **Flat solid fills only.** No gradients in the chrome, no textures, no patterns, no photography. The one near-gradient is the subtle vertical fade behind the og-image title.
- The "imagery" is the **data itself** — the scatter cloud. Visual interest comes from the dot field, the staircase, and the gold career trails.
- Glassy overlays: chart legend, toolbar, and loading chip use **`rgba(255,255,255,0.92)` + `backdrop-filter: blur(6px)`** to float above the plot. Modal backdrops are `rgba(15,23,42,0.45–0.5)` + 4px blur.

### Motion
- **Fast and functional.** Global `--transition: 0.15s ease` on color/border/box-shadow. No decorative or looping animation in the chrome.
- The welcome modal has a tasteful entrance: backdrop `fade 0.18s ease-out` + panel `pop 0.22s cubic-bezier(0.34, 1.4, 0.56, 1)` (a slight overshoot).
- The spinner rotates `0.8s linear infinite`. The slider thumb scales `1.1` on `:active`.
- The frontier **▶ animation** steps the end-year forward (data motion, not CSS). **Note:** there is *no* `prefers-reduced-motion` handling yet — flagged as an a11y gap in the review.

### Interaction states
- **Hover (controls/links):** text & border shift to **MLB blue**, background to `--bg`. Links grow a blue bottom-border.
- **Active/selected (toggles, chips, presets):** **solid MLB-blue fill, white text**, subtle inset shadow `0 1px 2px rgba(0,45,114,0.2)`. Country/franchise chips selected = blue border + 7% blue tint + blue text.
- **Focus:** `outline: none` replaced by a **3px `rgba(0,45,114,0.12)` ring** on fields; slider thumb gets a 4px ring on `:focus-visible`. (Many non-form controls lack a visible focus ring — flagged in review.)
- **Press:** solid-blue buttons darken via `opacity: 0.88` or `--mlb-blue-hover`. Slider thumb scales up + cursor `grabbing`.
- **Confirmation:** copy actions flip to **green `#1a9e5a`** with a ✓.

### Borders, cards, transparency
- **Hairline borders are the primary separator** — 1px `#e3e6ea`, occasionally dashed `1px dashed var(--border)` between tooltip rows. Cards lean on borders + faint shadow rather than heavy elevation.
- **Cards** = white panel + 1px border + `--shadow-sm`, `8px` radius. Tooltips/popovers add `--shadow-md`. No colored left-border accents anywhere.
- **Transparency/blur** is reserved for chart-overlay chrome (legend, toolbar, loading) and modal backdrops — used to keep the underlying data partly visible, not for decoration.

---

## ICONOGRAPHY

**Hand-authored inline SVG, monoline stroke.** There is **no icon font and no icon library** (no Lucide, Heroicons, Font Awesome, etc.). Every icon is a small inline `<svg>` written directly in `index.html`.

- **Style:** `stroke="currentColor"`, `stroke-width` ~1.4–1.6, `stroke-linecap="round"`, `stroke-linejoin="round"`, `fill="none"` for line icons; a handful are solid-fill (play ▶ triangle, stop square, the platform brand glyphs). They inherit text color so they recolor on hover via `currentColor`.
- **Sizes:** 14px (header utility + share actions), 16px (GitHub mark, chevrons), 18px (share-platform brand marks), 11–12px (play/stop, axis carets).
- **The set:** download-arrow (export SVG), GitHub octocat mark (solid fill), share-link, a `?` help glyph (text, not SVG), close ✕, a chevron used for collapse/expand, brush/pan/reset zoom tools, play ▶ / stop ■, and **brand marks for X, Bluesky, LinkedIn, Facebook, WhatsApp, Reddit** in the share modal (each a single-path solid SVG).
- **Unicode as icons:** the play glyph **▶** in prose, **✓** appended to selected items, **·** middot separators, the help **?** rendered as a styled text button.
- **Emoji as data:** **country flag emoji** in the country-of-birth filter chips (the only emoji in the product).
- **Franchise "icons":** the 30 teams are represented not by logos but by **colored dot swatches** (each team's primary hex) + 2–3-letter abbreviation. No team logos are used (licensing).

**Guidance for new work:** stay with inline monoline SVG at the documented stroke weights, or substitute **Lucide** (closest match: same 1.5px round-cap monoline style) and flag the substitution. Do **not** introduce filled/duotone icon sets, and do not add decorative emoji.

### Logo & app icons

A logomark was designed for the product (it had none — the brand was wordmark-only). The concept is the **Pareto frontier itself**: a descending staircase with a single highlighted "record" dot. The dot is **gold `#f59e0b`** — reusing the product's own "highlight / record" semantic (career trail, pinned players) so it does **not** collide with the AL-league red. Explore all directions + colorways in `logos/index.html`.

Chosen default: **F · Apex Dot, gold** — one bold record dot + step notch, the most legible at favicon size. In this repo it ships inline in the header and as `icons/favicon.svg` (+ PNG/apple-touch/maskable). The other concepts below are preserved in `icons/alternates/`:

| File | Use |
|---|---|
| `favicon.svg` | Primary scalable icon (= apex / gold). |
| `favicon-16.png`, `favicon-32.png` | Browser favicons. |
| `apple-touch-icon-180.png` | iOS home-screen (full-bleed navy, no transparent corners). |
| `icon-512.png` | General / PWA icon (rounded tile). |
| `icon-maskable-512.png` | Android maskable (full-bleed; content in safe zone). |
| `apex-gold/-mono/-red.svg` | The chosen concept in all three colorways. |
| `frontier-gold.svg`, `frontier-area-gold.svg`, `stepline-gold.svg`, `scatter-gold.svg`, `monogram-gold.svg` | The alternate concepts (kept so the final pick can change). |

The UI kit links `favicon.svg` + the apple-touch icon. The header wordmark lockup is unchanged pending a final concept decision.

> ⚠️ **Substitution flag:** no logo or icon-font files exist to copy from the repo (the icons live inline in HTML). The UI kit re-inlines the exact same SVG paths. If you need a standalone icon set for new surfaces, use Lucide from CDN and note it.

---

## Where this lives in the repo

The original export carried CSS/JSX kits, specimen previews, and the rendered review; those were integrated and are not duplicated here. What survives in the repo:

| In the repo | What it is |
|---|---|
| `styles.css` `:root` | The canonical token system — brand, neutrals, era ramp, shadows, radii, and the themeable `--glass-bg` / `--gold` / `--league-*` / `--on-primary` tokens. **Source of truth for the Classic theme.** |
| `script.js` → `THEMES` | The Classic / Editorial / Night token sets + per-theme era ramps; `applyTheme()` writes them to `<html>`. |
| `icons/` | The chosen apex logomark + favicon / app-icon set + `manifest.webmanifest` (linked from `index.html`). |
| `icons/alternates/` | The unchosen logo concepts (apex red/mono, frontier, stepline, scatter, monogram) — kept so the brand direction can change without re-deriving. |
| `docs/claude-design-review-brief.md` | The brief used to drive the Claude Design review. |

For tokens and decisions, `styles.css` + `script.js` in this repo are the source of truth; this document is the narrative style guide (voice, visual foundations, iconography rules) behind them.

---

*Distilled from a Claude Design review of `github.com/eliogovea/baseball-limits-2d`. Data © SABR Lahman DB, CC BY-SA 3.0. Source code MIT.*
