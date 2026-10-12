// qjs --stack-size 0 run_replay_qjs.mjs <captured.json> --dump out.json --ppm out.ppm : same as run_replay_node.mjs on QuickJS-ng
import * as std from 'qjs:std';
import '../../02-node-shim/host/globals.js';
import './dom/intl_shim.js';
import * as opentype from '/home/user/vscode98/node_modules/opentype.js/dist/opentype.mjs';
import { installEnvironment } from './dom/env.js';
import { replayPage, applyScrolls, dumpRows } from './dom/replay_core.js';
import { missing } from './dom/dom.js';
import { unsupported } from './dom/layout.js';
import { paintDocument, toPPM, unpainted } from './dom/paint.js';
console.error ??= (...a) => { std.err.puts(a.map(String).join(' ') + '\n'); };
const args = scriptArgs.slice(1); const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const data = JSON.parse(std.loadFile(args[0]));
globalThis.__readFileBytes = (p) => { const f = std.open(p, 'rb'); f.seek(0, std.SEEK_END); const n = f.tell(); f.seek(0, std.SEEK_SET); const ab = new ArrayBuffer(n); f.read(ab, 0, n); f.close(); return ab; };
const log = (m) => { std.out.puts(m + '\n'); std.out.flush(); };
const env = installEnvironment({ width: data.w, height: data.h, opentype });
const t0 = performance.now(); const doc = replayPage(env, data); const t1 = performance.now(); applyScrolls(doc, data.elements); doc.__ensureLayout(); const t2 = performance.now();
log(`replay: ${doc.documentElement.getElementsByTagName('*').length} elements; build ${Math.round(t1 - t0)} ms, style+layout ${Math.round(t2 - t1)} ms (styled ${doc.__styleCount})`);
log('missing: ' + JSON.stringify([...missing].sort((a, b) => b[1] - a[1]).slice(0, 30))); log('unsupported: ' + JSON.stringify([...unsupported]));
if (opt('ppm')) { const t = performance.now(); const r = paintDocument(doc, data.w, data.h); const u8 = toPPM(r.px, r.w, r.h); const f = std.open(opt('ppm'), 'wb'); f.write(u8.buffer, u8.byteOffset, u8.byteLength); f.close(); log(`painted in ${Math.round(performance.now() - t)} ms ${JSON.stringify(r.stats)} unpainted: ${JSON.stringify([...unpainted])}`); }
if (opt('dump')) { const f = std.open(opt('dump'), 'w'); f.puts(JSON.stringify({ elements: dumpRows(doc.documentElement, 'html') })); f.close(); }
std.exit(0);
