// The sampling profile of all processes (QJS98_PROFILE=<ms>, 07-native-render/host/prof98.h): every process writes <dir>/<pid>.prof.json next to its timeline
// file; this prints a summary into the harness log and the full tables into <dir>/../profile.txt.
// Sample weights are the time each sample stands for: CPU time of the main thread on Linux, wall time on Windows (there "[idle]" is the event loop waiting
// and is left out of the busy time). Self time = the sample's innermost frame (or a label: [gc], [compile], [read bytecode], [host] = C code outside any
// JavaScript call); inclusive = every function on the sample's stack, counted once.
import * as std from 'qjs:std';
import * as os from 'qjs:os';

const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n); const rpad = (s, n) => (' '.repeat(n) + String(s)).slice(-n);
const ms = (v) => rpad(Math.round(v), 7);
const pct = (v, tot) => rpad((100 * v / tot).toFixed(1), 5) + '%';
const fileOf = (name) => { const m = / ([^ ]+):\d+:\d+$/.exec(name); return m ? m[1] : null; };

export function loadProfiles(dir, procs) {
	const [names] = os.readdir(dir); const out = [];
	for (const n of (names || []).filter(x => x.endsWith('.prof.json'))) {
		let p; try { p = JSON.parse(std.loadFile(dir + '/' + n)); } catch { continue; }   // being rewritten
		const tl = procs.find(q => q.pid === p.pid); p.col = tl ? tl.col : 'pid ' + p.pid; p.label = tl ? tl.label : '';
		const empty = p.names.length; p.names.push('[no frames]');
		p.stacks = p.stacks.map(s => s.length ? s : [empty]);
		out.push(p);
	}
	return out;
}
/** aggregates the samples of p with t (harness clock, ms) in [a, b) */
export function aggregate(p, t0, a = -Infinity, b = Infinity) {
	const self = new Map(), incl = new Map(), file = new Map(); let busy = 0, idle = 0, n = 0;
	const idleId = p.names.indexOf('[idle]');
	for (let i = 0; i < p.samples.length; i += 3) {
		const t = p.t0 + p.samples[i] - t0; if (t < a || t >= b) { continue; }
		const st = p.stacks[p.samples[i + 1]], w = p.samples[i + 2] / 1000; n++;
		if (st[0] === idleId) { idle += w; continue; }
		busy += w; self.set(st[0], (self.get(st[0]) || 0) + w);
		const seen = new Set(); for (const id of st) { if (id >= 0 && !seen.has(id)) { seen.add(id); incl.set(id, (incl.get(id) || 0) + w); } }
		// the source file of the innermost JavaScript frame, or the label when the sample is in the collector, the parser, the host ...
		const leaf = p.names[st[0]]; let f = null;
		if (leaf.startsWith('[') && !leaf.startsWith('[native')) { f = leaf; } else { for (const id of st) { if (id >= 0) { f = fileOf(p.names[id]); if (f) { break; } } } }
		f = f || '(native, no JavaScript caller)'; file.set(f, (file.get(f) || 0) + w);
	}
	const top = (m, k) => [...m].sort((x, y) => y[1] - x[1]).slice(0, k);
	return { self, incl, file, busy, idle, n, top };
}
/** seconds from the harness start of the first and the last sample of p */
function sampleSpan(p, t0) { let a = Infinity, b = -Infinity; for (let i = 0; i < p.samples.length; i += 3) { const t = p.t0 + p.samples[i] - t0; if (t < a) { a = t; } if (t > b) { b = t; } } return [a / 1000, b / 1000]; }
/** the heaviest call paths (innermost frames first) through the function `id` */
function callers(p, id, depth, k) {
	const paths = new Map();
	for (let i = 0; i < p.samples.length; i += 3) {
		const st = p.stacks[p.samples[i + 1]]; const j = st.indexOf(id); if (j < 0) { continue; }
		const key = st.slice(j, j + depth).map(x => x < 0 ? '...' : p.names[x]).join(' < '); paths.set(key, (paths.get(key) || 0) + p.samples[i + 2] / 1000);
	}
	return [...paths].sort((x, y) => y[1] - x[1]).slice(0, k);
}

