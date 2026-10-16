// Oracle for the sampling profiler (07-native-render/host/prof98.h): functions that burn known shares of CPU time, a native call (JSON.parse), a
// closure called through a C function (Array.prototype.map), a deep recursion (deeper than the 64 recorded frames), many short-lived functions
// (their bytecode is freed while the profiler runs) and a garbage collection. Prints the measured share of each and checks it against the profile.
// Usage: QJS98_PROFILE=2 QJS98_TIMELINE=<dir> qjs-spike7 prof_oracle.mjs <dir>
import * as std from 'qjs:std';
import * as os from 'qjs:os';
const dir = scriptArgs[1];
const now = () => performance.now();
function spin(ms) { const end = now() + ms; let x = 0; while (now() < end) { x += Math.sqrt(x + 1); } return x; }
function burnA() { return spin(300); }
function burnB() { return spin(600); }
function outer() { return inner(); }
function inner() { return spin(300); }
const text = JSON.stringify(Array.from({ length: 200000 }, (_, i) => ({ i, s: 'x' + i, a: [i, i + 1] })));
function parseMany() { const end = now() + 300; let n = 0; while (now() < end) { n += JSON.parse(text).length; } return n; }
function mapper(v) { return spin(1) + v; }
function viaMap() { return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map(mapper).length; }
function deep(n) { return n === 0 ? spin(200) : deep(n - 1) + 0; }
function shortLived() { const end = now() + 200; let k = 0; while (now() < end) { k += new Function('x', 'return x + ' + (k % 1000))(k) & 1; } return k; }
const shares = {};
function timed(name, fn) { const t = now(); fn(); shares[name] = now() - t; }
timed('burnA', burnA); timed('burnB', burnB); timed('outer/inner', outer); timed('JSON.parse', parseMany); timed('mapper via map', viaMap);
timed('deep', () => deep(200)); timed('shortLived', shortLived);
let keep = []; for (let i = 0; i < 300000; i++) { const o = { i }; o.self = o; keep.push(o); } keep = null;
timed('gc', () => std.gc());
const total = Object.values(shares).reduce((a, b) => a + b, 0);
globalThis.__timelineInfo = () => JSON.stringify({ label: 'oracle', marks: [] });
__timelineDump();
// this process's file: the newest .prof.json in dir (QuickJS has no os.getpid on Windows)
const [files] = os.readdir(dir);
const file = files.filter(f => f.endsWith('.prof.json')).map(f => [f, os.stat(`${dir}/${f}`)[0].mtime]).sort((x, y) => y[1] - x[1])[0][0];
const prof = JSON.parse(std.loadFile(`${dir}/${file}`));
const self = new Map(), incl = new Map(); let n = 0, gcUnderStdGc = 0;
for (let i = 0; i < prof.samples.length; i += 3) {
	const st = prof.stacks[prof.samples[i + 1]], w = prof.samples[i + 2] / 1000; n++;
	const leaf = st[0] >= 0 ? prof.names[st[0]] : '?'; self.set(leaf, (self.get(leaf) || 0) + w);
	if (leaf === '[gc]' && st.some(id => id >= 0 && prof.names[id] === '[native] gc')) { gcUnderStdGc += w; }
	for (const id of new Set(st)) { if (id >= 0) { const nm = prof.names[id]; incl.set(nm, (incl.get(nm) || 0) + w); } }
}
const find = (m, re) => { let c = 0; for (const [k, v] of m) { if (re.test(k)) { c += v; } } return c; };
const ms = c => c;
const rows = [
	['burnA (incl)', shares.burnA, ms(find(incl, /^burnA /))], ['burnB (incl)', shares.burnB, ms(find(incl, /^burnB /))],
	['inner (incl)', shares['outer/inner'], ms(find(incl, /^inner /))], ['parseMany (incl; JSON.parse ' + ms(find(self, /^\[native\] parse$/)).toFixed(0) + ' self, [gc] inside it ' + ms(find(incl, /^\[gc\]$/) - gcUnderStdGc).toFixed(0) + ')', shares['JSON.parse'], ms(find(incl, /^parseMany /))],
	['mapper (incl)', shares['mapper via map'], ms(find(incl, /^mapper /))], ['deep (incl, cut stacks)', shares.deep, ms(find(incl, /^deep /))],
	['shortLived (incl)', shares.shortLived, ms(find(incl, /^shortLived /))], ['[gc] under std.gc()', shares.gc, gcUnderStdGc],
];
print(`samples ${n}, interval ${prof.intervalMs} ms, clock ${prof.clock}, dropped ${prof.dropped}, names ${prof.names.length}, stacks ${prof.stacks.length}; measured total ${total.toFixed(0)} ms`);
let bad = 0;
for (const [name, real, sampled] of rows) {
	const ok = Math.abs(sampled - real) <= Math.max(30, real * 0.15); if (!ok) { bad++; }
	print(`${name.padEnd(30)} measured ${real.toFixed(0).padStart(5)} ms  profile ${sampled.toFixed(0).padStart(5)} ms  ${ok ? 'ok' : 'MISMATCH'}`);
}
print('a mapper stack: ' + (prof.stacks.map(st => st.map(id => id < 0 ? '...' : prof.names[id]).join(' < ')).find(s => / < mapper /.test(s) || /^mapper /.test(s)) || 'none'));
print(bad ? `FAIL ${bad}` : 'PASS');
