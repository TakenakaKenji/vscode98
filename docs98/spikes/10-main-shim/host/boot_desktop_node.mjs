// Discovery harness (Node): runs VS Code's real electron-main bundle in a child process on top of electron_stub.mjs and renders its BrowserWindow in the spike 6 DOM engine.
// Usage: node boot_desktop_node.mjs <appRoot> [--seconds 60] [--ppm out.ppm] [--workspace <folder>] [--user-data-dir d] [--extensions-dir d]
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createRequire, register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { installEnvironment } from '../../06-rendering/host/dom/env.js';
import { parseFragment, missing } from '../../06-rendering/host/dom/dom.js';
import { unsupported } from '../../06-rendering/host/dom/layout.js';
import { paintDocument, toPPM, unpainted } from '../../06-rendering/host/dom/paint.js';
import { installWebShims, resolveUrl, absolutizeCssUrls } from '../../08-workbench-boot/host/web_shims.js';
import { summarizeRun, runScenario } from '../../08-workbench-boot/host/boot_common.js';
import { installPreload } from './preload98.js';
import { PortTable } from './ports98.js';
import { encode, decode } from './codec98.js';

register('./loader_hooks.mjs', import.meta.url);   // renderer side: vscode-file:// URLs
const args = process.argv.slice(2); const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const appRoot = path.resolve(args[0]); const seconds = Number(opt('seconds', 60)); const W = 1280, H = 800;
const userDataDir = path.resolve(opt('user-data-dir', '/tmp/claude-0/ud98')), extDir = path.resolve(opt('extensions-dir', '/tmp/claude-0/ext98'));
const require = createRequire(import.meta.url); const opentype = require('/home/user/vscode98/node_modules/opentype.js/dist/opentype.js');
const nodeProcess = process; const t00 = performance.now(); const mainLog = [];
const fileOf = (u) => u.replace(/^vscode-file:\/\/vscode-app/, '').replace(/[?#].*$/, '');
const readBytes = (f) => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
globalThis.__readFileBytes = (p) => readBytes(p);

// ---- main process
const mainArgs = ['--user-data-dir', userDataDir, '--extensions-dir', extDir, '--disable-gpu', '--disable-telemetry', ...(opt('workspace') ? [path.resolve(opt('workspace'))] : [])];
const child = fork(path.join(path.dirname(new URL(import.meta.url).pathname), 'run_main.mjs'), [appRoot, ...mainArgs], { serialization: 'json', stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, APP98_ROOT: appRoot, ELECTRON_STUB_LOG: opt('stub-log', '/tmp/claude-0/stub.log') } });
child.stdout.on('data', (d) => mainLog.push(String(d))); child.stderr.on('data', (d) => mainLog.push(String(d)));
child.on('exit', (c) => { mainLog.push(`[main exited ${c}]`); });

// ---- ipcRenderer transport
const listeners = new Map(); const pending = new Map(); let nextInvoke = 1; let wcId = 0;
const ipc = {
	send: (channel, ...args) => child.send(encode({ t: 'send', wc: wcId, channel, args })),
	invoke: (channel, ...args) => new Promise((res, rej) => { const id = nextInvoke++; pending.set(id, { res, rej }); child.send(encode({ t: 'invoke', id, wc: wcId, channel, args })); }),
	on: (ch, fn) => { let l = listeners.get(ch); if (!l) { l = []; listeners.set(ch, l); } l.push(fn); },
	once: (ch, fn) => { const w = (...a) => { ipc.off(ch, w); fn(...a); }; ipc.on(ch, w); },
	off: (ch, fn) => { const l = listeners.get(ch); if (l) { const i = l.indexOf(fn); if (i >= 0) { l.splice(i, 1); } } },
};
const ports = new PortTable((m) => child.send(encode({ ...m, wc: wcId })));
let onWindowLoad; const loadRequested = new Promise((r) => { onWindowLoad = r; }); let createOpts;
child.on('message', (m0) => {
	const m = decode(m0);
	if (m.t === 'createWindow') { createOpts = m; wcId = m.wc; }
	else if (m.t === 'loadURL') { onWindowLoad(m); }
	else if (m.t === 'send') { for (const fn of [...(listeners.get(m.channel) || [])]) { fn({ sender: null, ports: [] }, ...m.args); } }
	else if (m.t === 'postMessage') { for (const fn of [...(listeners.get(m.channel) || [])]) { fn({ sender: null, ports: m.ports.map(id => ports.make(id)) }, m.message); } }
	else if (m.t === 'portMsg') { ports.deliver(m); }
	else if (m.t === 'portClose') { const p = ports.ports.get(m.id); if (p) { p._closed = true; p.dispatchEvent({ type: 'close' }); } }
	else if (m.t === 'invokeResult') { const p = pending.get(m.id); pending.delete(m.id); if (m.error !== undefined) { p.rej(new Error(m.error)); } else { p.res(m.result); } }
});

const load = await loadRequested;
console.log('[harness] main created a window and asked to load', load.url, 'after', Math.round(performance.now() - t00), 'ms');
const pageFile = fileOf(load.url); const pageDir = path.dirname(pageFile);
const BASE = 'vscode-file://vscode-app' + appRoot;
const env = installEnvironment({ width: W, height: H, opentype, readUrl: (u) => readBytes(fileOf(u)) }); const doc = env.document;
installWebShims(env, { baseUrl: BASE, readFile: (p) => readBytes(path.join(appRoot, 'out', p)) });
Object.assign(env.window.location, { href: load.url });
// page: head/body of the product's workbench.html, stylesheets inlined with absolute url()s, module scripts started by us
const html = fs.readFileSync(pageFile, 'utf8').replace(/<!doctype[^>]*>/i, '').replace(/<!--[\s\S]*?-->/g, '');
const headM = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html), bodyM = /<body([^>]*)>([\s\S]*?)<\/body>/i.exec(html);
const mount = (el, markup) => { const f = parseFragment(doc, markup, el); for (const c of [...f.__children]) { el.appendChild(c); } };
mount(doc.head, headM[1].replace(/<script[\s\S]*?<\/script>/g, '')); mount(doc.body, bodyM[2].replace(/<script[\s\S]*?<\/script>/g, ''));
for (const el of doc.head.__children) { if (el.localName === 'link' && el.getAttribute('rel') === 'stylesheet') { const abs = resolveUrl(el.getAttribute('href'), load.url); el.__linkText = absolutizeCssUrls(fs.readFileSync(fileOf(abs), 'utf8'), abs); } }
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*type="module"[^>]*>|<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*>/g)].map(m => resolveUrl(m[1] || m[2], load.url));

