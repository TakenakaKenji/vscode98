// The sampling profile of the window process for the time the owner used the program (after the launch), printed into the log when the window closes:
// what the window did during the slow actions (window_host98.mjs records each input's start and last paint), and whether it was busy or waiting.
// Reads the window's <pid>.prof.json written by the profiler (07-native-render/host/prof98.h); the same aggregation as profile_report98.js.
import { loadProfiles, aggregate } from './profile_report98.js';

/** windows = [{ label, a, b }] with a, b in epoch ms (the span of one input, from the input to its last paint); log = the harness log */
export function useProfileReport(dir, pid, windows, log, slowMs = 500) {
	const p = loadProfiles(dir, []).find(q => q.pid === pid); if (!p) { log('[use-profile] no profile of this process in ' + dir + ' (QJS98_PROFILE off?)'); return; }
	const done = windows.filter(w => w.b > w.a); if (!done.length) { log('[use-profile] no input changed the screen'); return; }
	const name = (id) => p.names[id]; const r = (v) => String(Math.round(v)).padStart(6);
	const first = Math.min(...done.map(w => w.a)), last = Math.max(...done.map(w => w.b));
	const section = (title, pick, nTop) => {
		const self = new Map(), incl = new Map(), file = new Map(); let busy = 0, idle = 0;
		for (const [a, b] of pick) { const g = aggregate(p, 0, a, b); busy += g.busy; idle += g.idle; for (const [k, v] of g.self) { self.set(k, (self.get(k) || 0) + v); } for (const [k, v] of g.incl) { incl.set(k, (incl.get(k) || 0) + v); } for (const [k, v] of g.file) { file.set(k, (file.get(k) || 0) + v); } }
		const top = (m, k) => [...m].sort((x, y) => y[1] - x[1]).slice(0, k);
		log(`[use-profile] ${title}: window busy ${Math.round(busy)} ms, waiting ${Math.round(idle)} ms (in a profile sample every ${p.intervalMs} ms)`);
		if (busy < 1) { return; }
		log('  by source file: ' + top(file, 10).map(([f, v]) => `${f} ${Math.round(100 * v / busy)}%`).join(', '));
		log('  top by self time:'); for (const [id, v] of top(self, nTop)) { log(`  ${r(v)} ms ${(100 * v / busy).toFixed(1).padStart(5)}%  ${name(id)}`); }
		log('  top by inclusive time:'); for (const [id, v] of top(incl, nTop)) { log(`  ${r(v)} ms ${(100 * v / busy).toFixed(1).padStart(5)}%  ${name(id)}`); }
	};
	section(`all of the use, ${Math.round((last - first) / 1000)} s from the first input`, [[first, last]], 25);
	const slow = done.filter(w => w.b - w.a >= slowMs); if (slow.length) { section(`the ${slow.length} inputs that took ${slowMs} ms or more`, slow.map(w => [w.a, w.b]), 25); }
	log('[use-profile] the slowest inputs one by one (input to last paint, busy and waiting in the window, innermost functions):');
	for (const w of [...done].sort((x, y) => (y.b - y.a) - (x.b - x.a)).slice(0, 12)) {
		const g = aggregate(p, 0, w.a, w.b); const tops = g.top(g.self, 3).map(([id, v]) => `${Math.round(v)} ${name(id)}`).join(' | ');
		log(`  ${Math.round(w.b - w.a)} ms (busy ${Math.round(g.busy)}, waiting ${Math.round(g.idle)}) ${w.label}: ${tops}`);
	}
}
