# Roadmap — direction & phased plan (read this first)

**This is the single source of truth for project direction and "what to do next."**
It consolidates and supersedes the old per-track docs (`data-layer.md`,
`pbp-*-next-steps.md`, and the status sections of the design docs — full text in git
history). Format specs live in [`data-formats.md`](data-formats.md); render
architecture in [`rendering.md`](rendering.md); visual system in
[`design-system.md`](design-system.md). README's "Ideas & future work" remains the
source of truth for *shipped* status of individual features.

## Direction (decided 2026-06-12, binding)

1. **Rendering: the G-track is the destination.** One full-GPU engine (dots, frontier,
   HV, overlays, text) with Canvas2D+SVG as the shipped default until G6 parity, and
   the permanent fallback after. The gpustream engine is absorbed at G5.
2. **Data: BL2S is the single app-facing stat layer.** End-state formats: Lahman CSVs
   (canonical seasons) + BL2S (animatable stat layer) + BL2E (archival event source) +
   BL2D (offline bundle). `.evt` is removed at S3d; **BL2P and its builders retire at
   S4** once nothing reads them.
3. **POCs stay** as pedagogical references (not ported to BL2S); merged feature
   branches are deleted; `main` is the deployed branch.

## Current state (snapshot — 2026-06-13)

The G-track (full-GPU rendering) is the bulk of recent work and is nearly done; the data
tracks (S3/S4) have NOT been started yet. Concretely:

- **G-track G0–G5h SHIPPED** on `feat/event-level-pbp` — dots, sign-aware frontier,
  staircase, HV shade + contributions, glyph text, depth/era-B/ghost overlays, and the
  GPU hover/pin interaction overlays (G5a–c; G5d kept on SVG; G5e lifecycle). Present
  convergence (`present_unified`) + the single `graphLoop` owner ship on the converged
  `?legacyPresent=0` path (default still the proven legacy path). Commits `43b225d` (G5),
  earlier G0–G4 commits in `rendering.md`.
- **GPU is the non-optional default renderer** (commit `6eb276c`) — WebGPU auto-enables,
  Canvas2D is the silent automatic fallback, a read-only `#renderer-status` indicator
  shows GPU/CPU, spring is default-on; the renderer toggles were removed. This is the
  start of **G6** (graduate the flag).
- **NOT done:** the G5 real-browser MANUAL checkpoints, the `legacyPresent` default-flip,
  the rest of G6 (parity matrix / device-loss sign-off / rotated Y-title), **G5i**
  (deferred), and the entire **data layer** (S3/S4/S2) + the **S-track** season animation.

## Ordered plan (recommended next → last)

The original "data first" order was overtaken by the G-track work; the recommended order
now finishes the in-flight render track, then returns to the (still-unstarted) data work:

| # | Track | Phases | Status | Who can do it |
|---|---|---|---|---|
| 1 | **G6** — graduate the G-track | G6a–G6f (detail in [`rendering.md`](rendering.md) §"G6") | ◑ in progress (GPU-default shipped) | G6a + G6b-flip need a **human/browser MANUAL**; G6c–G6f are agent-doable headless |
| 2 | **S3** — app onto BL2S, remove `.evt` | S3a–S3e | ✅ S3a–S3d shipped (builder + batting & pitching swap + `.evt` removal); S3e optional | fully agent-doable |
| 3 | **S4** — retire BL2P | S4a–S4b | ◑ S4a shipped (readers on BL2S); S4b (removal) next | fully agent-doable |
| 4 | **S-track** — GPU season animation (folds in G5i) | SA0–SA4 | ☐ design only | agent-doable; SA2 motion needs a MANUAL |
| 5 | **S2** — Lahman complement | — | ☐ after S3/S4 | fully agent-doable |

### ▶ RESUME HERE (next session)

Two independent entry points — pick based on whether a human is available to drive a browser:

- **If a human can do the browser MANUAL:** start **G6a** (run the G5 real-browser
  checkpoints on the branch's Pages preview), then **G6b** (flip the `legacyPresent`
  default). Both are detailed in `rendering.md` §"G6".
