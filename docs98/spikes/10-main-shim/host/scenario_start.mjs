// Control comparison, QuickJS host side of 12-control/host/electron_start.mjs: time from process start until the explorer lists the workspace,
// then the memory of all host processes 30 s later (Linux: ps over the qjs processes).
import * as os from 'qjs:os';
import * as std from 'qjs:std';
const sleep = (ms) => new Promise((r) => os.setTimeout(r, ms));
export async function run(ctx) {
	const { doc, log, env } = ctx;
	const ready = () => [...doc.querySelectorAll('.explorer-folders-view .monaco-list-row')].some((r) => /hello\.txt/.test(r.getAttribute('aria-label') || ''));
	while (!ready()) { await sleep(20); env.flushFrames?.(); doc.__ensureLayout(); }
	const tReady = Math.round(performance.now());
	await sleep(30000);
	let mb = 0, n = 0; const f = std.popen('ps -eo rss=,comm=', 'r'); if (f) { for (let l = f.getline(); l !== null; l = f.getline()) { const [rss, comm] = l.trim().split(/\s+/); if (/qjs/.test(comm || '')) { mb += Number(rss) / 1024; n++; } } f.close(); }
	log('ctl: ours startup ' + JSON.stringify({ explorerReady: tReady, after30s: { mb: Math.round(mb), processes: n } }));
}