/** prints the summary with `log` and writes profile.txt next to `dir`; `t0` = harness start (epoch ms), `procs` = the timeline's processes (pid, col, label) */
export function profileReport(dir, log, t0, procs) {
	const profs = loadProfiles(dir, procs); if (!profs.length) { return; }
	const order = (p) => p.label === 'window' ? 0 : p.label === 'main' ? 1 : 2; profs.sort((x, y) => order(x) - order(y) || y.samples.length - x.samples.length);
	const lines = []; const out = (s) => lines.push(s);
	const head = `profile (one sample every ${profs[0].intervalMs} ms of ${profs[0].clock === 'cpu' ? 'CPU time' : 'wall time'}; busy = not waiting in the event loop${profs[0].clock === 'cpu' ? '' : ', which includes waiting for a CPU while other processes run'}):`;
	log(head); out(head);
	const now = Date.now(); const seconds = Math.ceil((now - t0) / 1000);
	for (const p of profs) {
		const all = aggregate(p, t0); if (all.busy < 50) { continue; }
		const name = (id) => p.names[id];
		// a process writes its file when its event loop is about to wait (at most every 2 s): one that has been busy since then has newer samples than these
		const span = sampleSpan(p, t0), stale = (now - t0) / 1000 - span[1] > 1.5;
		const hdr = `  ${p.col}: busy ${(all.busy / 1000).toFixed(1)} s in ${all.n} samples${p.dropped ? `, ${p.dropped} dropped` : ''}, ${span[0].toFixed(1)} to ${span[1].toFixed(1)} s${stale ? ' (not written since: busy without waiting, or idle)' : ''}`;
		const isWin = p.label === 'window';
		log(hdr); out(''); out(hdr);
		// by file: one line in the log, a table in the file
		const files = all.top(all.file, 40);
		log('    by source file: ' + files.slice(0, isWin ? 12 : 6).map(([f, v]) => `${f} ${(100 * v / all.busy).toFixed(0)}%`).join(', '));
		out('    by source file of the innermost JavaScript frame (or label):'); for (const [f, v] of files) { out(`    ${ms(v)} ms ${pct(v, all.busy)}  ${f}`); }
		const selfTop = all.top(all.self, isWin ? 100 : 40), inclTop = all.top(all.incl, isWin ? 100 : 30);
		const nLog = isWin ? 30 : 8;
		log(`    top ${nLog} by self time:`); for (const [id, v] of selfTop.slice(0, nLog)) { log(`    ${ms(v)} ms ${pct(v, all.busy)}  ${name(id)}`); }
		out(`    top ${selfTop.length} by self time:`); for (const [id, v] of selfTop) { out(`    ${ms(v)} ms ${pct(v, all.busy)}  ${name(id)}`); }
		if (isWin) { log('    top 30 by inclusive time:'); for (const [id, v] of inclTop.slice(0, 30)) { log(`    ${ms(v)} ms ${pct(v, all.busy)}  ${name(id)}`); } }
		out(`    top ${inclTop.length} by inclusive time:`); for (const [id, v] of inclTop) { out(`    ${ms(v)} ms ${pct(v, all.busy)}  ${name(id)}`); }
		out('    call paths of the top 25 by self time (innermost first, 8 frames):');
		for (const [id, v] of selfTop.slice(0, 25)) { out(`    ${ms(v)} ms  ${name(id)}`); for (const [path, w] of callers(p, id, 8, 4)) { out(`        ${ms(w)} ms  ${path}`); } }
		// per second of the launch (the seconds of the timeline table): the busiest functions by self time
		const perSec = []; for (let s = 0; s < seconds; s++) { const a = aggregate(p, t0, s * 1000, (s + 1) * 1000); if (a.busy < 20) { continue; } perSec.push([s, a]); }
		if (isWin) { log('    per second (busy ms: top 3 by self time):'); }
		out('    per second (busy ms: top 6 by self time; then the top 3 source files):');
		for (const [s, a] of perSec) {
			const tops = (k) => a.top(a.self, k).map(([id, v]) => `${Math.round(v)} ${name(id)}`).join(' | ');
			if (isWin) { log(`    ${rpad(s, 4)} ${rpad(Math.round(a.busy), 4)}: ${tops(3)}`); }
			out(`    ${rpad(s, 4)} ${rpad(Math.round(a.busy), 4)}: ${tops(6)}`); out(`              files: ${a.top(a.file, 3).map(([f, v]) => `${f} ${Math.round(v)}`).join(', ')}`);
		}
	}
	const file = dir.replace(/[\\/][^\\/]*$/, '') + '/profile.txt';
	try { const f = std.open(file, 'w'); f.puts(lines.join('\n') + '\n'); f.close(); log(`  full tables (all processes, call paths, per second): ${file}`); } catch (e) { log('  profile.txt: ' + e); }
}
