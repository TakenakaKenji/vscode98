// QuickJS-ng harness, same job as run_node.mjs: qjs --stack-size 0 run_qjs.mjs <monacoDir> <page.html> [--dump out.json] [--ppm out.ppm]
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import '../../02-node-shim/host/globals.js';
import * as opentype from '/home/user/vscode98/node_modules/opentype.js/dist/opentype.mjs';
import './dom/intl_shim.js';
import { installEnvironment } from './dom/env.js';
import { loadPage } from './dom/page_loader.js';
import { missing } from './dom/dom.js';
import { unsupported } from './dom/layout.js';
import { paintDocument, toPPM, unpainted } from './dom/paint.js';

console.error ??= (...a) => { std.err.puts(a.map(String).join(' ') + '\n'); std.err.flush(); };
const _st = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...a) => _st(typeof fn === 'function' ? (...x) => { try { return fn(...x); } catch (e) { std.err.puts('[timer error] ' + (e && e.stack || e) + '\\n'); std.err.flush(); } } : fn, ms, ...a);
const args = scriptArgs.slice(1); const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const [monacoDir, pageFile] = args;
const writeBytes = (path, u8) => { const f = std.open(path, 'wb'); f.write(u8.buffer, u8.byteOffset, u8.byteLength); f.close(); };
globalThis.__readFileBytes = (p) => { const f = std.open(p, 'rb'); f.seek(0, std.SEEK_END); const n = f.tell(); f.seek(0, std.SEEK_SET); const ab = new ArrayBuffer(n); f.read(ab, 0, n); f.close(); return ab; };
const log = (m) => { std.out.puts(m + '\n'); std.out.flush(); };
async function main() {
	const t0 = performance.now(); const env = installEnvironment({ width: 800, height: 520, opentype }); const doc = env.document; let error = null;
	const indirectEval = (0, eval); const container0 = () => doc.getElementById('container');
	try { loadPage(doc, std.loadFile(pageFile), monacoDir, { readText: (p) => std.loadFile(p), evalScript: (t, n) => indirectEval(t), join: (a, b) => a + '/' + b }); }
	catch (e) { error = e; }
	let stable = 0, last = -1; for (let i = 0; i < 400 && !error && stable < 8; i++) { await new Promise(r => setTimeout(r, 15)); try { env.flushFrames(); } catch (e) { error = e; } const n = container0().getElementsByTagName('*').length; if (n === last && !env.pendingFrames()) { stable++; } else { stable = 0; } last = n; if (std.getenv('TICKS')) { log(`tick ${i} elements ${n} t=${Math.round(performance.now() - t0)}ms`); } }
	if (error) { log('LOAD FAILED: ' + (error.message || error) + '\n' + (error.stack || '')); }
	const ms = Math.round(performance.now() - t0); const container = doc.getElementById('container');
	log(`loaded in ${ms} ms; layouts ${doc.__layoutCount} (${Math.round(doc.__layoutMs)} ms); container descendants: ${container ? container.getElementsByTagName('*').length : 'n/a'}`);
	log('missing: ' + JSON.stringify([...missing].sort((a, b) => b[1] - a[1]).slice(0, 40))); log('unsupported: ' + JSON.stringify([...unsupported]));
	const ppm = opt('ppm', null); if (ppm) { const t = performance.now(); const r = paintDocument(doc, 800, 520); writeBytes(ppm, toPPM(r.px, r.w, r.h)); log(`painted in ${Math.round(performance.now() - t)} ms ${JSON.stringify(r.stats)} unpainted: ${JSON.stringify([...unpainted])}`); }
	const dump = opt('dump', null);
	if (dump && container) {
		const rows = []; const walk = (el, depth, p) => { const r = el.getBoundingClientRect(); rows.push({ path: p, tag: el.localName, cls: el.getAttribute('class') || '', id: el.id, x: r.x, y: r.y, w: r.width, h: r.height, depth, text: el.children.length === 0 ? el.textContent.slice(0, 80) : undefined, inlineStyle: el.getAttribute('style') || '', offsetW: el.offsetWidth, offsetH: el.offsetHeight, scrollW: el.scrollWidth, scrollH: el.scrollHeight }); let i = 0; for (const c of el.children) { walk(c, depth + 1, p + '/' + c.localName + '[' + (i++) + ']'); } };
		walk(container, 0, 'container'); const f = std.open(dump, 'w'); f.puts(JSON.stringify({ elements: rows, html: container.outerHTML })); f.close();
	}
	std.exit(0);
}
main().catch(e => { log('FATAL ' + (e && e.stack || e)); std.exit(1); });
