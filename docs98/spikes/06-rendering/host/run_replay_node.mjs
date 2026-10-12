// node run_replay_node.mjs <captured.json> --dump out.json --ppm out.ppm  : static layout + paint replay of a captured page
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { installEnvironment } from './dom/env.js';
import { replayPage, applyScrolls, dumpRows } from './dom/replay_core.js';
import { missing } from './dom/dom.js';
import { unsupported } from './dom/layout.js';
import { paintDocument, toPPM, unpainted } from './dom/paint.js';
const require = createRequire(import.meta.url); const opentype = require('/home/user/vscode98/node_modules/opentype.js/dist/opentype.js');
const args = process.argv.slice(2); const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const data = JSON.parse(fs.readFileSync(args[0], 'utf8'));
globalThis.__readFileBytes = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const env = installEnvironment({ width: data.w, height: data.h, opentype, scrollbarSize: Number(opt('scrollbar', 0)) });
const t0 = performance.now(); const doc = replayPage(env, data); const t1 = performance.now(); applyScrolls(doc, data.elements); doc.__ensureLayout(); const t2 = performance.now();
const out = (m) => process.stdout.write(m + '\n');
out(`style ${Math.round(doc.__layout.styleMs)} ms, layout ${Math.round(doc.__layout.layoutMs ?? 0)} ms`);
out(`replay: ${doc.documentElement.getElementsByTagName('*').length} elements; build ${Math.round(t1 - t0)} ms (parse ${data.sheets.length} sheets), style+layout ${Math.round(t2 - t1)} ms (styled ${doc.__styleCount})`);
out('missing: ' + JSON.stringify([...missing].sort((a, b) => b[1] - a[1]).slice(0, 30))); out('unsupported: ' + JSON.stringify([...unsupported]));
if (opt('ppm')) { const t = performance.now(); const r = paintDocument(doc, data.w, data.h); fs.writeFileSync(opt('ppm'), toPPM(r.px, r.w, r.h)); out(`painted in ${Math.round(performance.now() - t)} ms ${JSON.stringify(r.stats)} unpainted: ${JSON.stringify([...unpainted])}`); }
if (opt('dump')) { fs.writeFileSync(opt('dump'), JSON.stringify({ elements: dumpRows(doc.documentElement, 'html') })); }
process.exit(0);
