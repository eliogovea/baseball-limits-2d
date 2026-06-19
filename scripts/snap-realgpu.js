#!/usr/bin/env node
// Capture the app's REAL-GPU (Metal) WebGPU output via Playwright + headed system Chrome.
// Usage: node snap-realgpu.js <url> <out.png> [waitMs] [evalJS]
//
// Why this exists (and snap-gpu.js doesn't suffice): headless Chrome runs the SwiftShader
// fallback adapter, which cannot configure a visible canvas AND stalls/serializes some
// timing-sensitive GPU paths — so live-animation bugs (e.g. a persistent-draw glitch that
// only shows mid-glide) never reproduce there. This driver launches HEADED system Chrome
// (real Metal GPU), drives the live playback, and grabs the app's OFFSCREEN render-target
// readback (`__bl2d_exportDataURLs()`) ACROSS live glide frames — the only way to see the
// GPU layer (Playwright's page.screenshot does NOT composite the WebGPU canvas, and
// `pointRenderer` is module-scoped, not on window). See memory project_realgpu_verification.
//
// Setup (one-time, repo stays package.json-free): a throwaway playwright install —
//   mkdir -p /tmp/pw && cd /tmp/pw && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
// Override the location with PLAYWRIGHT_DIR. No browser download — we use channel:'chrome'.
//
// The URL MUST include ?webgpuHeadless=1 — Playwright sets navigator.webdriver=true, which the
// app's chooseRenderer otherwise treats as headless → stays Canvas2D. With the flag + headed
// real GPU, __bl2d_renderer === "webgpu". evalJS (last arg) runs after the tour is dismissed
// and after waitMs; print diagnostics from it with console.log (forwarded to stderr).

const fs = require('node:fs');
const PW_DIR = process.env.PLAYWRIGHT_DIR || '/tmp/pw';
const { chromium } = require(`${PW_DIR}/node_modules/playwright`);

async function main() {
    const [url, outPath, waitMsStr, evalJS] = process.argv.slice(2);
    if (!url || !outPath) { console.error('usage: snap-realgpu.js <url> <out.png> [waitMs] [evalJS]'); process.exit(1); }
    if (!/webgpuHeadless=1/.test(url)) console.error('WARNING: url lacks ?webgpuHeadless=1 — Playwright will stay Canvas2D');
    const waitMs = parseInt(waitMsStr || '3500');

    const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--enable-unsafe-webgpu'] });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        page.on('console', (m) => process.stderr.write(`[page ${m.type()}] ${m.text()}\n`));
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForTimeout(800);
        // Dismiss the first-run tour so it doesn't cover the chart.
        await page.evaluate(() => document.getElementById('explainer-dismiss')?.click()).catch(() => {});
        await page.waitForTimeout(waitMs);

        const renderer = await page.evaluate(() => window.__bl2d_renderer).catch(() => null);
        process.stderr.write(`[realgpu] renderer=${renderer}\n`);

        if (evalJS) { await page.evaluate(`(async()=>{ ${evalJS} })()`).catch((e) => process.stderr.write(`[evalJS error] ${e.message}\n`)); }

        // Offscreen GPU readback → PNG. Race a timeout (it can stall if a frame is mid-submit).
        const dataUrl = await page.evaluate(async () => {
            if (!window.__bl2d_exportDataURLs) return '';
            const race = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
            const u = await race(window.__bl2d_exportDataURLs(), 4000);
            return (u && u[0]) || '';
        }).catch(() => '');
        if (dataUrl.startsWith('data:image/png;base64,')) {
            fs.writeFileSync(outPath, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
            console.log(`wrote ${outPath} (real-GPU offscreen readback)`);
        } else {
            console.log('no GPU readback (renderer=' + renderer + ') — nothing written');
        }
    } finally {
        await browser.close();
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
