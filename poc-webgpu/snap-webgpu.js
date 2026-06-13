#!/usr/bin/env node
// POC-local headless harness — like scripts/snap.js but launches Chrome with
// WebGPU ENABLED (the shared snap.js uses --disable-gpu, which kills WebGPU).
// Usage: node snap-webgpu.js <url> <out.png> <width> <height> [waitMs] [evalJS]
//
// If the sandbox's headless Chrome can't get a GPU adapter, the page sets
// window.__bl2d_error and the WASM-side invariants (which need no GPU) can still
// be asserted via evalJS — the render image is secondary, the architecture is
// the point. No external dependencies.

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
    const [url, outPath, widthStr, heightStr, waitMsStr, evalJS] = process.argv.slice(2);
    if (!url || !outPath || !widthStr || !heightStr) {
        console.error('usage: snap-webgpu.js <url> <out.png> <width> <height> [waitMs] [evalJS]');
        process.exit(1);
    }
    const width = parseInt(widthStr), height = parseInt(heightStr);
    const waitMs = parseInt(waitMsStr || '3000');

    const userDataDir = fs.mkdtempSync('/tmp/chrome-webgpu-');
    const port = 9222 + Math.floor(Math.random() * 1000);
    // WebGPU-enabling flags. --enable-unsafe-webgpu exposes navigator.gpu in
    // headless; an ANGLE backend gives a real GPU device; SwiftShader is the
    // software fallback. The ANGLE backend is platform-aware: on macOS the
    // native Metal backend is reliable, whereas --use-angle=vulkan (MoltenVK)
    // can fail requestDevice with "external Instance reference no longer
    // exists"; on Linux/Windows Vulkan is the right default. Override with
    // SNAP_WEBGPU_ANGLE=metal|vulkan|swiftshader if a machine needs it.
    const angle = process.env.SNAP_WEBGPU_ANGLE ||
        (process.platform === 'darwin' ? 'metal' : 'vulkan');
    const backendFeature = { metal: 'Metal', vulkan: 'Vulkan' }[angle];
    const chrome = spawn(CHROME, [
        '--headless=new', '--no-sandbox',
        '--enable-unsafe-webgpu',
        ...(backendFeature ? [`--enable-features=${backendFeature}`] : []),
        `--use-angle=${angle}`,
        '--enable-unsafe-swiftshader',
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
            const id = ++msgId; pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });
        ws.onMessage((data) => {
            const msg = JSON.parse(data);
            if (msg.method === 'Runtime.consoleAPICalled') {
                const args = (msg.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || '[?]'));
                process.stderr.write(`[page ${msg.params.type}] ${args.join(' ')}\n`);
            }
        });
        await send('Page.enable');
        await send('Runtime.enable');
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await send('Page.navigate', { url });
        await new Promise((resolve) => {
            ws.onMessage((data) => { if (JSON.parse(data).method === 'Page.loadEventFired') resolve(); });
            setTimeout(resolve, 8000);
        });
        await sleep(waitMs);

        if (evalJS) {
            const r = await send('Runtime.evaluate', { expression: evalJS, awaitPromise: true, returnByValue: true });
            const v = r.result && r.result.value;
            // a returned data:image/png URL is written straight to outPath (the
            // offscreen capture path); anything else is logged as EVAL output.
            if (typeof v === 'string' && v.startsWith('data:image/png;base64,')) {
                fs.writeFileSync(outPath, Buffer.from(v.slice('data:image/png;base64,'.length), 'base64'));
                console.log(`wrote ${outPath} (offscreen capture)`);
                ws.close();
                return;
            }
            if (v !== undefined) process.stdout.write(`EVAL ${JSON.stringify(v)}\n`);
            await sleep(300);
        }
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
        console.log(`wrote ${outPath} (${width}x${height})`);
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
                return (tabs.find(t => t.type === 'page') || tabs[0]).webSocketDebuggerUrl;
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
            send: (d) => ws.send(d), onMessage: (fn) => listeners.push(fn), close: () => ws.close(),
        }));
        ws.addEventListener('message', (ev) => { for (const fn of listeners) fn(ev.data); });
        ws.addEventListener('error', reject);
    });
}
main().catch((err) => { console.error(err); process.exit(1); });