- **If it's an unattended coding agent:** do the headless-doable G6 close-out —
  **G6c** (one-run parity matrix), **G6d** (device-loss recovery test), **G6e** (rotated
  Y-axis title on the GPU) — in any order; they don't depend on the MANUAL. *Or* continue
  the data track at **S4** (retire BL2P — S3a–S3d all shipped: the BL2S builder, the
  batting+pitching app swap, and the `.evt`/STEV removal are done). S4 migrates the
  remaining `.bl2p` readers (rate-pair smooth fallback + group-career) onto BL2S
  components, then deletes the 106 `.bl2p.gz`. S3e (`qualDeps:["PA"]`) is an optional
  one-file-load optimization that can come any time.

_Resume at the first unticked phase of the chosen track. Update the checkbox + the
progress-trail row + the README "Ideas & future work" entry in the SAME commit as each
phase (README is the source of truth for shipped status)._

---

## S3 — migrate the app onto BL2S, remove `.evt`

Decisions already made (binding):
1. **Pitching ports to BL2S too** (`--pitching` builder mode → `stat_p_*.bl2s.gz` from
   Lahman season totals), so ALL 40 `.evt.gz` + `scripts/build_stat_streams.js` go away.
2. **Pre-1910 batting regression accepted until S2**: batting gains 1910–1919 exact
   daily animation, loses the 1871–1909 Lahman season-step animation `.evt` had
   (early careers like Cobb's lose their pre-1910 portion in smooth mode; S2 restores).
   Pitching keeps full 1871–2025 (per-file epoch, S3a).
3. **POCs are NOT ported** (`poc-webgpu`, `poc-webgpu-spring` parse `.evt` in C/WASM
   cores); their READMEs get a one-line note that `.evt` was removed (data in git
   history).

Key feasibility fact (mapped 2026-06-12): everything downstream of `buildEvtModel` is
**shape-agnostic** — `evtPointsAsOf`, `evtOpenSeasonPoints`, `buildEvtEventStream`
(GPU), `evtGpuMonotone`, `evtSeasonSnap`, scrubber (`yearOf`/`doy`), deep-links read
only the model object's fields. The swap is loader-level: new decoders + `loadEvtStat`
URL change + `buildEvtModel` internals; the returned model must be field-for-field
identical
(`xDim/yDim/xs/ys/usesQual/qual/thresholdField/depList/numDates/players[{name,comp:{dep:{dates,cum}},debutYear,lastYear}]/doy/yearOf/seasonStartByYear/seasonEndByYear/xMax/yMax/minYear/maxYear`).
Player names: the BL2S dimension's displayName comes from `build_retro_to_display` —
the same Lahman-disambiguated `(b.YYYY)` names `.evt` used, so `metaFor()` is unchanged.

### [x] S3a — builder: global date-table files + pitching layer *(shipped)*

- **Why a dates file:** STEV carried a global game-date table (`numDates`/`seasons[]`/
  `doy[]`) the cursor steps over; BL2S stat files store per-player epoch-days only, and
  reconstructing from the loaded axis pair's union would coarsen the cursor. Emit
  **`stat_dates.bl2s.gz`** (new **kind 2**: `'BL2S'|maj|min|2 | epoch | u32 nDates |
  nDates×varint dateDelta`) by unioning the committed `stat_pa.bl2s.gz` cells (every
  game date has a PA — no plays.csv re-download). ~25–30k dates, <60 KB. Bump format
  MINOR 0→1.
- **Pitching layer** (`build_stat_files.py --pitching`): source
  `data/pitching_limits_1871-2025.csv` (Lahman season totals); names via
  `_display_name.py`. Emits `stat_p_players.bl2s.gz` (kind 0; retroID slot holds the
  Lahman playerID), 23 `stat_p_<stat>.bl2s.gz` (one season-end cell per player-season,
  date = Oct 1), `stat_p_dates.bl2s.gz`. **Per-file epoch 1871-01-01** → pitching keeps
  1871–2025.
- **Files:** `scripts/build_stat_files.py` (+`--dates-from-pa`, `--pitching`),
  `scripts/decode_stat.py` (kind 2), `docs/data-formats.md` (kind 2 + pitching spec),
  new data files.
- **Gate:** `decode_stat.py` round-trips all new files; dates count == distinct
  `stat_pa` dates; pitching career spot-checks vs Lahman (Cy Young 511 W,
  Ryan 5,714 SO, Rivera 652 SV).

### [x] S3b — script.js batting swap (`.evt` files untouched = instant rollback) *(shipped)*

- New decoders mirroring `decode_stat.py`: `decodeBl2sPlayers` (kind 0),
  `decodeBl2sStat` (kind 1, prefix-sum day-deltas → `cum`), `decodeBl2sDates` (kind 2);
  `decodeStev` is deleted only in S3d. `loadEvtStat` (~script.js:1075) fetches
  `data/pbp/stat_<stat>.bl2s.gz` + one-time `stat_players`/`stat_dates` (cached in
  `evtStreamCache`). `buildEvtModel` (~1087–1133): date table from the dates file
  (epoch-day → calendar via JS `Date` for `yearOf`/`doy`; season boundaries =
  calendar-year runs; epoch-day → index Map for cell conversion); iterate by gpid;
  `player.name` = dimension displayName. `EVT_REGISTRY` semantically unchanged.
- **Gate:** Bonds 762/514 + Henderson 296/1406 via `__bl2d_verifySpring` records;
  `?verifyFrontier=1` `mis 0` over a forward+backward scrub; season-mode boundary
  crossing (1953–1955) + `evtSeasonSnap` lands on season ends; `t=YYYYMMDD` deep-link
  round-trips; `snap.js` desktop 1440×900 + mobile 390×844 final-frame before/after
  (only the documented early-era deltas allowed).

### [x] S3c — pitching swap *(shipped with S3b — the loader is prefix-generic)*

- Route `prefix: "p_"` to `stat_p_*.bl2s.gz` + its own dimension/dates (epoch differs
  per file — the decoder reads epoch from each header, no special-casing).
- **Gate:** `ds=pitching` smooth view animates season steps; Ryan 5,714 SO on chart;
  ERA (rate) qualifier behavior unchanged.

### [x] S3d — removal + deploy *(shipped)*

- Deleted `data/pbp/*.evt.gz` (40 files), `scripts/build_stat_streams.js`, the dead
  `decodeStev`/STEV path in script.js, **and** the standalone `evt-demo.html`/`.js`
  STEV demo (it only existed to demo the removed format; user-confirmed). Dropped the
  `*.bl2s.gz` exclude in `.github/workflows/deploy-pages.yml` so `stat_*.bl2s.gz` ships,
  and updated its asset-policy comment + the §Infrastructure note. POC README notes
  (decision 3: `poc-webgpu`/`-spring`/`-c` parse `.evt` in their cores — not ported,
  data in git history). README backlog updated (same commit).
- **Gate:** zero `.evt` requests in a full session (verified — no `.evt`/STEV refs left
  in script.js except historical comments); bundle builds (4.5 MB, never read `.evt`);
  `file://` bundle still falls back to the static view.

### [ ] S3e (optional) — `qualDeps: ["PA"]`

- BL2S has raw `stat_pa`, so batting rate-stat qualifiers can load 1 file instead of 5
  components. Own commit, only after S3b/S3c parity is green.

### S3 progress trail

| Phase | Status | Notes / commit |
|---|---|---|
| S3a builder (dates + pitching) | ✅ shipped | kind 2 `decode_dates`; `--dates-from-pa` (19,839 dates) + `--pitching` (12,134 players, 23 stats, epoch 1871). Gates: round-trip, dates==stat_pa, Cy Young 511 W / Ryan 5,714 SO / Rivera 652 SV |
| S3b batting swap | ✅ shipped | decodeBl2sPlayers/Stat/Dates + loadEvtDim/Dates; buildEvtModel rebuilds yearOf/doy/season-boundaries from stat_dates + epoch-day→index, counts→cum. Gates: Bonds 762/514 + Henderson 296/1406, t=19980908 deep-link round-trips, before/after PNG byte-identical (desktop+mobile) |
| S3c pitching swap | ✅ shipped | same prefix-generic loader (`stat_p_*`, epoch 1871). Ryan 5,714 SO / 324 W, Cy Young 511 W, Pedro ERA 2.93 / IP 2,827 (qualifier path), 1871–2025 |
| S3d removal + deploy | ✅ shipped | deleted 40 `.evt.gz` + `build_stat_streams.js` + `decodeStev` + `evt-demo.html/.js`; deploy workflow now ships `*.bl2s.gz`. POC READMEs noted |
| S3e qualDeps opt (optional) | ☐ not started | |

---

## S4 — retire BL2P (new; after S3)

After S3d, `.bl2p`'s remaining consumers are the **rate-stat-pair smooth fallback** and
**group-career animation** in `script.js` (the `.evt` builder is already gone). BL2S
carries every batting counting component 1910–2025, so both can ride BL2S components
instead, and the BL2P layer (~12 MB, 1920–2025 AL/NL batting only) retires.

### [x] S4a — migrate the remaining `.bl2p` readers to BL2S *(shipped)*

- Rate-pair fallback: the audit found exactly one straggler — **RC** (Runs Created) was
  the only offered dim not in `EVT_REGISTRY`, so RC charts fell to `.bl2p`. Added RC to
  `batting.derived` (deps H/2B/3B/HR/AB/BB, rate:false, the same formula as
  `aggregateCareer`), so every batting+pitching axis pair is now evt-eligible and the
  `.bl2p` fallback is unreachable.
- Group-career: kept the **hybrid** (user-chosen) — Lahman prior completed seasons (so
  pre-1910 + exact career-end == Lahman survive) + the OPEN season's game-by-game partial
  now sourced from a BL2S **all-components** model (`buildEvtModel(…, allComponents)` loads
  every `reg.stats` file; new `evtBuildGroupCareer` replaces `pbpBuildGroupCareer`).
  Group-career rides the `pbpEvt` cursor now, not the `.bl2p` timeline; `enableGroupCareer`
  dropped `forceBl2p`.
- **Gate (verified):** group-career career-end == Lahman — Bonds 762/514, Henderson
  297/1406, Mays 660/339 (== the Lahman CSV's season-sum, matching the static career dot);
  Bonds trail monotone; a full group-career session fetches **only `.bl2s`** (19 files),
  zero `.bl2p`/`.evt`; RC chart loads via BL2S. The `.bl2p` engine is now dead code (S4b
  removes it).

### [ ] S4b — removal

- Delete `data/pbp/b*.bl2p.gz` (106 files), `convert_retrosheet_pbp.py`'s writer role
  (keep the file in git history; the `build_retro_to_display` helper it hosts must
  move/already be shared with `build_stat_files.py` first), `parseBl2p` in script.js,
  deploy-workflow excludes, README/CLAUDE references.
- **Gate:** full session with zero `.bl2p` requests; bundle builds; snap.js suite green.

| Phase | Status | Notes / commit |
|---|---|---|
| S4a migrate readers | ☐ not started | audit `.bl2p` call sites first |
| S4b removal | ☐ not started | |

---

## G-track — full-GPU graph rendering (the committed destination)

Full design, phase details, WGSL entry points, and verify gates:
[`rendering.md`](rendering.md) §"G-track design". Summary status:

| Phase | What | Status |
|---|---|---|
| G0 | retained-scene dots + data-space coord model + bundler split | ✅ shipped (`webgpu-graph.js`) |
| G1 | GPU sign-aware frontier + readback contract | ✅ shipped (`webgpu-graph.js`: `sceneSkyline`+`compact`) |
| G2 | staircase + HV shade + HV contributions | ✅ shipped (`webgpu-graph.js`: `ranksort`/`emit` + `hvTotal`/`hvContrib`/`hvMax`/`hvRadius` + shade/front pipelines) |
| G3 | GPU text (glyph atlas, axes, labels) | ✅ shipped (`ae03fa2`) |
| G4 | overlays: depth, era-B, ghost (dashed), cross-fade | ✅ shipped (G4a–d) |
| G5 | interaction + loop owner + present convergence | ✅ G5a–G5h (G5d cut→SVG; G5i deferred) |
| G6 | graduate flag; keep Canvas2D fallback | ◑ in progress (WebGPU non-optional + default; graceful silent Canvas2D fallback + read-only GPU/CPU indicator; spring default-on; toggles removed; `?renderer=canvas`/`?gpugraph=0`/`?gpustream=0` dev hatches, `?gpuonly=1` for the strict banner) |

G0 finding to carry forward: smooth is the default view (every axis pair is
stat-layer-covered), so the `file://` bundle is the verification vehicle for static
frames. Also absorbed by the G-track: the gpustream
follow-ups (idle `onFront` readback replacing the live JS frontier → G5; crisper
quad-based staircase line; bats/country mask on the GPU).

G1 decisions of record: the scene now uploads the FULL deduped cloud (`unique`,
frontier included — the cloud shader degenerates on-front instances, so the visible
output is unchanged until G2 draws the frontier dots itself); xSign/ySign joined the
scene identity key; the double-buffered fire-and-forget readback (`bCount`+`bFrontIdx`
→ `g.front`) ships as MECHANISM only — cards/tooltip/quadtree stay CPU-fed until the
G5 convergence. The evtSeason completed-seasons bg-layer reach-extension was
considered and deferred (it belongs with the S-track's completed-season scene, SA2).

G2 decisions of record: the GPU now owns the WHOLE static envelope — the sign-aware
staircase (canonical-x `ranksort` → `emit`, caps at the canonical DOMAIN edges not
value 0, vertices un-folded to data space so zoom is still a uniform write), the
gradient HV shade (a triangle FAN from the anti-ideal apex; the fragment projects
onto the ideal→anti axis from `uScene.corn`), the HV-sized white-ringed frontier dots
(the cloud shader's on-front degenerate handed over to a dedicated `sceneFront` pass),
and — the crux — the HV contributions ported as the EXACT leave-one-out-with-fill
oracle (`computeHvContributions`), NOT the cheap exclusive-corner formula: one GPU
thread per frontier slot re-sweeps the whole cloud excluding that point. The CPU SVG
staircase/shade and `drawFrontierDots` are suppressed under `gpuGraph`. Verify floor:
`radiusMis 0` (the visible dot size is the authoritative parity gate) + `stairVertMis 0`
+ `shadeQuadrant` across HR×SB, ERA↓×SO, WHIP↓×SO and the worst toggle; `hvMis` uses a
maxContrib-normalized f32 tolerance (a contribution is total−alt of two large HV areas,
so raw 1e-6 is unreachable — the design's aspiration; the radius compresses it away).

---

## S-track — GPU season-mode animation (after G-track foundation)

Design summary in [`rendering.md`](rendering.md) §"Season GPU animation". Phases
SA0 (gating) → SA1 (GPU season targeting, correctness core) → SA2 (sprung open-season
cloud) → SA3 (hybrid GPU frontier) → SA4 (polish). All ☐ not started.

---

## S2 — Lahman complement (after S3/S4)

Backfill coverage Retrosheet lacks, at SEASON grain (one end-of-season cell, no
intra-season motion): pre-1910, gaps, and the *complete* Negro Leagues (Lahman has
official NeL totals Retrosheet only partially reconstructs). Source:
`data/batting_limits_1871-2025.csv`. For each (player, year) Lahman has but the stat
files don't (or under-cover), add a season-end cell; new players (pre-1910, NeL-only)
append to the dimension. Probably merge into the same files, not a separate overlay.
**Restores the pre-1910 animation coverage S3 knowingly drops.** Keep all converters.

## Backlog (unordered)

- **Pitching game-grain animation** — S3c gives pitching season-grain smooth via BL2S;
  game-by-game pitching would be derived as BL2S game-grain cells from plays.csv
  (W/L/SV are per-game *decision* fields: `wp`/`lp`/`save` hold the credited pitcher's
  retroID; SHO = `cg && r==0`; GIDP absent from pitching.csv). Only if wanted.
- **`core.wasm` in the app** — only when pitch-by-pitch volumes (10⁶–10⁸ events) land.
- README "Ideas & future work" holds the full feature backlog (open `- [ ]` items).

---

## Infrastructure — GitHub Pages previews (shipped 84f3600)

`.github/workflows/deploy-pages.yml` serves production **and** a preview of every
branch from one Pages site via a persistent `gh-pages` branch (`keep_files: true` —
additive; a `delete`-event job prunes a branch's folder):

- `main` → `https://<user>.github.io/<repo>/`
- any branch → `…/experimental/<branch-slug>/` (slug: `/` → `-`)

Key facts: a branch only deploys itself if `deploy-pages.yml` exists **on that branch**
(workflows run from the pushed branch); only runtime assets ship (rsync excludes
`scripts/`, `docs/`, `dist/`, `*.md`, raw Lahman CSVs, and the archival `*.bl2e.gz`
corpus — since S3d the `*.bl2s.gz` stat layer ships and the `*.evt.gz` files are gone),
~45 MB/branch; a branch with
no root `index.html` is skipped (native POCs produce no broken previews); web POCs get
their own branch with the POC's `index.html` at the branch **root**. Deleted files
linger until the branch-delete cleanup runs. Pages setting: Deploy from a branch →
`gh-pages` / root.

Real-GPU visual verification of WebGPU phases rides these previews (headless CI is
SwiftShader-only and can't configure a canvas).
