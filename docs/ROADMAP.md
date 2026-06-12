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

## Ordered plan

Do the tracks in this order (data first — small, unblocks deletions; then the
committed render destination):

| # | Track | Phases | Status |
|---|---|---|---|
| 1 | **S3** — app onto BL2S, remove `.evt` | S3a–S3e | ☐ not started |
| 2 | **S4** — retire BL2P | S4a–S4b | ☐ not started (new) |
| 3 | **G-track** — full-GPU graph | G0 ✅, G1–G6 | G0 shipped (`webgpu-graph.js`) |
| 4 | **S-track** — GPU season animation | SA0–SA4 | ☐ design only |
| 5 | **S2** — Lahman complement | — | ☐ after S3/S4 |

_Resume at the first unticked phase. Update the checkbox + progress-trail row in the
same commit as each phase._

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

### [ ] S3a — builder: global date-table files + pitching layer

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

### [ ] S3b — script.js batting swap (`.evt` files untouched = instant rollback)

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

### [ ] S3c — pitching swap

- Route `prefix: "p_"` to `stat_p_*.bl2s.gz` + its own dimension/dates (epoch differs
  per file — the decoder reads epoch from each header, no special-casing).
- **Gate:** `ds=pitching` smooth view animates season steps; Ryan 5,714 SO on chart;
  ERA (rate) qualifier behavior unchanged.

### [ ] S3d — removal + deploy

- Delete `data/pbp/*.evt.gz` (40 files), `scripts/build_stat_streams.js`, the now-dead
  `decodeStev`/STEV path in script.js. `.github/workflows/deploy-pages.yml`: drop the
  `*.bl2s.gz` exclude (~line 79) so `stat_*.bl2s.gz` ships; update its `.evt` comment
  and the size note in §Infrastructure below. POC README notes (decision 3). README
  backlog update (same commit).
- **Gate:** zero `.evt` requests in a full session (server log); bundle builds;
  `file://` bundle still falls back static.

### [ ] S3e (optional) — `qualDeps: ["PA"]`

- BL2S has raw `stat_pa`, so batting rate-stat qualifiers can load 1 file instead of 5
  components. Own commit, only after S3b/S3c parity is green.

### S3 progress trail

| Phase | Status | Notes / commit |
|---|---|---|
| S3a builder (dates + pitching) | ☐ not started | |
| S3b batting swap | ☐ not started | |
| S3c pitching swap | ☐ not started | |
| S3d removal + deploy | ☐ not started | |
| S3e qualDeps opt (optional) | ☐ not started | |

---

## S4 — retire BL2P (new; after S3)

After S3d, `.bl2p`'s remaining consumers are the **rate-stat-pair smooth fallback** and
**group-career animation** in `script.js` (the `.evt` builder is already gone). BL2S
carries every batting counting component 1910–2025, so both can ride BL2S components
instead, and the BL2P layer (~12 MB, 1920–2025 AL/NL batting only) retires.

### [ ] S4a — migrate the remaining `.bl2p` readers to BL2S

- Rate-pair smooth fallback: should largely disappear — post-S3 every batting counting
  component is a BL2S file, so `EVT_DERIVED` eligibility covers the pairs that used to
  fall back. Audit which pairs still hit the `.bl2p` path and route them through BL2S
  component loads.
- Group-career animation (`pbpBuildGroupCareer`): rebuild its per-player
  career-cumulative as-of values from BL2S component series instead of per-season
  `.bl2p` decode. Coverage *improves* (1910 vs 1920 start, + Negro/Federal).
- **Gate:** group-career spot-check (a selected player's career-end dot == Lahman
  career total on a counting axis; monotone trail); rate-pair smooth view parity
  before/after; no `.bl2p` requests in a full session.

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
| G1 | GPU sign-aware frontier + readback contract | ☐ not started |
| G2 | staircase + HV shade + HV contributions | ☐ not started |
| G3 | GPU text (glyph atlas, axes, labels) | ☐ not started |
| G4 | overlays: depth, era-B, ghost (dashed), cross-fade | ☐ not started |
| G5 | interaction + spring-FLIP + loop owner + stream-engine convergence | ☐ not started |
| G6 | graduate flag; keep Canvas2D fallback | ☐ not started |

G0 finding to carry forward: smooth is the default view (every axis pair is
stat-layer-covered), so the `file://` bundle is the verification vehicle for static
frames; routing the evtSeason completed-seasons bg layer through the scene is the
natural reach-extension — decide in G1. Also absorbed by the G-track: the gpustream
follow-ups (idle `onFront` readback replacing the live JS frontier → G1/G5; crisper
quad-based staircase line; bats/country mask on the GPU).

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
`scripts/`, `docs/`, `dist/`, `*.md`, raw Lahman CSVs, and currently the unused
`*.bl2e.gz`/`*.bl2s.gz` — the BL2S exclude drops at S3d), ~43 MB/branch; a branch with
no root `index.html` is skipped (native POCs produce no broken previews); web POCs get
their own branch with the POC's `index.html` at the branch **root**. Deleted files
linger until the branch-delete cleanup runs. Pages setting: Deploy from a branch →
`gh-pages` / root.

Real-GPU visual verification of WebGPU phases rides these previews (headless CI is
SwiftShader-only and can't configure a canvas).
