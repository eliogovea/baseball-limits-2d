#!/usr/bin/env node
// Capture the full-GPU graph's OFFSCREEN render target to a PNG via CDP.
// Usage: node snap-gpu.js <url> <out.png> <width> <height> [waitMs] [evalJS]
//
// Why this exists (and snap.js doesn't suffice for the G-track): under headless
// Chrome the WebGPU backend can't configure a visible canvas (SwiftShader), so the
// G-track renders to an OFFSCREEN texture and never reaches the page's pixels —
// Page.captureScreenshot would show only the SVG layer. This driver instead forces
// the GPU path (?webgpuHeadless=1&gpugraph=1 must be in <url>), then calls the
// app's `window.__bl2d_exportDataURLs()` readback probe and writes the decoded PNG.
// It also prints `window.__bl2d_verifyGraph()` so the numeric invariants
// (glyphMis/tickMis/atlasMissing/…) ride along with the visual capture.
//
// Shares the minimal CDP plumbing style of snap.js — no external npm deps.

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
    const [url, outPath, widthStr, heightStr, waitMsStr, evalJS] = process.argv.slice(2);
    if (!url || !outPath || !widthStr || !heightStr) {
        console.error('usage: snap-gpu.js <url> <out.png> <width> <height> [waitMs] [evalJS]');
        process.exit(1);
    }
    const width = parseInt(widthStr), height = parseInt(heightStr);
    const waitMs = parseInt(waitMsStr || '3000');

    const userDataDir = fs.mkdtempSync('/tmp/chrome-gpu-');
    const port = 9222 + Math.floor(Math.random() * 1000);
    // NOTE: no --disable-gpu here — WebGPU needs an adapter; SwiftShader serves the
    // fallback adapter in headless. The app's ?webgpuHeadless=1 flag opts past the
    // "headless → stay Canvas2D" guard.
    const chrome = spawn(CHROME, [
        '--headless=new', '--no-sandbox',
        '--enable-unsafe-webgpu', '--enable-features=Vulkan',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run', '--no-default-browser-check',
        'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    chrome.on('error', (err) => { console.error('chrome failed to spawn:', err); process.exit(1); });

    try {
        const debuggerUrl = await waitForDebugger(port);
        const ws = await openWs(debuggerUrl);
        let msgId = 0;
        const pending = new Map();
        ws.onMessage((data) => {
            const msg = JSON.parse(data);
            if (msg.id && pending.has(msg.id)) {
                const { resolve, reject } = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
                else resolve(msg.result);
            }
        });
        const send = (method, params = {}) => new Promise((resolve, reject) => {
            const id = ++msgId;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });
        ws.onMessage((data) => {
            const msg = JSON.parse(data);
            if (msg.method === 'Runtime.consoleAPICalled') {
                const args = (msg.params.args || []).map(a =>
                    a.value !== undefined ? a.value : (a.description || '[?]'));
                process.stderr.write(`[page ${msg.params.type}] ${args.join(' ')}\n`);
            }
        });
        await send('Page.enable');
        await send('Runtime.enable');
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
        await send('Page.navigate', { url });
        await new Promise((resolve) => {
            ws.onMessage((data) => { if (JSON.parse(data).method === 'Page.loadEventFired') resolve(); });
        });
        await sleep(waitMs);
        if (evalJS) { await send('Runtime.evaluate', { expression: evalJS, awaitPromise: true }); await sleep(300); }

        // Numeric invariants alongside the visual.
        const v = await send('Runtime.evaluate', {
            expression: '(async()=>{ const r = window.__bl2d_verifyGraph ? await window.__bl2d_verifyGraph() : null; return JSON.stringify(r); })()',
            awaitPromise: true, returnByValue: true });
        process.stderr.write(`[verifyGraph] ${v.result.value}\n`);

        // Offscreen GPU readback → PNG.
        const r = await send('Runtime.evaluate', {
            expression: '(async()=>{ const u = window.__bl2d_exportDataURLs ? await window.__bl2d_exportDataURLs() : []; return (u && u[0]) || ""; })()',
            awaitPromise: true, returnByValue: true });
        const dataUrl = r.result.value || '';
        if (dataUrl.startsWith('data:image/png;base64,')) {
            fs.writeFileSync(outPath, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
            console.log(`wrote ${outPath} (${width}x${height}, GPU offscreen readback)`);
        } else {
            // No GPU readback (e.g. the renderer fell back to Canvas 2D — a device-loss test,
            // or WebGPU never came up): the visible canvas/SVG now carries the frame, so a
            // plain screenshot is the right capture.
            const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
            console.log(`wrote ${outPath} (${width}x${height}, visible-frame screenshot — no GPU readback)`);
        }
        ws.close();
    } finally {
        chrome.kill('SIGTERM');
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForDebugger(port, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (res.ok && (await res.json()).webSocketDebuggerUrl) {
                const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
                const page = tabs.find(t => t.type === 'page') || tabs[0];
                return page.webSocketDebuggerUrl;
            }
        } catch { /* not ready */ }
        await sleep(120);
    }
    throw new Error(`debugger never came up on port ${port}`);
}

function openWs(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const listeners = [];
        ws.addEventListener('open', () => resolve({
            send: (data) => ws.send(data),
            onMessage: (fn) => { listeners.push(fn); },
            close: () => ws.close(),
        }));
        ws.addEventListener('message', (ev) => { for (const fn of listeners) fn(ev.data); });
        ws.addEventListener('error', reject);
    });
}

main().catch((err) => { console.error(err); process.exit(1); });
