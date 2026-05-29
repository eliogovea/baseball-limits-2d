#!/usr/bin/env node
// Render an HTML file at an explicit viewport via Chrome DevTools Protocol.
// Usage: node snap.js <url> <out.png> <width> <height> [waitMs] [evalJS]
//
// Headless Chrome's --window-size flag is unreliable below ~500px. We launch Chrome
// with --remote-debugging-port and use CDP's Emulation.setDeviceMetricsOverride to
// force the exact viewport, then capture a screenshot. No external dependencies —
// just Node's built-in WebSocket and fetch.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
    const [url, outPath, widthStr, heightStr, waitMsStr, evalJS] = process.argv.slice(2);
    if (!url || !outPath || !widthStr || !heightStr) {
        console.error('usage: snap.js <url> <out.png> <width> <height> [waitMs] [evalJS]');
        process.exit(1);
    }
    const width = parseInt(widthStr);
    const height = parseInt(heightStr);
    const waitMs = parseInt(waitMsStr || '1500');

    const userDataDir = fs.mkdtempSync('/tmp/chrome-cdp-');
    const port = 9222 + Math.floor(Math.random() * 1000);
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-sandbox',
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

        // Forward console messages from the page to our stderr. Register the
        // listener BEFORE Runtime.enable so we don't miss messages emitted
        // during the burst right after navigate.
        ws.onMessage((data) => {
            const msg = JSON.parse(data);
            if (msg.method === 'Runtime.consoleAPICalled') {
                const args = (msg.params.args || []).map(a =>
                    a.value !== undefined ? a.value : (a.description || '[?]'));
                process.stderr.write(`[page ${msg.params.type}] ${args.join(' ')}\n`);
            }
            if (process.env.SNAP_DEBUG && msg.method) {
                process.stderr.write(`[cdp event] ${msg.method}\n`);
            }
        });
        await send('Page.enable');
        await send('Runtime.enable');
        await send('Emulation.setDeviceMetricsOverride', {
            width, height,
            deviceScaleFactor: 1,
            mobile: width < 768,
        });
        // TODO: support headless dark-mode capture via
        //   await send('Emulation.setEmulatedMedia', { features: [{name:'prefers-color-scheme', value:'dark'}] });
        // Wired through a --color-scheme flag would unblock @media (prefers-color-scheme: dark) verification.
        await send('Page.navigate', { url });

        // Wait for load + extra time for async decode/render.
        await new Promise((resolve) => {
            ws.onMessage((data) => {
                const msg = JSON.parse(data);
                if (msg.method === 'Page.loadEventFired') resolve();
                if (msg.id && pending.has(msg.id)) {
                    const { resolve, reject } = pending.get(msg.id);
                    pending.delete(msg.id);
                    if (msg.error) reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
                    else resolve(msg.result);
                }
            });
        });
        await sleep(waitMs);

        if (evalJS) {
            // awaitPromise lets the caller use top-level `await` inside an
            // async IIFE so we don't take the screenshot before the eval
            // finishes its own work.
            await send('Runtime.evaluate', { expression: evalJS, awaitPromise: true });
            await sleep(400);
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
            if (res.ok) {
                const info = await res.json();
                if (info.webSocketDebuggerUrl) {
                    // Get the page target.
                    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
                    const page = tabs.find(t => t.type === 'page') || tabs[0];
                    return page.webSocketDebuggerUrl;
                }
            }
        } catch { /* not ready yet */ }
        await sleep(120);
    }
    throw new Error(`debugger never came up on port ${port}`);
}

function openWs(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const listeners = [];
        ws.addEventListener('open', () => {
            resolve({
                send: (data) => ws.send(data),
                onMessage: (fn) => { listeners.push(fn); },
                close: () => ws.close(),
            });
        });
        ws.addEventListener('message', (ev) => {
            for (const fn of listeners) fn(ev.data);
        });
        ws.addEventListener('error', reject);
    });
}

main().catch((err) => { console.error(err); process.exit(1); });
