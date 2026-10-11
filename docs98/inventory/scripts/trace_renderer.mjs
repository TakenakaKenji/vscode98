// Runtime trace of the VS Code renderer (workbench window) over the Chrome DevTools Protocol.
//
// What it does:
//   1. Attaches to the running workbench page (Electron started with --remote-debugging-port=PORT).
//   2. Registers an init script that wraps DOM / Web API prototypes and constructors with call counters,
//      then reloads the window so the counters see the whole startup.
//   3. Waits SETTLE seconds, then collects: API call counts, a census of CSS declarations in loaded
//      stylesheets, and a census of computed styles over every element currently in the DOM.
//
// Usage (repo root):
//   node docs98/inventory/scripts/trace_renderer.mjs <port> <settleSeconds> <outFile.json>
//
// Needs `chrome-remote-interface` (already a root devDependency of the repo).

import CDP from 'chrome-remote-interface';
import { writeFileSync } from 'node:fs';
import { INSTRUMENT, CENSUS } from './trace_common.mjs';

const [port = '9333', settle = '30', out = 'renderer-trace.json'] = process.argv.slice(2);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Find the workbench page target.
let target;
for (let i = 0; i < 60 && !target; i++) {
	try {
		const list = await CDP.List({ port: Number(port) });
		target = list.find(t => t.type === 'page' && /workbench/.test(t.url));
	} catch { /* not up yet */ }
	if (!target) { await sleep(1000); }
}
if (!target) { console.error('No workbench page target found on port ' + port); process.exit(2); }
console.error('attached to', target.url);

const client = await CDP({ port: Number(port), target });
const { Page, Runtime, Emulation } = client;
await Page.enable(); await Runtime.enable();
// Headless windows default to a tiny viewport, which hides most of the UI; emulate a normal desktop size.
await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await Page.addScriptToEvaluateOnNewDocument({ source: INSTRUMENT });
const t0 = Date.now();
await Page.reload({ ignoreCache: false });
console.error('reloaded; settling for ' + settle + 's');
await sleep(Number(settle) * 1000);

const ev = async (expression) => {
	const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) { throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); }
	return r.result.value;
};

const counts = await ev('globalThis.__trace ? globalThis.__trace.counts : null');
const census = await ev(CENSUS);
const timing = await ev(`(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { domContentLoaded: n.domContentLoadedEventEnd, loadEvent: n.loadEventEnd } : null; })()`);
const heap = await client.send('Runtime.getHeapUsage').catch(() => null);

const sorted = o => Object.fromEntries(Object.entries(o || {}).sort((a, b) => b[1] - a[1]));
writeFileSync(out, JSON.stringify({
	takenAt: new Date().toISOString(), settleSeconds: Number(settle), msSinceReload: Date.now() - t0, timing, heapUsage: heap,
	apiCounts: sorted(counts), census: { ...census, computed: sorted(census.computed), stylesheets: { ...census.stylesheets, properties: sorted(census.stylesheets.properties) } }
}, null, 1));
console.error('wrote ' + out);
await client.close();
process.exit(0);
