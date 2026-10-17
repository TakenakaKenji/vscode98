// Oracle for changes to analyzeIndex (06-rendering/host/dom/style_invalidation.js): builds the rule index of the given stylesheets (the workbench's CSS) and
// writes the analysis as canonical JSON (Sets and Maps as sorted arrays, shapes as trees), with the time of the analysis (best of 5). Run it with the old and the new
// module and compare the two files. Usage: node analyze_oracle.mjs <style_invalidation.js to use> <out.json> <css file>...
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { installEnvironment } from '../../06-rendering/host/dom/env.js';
import { buildRuleIndex } from '../../06-rendering/host/dom/css.js';
const [mod, outFile, ...css] = process.argv.slice(2);
const { analyzeIndex } = await import(path.resolve(mod));
const require = createRequire(import.meta.url); const opentype = require('/home/user/vscode98/node_modules/opentype.js/dist/opentype.js');
globalThis.__readFileBytes = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const env = installEnvironment({ width: 1100, height: 700, opentype }); const doc = env.document;
for (const f of css) { const s = doc.createElement('style'); s.textContent = fs.readFileSync(f, 'utf8'); doc.head.appendChild(s); }
const index = buildRuleIndex(doc, { vw: 1100, vh: 700, dark: true, dpr: 1 }, null);
let inv, best = Infinity; for (let k = 0; k < 5; k++) { const t = performance.now(); inv = analyzeIndex(index, null, null); best = Math.min(best, performance.now() - t); }
const canon = (v) => v instanceof Set ? { set: [...v].map(canon).map(x => JSON.stringify(x)).sort() } : v instanceof Map ? { map: [...v].map(([k, x]) => [String(k), canon(x)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) } : Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const json = JSON.stringify(canon(inv)); fs.writeFileSync(outFile, json);
console.log(`${index.count ?? '?'} entries; analysis ${best.toFixed(1)} ms (best of 5); ${json.length} bytes of JSON`);