const additionalArguments = (createOpts?.options?.webPreferences?.additionalArguments) || [];
const procLike = { platform: 'linux', arch: 'x64', env: { ...process.env }, versions: { electron: '39.0.0', chrome: '140.0.0.0', node: '22.0.0' }, execPath: nodeProcess.execPath };
installPreload(env.window, ipc, { argv: additionalArguments, process: procLike });
env.window.vscode_stub_note = 'preload installed';

const errors = []; const note = (k, e) => { errors.push([k, (e && (e.stack || e.message)) || String(e)]); };
nodeProcess.on('unhandledRejection', (e) => note('unhandledRejection', e)); nodeProcess.on('uncaughtException', (e) => note('uncaughtException', e));
env.window.addEventListener('error', (ev) => note('window.onerror', ev.error || ev.message));
{ const pm = performance.measure.bind(performance); performance.measure = (...a) => { try { return pm(...a); } catch { return undefined; } }; }
env.window.queryLocalFonts = async () => [];
env.window.postMessage = (data, origin, transfer) => { const ev = Object.assign(new env.window.Event('message'), { data, origin: '', source: env.window, ports: transfer || [] }); setTimeout(() => env.window.dispatchEvent(ev), 0); };
Object.defineProperty(globalThis, 'process', { value: undefined, configurable: true, writable: true });
const consoleLog = []; for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace']) { console[k] = (...a) => { consoleLog.push([k, a.map(x => (x && x.stack) || String(x)).join(' ')]); }; }
const tImport = performance.now();
for (const s of scripts) { try { await import(s); } catch (e) { note('import ' + s, e); } }
const tLoaded = performance.now();
doc.__passStats = [];
const ctx = { env, doc, note, rss: () => ({ rss: Math.round(nodeProcess.memoryUsage().rss / 1048576), peak: 0 }), layoutTiming: null, opt, log: (m) => nodeProcess.stdout.write(m + '\n'), W, H };
await runScenario(ctx, { seconds, stableRounds: Number(opt('stable', 25)) });
const done = performance.now();
summarizeRun(ctx, { tImport, tLoaded, done, t00, errors, consoleLog, rssAfterImport: { rss: 0 }, missing, unsupported });
if (opt('scenario')) { const sc = await import(pathToFileURL(path.resolve(opt('scenario'))).href); await sc.run(ctx); }
ctx.log('--- main process output (last 40 lines)\n' + mainLog.join('').split('\n').slice(-40).join('\n'));
if (opt('ppm')) { const r = paintDocument(doc, W, H); fs.writeFileSync(opt('ppm'), toPPM(r.px, r.w, r.h)); ctx.log('painted ' + JSON.stringify(r.stats)); }
child.kill(); nodeProcess.exit(0);
