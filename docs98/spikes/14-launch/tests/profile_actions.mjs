// Where does the time of each action of scenario_ctl go? Takes a profile (<pid>.prof.json, QJS98_PROFILE=1) and the log of a run with --marks 1,
// and prints per action (all rounds together): the busy time by innermost frame's source file and the top functions by self and inclusive time.
// Usage: node profile_actions.mjs <prof.json> <ctl log> [top n=12]
import fs from 'node:fs';
const [profFile, logFile, topArg] = process.argv.slice(2); const TOP = Number(topArg || 12);
const p = JSON.parse(fs.readFileSync(profFile, 'utf8'));
const marks = {}; for (const l of fs.readFileSync(logFile, 'utf8').split('\n')) { const m = /^ctl: mark (\w+) (\d+) (\d+)/.exec(l); if (m) { (marks[m[1]] ??= []).push([+m[2], +m[3]]); } }
const fileOf = (n) => { const m = / ([^ ]+):\d+:\d+$/.exec(n); return m ? m[1].replace(/^.*\//, '') : null; };
const idleId = p.names.indexOf('[idle]');
for (const [name, wins] of Object.entries(marks)) {
	const self = new Map(), incl = new Map(), file = new Map(); let busy = 0, total = 0;
	for (let i = 0; i < p.samples.length; i += 3) {
		const epoch = p.t0 + p.samples[i]; if (!wins.some(([a, b]) => epoch >= a && epoch < b)) { continue; }
		const st = p.stacks[p.samples[i + 1]], w = p.samples[i + 2] / 1000; total += w; if (st[0] === idleId) { continue; } busy += w;
		self.set(st[0], (self.get(st[0]) || 0) + w); const seen = new Set(); for (const id of st) { if (id >= 0 && !seen.has(id)) { seen.add(id); incl.set(id, (incl.get(id) || 0) + w); } }
		let f = null; const leaf = p.names[st[0]]; if (leaf.startsWith('[') && !leaf.startsWith('[native')) { f = leaf; } else { for (const id of st) { if (id >= 0 && fileOf(p.names[id])) { f = fileOf(p.names[id]); break; } } } f ||= '(native)'; file.set(f, (file.get(f) || 0) + w);
	}
	const top = (m, k) => [...m].sort((x, y) => y[1] - x[1]).slice(0, k); const r = (v) => String(Math.round(v / wins.length)).padStart(5);
	console.log(`\n== ${name}: ${wins.length} rounds, per round: ${Math.round(total / wins.length)} ms in the window, ${Math.round(busy / wins.length)} busy`);
	console.log('  by file: ' + top(file, 8).map(([f, v]) => `${f} ${Math.round(v / wins.length)}`).join(', '));
	console.log('  self:'); for (const [id, v] of top(self, TOP)) { console.log(`   ${r(v)} ms  ${p.names[id]}`); }
	console.log('  inclusive:'); for (const [id, v] of top(incl, TOP)) { console.log(`   ${r(v)} ms  ${p.names[id]}`); }
}
