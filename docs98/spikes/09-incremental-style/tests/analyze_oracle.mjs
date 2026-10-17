// Oracle for changes to analyzeIndex (06-rendering/host/dom/style_invalidation.js): builds the rule index of the given stylesheets (the workbench's CSS) and
// writes the analysis as canonical JSON (Sets and Maps as sorted arrays, shapes as trees), with the time of the analysis (best of 5). Run it with the old and the new
// module and compare the two files. Usage: node analyze_oracle.mjs <style_invalidation.js to use> <out.json> <css file>...
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { installEnvironment } from '../../06-rendering/host/dom/env.js';
import { buildRuleIndex } from '../../06-rendering/host/dom/css.js';
const [mod, outFile, ...css] = process.argv.slice(2);
const M = await import(path.resolve(mod)); const { analyzeIndex } = M;
const require = createRequire(import.meta.url); const opentype = require('/home/user/vscode98/node_modules/opentype.js/dist/opentype.js');
globalThis.__readFileBytes = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const env = installEnvironment({ width: 1100, height: 700, opentype }); const doc = env.document;
for (const f of css) { const s = doc.createElement('style'); s.textContent = fs.readFileSync(f, 'utf8'); doc.head.appendChild(s); }
const index = buildRuleIndex(doc, { vw: 1100, vh: 700, dark: true, dpr: 1 }, null);
let inv, best = Infinity; for (let k = 0; k < 5; k++) { const t = performance.now(); inv = analyzeIndex(index, null, null); best = Math.min(best, performance.now() - t); }
const canon = (v) => v instanceof Set ? { set: [...v].map(canon).map(x => JSON.stringify(x)).sort() } : v instanceof Map ? { map: [...v].map(([k, x]) => [String(k), canon(x)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) } : Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const json = JSON.stringify(canon(inv)); fs.writeFileSync(outFile, json);
// the saved-analysis path (setAnalysisStore): a second analysis of the same rules must be read from the store and equal the computed one
if (M.setAnalysisStore) {
	const mem = new Map(); let gets = 0, hits = 0; M.setAnalysisStore({ get(k) { gets++; const v = mem.get(k) ?? null; if (v !== null) { hits++; } return v; }, put(k, v) { mem.set(k, v); } });
	const a = analyzeIndex(index, null, null); const t = performance.now(); const b = analyzeIndex(index, null, null); const dt = performance.now() - t; M.setAnalysisStore(null);
	const ja = JSON.stringify(canon(a)), jb = JSON.stringify(canon(b));
	console.log(`store: ${gets} reads, ${hits} hits, ${[...mem.values()][0]?.length ?? 0} bytes saved; restored in ${dt.toFixed(1)} ms; computed ${ja === json ? 'equals' : 'DIFFERS FROM'} the plain analysis; restored ${jb === json ? 'equals' : 'DIFFERS FROM'} it; seen ${b.__seen.size} of ${inv.__seen.size}`);
	if (ja !== json || jb !== json || hits !== 1 || b.__seen.size !== inv.__seen.size || b.entries !== inv.entries) { console.log('FAIL'); process.exitCode = 1; } else { console.log('PASS'); }
}
console.log(`${index.count ?? '?'} entries; analysis ${best.toFixed(1)} ms (best of 5); ${json.length} bytes of JSON`);
