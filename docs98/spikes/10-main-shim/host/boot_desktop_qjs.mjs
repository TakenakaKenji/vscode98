// QuickJS version of boot_desktop_node.mjs: renderer harness on the spike 6/7 engine (native layout + integer rasterizer), main process = VS Code's own electron-main on QuickJS too.
//   qjs-spike7 --stack-size 0 <spike5>/fork_main.mjs <shimsDir> boot_desktop_qjs.mjs <appRoot> [--seconds 60] [--stable 25] [--layout native] [--backend native] [--ppm out.ppm]
//                                                    [--workspace dir] [--user-data-dir d] [--extensions-dir d] [--scenario file.mjs] [--main-runtime qjs|node]
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import Module from 'node:module';
import cp from 'node:child_process';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import '../../06-rendering/host/dom/intl_shim.js';
import * as opentype from '/home/user/vscode98/node_modules/opentype.js/dist/opentype.mjs';
import { installEnvironment } from '../../06-rendering/host/dom/env.js';
import { parseFragment, missing } from '../../06-rendering/host/dom/dom.js';
import { unsupported } from '../../06-rendering/host/dom/layout.js';
import { paintDocument, toPPM, unpainted } from '../../06-rendering/host/dom/paint.js';
import { installWebShims, resolveUrl, absolutizeCssUrls } from '../../08-workbench-boot/host/web_shims.js';
import { summarizeRun, runScenario } from '../../08-workbench-boot/host/boot_common.js';
import './error_stack98.js';
import { installPreload } from './preload98.js';
import { PortTable } from './ports98.js';
import { encode, decode } from './codec98.js';

