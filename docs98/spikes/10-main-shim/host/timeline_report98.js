// The launch timeline of all processes (--timeline <dir> of boot_desktop_qjs.mjs). Every QuickJS process of the app writes <dir>/<pid>.json every ~2 s
// (07-native-render/host/timeline98.h: per 100 ms of wall time, how long its event loop waited and how long it was blocked in a synchronous call, plus a label
// and VS Code's performance marks from __timelineInfo below); this merges them into one table on the harness's clock, followed by the sampling profile when
// QJS98_PROFILE is set (profile_report98.js).
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import { profileReport } from './profile_report98.js';

const harnessMarks = [];
/** a mark of the harness itself (window opened, workbench stable ...) */
export function timelineMark(name) { harnessMarks.push([name, Date.now()]); }

/** starts recording in this process and in every process started after this (the environment is inherited) */
export function startTimeline(dir, env) {
	const parent = dir.replace(/[\\/][^\\/]*$/, ''); if (parent && parent !== dir) { os.mkdir(parent); } os.mkdir(dir); const [names] = os.readdir(dir); for (const n of names || []) { if (n.endsWith('.json') || n.endsWith('.tmp')) { os.remove(dir + '/' + n); } }
	env.QJS98_TIMELINE = dir; globalThis.__timelineLabel = 'window';
	if (globalThis.__timelineStart) { globalThis.__timelineStart(dir); }
	globalThis.__timelineInfo = () => JSON.stringify({ label: 'window', marks: [...marksOfThisProcess(), ...harnessMarks] });
}
/** VS Code's performance marks of this process as [name, epoch ms] */
export function marksOfThisProcess() {
	const pm = globalThis.MonacoPerformanceMarks; if (!pm || typeof pm.getMarks !== 'function') { return []; }
	try { return pm.getMarks().map(m => [m.name, Math.round(m.startTime)]); } catch { return []; }
}

const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n); const rpad = (s, n) => (' '.repeat(n) + String(s)).slice(-n);
/** prints the merged timeline up to now; `t0` is the harness's start (epoch ms) */
export function timelineReport(dir, log, t0) {
	if (globalThis.__timelineDump) { globalThis.__timelineDump(); }
	const [names] = os.readdir(dir); const procs = [];
	for (const n of (names || []).filter(x => x.endsWith('.json') && !x.endsWith('.prof.json'))) { try { const p = JSON.parse(std.loadFile(dir + '/' + n)); p.info = p.info || {}; p.label = p.info.label || ('pid ' + p.pid); procs.push(p); } catch { /* being rewritten */ } }
	if (!procs.length) { log('launch timeline: no data (QJS98_TIMELINE not set in the processes?)'); return; }
	procs.sort((a, b) => a.t0 - b.t0); const now = Date.now(); const rows = Math.ceil((now - t0) / 1000);
	const labels = new Map(); for (const p of procs) { const k = labels.get(p.label) || 0; labels.set(p.label, k + 1); p.col = k ? `${p.label}#${k + 1}` : p.label; }
	// per process and second: share of the second spent running JavaScript (busy) and blocked in a synchronous call (sync), over the part of the second it existed
	const cell = (p, s) => {
		const a = t0 + s * 1000, b = a + 1000; let busy = 0, sync = 0, alive = 0;
		for (let k = Math.max(0, Math.floor((a - p.t0) / p.bucketMs)); k < p.wait.length; k++) {
			const ba = p.t0 + k * p.bucketMs; if (ba >= b) { break; } const ov = Math.min(b, ba + p.bucketMs) - Math.max(a, ba); if (ov <= 0) { continue; }
			const f = ov / p.bucketMs; alive += ov; sync += p.sync[k] * f; busy += Math.max(0, p.bucketMs - p.wait[k] - p.sync[k]) * f;
		}
		return alive < 50 ? null : { busy: busy / 10, sync: sync / 10 };   // % of the second
	};
	log(`launch timeline (${procs.length} processes; per second from the harness start: % of the second each process ran JavaScript, "s" = blocked in a synchronous call):`);
	log('    t ' + procs.map(p => rpad(pad(p.col, 9).trim(), 9)).join(''));
	const totals = procs.map(() => ({ busy: 0, sync: 0 }));
	for (let s = 0; s < rows; s++) {
		let line = rpad(s, 5) + ' ';
		procs.forEach((p, i) => { const c = cell(p, s); if (!c) { line += rpad('.', 9); return; } totals[i].busy += c.busy * 10; totals[i].sync += c.sync * 10; line += rpad(Math.round(c.busy) + (c.sync >= 10 ? 's' + Math.round(c.sync) : ''), 9); });
		log(line);
	}
	log('  busy total (s): ' + procs.map((p, i) => `${p.col} ${(totals[i].busy / 1000).toFixed(1)}${totals[i].sync >= 100 ? ` (+${(totals[i].sync / 1000).toFixed(1)} sync)` : ''}`).join(', '));
	// seconds where the window mostly waited while something else ran: what the launch waited for
	const win = procs.find(p => p.label === 'window'); if (win) {
		const waitedFor = new Map(); let idle = 0;
		for (let s = 0; s < rows; s++) { const w = cell(win, s); if (!w || w.busy >= 40) { continue; } idle++; let best = null, bv = 25; for (const p of procs) { if (p === win) { continue; } const c = cell(p, s); if (c && c.busy + c.sync > bv) { bv = c.busy + c.sync; best = p.col; } } waitedFor.set(best || '(nothing busy)', (waitedFor.get(best || '(nothing busy)') || 0) + 1); }
		log(`  seconds the window ran JavaScript less than 40 % of the time: ${idle}; busiest other process in those seconds: ${[...waitedFor].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || '-'}`);
	}
	// the phase marks (code/willX, code/didX, lifecycle phases, the harness's own); the per-contribution, per-extension-point and per-model ones are counted only
	const phase = (n) => /^code\/(will|did)[A-Z]\w*$|^code\/LifecyclePhase\/|^code\/(mainAppReady|didStartRenderer)$|^harness:/.test(n) && !/Resolve(TextFileEditorModel)/.test(n);
	const marks = []; let skipped = 0; for (const p of procs) { for (const [name, t] of (p.info.marks || [])) { if (typeof t !== 'number' || t < 1e12) { continue; } if (phase(name)) { marks.push([t, p.col, name]); } else { skipped++; } } }
	{ const seen = new Set(); for (let i = marks.length - 1; i >= 0; i--) { const k = marks[i].join('|'); if (seen.has(k)) { marks.splice(i, 1); } else { seen.add(k); } } }   // a process can report a mark twice (the main process's marks also reach it through the window configuration)
	marks.sort((a, b) => a[0] - b[0]); log(`  marks (${marks.length} phase marks, ${skipped} finer ones not shown; seconds from the harness start):`);
	for (const [t, col, name] of marks) { log(`    ${rpad(((t - t0) / 1000).toFixed(2), 7)}  ${pad(col, 14)} ${name}`); }
	// with QJS98_PROFILE set: where each process spent its busy time
	try { profileReport(dir, log, t0, procs); } catch (e) { log('profile: ' + e); }
}
