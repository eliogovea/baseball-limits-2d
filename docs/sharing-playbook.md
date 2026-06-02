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

## Worked example: putting numbers on Ohtani's 50/50

A self-contained thread / post that shows the site doing something no box score can:
quantifying *how* historic the first 50/50 season really was. Everything below comes
straight from the site's own hypervolume-contribution metric on the **HR vs SB** frontier
(qualified hitters) — pin the dot with
[`…/#x=HR&y=SB&hl=Shohei Ohtani`](https://eliogovea.github.io/baseball-limits-2d/#x=HR&y=SB&hl=Shohei%20Ohtani)
for the screenshot.

**The finding:** Ohtani's 2024 (54 HR, 59 SB) has the single largest hypervolume
contribution of any season on the HR-vs-SB frontier in 150 years of MLB.

| Rank | Season | HR | SB | HV contribution | Share of frontier area |
|---|---|---|---|---|---|
| **1** | **Shohei Ohtani 2024** | **54** | **59** | **338** | **6.9%** |
| 2 | Ronald Acuña 2023 | 41 | 73 | 182 | 3.7% |
| 3 | Rickey Henderson 1982 | 10 | 130 | 169 | 3.4% |
| 4 | Rickey Henderson 1986 | 28 | 87 | 117 | 2.4% |
| 5 | Barry Bonds 2001 | 73 | 13 | 87 | 1.8% |
| 6 | Sammy Sosa 1998 | 66 | 18 | 29 | 0.6% |
| 7 | Harry Stovey 1890 | 12 | 97 | 17 | 0.3% |
| 8 | Hugh Nicol 1887 | 1 | 138 | 8 | 0.2% |

*(units are HR·SB of frontier area; full dataset 1871–2024, qualified seasons)*

**What the metric measures.** Hypervolume contribution here is *leave-one-out*: delete the
season, let the entire 150-year cloud re-sweep and backfill the gap, then measure how much
frontier area is *still* lost. So 338 isn't a paper rectangle — it's territory **no other
season in history can recover**.

**Why it's so large — balanced-extreme beats single-axis-extreme.**

- **Bonds' 73 HR** — the all-time record — contributes only **87**. His territory is a tall,
  thin sliver, and Sosa (66) sits right behind him, so removing Bonds barely moves the curve.
- **Henderson's 130 SB** contributes **169** and *shrinks* as you widen the window (208 → 169
  once the 1880s speedsters enter and backfill his high-steal strip).
- **Ohtani sits where the frontier bulges farthest into empty space** — high on *both* axes.
  His exclusive band runs from Acuña (41 HR / 73 SB) on the speed side to the next 50-HR
  hitter, Griffey (56 HR / **20** SB). That ~39-SB gap above 50 HR is occupied by nobody else.

**The kicker — it's era-proof.** Ohtani's contribution is **exactly 338 whether the window is
1920–2024 or 1871–2024**, while every other point's number moves as competitors are added or
removed. No one else has ever lived in his corner of the frontier, so the rest of baseball
history can't touch his value.

That's the quantitative case for 50/50: not that 54 HR or 59 SB is a record (neither is), but
that the *combination* pushed the achievable limit into space the other ~220k qualified
seasons can't reach — and hypervolume contribution is exactly the measure of "expanded the
limit into empty space."

**Ready-made caption:**
> Ohtani's 2024 (54 HR / 59 SB) owns more of the HR-vs-SB frontier than any season in 150
> years of MLB — 1.9× the runner-up, 2× Henderson's 130 steals, 4× Bonds' 73 homers. And its
> value doesn't budge no matter who else you add, because nobody else has ever lived in that
> corner.

*(Reproduce the numbers headlessly: load the view, then read `window.__bl2d_hv.contributions`
— see `CLAUDE.md` → "Headless verification".)*

---

## Draft copy (adapt before posting)

Lead with the Ohtani 50/50 result (see the worked example above) — it's concrete, timely,
and has hard numbers behind it. Keep the pure-method framing for Hacker News.

**Show HN**
> Show HN: Baseball Limits 2D – the Pareto frontier of 150 years of MLB stats
>
> Pick any two stats; the chart highlights the player-seasons (or careers) that define the
> outer edge of what's ever been possible — you can't beat them on both axes at once. Static
> D3, no backend, every view is a shareable URL. It also computes each frontier point's
> leave-one-out hypervolume contribution — which surfaced a fun result: Ohtani's 2024 50/50
> is the most "valuable" season on the HR-vs-SB frontier in 150 years, and its value doesn't
> change no matter who else you add to the comparison. Click any frontier dot to trace that
> player's whole career.

**r/dataisbeautiful**
> [OC] Ohtani's 50/50 owns more of the HR-vs-SB "record frontier" than any season in 150
> years of MLB — 2× Henderson's 130 steals, 4× Bonds' 73 homers [interactive]

*(Alternate, method-first):*
> [OC] The Pareto frontier of MLB batting & pitching, 1871–2025 — watch the "limits" expand
> across history [interactive]

**r/baseball  /  r/Sabermetrics**
> I tried to measure *how* historic Ohtani's 50/50 was, not just that it happened
>
> Using the Pareto frontier of HR vs SB (the seasons you can't beat on both at once) and a
> metric called hypervolume contribution — basically "how much unique territory does this
> season own that nothing else in history covers" — Ohtani's 2024 comes out #1 of all time:
> 1.9× the runner-up (Acuña '23), 2× Henderson's 130-steal year, 4× Bonds' 73 HR. The wild
> part: his number is *identical* whether you go back to 1920 or 1871, because nobody else
> has ever lived in the 50-HR-and-50-SB corner. [interactive chart, every view is a link]

**X / Bluesky — thread**
> 1/ Everyone knows Ohtani's 2024 was the first 50/50 season. But *how* historic was it,
> in numbers? I built a tool that plots the Pareto frontier of MLB stats and measured it. 🧵
>
> 2/ On the HR-vs-SB "record frontier" — the seasons no one has beaten on both at once —
> Ohtani 2024 (54 HR / 59 SB) has the largest "hypervolume contribution" of any season in
> 150 years. It owns ~6.9% of the entire frontier, alone.
>
> 3/ That's ~2× Rickey Henderson's legendary 130-steal 1982, and ~4× Barry Bonds' 73-homer
> 2001. The single-axis records are *thinner* than you'd think — someone's always right
> behind them.
>
> 4/ The kicker: Ohtani's number is exactly the same whether you start the clock in 1920 or
> 1871. Adding 50 more years of baseball changes everyone else's value — but not his, because
> no one has ever lived in his corner of the frontier.
>
> 5/ Pin his season yourself: <link with #x=HR&y=SB&hl=Shohei Ohtani> — or pick any two
> stats and find your own record. [tool link]

**LinkedIn (method / optimization angle)**
> What does multi-objective optimization look like when the data is something everyone has
> intuition for? I plotted 150 years of MLB stats as Pareto frontiers and computed each
> record's *hypervolume contribution* — the area it uniquely owns. It put a clean number on
> a story baseball fans already felt: Ohtani's 2024 50/50 contributes more to the HR-vs-SB
> frontier than any season ever, and — unlike the single-stat record holders — its value is
> invariant to the rest of the dataset. A nice illustration that "balanced and extreme" beats
> "extreme on one axis" in objective space. [interactive, static D3, no backend]

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
