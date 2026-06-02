# Sharing playbook — Baseball Limits 2D

A reusable guide for getting the site (https://eliogovea.github.io/baseball-limits-2d/)
in front of people. Built-in sharing affordances already exist: in-app share buttons
(X, Bluesky, LinkedIn, Reddit, Facebook, WhatsApp), PNG + SVG export, and full
URL-hash deep-linking so **every view is a shareable link**.

---

## Two audiences, two angles

The site sits at the intersection of two enthusiast communities. Pick the angle to
match where you're posting; don't blend them.

1. **Baseball / sabermetrics** — *"the outer edge of what's ever been done."* Lead with
   a surprising record. These readers care about players and eras, not the algorithm.
2. **Data-viz / CS / optimization** — *"multi-objective Pareto frontiers, made tangible
   with 150 years of baseball."* Lead with the method: static D3, no build step, interesting
   metrics like hypervolume contribution. These readers care about the
   technique and the dataset they already have intuition for.

---

## Where to post (ranked by fit)

- **Hacker News — "Show HN"** — best single shot. The no-build static-D3 + Pareto-frontier
  framing is HN-native. Post the *method* angle; the curated deep-links below give
  commenters concrete things to click and argue about.
- **Reddit**
  - `r/dataisbeautiful` — use OC flair + the year-animation GIF. Highest-ceiling.
  - `r/baseball`, `r/Sabermetrics`, `r/mlb` — the baseball angle + a single striking record.
  - `r/optimization`, `r/compsci` — the Pareto angle (secondary).
- **Bluesky + X** — the baseball-analytics community (the FanGraphs / Tom Tango orbit).
  Post a thread of 4–5 surprising frontier records, each with a deep-link + image.
- **LinkedIn** — the professional optimization / data-viz angle: "teaching Pareto
  frontiers with a dataset everyone has intuition for."
- **Niche** — lobste.rs, the Observable / D3 community, baseball newsletters and
  comment threads, SABR's own community (appropriate, given the data source), Tildes.

---

## Content formats (priority order)

1. **Screen-recording GIF of the ▶ year animation** — the frontier visibly expanding from
   1871 → 2025 is the money shot. One GIF carries most posts. Capture by hitting the year
   animation and screen-recording the chart region.
2. **Annotated still** of one striking frontier (arrow + one-line caption). Mint stills
   with `scripts/share_images.sh` (see below), then annotate.
3. **"Did you know" single-stat cards** — one record per image, deep-link in the caption.
4. **Thread / carousel** — 5 records, 5 images, 5 links.
5. **Short explainer post** — "what is a Pareto frontier, explained with home runs."

---

## Hooks / surprising findings to lead with

All grounded in what the chart actually shows:

- Rickey Henderson's **130 SB (1982)** has anchored the steal frontier for 40+ years.
- The **power frontier is owned by the steroid era**; the **pitching-volume frontier by the
  dead-ball era** — the chart makes era bias *visible*, not just arguable.
- The **ERA / WHIP "frontier" surfaces the *worst* seasons** (the sweep finds the upper-right
  envelope, and those stats are lower-is-better) — a fun, counterintuitive teaching moment
  that doubles as an explainer hook.
- Click any red dot to **trace that player's whole career arc in gold** — great for a GIF.
- **Negro Leagues seasons are in the dataset** (2020 Lahman addition) — a respectful
  spotlight angle that surfaces history hidden by default filters.
- Novel metrics most viz tools don't have: **hypervolume contribution**.

---

## Draft copy (adapt before posting)

**Show HN**
> Show HN: Baseball Limits 2D – the Pareto frontier of 150 years of MLB stats
>
> Pick any two stats; the chart highlights the player-seasons (or careers) that define the
> outer edge of what's ever been possible — you can't beat them on both axes at once. Static
> D3, no backend, and every view is a shareable URL. Click any frontier dot to trace that
> player's whole career.

**r/dataisbeautiful**
> [OC] The Pareto frontier of MLB batting & pitching, 1871–2025 — watch the "limits" expand
> across history [interactive]

**X / Bluesky thread opener**
> Which MLB seasons are literally impossible to beat on two stats at once? I plotted 150
> years of Pareto frontiers. A thread of records that have stood for decades 🧵👇

---

## Curated deep-links

Base: `https://eliogovea.github.io/baseball-limits-2d/`. Append the hash. Batting links work
today; pitching links rely on the `ds` hash key (now serialized).

| Hook | URL |
|---|---|
| Power/speed frontier, all-time careers | `…/#m=career` |
| Steroid-era power vs contact (season) | `…/#x=HR&y=AVG` |
| Triples vs home runs — gap-power/speed vs raw power | `…/#x=3B&y=HR` |
| On-base vs slugging — the OBP/SLG envelope | `…/#x=OBP&y=SLG` |
| Workhorse pitching frontier (career IP vs SO) | `…/#ds=pitching&m=career` |
| K/9 vs ERA — surfaces the *worst* ERAs (the quirk *is* the hook) | `…/#ds=pitching&x=K/9&y=ERA` |

**Player-pinned links** (`hl=`): the easiest way to make one is to click the player's dot in
the chart and copy the resulting URL — the `hl` token is the disambiguated display key, and
the hash updates live. Hand-encoding player IDs is not worth it.

Hash keys, for reference: `ds` (batting|pitching), `x`/`y` (axis stats), `sy`/`ey` (start/end
year), `pa` (min PA or IP), `m` (season|career), `lg`, `bt` (bats/throws), `co` (country),
`fr` (franchise), `hl` (pinned players). Defaults are omitted from the URL to keep it short.

---

## Generating share images

`scripts/share_images.sh` loops the curated deep-links through `scripts/snap.js` to mint one
PNG per view (1440×900) plus the 1200×630 `og-image.png`. Run a local server first:

```
python3 -m http.server 8000 &
scripts/share_images.sh            # writes /tmp/share-*.png and og-image.png
```

See `CLAUDE.md` → "Headless verification" for the `snap.js` interface.
