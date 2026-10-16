// QuickJS-ng version of boot_node.mjs: boots the real web workbench on the spike 6/7 DOM + style + layout engine.
// qjs-spike7 --stack-size 0 boot_qjs.mjs <outWebDir> [--ppm out.ppm] [--seconds 60] [--layout native] [--backend native] [--scenario file.mjs]
import * as std from 'qjs:std';
import '../../02-node-shim/host/globals.js';
import '../../06-rendering/host/dom/intl_shim.js';
import * as opentype from '../../../../node_modules/opentype.js/dist/opentype.mjs';
import { installEnvironment } from '../../06-rendering/host/dom/env.js';
import { parseFragment, missing } from '../../06-rendering/host/dom/dom.js';
import { unsupported } from '../../06-rendering/host/dom/layout.js';
import { paintDocument, toPPM, unpainted } from '../../06-rendering/host/dom/paint.js';
import { installWebShims, preparePage } from './web_shims.js';
import { summarizeRun, runScenario } from './boot_common.js';

console.error ??= (...a) => { std.err.puts(a.map(String).join(' ') + '\n'); };
const args = scriptArgs.slice(1); const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const webDir = args[0]; const seconds = Number(opt('seconds', 60)); const W = 1280, H = 800; const BASE = 'http://localhost:8080';
const readBytes = (p) => { const f = std.open(p, 'rb'); f.seek(0, std.SEEK_END); const n = f.tell(); f.seek(0, std.SEEK_SET); const ab = new ArrayBuffer(n); f.read(ab, 0, n); f.close(); return ab; };
globalThis.__readFileBytes = readBytes;
const readUrl = (u) => readBytes(webDir + '/' + u.replace(/^https?:\/\/[^/]+\/out\//, '').replace(/[?#].*$/, ''));
const rss = () => { const m = /VmRSS:\s+(\d+)/.exec(std.loadFile('/proc/self/status') || ''); const h = /VmHWM:\s+(\d+)/.exec(std.loadFile('/proc/self/status') || ''); return { rss: m ? Math.round(+m[1] / 1024) : 0, peak: h ? Math.round(+h[1] / 1024) : 0 }; };
async function main() {
const t00 = performance.now();
const env = installEnvironment({ width: W, height: H, opentype, readUrl }); const doc = env.document;
let layoutTiming = null; if (opt('layout', 'js') === 'native') { const m = await import('../../07-native-render/host/native_layout.js'); env.layoutEngine = m.engine; layoutTiming = m.timing; }
// selector matching in C by default (07-native-render/host/native_style.js, module spike:style); --style js: the JavaScript matcher; --style match: native matching, computed values in JavaScript; --style verify: both, differences logged
let styleNative = null; if (opt('style', 'native') !== 'js') { try { styleNative = await import('../../07-native-render/host/native_style.js'); env.styleEngine = styleNative.engine; styleNative.engine.verify = opt('style', 'native') === 'verify'; if (opt('style', 'native') === 'match') { styleNative.engine.compute = null; } } catch (e) { styleNative = null; ((m) => { std.out.puts(m + '\n'); std.out.flush(); })('[harness] no native style engine (' + (e && e.message || e) + '): JavaScript matching'); } }
installWebShims(env, { baseUrl: BASE, readFile: (p) => readBytes(webDir + '/' + p) });
preparePage(doc, parseFragment, { html: std.loadFile(webDir + '/vs/code/browser/workbench/workbench.html'), base: BASE, readText: (p) => std.loadFile(p), webDir });
globalThis._VSCODE_FILE_ROOT = BASE + '/out/';
const errors = []; const note = (k, e) => { errors.push([k, (e && (e.stack || e.message)) || String(e)]); };
globalThis.addEventListener('error', (ev) => note('window.onerror', ev.error || ev.message));
const consoleLog = []; for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace']) { console[k] = (...a) => { consoleLog.push([k, a.map(x => (x && x.stack) || String(x)).join(' ')]); }; }
globalThis.__rejection = (promise, reason, handled) => { if (handled) { return; } const ev = new globalThis.Event('unhandledrejection', { cancelable: true }); ev.promise = promise; ev.reason = reason; globalThis.dispatchEvent(ev); if (!ev.defaultPrevented) { note('unhandledRejection', reason); } };
doc.__passStats = []; if (opt('verify', '0') === '1') { doc.__verifyStyles = true; } if (opt('incremental', '1') === '0') { doc.__incremental = false; }
const tImport = performance.now(); std.out.puts('importing the workbench...\n'); std.out.flush();
try { await import(webDir + '/vs/code/browser/workbench/workbench.js'); } catch (e) { note('import', e); }
const tLoaded = performance.now(); std.out.puts(`imported after ${Math.round(tLoaded - tImport)} ms\n`); std.out.flush(); const rssAfterImport = rss();
const ctx = { env, doc, note, rss, layoutTiming, styleNative, opt, log: (m) => { std.out.puts(m + '\n'); std.out.flush(); }, W, H };
globalThis.__scenarioDetail = opt('detail', '0') !== '0';   // --detail 1: per-pass lines in scenarios; --detail 2: also the large level-3 marks of the style planner and why (see style_invalidation.js)
if (opt('detail', '0') === '2') { const d = (el) => el.localName + (el.id ? '#' + el.id : '') + '.' + String(el.getAttribute('class') || '').split(' ').slice(0, 3).join('.'); globalThis.__styleDebug = (plan) => { const big = [...plan.marks].filter(([el, l]) => l === 3 && el.getElementsByTagName('*').length > 100).map(([el]) => [el.getElementsByTagName('*').length, d(el), plan.why.get(el)]); if (big.length) { ctx.log('BIGMARK ' + JSON.stringify(big)); } }; }
await runScenario(ctx, { seconds, label: 'boot' });
const done = performance.now();
summarizeRun(ctx, { tImport, tLoaded, done, t00, errors, consoleLog, rssAfterImport, missing, unsupported });
if (opt('scenario')) { const sc = await import(args[args.indexOf('--scenario') + 1]); await sc.run(ctx); }
if (opt('ppm')) { const t = performance.now(); let backend; if (opt('backend', 'js').startsWith('native')) { const { NativeBackend } = await import('../../07-native-render/host/native_backend.js'); backend = new NativeBackend(W, H, { exact: opt('backend') === 'native-exact' }); } const r = paintDocument(doc, W, H, backend); const pt = performance.now() - t; const u8 = toPPM(r.px, r.w, r.h); const f = std.open(opt('ppm'), 'wb'); f.write(u8.buffer, u8.byteOffset, u8.byteLength); f.close(); ctx.log(`painted in ${pt.toFixed(0)} ms ${JSON.stringify(r.stats)} unpainted: ${JSON.stringify([...unpainted])}`); }
std.exit(0);
}
main().catch(e => { std.err.puts('FATAL ' + (e && e.message) + '\n' + (e && e.stack || e) + '\n'); std.exit(1); });
