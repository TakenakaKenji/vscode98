// Startup-time and memory baseline of a running VS Code (dev or bundled), over CDP + /proc. No instrumentation is injected,
// so the numbers are not skewed by the API-counting tracers.
//
// Usage: node measure_baseline.mjs <port> <outFile.json> <launchEpochMs> <settleSeconds>
// Reports: time from launch to "workbench ready" (workbench DOM with editor part + status bar, document complete),
// VS Code's own startup marks (code/*), then per-process RSS/PSS and the renderer JS heap at ready+1s and after the settle time.
import CDP from 'chrome-remote-interface';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const [port = '9333', out = 'baseline.json', launchMs = String(Date.now()), settle = '20'] = process.argv.slice(2);
const launch = Number(launchMs);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- /proc helpers (Linux)
const read = (p) => { try { return readFileSync(p, 'latin1'); } catch { return ''; } };
function allProcs() {
	const procs = [];
	for (const d of readdirSync('/proc')) {
		if (!/^\d+$/.test(d)) { continue; }
		const stat = read(`/proc/${d}/stat`); if (!stat) { continue; }
		const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		procs.push({ pid: Number(d), ppid: Number(rest[1]), cmd: read(`/proc/${d}/cmdline`).split('\0').join(' ') });
	}
	return procs;
}
function findMain(procs) {
	return procs.find(p => p.cmd.includes(`--remote-debugging-port=${port}`) && !p.cmd.includes('--type='));
}
function classify(p) {
	const t = /--type=(\w[\w-]*)/.exec(p.cmd);
	if (t) {
		const sub = /--utility-sub-type=([\w.-]+)/.exec(p.cmd);
		return t[1] === 'utility' && sub ? `utility:${sub[1]}` : t[1];
	}
	if (/tsserver/.test(p.cmd)) { return 'node:tsserver'; }
	if (/typingsInstaller/.test(p.cmd)) { return 'node:typingsInstaller'; }
	if (/jsonServerMain/.test(p.cmd)) { return 'node:jsonServer'; }
	if (/workerMain/.test(p.cmd)) { return 'node:markdownWorker'; }
	if (/ripgrep|\/rg /.test(p.cmd)) { return 'rg'; }
	return 'main-or-other';
}
function kb(pid, file, key) {
	const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(read(`/proc/${pid}/${file}`));
	return m ? Number(m[1]) : 0;
}
function sampleProcesses() {
	const procs = allProcs(); const main = findMain(procs); if (!main) { return null; }
	const tree = new Set([main.pid]); let grew = true;
	while (grew) { grew = false; for (const p of procs) { if (!tree.has(p.pid) && tree.has(p.ppid)) { tree.add(p.pid); grew = true; } } }
	const rows = procs.filter(p => tree.has(p.pid)).map(p => ({ pid: p.pid, kind: p.pid === main.pid ? 'main' : classify(p), rssKB: kb(p.pid, 'status', 'VmRSS'), pssKB: kb(p.pid, 'smaps_rollup', 'Pss'), threads: kb(p.pid, 'status', 'Threads') }));
	const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
	return { processes: rows.length, totalRssMB: Math.round(sum('rssKB') / 1024), totalPssMB: Math.round(sum('pssKB') / 1024), rows };
}

// ---- attach
let target;
for (let i = 0; i < 400 && !target; i++) {
	try { target = (await CDP.List({ port: Number(port) })).find(t => t.type === 'page' && /workbench/.test(t.url)); } catch { /* not up yet */ }
	if (!target) { await sleep(100); }
}
if (!target) { console.error('no workbench page'); process.exit(2); }
const client = await CDP({ port: Number(port), target });
const { Runtime, Performance } = client;
await Runtime.enable(); await Performance.enable();

const READY = `(() => { const q = s => document.querySelector(s); return document.readyState === 'complete' && !!q('.monaco-workbench') && !!q('.monaco-workbench .part.editor') && !!q('.monaco-workbench .part.statusbar'); })()`;
let readyAt = null;
for (let i = 0; i < 1200; i++) {
	try { const r = await Runtime.evaluate({ expression: READY, returnByValue: true }); if (r.result.value === true) { readyAt = Date.now(); break; } } catch { /* page navigating */ }
	await sleep(100);
}
if (!readyAt) { console.error('workbench never became ready'); process.exit(3); }

async function renderer() {
	const m = Object.fromEntries((await Performance.getMetrics()).metrics.map(x => [x.name, x.value]));
	return { jsHeapUsedMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), jsHeapTotalMB: +(m.JSHeapTotalSize / 1048576).toFixed(1), domNodes: m.Nodes, documents: m.Documents, jsEventListeners: m.JSEventListeners };
}
const marksExpr = `JSON.stringify(performance.getEntriesByType('mark').filter(m => m.name.startsWith('code/')).map(m => [m.name, Math.round(m.startTime)]))`;
const marks = JSON.parse((await Runtime.evaluate({ expression: marksExpr, returnByValue: true })).result.value);
const timeOrigin = (await Runtime.evaluate({ expression: 'performance.timeOrigin', returnByValue: true })).result.value;

await sleep(1000);
const atReady = { renderer: await renderer(), ...sampleProcesses() };
await sleep(Number(settle) * 1000);
const idle = { renderer: await renderer(), ...sampleProcesses() };

const result = {
	timeToReadyMs: readyAt - launch,
	rendererTimeOriginAfterLaunchMs: Math.round(timeOrigin - launch),
	marks: Object.fromEntries(marks),
	atReadyPlus1s: atReady, idleAfterSettle: { settleSeconds: Number(settle), ...idle },
};
writeFileSync(out, JSON.stringify(result, null, 1));
console.error(`ready ${result.timeToReadyMs} ms; at +1s: ${atReady.processes} procs, RSS ${atReady.totalRssMB} MB, PSS ${atReady.totalPssMB} MB, renderer JS heap ${atReady.renderer.jsHeapUsedMB} MB; idle: RSS ${idle.totalRssMB} MB, PSS ${idle.totalPssMB} MB, heap ${idle.renderer.jsHeapUsedMB} MB`);
await client.close();
