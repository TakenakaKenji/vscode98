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
let layoutTiming = null; if (opt('layout', 'js') === 'native') { const m = await import('../../07-native-render/host/native_layout.js'); env.layoutEngine = m.engine; layoutTiming = m.timing; }
let styleNative = null; if (opt('style', 'js') !== 'js') { styleNative = await import('../../07-native-render/host/native_style.js'); env.styleEngine = styleNative.engine; styleNative.engine.verify = opt('style', 'js') === 'verify'; }   // --style native|verify: selector matching in C
const t0 = performance.now(); const doc = replayPage(env, data); const t1 = performance.now(); applyScrolls(doc, data.elements); doc.__ensureLayout(); const t2 = performance.now();
log(`style ${Math.round(doc.__layout.styleMs)} ms, layout ${Math.round(doc.__layout.layoutMs ?? 0)} ms${layoutTiming ? ` (native engine: pack ${layoutTiming.pack.toFixed(0)} + C ${layoutTiming.native.toFixed(0)} + apply ${layoutTiming.apply.toFixed(0)} ms)` : ''}`);
log(`replay: ${doc.documentElement.getElementsByTagName('*').length} elements; build ${Math.round(t1 - t0)} ms, style+layout ${Math.round(t2 - t1)} ms (styled ${doc.__styleCount})`);
log('missing: ' + JSON.stringify([...missing].sort((a, b) => b[1] - a[1]).slice(0, 30))); log('unsupported: ' + JSON.stringify([...unsupported]));
globalThis.__rasterProfile = opt('profile', '0') === '1';
const reps = Number(opt('repeat', 0)); for (let i = 0; i < reps; i++) { const nk = layoutTiming ? layoutTiming.perRun.length : 0; doc.__dirty = true; doc.__ensureLayout(); const L = doc.__layout; log(`re-layout #${i + 1} (warm): style ${L.styleMs.toFixed(0)} ms, layout ${L.layoutMs.toFixed(1)} ms${layoutTiming ? ` [pack ${layoutTiming.perRun[nk][0]} + C ${layoutTiming.perRun[nk][1]} + apply ${layoutTiming.perRun[nk][2]} ms]` : ''}`); }
for (let i = 0, n = Number(opt('restyle', 0)); i < n; i++) { doc.__styleReady = false; doc.__dirty = true; const m0 = styleNative ? styleNative.stats.matchMs : 0; doc.__ensureLayout(); const L = doc.__layout, I = doc.__styleInfo; log(`full restyle #${i + 1}: style ${L.styleMs.toFixed(0)} ms (index ${I.indexMs.toFixed(1)}, ${I.recomputed} elements${styleNative ? `, native matching ${(styleNative.stats.matchMs - m0).toFixed(1)} ms` : ''})`); }   // --restyle N: N forced full style passes (warm caches)
const fontStats = (b) => { const f = globalThis.__nativeFontStats; return f ? Object.fromEntries(Object.entries(f).map(([k, v]) => [k, +v.toFixed(0)])) : null; };
let backend; if (opt('backend', 'js').startsWith('native')) { const { NativeBackend } = await import('../../07-native-render/host/native_backend.js'); backend = new NativeBackend(data.w, data.h, { exact: opt('backend', 'js') === 'native-exact' }); }
if (opt('ppm')) { const t = performance.now(); const r = paintDocument(doc, data.w, data.h, backend); const paintMs = performance.now() - t; const u8 = toPPM(r.px, r.w, r.h); const f = std.open(opt('ppm'), 'wb'); f.write(u8.buffer, u8.byteOffset, u8.byteLength); f.close(); log(`painted in ${Math.round(paintMs)} ms${backend ? ` (record ${Math.round(paintMs - backend.execMs)} ms + native execute ${backend.execMs.toFixed(1)} ms, ${backend.commands} commands)` : ''} ${JSON.stringify(r.stats)} unpainted: ${JSON.stringify([...unpainted])}`); }
for (let i = 0, n = Number(opt('repaint', 0)); i < n; i++) { let be2; if (backend) { const { NativeBackend } = await import('../../07-native-render/host/native_backend.js'); be2 = new NativeBackend(data.w, data.h, { exact: opt('backend', 'js') === 'native-exact' }); } const t = performance.now(); paintDocument(doc, data.w, data.h, be2); if (globalThis.__lastRasterProfile) { log('  profile ' + JSON.stringify(Object.fromEntries(Object.entries(globalThis.__lastRasterProfile).filter(([, v]) => v.n).map(([k, v]) => [k, `${v.ms.toFixed(1)} ms x${v.n}`])))); }
	log(`repaint #${i + 1} (warm): ${(performance.now() - t).toFixed(0)} ms${be2 ? ` (record ${(performance.now() - t - be2.execMs).toFixed(0)} + native execute ${be2.execMs.toFixed(1)})` : ''}`); }
if (styleNative) { log('native style: ' + JSON.stringify(styleNative.stats) + ' mismatches ' + styleNative.mismatches.length + (styleNative.mismatches.length ? '\n  ' + styleNative.mismatches.slice(0, 20).join('\n  ') : '')); }
if (opt('dump')) { const f = std.open(opt('dump'), 'w'); f.puts(JSON.stringify({ elements: dumpRows(doc.documentElement, 'html') })); f.close(); }
std.exit(0);
