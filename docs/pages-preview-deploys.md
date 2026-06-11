# GitHub Pages: live site + per-branch previews

`.github/workflows/deploy-pages.yml` serves the production site **and** a preview of every
branch from one Pages site, via a persistent `gh-pages` branch:

| Branch              | URL                                                        |
|---------------------|-----------------------------------------------------------|
| `main`              | `https://<user>.github.io/<repo>/`                        |
| any other branch    | `https://<user>.github.io/<repo>/experimental/<branch>/` |

Branch slugs replace `/` with `-` (`feat/event-level-pbp` → `experimental/feat-event-level-pbp/`).

## Why a `gh-pages` branch (not the "GitHub Actions" Pages source)

A repo has exactly one Pages site. The official Actions Pages deploy replaces the **whole**
site each run, so it can't keep `main` + N previews side-by-side. Writing into a `gh-pages`
branch with `keep_files: true` is **additive** — a push to one branch only updates its own
folder and never disturbs production or the other previews. The cost: deleted files linger
(nothing is wiped), so removed runtime files persist on the site until manually pruned. The
`delete`-event cleanup job removes a whole preview folder when its branch is deleted.

## One-time setup (repo admin)

1. Merge `deploy-pages.yml` to `main` and push (creates `gh-pages` on first run).
2. **Settings → Pages → Build and deployment**
   - Source: **Deploy from a branch**
   - Branch: **`gh-pages`**  ·  Folder: **`/ (root)`**
3. Confirm `https://<user>.github.io/<repo>/` still serves production (mirrored from `main`).

> ⚠️ This moves production off "main/root served directly" onto "gh-pages/root, written by the
> workflow from main." Update CLAUDE.md's *Git / deployment* section when you flip the switch.

## The `on: push` gotcha

GitHub runs the workflow definition **from the branch being pushed**. A branch only deploys
itself if `deploy-pages.yml` exists on it. Add it to `main`; branches cut from `main` inherit
it. For branches that predate it, merge/rebase the file in once.

## What ships (asset policy)

Only runtime web assets are deployed. The workflow's `rsync` excludes:
`scripts/`, `docs/`, `dist/`, `node_modules/`, `*.md`, the raw Lahman source CSVs
(`*_lahman_*.csv` except `people_*`), `data/*.zip`, and the **unused** `data/pbp/*.bl2e.gz` /
`*.bl2s.gz` formats (the app fetches only `.bl2p.gz` + `.evt.gz`). Result: ~43 MB/branch
instead of ~136 MB. A branch with **no `index.html` at its root** is skipped (not deployed
empty), so native POCs don't produce broken previews.

## POC branches: one web POC per branch, at root

The system keys off `index.html` **at the branch root**. To make a POC previewable:

- **Web POCs** (WebGPU/Canvas/JS): give each its own branch with the POC's `index.html` at the
  **root** of that branch — `experimental/poc-webgpu-spring/` etc. Avoid nesting it under a
  `poc-*/` subdirectory on a deployable branch; the deploy serves the branch root, so a nested
  POC would need its files hoisted (or a root redirect).
- **Native POCs** (Vulkan/C): not web-servable. They can keep their branches; the workflow's
  `index.html` guard skips them automatically — no broken preview, no config needed.

This matches the "uniform format, no nested poc directories" goal: each previewable POC is a
self-contained web app at its branch root, reachable at a predictable `experimental/<branch>/`
URL.

## Adjusting the asset whitelist

Edit the `rsync --exclude` block in `deploy-pages.yml`. It's tuned to the main app's data
layout; a POC branch with a different layout (e.g. `shaders/*.wgsl`, a `.wasm`) ships fine as
long as those files aren't matched by an exclude — only `scripts/`, `docs/`, `dist/`,
`node_modules/`, `*.md`, and the specific raw-data globs are removed.
