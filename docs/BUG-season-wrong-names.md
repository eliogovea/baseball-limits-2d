# BUG — season animation shows wrong names/values "here and there" (OPEN)

**Reported 2026-06-20** (after SA2–SA4 + S2 shipped). **Branch `feat/event-level-pbp`.**
This is the resume doc for a fresh session. The bug is NOT yet fixed.

## Symptoms (user-observed, live real-GPU browser)

1. In **season smooth** mode, playing the animation and stopping (e.g. at **Sep 9 1948**),
   the chart/cards show **wrong players at impossible values** — e.g. a point/card
   **"Kent Hrbek, 76 HR, 0 SB"**. Kent Hrbek debuted **1981** (so he can't appear in 1948),
   and **76 HR in a season is impossible** (record 73). So a value is either a **career** total
   leaking as a season value, or a **name↔value/gpid mislabel**, or both.
2. On the **SB axis**, a point sits **above the axis max** even though the axis is auto-fit to the
   all-time **season** record — i.e. some point has a value **exceeding any single-season record**,
   consistent with a **career value leaking** into the season view (the season axis is extent-locked
   across the sweep via `pbpExtentCache`, so a career-magnitude value lands off-scale).
3. User summary: "many times renders incorrect **(random?) names** here and there, sometimes for
   **players on incorrect times**" — i.e. it's **frequent/reproducible**, not a one-off transient.

## What has been RULED OUT (with evidence)

All checks were on the dev server (`python3 -m http.server 8000`) at the user's repro point
`#m=season&ds=batting&x=HR&y=SB&smooth=1&sy=1900&ey=2024&t=19480909` (cursor idx 6589 = 1948‑09‑09,
`yearOf[cur]=1948`, season `start=6450 end=6612 before=6449`).

- **The CPU model is CORRECT at that cursor.** Dumped season values for all 339 active players via
  `window.__bl2d_pbpEvt()` + a local `evtAsOf` (binary search over `comp[dep].dates`/`.cum`, which are
  GLOBAL DATE INDICES, not epoch-days): **maxHR = Ralph Kiner 38**, **maxSB = Richie Ashburn 32** (both
  the real 1948 leaders), **no player > 50 HR**, no `(76,0)`, no `Hrbek`-anything. Kent Hrbek resolves
  to idx 5393, debut 1981, last 1994, and computes to **0/0** at 1948 (his first HR cell is global
  index 12132 > cursor 6589). So `evtOpenSeasonPoints`/the model is NOT emitting the bad value.
- **The GPU per-player season values are CORRECT at season boundaries.**
  `__bl2d_verifySeason([1905,1948,2001])` → **allGreen, totalMis 0**; Kiner **40 HR / 1 SB** at
  1948‑end (his real totals), 0/0 at 1905/2001. So the GPU season-targeting math (career − baseline)
  is right when **settled**.
- **The GPU union frontier is correct at the tested years** — `__bl2d_verifySeasonFrontier` was green
  for 1998/2001/2002 (HR×SB), TB×R, H×BB (SA3 verification). NOT yet re-run at 1948 or pre-1910.
- **S2 did NOT change existing players' model values.** The re-epoch (1910→1871, +14347d) shifts every
  cell-day AND the dates/dim epoch by the same constant, so `epoch+day` = same calendar date and the
  day→global-index map is identical; existing careers are byte-identical (Bonds 762, Henderson 1406 SB
  verified). `data/batting_limits…csv` (the STATIC source) was untouched, so the completed-season cloud
  is unchanged.

**Conclusion so far:** settled CPU and settled GPU are both correct. The bug lives in the **live glide
/ playback path** and/or the **GPU↔CPU hover-hit-test/card labeling** under `gpuSeason` (now default-on,
SA2–SA4) — which the settled oracles do NOT exercise, and which **only reproduces on a real GPU**
(headless SwiftShader runs the CPU path for season, so `snap.js`/`snap-gpu.js` can't see it). It is NOT
established yet whether S2 is the trigger or it's a pre-existing SA2–SA4 live-path bug surfaced now.

## Leading hypotheses (ranked) — for the next session to confirm/kill

1. **GPU↔CPU mislabel via the hover/quadtree hit-test (most likely for the NAME mismatch).** Under
   `gpuSeason`, `drawScatterPlot` sets `foregroundCloudPoints = []` (the GPU owns the open cloud), so
   the CPU quadtree/tooltip/cards may be built on the WRONG point set (completed-bg only, or a stale
   `unique`), or map a GPU dot's pixel to the nearest CPU point of a DIFFERENT player. That would label
   a dot with a wrong name like "Kent Hrbek". **Check:** where the quadtree is built under `gpuSeason`,
   and what `renderFrontierCards(frontier,…)` (script.js:7250) is fed — is `frontier` the union frontier
   with correct per-point `playerID/name`, or does an index get crossed? Grep the hover handler + the
   quadtree build for the `gpuSeason`/`gpuCloud` branch.
2. **Live multi-season-jump baseline staleness (most likely for the over-record VALUE).** During
   playback the cursor auto-advances; crossing a season boundary must re-snapshot the GPU baseline
   (`_seasonAccumulateTo`'s forward-cross branch) AND snap pos/vel to 0 (`accumulateSeasonCloud`, on
   `first||baseChanged`). If a single frame jumps **multiple** seasons, or the per-frame
   `accumulateSeasonCloud` mis-detects the boundary, the baseline can be from an earlier year →
   season value = career − stale_baseline = **multi-season magnitude** → exceeds records / lands
   off-axis. `__bl2d_verifySeasonLive` tested fresh→cross→cross→backward but NOT a multi-season jump
   or the real playback cadence. **Check:** drive `accumulateSeasonCloud` with a cursor sequence that
   jumps 2–3 seasons per step and compare `bX−baseX` to the `evtAsOf` oracle (extend
   `__bl2d_verifySeasonLive`).
3. **Settled vs glide divergence at the pause→CPU handoff.** On pause SA2 says non-lite frames revert
   to the CPU exact cloud, but the user read the bad value WHILE stopped — check the
   GPU(playing)→CPU(paused) transition leaves no stale GPU frame / stale `frontier` cards, and that
   `lite` actually flips off on stop for the season path.

## Concrete next steps (do these in order)

1. **Reproduce on a REAL GPU** (the only place it shows). Use `scripts/snap-realgpu.js` (Playwright
   headed Chrome; setup in CLAUDE.md / memory `project_realgpu_verification`). Drive **actual playback**
   (click `#anim-play-btn`), let the cursor sweep toward ~1948, then read BOTH:
   - the frontier-card DOM text (`#frontier-cards .frontier-card`, names+values) — this is literally
     what the user read ("Kent Hrbek 76 HR 0 SB"); and
   - `window.__bl2d_lastSeasonUnionFrontier` ([x,y] pairs) + the model season values,
   sampling across glide frames. Catch any card with HR>60 / SB>140 or a name whose `debutYear`
   postdates the open year. Example skeleton:
   ```
   node scripts/snap-realgpu.js "http://localhost:8000/?webgpuHeadless=1&renderer=webgpu&gpustream=1#m=season&ds=batting&x=HR&y=SB&smooth=1&sy=1900&ey=2024" /tmp/r.png 9000 \
     'document.getElementById("anim-play-btn").click();
      for(let k=0;k<40;k++){ await new Promise(r=>setTimeout(r,200));
        const cards=[...document.querySelectorAll("#frontier-cards .frontier-card")].map(c=>c.textContent.replace(/\s+/g," ").trim());
        const bad=cards.filter(t=>/(\b[6-9]\d HR|1\d\d HR|1[4-9]\d SB|[2-9]\d\d SB)/.test(t));
        if(bad.length){ console.log("BADCARDS "+(window.__bl2d_pbpCursorYmd||"?")+" "+JSON.stringify(bad)); break; } }'
   ```
   (Tune the regex; the point is to catch impossible season values + their labels live.)
2. **Once caught, bisect CPU vs GPU vs hit-test:** at the bad frame, compare (a) the model's
   `evtOpenSeasonPoints` value for that gpid, (b) the GPU readback (`verifySeasonFrontier`/a counter
   readback), (c) the card's name/value. That isolates whether it's a value bug (GPU baseline) or a
   labeling bug (hit-test/quadtree).
3. **Is S2 the trigger?** Re-test the SAME repro on the **pre-S2 data**: `git stash` won't help (it's
   committed) — instead `git checkout 90ea853 -- data/pbp` (the commit before S2 `4cadc49`), retest,
   then `git checkout 4cadc49 -- data/pbp` to restore. If the bug vanishes pre-S2, it's S2-specific
   (look at the +6,513 appended dim players / the larger event stream / `eventsByDate` after the
   complement). If it persists, it's a pre-existing SA2–SA4 live-path bug.
4. **Likely fix areas** (confirm before editing): the `gpuSeason` branch in `drawScatterPlot` around the
   quadtree/hover build and `foregroundCloudPoints=[]`; `renderFrontierCards` feed; the boundary-cross
   detection in `accumulateSeasonCloud` / `_seasonAccumulateTo`; the pause→CPU handoff.

## Mitigation option (if a fix is non-trivial)

`?gpuseason=0` forces the proven CPU season path (SA4 made GPU season default-on). If the bug is
GPU-path-only and a fix is deferred, **revert the SA4 graduation** (`GPU_SEASON = …get("gpuseason")
=== "1"`, back to default-OFF) as a stopgap so production season animation uses the correct CPU path
until the live-glide bug is fixed. That's a one-line change in `script.js` (the `GPU_SEASON` const).

## Verification-tooling reminders (cost me time this session)

- `snap-gpu.js` **sleeps `waitMs` BEFORE running evalJS and never prints the evalJS return value** —
  use a SMALL `waitMs` (~2000) and `console.log(...)` inside the IIFE (forwarded as `[page log]`).
- **macOS has no `timeout` command** (exit 127 silently) — don't wrap node in `timeout`.
- Kill stray headless Chrome between runs (`pkill -f snap-gpu.js`; `pkill -f snap-realgpu`) — multiple
  instances collide and hang the model warmup.
- Season oracles need the **dev server** (stat layer present), NOT the `file://` bundle, and the model
  loads only after a playback frame — click `#anim-play-btn` then poll `__bl2d_verifySpring().maxX>0`
  or `__bl2d_evtGpuSeason===true` before trusting a run (cold-page SwiftShader flake).
- Model hooks: `window.__bl2d_pbpEvt()` (resident BL2S model), `__bl2d_pbpCursorIdx()`,
  `__bl2d_pbpCursorYmd`, `__bl2d_evtGpuSeason`, `__bl2d_lastSeasonUnionFrontier`,
  `__bl2d_verifySeason`, `__bl2d_verifySeasonLive`, `__bl2d_verifySeasonFrontier`.
