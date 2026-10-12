// Shared Node bootstrap for the dev harnesses: environment + page load. Returns { env, doc, ms, nodeProcess }.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { installEnvironment } from './dom/env.js';
import { loadPage } from './dom/page_loader.js';
const require = createRequire(import.meta.url);
export async function boot(monacoDir, pageFile = path.join(import.meta.dirname, '../tests/pages/basic.html'), width = 800, height = 520) {
	const opentype = require('/home/user/vscode98/node_modules/opentype.js/dist/opentype.js');
	globalThis.__readFileBytes = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
	const nodeProcess = globalThis.process;
	const env = installEnvironment({ width, height, opentype });
	Object.defineProperty(globalThis, 'process', { value: undefined, configurable: true, writable: true });   // the page must not think it runs in Node
	const t0 = performance.now(); let error = null;
	try { loadPage(env.document, fs.readFileSync(pageFile, 'utf8'), monacoDir, { readText: (p) => fs.readFileSync(p, 'utf8'), evalScript: (t, n) => vm.runInThisContext(t, { filename: n }), join: path.join }); } catch (e) { error = e; }
	// let timers / animation frames run (Monaco renders lines on the next animation frame)
	for (let i = 0; i < 20 && !error; i++) { await new Promise(r => setTimeout(r, 15)); try { env.flushFrames(); } catch (e) { error = e; } }
	return { env, doc: env.document, ms: Math.round(performance.now() - t0), nodeProcess, error };
}