const nodeProcess = globalThis.process;
const args = nodeProcess.argv.slice(2); const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const appRoot = nodePath.resolve(args[0]); const seconds = Number(opt('seconds', 60)); const W = 1280, H = 800;
const userDataDir = nodePath.resolve(opt('user-data-dir', nodePath.join(globalThis.__builtins.os.tmpdir(), 'ud98'))), extDir = nodePath.resolve(opt('extensions-dir', nodePath.join(globalThis.__builtins.os.tmpdir(), 'ext98')));
const here = nodePath.dirname(fileURLToPath(import.meta.url));
const fileOf = (u) => fileURLToPath('file://' + u.replace(/^vscode-file:\/\/vscode-app/, '').replace(/[?#].*$/, ''));   // vscode-file://vscode-app/<file URL path>, also /C:/dir on Windows
const readBytes = (f) => { const h = std.open(f, 'rb'); if (!h) { throw new Error('ENOENT ' + f); } h.seek(0, std.SEEK_END); const n = h.tell(); h.seek(0, std.SEEK_SET); const ab = new ArrayBuffer(n); h.read(ab, 0, n); h.close(); return ab; };
globalThis.__readFileBytes = readBytes;
const rss = () => { const m = /VmRSS:\s+(\d+)/.exec(std.loadFile('/proc/self/status') || ''); const h = /VmHWM:\s+(\d+)/.exec(std.loadFile('/proc/self/status') || ''); return { rss: m ? Math.round(+m[1] / 1024) : 0, peak: h ? Math.round(+h[1] / 1024) : 0 }; };
const log = (m) => { std.out.puts(m + '\n'); std.out.flush(); };
console.error ??= (...a) => { std.err.puts(a.map(String).join(' ') + '\n'); };

async function main() {
const t00 = performance.now(); const mainLog = []; log('[harness] start');
// ---- vscode-file://vscode-app/<abs path> -> file path, for import()
Module.registerHooks({ resolve(specifier, context, nextResolve) { if (specifier.startsWith('vscode-file://vscode-app/')) { return { url: 'file://' + specifier.slice('vscode-file://vscode-app'.length).replace(/[?#].*$/, ''), shortCircuit: true }; } return nextResolve(specifier, context); } });
// ---- user settings for a headless run: no trust prompt (the git extension is limited in untrusted workspaces), no welcome page, no telemetry or update checks
{ const dir = nodePath.join(userDataDir, 'User'); const mk = (d) => { if (os.stat(d)[1] !== 0) { mk(nodePath.dirname(d)); os.mkdir(d, 0o777); } }; mk(dir);
	if (opt('seed-settings', '1') === '1' && !std.loadFile(dir + '/settings.json')) { const f = std.open(dir + '/settings.json', 'w'); f.puts(JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false }, null, 2)); f.close(); } }
// ---- main process
const mainArgs = ['--user-data-dir', userDataDir, '--extensions-dir', extDir, '--disable-gpu', '--disable-telemetry', ...(opt('workspace') ? [opt('workspace')] : [])];
const child = cp.fork(nodePath.join(here, 'run_main.mjs'), [appRoot, ...mainArgs], { serialization: 'json', stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...nodeProcess.env, APP98_ROOT: appRoot, ELECTRON_STUB_LOG: opt('stub-log', nodePath.join(globalThis.__builtins.os.tmpdir(), 'electron-stub.log')) } });
log('[harness] forked main pid ' + child.pid); const echo = opt('echo-main', '0') === '1'; child.stdout.on('data', (d) => { mainLog.push(String(d)); if (echo) { std.err.puts('[main] ' + String(d)); } }); child.stderr.on('data', (d) => { mainLog.push(String(d)); if (echo) { std.err.puts('[main!] ' + String(d)); } });
child.on('exit', (c) => { mainLog.push(`[main exited ${c}]`); });
// ---- ipcRenderer transport
const listeners = new Map(), pending = new Map(); let nextInvoke = 1, wcId = 0;
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
	else if (m.t === 'invokeResult') { const p = pending.get(m.id); pending.delete(m.id); if (opt('debug-config', '0') === '1' && m.result && m.result.windowId) { log('[harness] window config: workspace=' + JSON.stringify(m.result.workspace) + ' filesToOpen=' + JSON.stringify(m.result.filesToOpenOrCreate) + ' _=' + JSON.stringify(m.result._) + ' userDataDir=' + m.result.userDataDir); } if (m.error !== undefined) { p.rej(new Error(m.error)); } else { p.res(m.result); } }
});
const load = await loadRequested;
log(`[harness] main created a window and asked to load ${load.url} after ${Math.round(performance.now() - t00)} ms`);
const pageFile = fileOf(load.url);
const BASE = 'vscode-file://vscode-app' + pathToFileURL(appRoot).pathname;
const env = installEnvironment({ width: W, height: H, opentype, readUrl: (u) => readBytes(fileOf(u)) }); const doc = env.document;
let layoutTiming = null; if (opt('layout', 'js') === 'native') { const m = await import('../../07-native-render/host/native_layout.js'); env.layoutEngine = m.engine; layoutTiming = m.timing; }
installWebShims(env, { baseUrl: BASE, readFile: (p) => readBytes(nodePath.join(appRoot, 'out', p)) });
Object.assign(env.window.location, { href: load.url });
const html = std.loadFile(pageFile).replace(/<!doctype[^>]*>/i, '').replace(/<!--[\s\S]*?-->/g, '');
const headM = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html), bodyM = /<body([^>]*)>([\s\S]*?)<\/body>/i.exec(html);
const mount = (el, markup) => { const f = parseFragment(doc, markup, el); for (const c of [...f.__children]) { el.appendChild(c); } };
mount(doc.head, headM[1].replace(/<script[\s\S]*?<\/script>/g, '')); mount(doc.body, bodyM[2].replace(/<script[\s\S]*?<\/script>/g, ''));
for (const el of doc.head.__children) { if (el.localName === 'link' && el.getAttribute('rel') === 'stylesheet') { const abs = resolveUrl(el.getAttribute('href'), load.url); el.__linkText = absolutizeCssUrls(std.loadFile(fileOf(abs)), abs); } }
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*type="module"[^>]*>|<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*>/g)].map(m => resolveUrl(m[1] || m[2], load.url));
const procLike = { platform: 'linux', arch: 'x64', env: { ...nodeProcess.env }, versions: { electron: '39.0.0', chrome: '140.0.0.0', node: '22.0.0' }, execPath: nodeProcess.execPath };
installPreload(env.window, ipc, { argv: createOpts?.options?.webPreferences?.additionalArguments || [], process: procLike });
env.window.queryLocalFonts = async () => [];
env.window.postMessage = (data, origin, transfer) => { const ev = Object.assign(new env.window.Event('message'), { data, origin: '', source: env.window, ports: transfer || [] }); setTimeout(() => env.window.dispatchEvent(ev), 0); };
const errors = []; const note = (k, e) => { errors.push([k, (e && (e.stack || e.message)) || String(e)]); };
env.window.addEventListener('error', (ev) => note('window.onerror', ev.error || ev.message));
globalThis.__rejection = (promise, reason, handled) => { if (handled) { return; } const ev = new globalThis.Event('unhandledrejection', { cancelable: true }); ev.promise = promise; ev.reason = reason; globalThis.dispatchEvent(ev); if (!ev.defaultPrevented) { note('unhandledRejection', reason); } };
const consoleLog = []; for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace']) { console[k] = (...a) => { consoleLog.push([k, a.map(x => (x && x.stack) || String(x)).join(' ')]); }; }
doc.__passStats = []; if (opt('verify', '0') === '1') { doc.__verifyStyles = true; }
const tImport = performance.now();
for (const s of scripts) { try { await import(s); } catch (e) { note('import ' + s, e); } }
const tLoaded = performance.now(); const rssAfterImport = rss();
const ctx = { env, doc, note, rss, layoutTiming, opt, log, W, H, consoleLog };
await runScenario(ctx, { seconds, stableRounds: Number(opt('stable', 25)) });
const done = performance.now();
summarizeRun(ctx, { tImport, tLoaded, done, t00, errors, consoleLog, rssAfterImport, missing, unsupported });
if (opt('scenario')) { const sc = await import(opt('scenario')); await sc.run(ctx); }
log('--- main process output (last 40 lines)\n' + mainLog.join('').split('\n').slice(-40).join('\n'));
if (opt('ppm')) { let backend; if (opt('backend', 'js').startsWith('native')) { const { NativeBackend } = await import('../../07-native-render/host/native_backend.js'); backend = new NativeBackend(W, H, { exact: opt('backend') === 'native-exact' }); } const r = paintDocument(doc, W, H, backend); const u8 = toPPM(r.px, r.w, r.h); const f = std.open(opt('ppm'), 'wb'); f.write(u8.buffer, u8.byteOffset, u8.byteLength); f.close(); log('painted ' + JSON.stringify(r.stats)); }
child.kill(); std.exit(0);
}
main().catch(e => { std.err.puts('FATAL ' + (e && e.message) + '\n' + (e && e.stack || e) + '\n'); std.exit(1); });
