// QuickJS version of boot_desktop_node.mjs: renderer harness on the spike 6/7 engine (native layout + integer rasterizer), main process = VS Code's own electron-main on QuickJS too.
//   qjs-spike7 --stack-size 0 <spike5>/fork_main.mjs <shimsDir> boot_desktop_qjs.mjs <appRoot> [--seconds 60] [--stable 25] [--layout native] [--backend native] [--ppm out.ppm]
//                                                    [--workspace dir] [--user-data-dir d] [--extensions-dir d] [--scenario file.mjs] [--main-runtime qjs|node]
import { execCommand } from '../../06-rendering/host/dom/textcontrol.js';
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import Module from 'node:module';
import cp from 'node:child_process';
import nodePath from 'node:path';
import { createHash } from '../../02-node-shim/host/impl/crypto.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import '../../06-rendering/host/dom/intl_shim.js';
import * as opentype from '../../../../node_modules/opentype.js/dist/opentype.mjs';
import { installEnvironment } from '../../06-rendering/host/dom/env.js';
import { parseColor } from '../../06-rendering/host/dom/css.js';
import { parseFragment, missing } from '../../06-rendering/host/dom/dom.js';
import { unsupported } from '../../06-rendering/host/dom/layout.js';
import { setAnalysisStore } from '../../06-rendering/host/dom/style_invalidation.js';
import { paintDocument, toPPM, unpainted } from '../../06-rendering/host/dom/paint.js';
import { NativeBackend } from '../../07-native-render/host/native_backend.js';
import * as spikeProc from 'spike:proc';
globalThis.__spikeProc = spikeProc;
import { installWebShims, resolveUrl, absolutizeCssUrls } from '../../08-workbench-boot/host/web_shims.js';
import { summarizeRun, runScenario } from '../../08-workbench-boot/host/boot_common.js';
import './error_stack98.js';
import { installPreload } from './preload98.js';
import { ONIG_SHIM_SOURCE } from './onig_shim98.js';
import { PortTable } from './ports98.js';
import { encode, decode } from './codec98.js';
import { startTimeline, timelineMark, timelineReport } from './timeline_report98.js';
import { useProfileReport } from './use_profile98.js';

const nodeProcess = globalThis.process;
const args = nodeProcess.argv.slice(2); const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const appRoot = nodePath.resolve(args[0]); const seconds = Number(opt('seconds', 60)); const W = Number(opt('width', 1280)), H = Number(opt('height', 800));
const userDataDir = nodePath.resolve(opt('user-data-dir', nodePath.join(globalThis.__builtins.os.tmpdir(), 'ud98'))), extDir = nodePath.resolve(opt('extensions-dir', nodePath.join(globalThis.__builtins.os.tmpdir(), 'ext98')));
const here = nodePath.dirname(fileURLToPath(import.meta.url));
const fileOf = (u) => fileURLToPath('file://' + u.replace(/^vscode-file:\/\/vscode-app/, '').replace(/[?#].*$/, ''));   // vscode-file://vscode-app/<file URL path>, also /C:/dir on Windows
const readBytes = (f) => { const h = std.open(f, 'rb'); if (!h) { throw new Error('ENOENT ' + f); } h.seek(0, std.SEEK_END); const n = h.tell(); h.seek(0, std.SEEK_SET); const ab = new ArrayBuffer(n); h.read(ab, 0, n); h.close(); return ab; };
globalThis.__readFileBytes = readBytes;
// Web Crypto digest (webviews derive the origin of their iframe from a SHA-256)
globalThis.crypto.subtle = { digest: async (alg, data) => { const name = String(alg && alg.name || alg).toLowerCase().replace('-', ''); const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data); const out = createHash(name).update(bytes).digest(); const u = new Uint8Array(out.length); u.set(out); return u.buffer; } };
const rss = () => { const m = /VmRSS:\s+(\d+)/.exec(std.loadFile('/proc/self/status') || ''); const h = /VmHWM:\s+(\d+)/.exec(std.loadFile('/proc/self/status') || ''); return { rss: m ? Math.round(+m[1] / 1024) : 0, peak: h ? Math.round(+h[1] / 1024) : 0 }; };
const log = (m) => { std.out.puts(m + '\n'); std.out.flush(); };
globalThis.__log98 = log;   // live logging for probes placed in the workbench bundle (console output is only summarised at the end)
console.error ??= (...a) => { std.err.puts(a.map(String).join(' ') + '\n'); };
for (const m of ['group', 'groupCollapsed', 'groupEnd', 'table', 'time', 'timeEnd', 'timeLog', 'count', 'countReset', 'dir', 'dirxml', 'assert', 'clear', 'profile', 'profileEnd', 'timeStamp']) { console[m] ??= () => { }; }   // the extension host's output is replayed with console.group()

async function main() {
const t00 = performance.now(); const mainLog = []; { const d = new Date(Date.now() - t00), p2 = (n) => String(n).padStart(2, '0'); log(`[harness] start (process started at ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p2(Math.floor(d.getMilliseconds() / 10))})`); }
// --timeline <dir>: every process of the app records its event loop (busy / waiting) and VS Code's startup marks there; the merged table is printed when the workbench is stable
const timelineDir = opt('timeline'); const t00Epoch = Date.now() - t00; let timelinePrinted = false; if (timelineDir) { startTimeline(timelineDir, nodeProcess.env); }   // printed when the workbench is stable, or when the window is closed before that
// --code-cache <dir> (default <user-data-dir>/code-cache; 0 = off): bytecode of the large ES modules (05-child-process/host/esm.c), for this process and every one it starts
const codeCacheDir = opt('code-cache', opt('user-data-dir') ? nodePath.join(opt('user-data-dir'), 'code-cache') : '0');
if (codeCacheDir !== '0' && globalThis.__codeCacheDir) { try { os.mkdir(nodePath.dirname(codeCacheDir)); } catch { /* exists */ } os.mkdir(codeCacheDir); globalThis.__codeCacheDir(codeCacheDir); nodeProcess.env.QJS98_CODE_CACHE = codeCacheDir; }
// --gc-idle 0: the collector as stock QuickJS runs it (inside whatever allocation finds the heap 50 % larger); default: at idle moments (07-native-render/host/gc98.h)
const gcIdle = opt('gc-idle', '1') === '1' && typeof globalThis.__gcIdle === 'function'; if (gcIdle) { globalThis.__gcIdle(true); }
// the style engine's first full analysis of the rules is saved next to the bytecode (style-<key>.json; the key names the rule set): later starts read it
if (codeCacheDir !== '0') { setAnalysisStore({ get: (k) => std.loadFile(`${codeCacheDir}/style-${k}.json`), put: (k, v) => { const f = `${codeCacheDir}/style-${k}.json`, t = f + '.tmp'; const h = std.open(t, 'w'); if (!h) { return; } h.puts(v); h.close(); os.rename(t, f); } }); }
// ---- vscode-file://vscode-app/<abs path> -> file path, for import()
Module.registerHooks({ resolve(specifier, context, nextResolve) { if (specifier.startsWith('vscode-file://vscode-app/')) { return { url: 'file://' + specifier.slice('vscode-file://vscode-app'.length).replace(/[?#].*$/, ''), shortCircuit: true }; } return nextResolve(specifier, context); } });
// ---- user settings for a headless run: no trust prompt (the git extension is limited in untrusted workspaces), no welcome page, no telemetry or update checks
{ const dir = nodePath.join(userDataDir, 'User'); const mk = (d) => { if (os.stat(d)[1] !== 0) { mk(nodePath.dirname(d)); os.mkdir(d, 0o777); } }; mk(dir);
	if (opt('seed-settings', '1') === '1') {   // product defaults: added when missing from settings.json, never overriding what the user set
		const defaults = { 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'chat.disableAIFeatures': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'window.commandCenter': false, 'workbench.layoutControl.enabled': false, 'breadcrumbs.enabled': false, 'editor.minimap.enabled': false, 'workbench.tips.enabled': false, 'workbench.enableExperiments': false, 'update.showReleaseNotes': false, 'window.dialogStyle': 'custom', 'editor.useShadowDOM': false, 'files.simpleDialog.enable': true, 'terminal.integrated.gpuAcceleration': 'off', 'terminal.integrated.defaultProfile.windows': 'Command Prompt', 'terminal.integrated.shellIntegration.enabled': false, ...JSON.parse(opt('seed-extra', '{}')) };
		let cur = {}; const txt = std.loadFile(dir + '/settings.json'); if (txt) { try { cur = JSON.parse(txt); } catch { cur = null; } }
		if (cur) { let changed = !txt; for (const [k, v] of Object.entries(defaults)) { if (!(k in cur)) { cur[k] = v; changed = true; } } if (changed) { const f = std.open(dir + '/settings.json', 'w'); f.puts(JSON.stringify(cur, null, 2)); f.close(); } }
	}
}
// ---- main process
const mainArgs = ['--user-data-dir', userDataDir, '--extensions-dir', extDir, '--disable-gpu', '--disable-telemetry', ...(opt('log-level') ? ['--log', opt('log-level')] : []), ...(opt('workspace') ? [opt('workspace')] : [])];
const child = cp.fork(nodePath.join(here, 'run_main.mjs'), [appRoot, ...mainArgs], { serialization: 'json', stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...nodeProcess.env, APP98_ROOT: appRoot, ELECTRON_STUB_LOG: opt('stub-log', nodePath.join(globalThis.__builtins.os.tmpdir(), 'electron-stub.log')) } });
log('[harness] forked main pid ' + child.pid); const echo = opt('echo-main', '0') === '1'; child.stdout.on('data', (d) => { mainLog.push(String(d)); if (echo) { std.err.puts('[main] ' + String(d)); } }); child.stderr.on('data', (d) => { mainLog.push(String(d)); if (echo) { std.err.puts('[main!] ' + String(d)); } });
child.on('exit', (c, sig) => { mainLog.push(`[main exited ${c}]`); log('[harness] main process exited: code ' + c + ' signal ' + sig); });
// ---- ipcRenderer transport
const DEBUG_IPC = opt('debug-ipc', '0') === '1';   // log every message to and from main with a timestamp
const listeners = new Map(), pending = new Map(); let nextInvoke = 1, wcId = 0;
const ipc = {
	send: (channel, ...args) => (DEBUG_IPC && log(`[ipc] ${Date.now() % 1e7} send ${channel}`), child.send(encode({ t: 'send', wc: wcId, channel, args }))),
	invoke: (channel, ...args) => new Promise((res, rej) => { const id = nextInvoke++; if (opt('debug-ipc', '0') === '1') { log(`[ipc] invoke ${channel}`); } pending.set(id, { res, rej }); child.send(encode({ t: 'invoke', id, wc: wcId, channel, args })); }),
	on: (ch, fn) => { let l = listeners.get(ch); if (!l) { l = []; listeners.set(ch, l); } l.push(fn); },
	once: (ch, fn) => { const w = (...a) => { ipc.off(ch, w); fn(...a); }; ipc.on(ch, w); },
	off: (ch, fn) => { const l = listeners.get(ch); if (l) { const i = l.indexOf(fn); if (i >= 0) { l.splice(i, 1); } } },
};
// the first terminal starts the pty host, a whole process (on a slow machine more than the 5 s the workbench allows for creating a terminal process): start it in the background once the workbench has had time to settle
if (Number(opt('pty-prewarm-ms', 20000)) > 0) { os.setTimeout(() => { try { ipc.send('vscode:createPtyHostMessageChannel', 'prewarm-' + Date.now()); } catch (e) { log('pty prewarm failed: ' + e); } }, Number(opt('pty-prewarm-ms', 20000))); }
const ports = new PortTable((m) => child.send(encode({ ...m, wc: wcId })));
let onWindowLoad; const loadRequested = new Promise((r) => { onWindowLoad = r; }); let createOpts;
child.on('message', (m0) => {
	if (DEBUG_IPC) { const m1 = decode(m0); log(`[ipc] ${Date.now() % 1e7} recv ${m1 && m1.t} ${(m1 && m1.channel) || ''}`); }
	const m = decode(m0);
	if (m.t === 'createWindow') { createOpts = m; wcId = m.wc; }
	else if (m.t === 'loadURL') { onWindowLoad(m); }
	else if (m.t === 'send') { for (const fn of [...(listeners.get(m.channel) || [])]) { fn({ sender: null, ports: [] }, ...m.args); } }
	else if (m.t === 'editCommand') { log('[harness] editCommand ' + m.cmd); try { execCommand(env.document, m.cmd); } catch (e) { log('editCommand ' + m.cmd + ' failed: ' + e); } }   // webContents.paste()/copy()/... of the main process: the focused control performs the edit
	else if (m.t === 'postMessage') { for (const fn of [...(listeners.get(m.channel) || [])]) { fn({ sender: null, ports: m.ports.map(id => ports.make(id)) }, m.message); } }
	else if (m.t === 'portMsg') { ports.deliver(m); }
	else if (m.t === 'portClose') { const p = ports.ports.get(m.id); if (p) { p._closed = true; p.dispatchEvent({ type: 'close' }); } }
	else if (m.t === 'invokeResult') { const p = pending.get(m.id); pending.delete(m.id); if (opt('debug-config', '0') === '1' && m.result && m.result.windowId) { log('[harness] window config: workspace=' + JSON.stringify(m.result.workspace) + ' filesToOpen=' + JSON.stringify(m.result.filesToOpenOrCreate) + ' _=' + JSON.stringify(m.result._) + ' userDataDir=' + m.result.userDataDir); } if (m.error !== undefined) { p.rej(new Error(m.error)); } else { p.res(m.result); } }
});
const load = await loadRequested;
log(`[harness] main created a window and asked to load ${load.url} after ${Math.round(performance.now() - t00)} ms`);
const pageFile = fileOf(load.url);
const BASE = 'vscode-file://vscode-app' + pathToFileURL(appRoot).pathname;
{ const fd = opt('font-dir', nodePath.join(nodePath.dirname(appRoot), 'fonts')); if (os.stat(fd)[1] === 0) { globalThis.__fontRoot = fd.replace(/\\/g, '/'); log('[harness] fonts: ' + globalThis.__fontRoot); } else { log('[harness] no font directory at ' + fd + ': the system font paths of the Linux host are used'); } }
// native Oniguruma for TextMate grammars (the host has no WebAssembly to run vscode-oniguruma's onig.wasm); older hosts without the module have no syntax highlighting
try { globalThis.__onig98 = await import('spike:onig-native'); log('[harness] native oniguruma: ' + globalThis.__onig98.engine); } catch (e) { log('[harness] no native oniguruma (' + (e && e.message || e) + '): no syntax highlighting'); }
const onigShim = globalThis.__onig98 ? new TextEncoder().encode(ONIG_SHIM_SOURCE).buffer : null;
const env = installEnvironment({ width: W, height: H, opentype, readUrl: (u) => (onigShim && /\/vscode-oniguruma\/release\/main\.js(?:[?#]|$)/.test(u) ? onigShim : readBytes(fileOf(u))) }); const doc = env.document;
// resources of iframes (webviews): vscode-webview://<id>/<file> is the webview shell of the workbench, https://file+.vscode-resource.vscode-cdn.net/<path> a local file of an extension or the workspace (what a service worker would fetch through the host), data: URLs are decoded
{ const pre = nodePath.join(appRoot, 'out', 'vs', 'workbench', 'contrib', 'webview', 'browser', 'pre'); const plain = env.fetchResource;
  env.fetchResource = (u) => {
	u = String(u); let m;
	if ((m = /^vscode-webview:\/\/[^/]*(\/[^?#]*)/.exec(u))) { const f = nodePath.join(pre, decodeURIComponent(m[1])); if (opt('webview-debug', '0') === '1' && /index\.html$/.test(f)) { const t = std.loadFile(f).replace('function forwardKeyEvent(channel, e) {', "function forwardKeyEvent(channel, e) { __log98('FWD ' + channel + ' key=' + e.key + ' trusted=' + e.isTrusted);"); return new TextEncoder().encode(t).buffer; } return readBytes(f); }
	if ((m = /^https?:\/\/file(?:%2B|\+)[^/]*\.vscode-resource\.vscode-cdn\.net(\/[^?#]*)/i.exec(u))) { let p = decodeURIComponent(m[1]); if (/^\/[A-Za-z]:/.test(p)) { p = p.slice(1); } return readBytes(p); }
	if ((m = /^data:([^,]*),(.*)$/s.exec(u))) { const bytes = /;base64/.test(m[1]) ? Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[2])); return bytes.buffer; }
	return plain(u);
  };
  env.fetchDocument = env.fetchResource; }
let layoutTiming = null; if (opt('layout', 'js') === 'native') { const m = await import('../../07-native-render/host/native_layout.js'); env.layoutEngine = m.engine; layoutTiming = m.timing; }
// selector matching in C by default (07-native-render/host/native_style.js, module spike:style); --style js: the JavaScript matcher; --style match: native matching, computed values in JavaScript; --style verify: both, differences logged
let styleNative = null; if (opt('style', 'native') !== 'js') { try { styleNative = await import('../../07-native-render/host/native_style.js'); env.styleEngine = styleNative.engine; styleNative.engine.verify = opt('style', 'native') === 'verify'; if (opt('style', 'native') === 'match') { styleNative.engine.compute = null; } } catch (e) { styleNative = null; log('[harness] no native style engine (' + (e && e.message || e) + '): JavaScript matching'); } }
installWebShims(env, { baseUrl: BASE, readFile: (p) => readBytes(nodePath.join(appRoot, 'out', p)) });
Object.assign(env.window.location, { href: load.url });
const html = std.loadFile(pageFile).replace(/<!doctype[^>]*>/i, '').replace(/<!--[\s\S]*?-->/g, '');
const headM = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html), bodyM = /<body([^>]*)>([\s\S]*?)<\/body>/i.exec(html);
const mount = (el, markup) => { const f = parseFragment(doc, markup, el); for (const c of [...f.__children]) { el.appendChild(c); } };
mount(doc.head, headM[1].replace(/<script[\s\S]*?<\/script>/g, '')); mount(doc.body, bodyM[2].replace(/<script[\s\S]*?<\/script>/g, ''));
for (const el of doc.head.__children) { if (el.localName === 'link' && el.getAttribute('rel') === 'stylesheet') { const abs = resolveUrl(el.getAttribute('href'), load.url); el.__linkText = absolutizeCssUrls(std.loadFile(fileOf(abs)), abs); } }
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*type="module"[^>]*>|<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*>/g)].map(m => resolveUrl(m[1] || m[2], load.url));
const procLike = { platform: nodeProcess.platform, arch: 'x64', env: { ...nodeProcess.env }, versions: { electron: '39.0.0', chrome: '140.0.0.0', node: '22.0.0' }, execPath: nodeProcess.execPath };
installPreload(env.window, ipc, { argv: createOpts?.options?.webPreferences?.additionalArguments || [], process: procLike });
env.window.queryLocalFonts = async () => [];
env.window.postMessage = (data, origin, transfer) => { const ev = Object.assign(new env.window.Event('message'), { data, origin: '', source: env.window, ports: transfer || [] }); setTimeout(() => env.window.dispatchEvent(ev), 0); };
const errors = []; let liveNote = null; const note = (k, e) => { const m = (e && (e.stack || e.message)) || String(e); errors.push([k, m]); if (liveNote) { liveNote(k, m); } };
env.window.addEventListener('error', (ev) => note('window.onerror', ev.error || ev.message));
globalThis.__rejection = (promise, reason, handled) => { if (handled) { return; } const ev = new globalThis.Event('unhandledrejection', { cancelable: true }); ev.promise = promise; ev.reason = reason; globalThis.dispatchEvent(ev); if (!ev.defaultPrevented) { note('unhandledRejection', reason); } };
const consoleLog = []; for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace']) { console[k] = (...a) => { consoleLog.push([k, a.map(x => (x && x.stack) || String(x)).join(' ')]); }; }
doc.__passStats = []; if (opt('verify', '0') === '1') { doc.__verifyStyles = true; } if (opt('pack-verify', '0') === '1') { globalThis.__packVerify = true; } if (opt('verify-style-only', '0') === '1') { doc.__verifyStyleOnly = true; } if (opt('no-style-only', '0') === '1') { doc.__noStyleOnly = true; }
const tImport = performance.now();
log('[harness] page scripts: ' + JSON.stringify(scripts));
for (const s of scripts) { try { await import(s); log('[harness] imported ' + s + ' after ' + Math.round(performance.now() - t00) + ' ms (' + Math.round(performance.now() - tImport) + ' ms for the import)'); } catch (e) { log('[harness] import failed ' + s + ': ' + (e && e.stack || e)); note('import ' + s, e); } }
const tLoaded = performance.now(); const rssAfterImport = rss();
const ctx = { env, doc, note, rss, layoutTiming, styleNative, opt, log, W, H, consoleLog, gcIdle, timelineMark: timelineDir ? timelineMark : null,
	useProfile: timelineDir ? (wins) => { try { globalThis.__timelineDump?.(); useProfileReport(timelineDir, nodeProcess.pid ?? globalThis.__spikeProc?.getpid?.(), wins, log); } catch (e) { log('[use-profile] ' + e); } } : null };
// the BrowserWindow's backgroundColor (main: the theme's background, #1E1E1E by default): what Electron shows before the page paints and where it sets no background
const windowBackground = (() => { try { const c = createOpts?.options?.backgroundColor; return c ? parseColor(String(c)) : null; } catch { return null; } })(); if (windowBackground) { doc.__baseBackground = windowBackground; }
let winHost = null;
if (opt('window', '0') === '1') {                      // a real window (Win32/GDI through spike:win): the document is painted whenever it changes, input goes to the DOM
	const { openWindow } = await import('../../11-windows-host/host/window_host98.mjs');
	winHost = openWindow(ctx, { width: W, height: H, title: 'vscode98', background: windowBackground, exact: opt('backend') === 'native-exact', onClose: () => { if (timelineDir && !timelinePrinted) { timelineMark('harness: window closed'); try { timelineReport(timelineDir, log, t00Epoch); } catch (e) { log('timeline: ' + e); } } try { child.kill(); } catch { /* gone */ } } });
	log('[harness] window opened'); timelineMark('harness: window opened');
	{ const seen = new Map(); liveNote = (k, m) => { const key = k + m.split('\n')[0].slice(0, 120); const n = (seen.get(key) || 0) + 1; seen.set(key, n); if (n <= 2) { log('[error] ' + k + ': ' + m.split('\n').slice(0, 6).join(' | ').slice(0, 600)); } }; }   // errors of the renderer (window events, paints, rejections) as they happen
	// progress and memory every --status-every seconds (default 15), and a BMP of the window (open it with Paint) at the times given by --shot-at (default 60,150,300)
	const t0w = performance.now(); const shots = opt('shot-at', '60,150,300').split(',').map(Number).filter(Boolean); const every = Number(opt('status-every', 15));
	const bmp = (name, px, w, h) => { const rowb = (w * 3 + 3) & ~3, size = 54 + rowb * h, b = new Uint8Array(size), dv = new DataView(b.buffer); b[0] = 66; b[1] = 77; dv.setUint32(2, size, true); dv.setUint32(10, 54, true); dv.setUint32(14, 40, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true); dv.setUint16(26, 1, true); dv.setUint16(28, 24, true); dv.setUint32(34, rowb * h, true);
		for (let y = 0; y < h; y++) { let o = 54 + (h - 1 - y) * rowb; for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; b[o++] = px[i + 2]; b[o++] = px[i + 1]; b[o++] = px[i]; } } const f = std.open(name, 'wb'); if (f) { f.write(b.buffer, 0, size); f.close(); } };
	const done = new Set(); const prevCpu = new Map(); let prevCpuAt = 0;
	const status = () => {
		const t = (performance.now() - t0w) / 1000; const els = doc.getElementsByTagName('*').length; const ps = doc.__passStats || []; let tree = '';
		try { const sp = globalThis.__spikeProc; if (sp && sp.processTree) { const pt = sp.processTree(nodeProcess.pid ?? sp.getpid()); const now = performance.now(); const dt = prevCpuAt ? now - prevCpuAt : 0; prevCpuAt = now;   // per process: pid<parent pid, working set, CPU use over the last interval (100 % = one core): a child that works while the window waits shows here
			tree = pt.map(x => { const before = prevCpu.get(x.pid); prevCpu.set(x.pid, x.cpuMs); const pct = before !== undefined && dt > 0 && x.cpuMs !== undefined ? Math.round((x.cpuMs - before) / dt * 100) : null; return `${x.name.replace(/\.exe$/i, '')}:${x.pid}<${x.ppid}:${x.mb.toFixed(0)}MB${pct === null ? '' : ':' + pct + '%'}`; }).join(' ') + ' | total ' + pt.reduce((a, x) => a + x.mb, 0).toFixed(0) + ' MB'; } } catch (e) { tree = 'mem? ' + e.message; }
		const ed = doc.querySelector('.editor-instance .monaco-editor'); const edInfo = ed ? ` editor=${JSON.stringify([...ed.querySelectorAll('.view-line')].slice(0, 3).map(l => l.textContent))} active=${doc.activeElement ? doc.activeElement.localName + '.' + String(doc.activeElement.getAttribute('class') || '').split(' ')[0] : 'none'}` : ' editor=none';
		log(`[status] t=${t.toFixed(0)}s elements=${els} layoutPasses=${ps.length} paints=${winHost.stats().paints}${edInfo} ${tree}`);
		for (const s of shots) { if (t >= s && !done.has(s)) { done.add(s); const r = paintDocument(doc, W, H, new NativeBackend(W, H)); const name = nodePath.join(nodePath.dirname(opt('user-data-dir', '.')), 'results', `window-${s}s.bmp`); bmp(name, r.px, r.w, r.h); log('[status] wrote ' + name); } }
		os.setTimeout(status, every * 1000);
	};
	os.setTimeout(status, every * 1000);
}
if (opt('progress', '0') !== '0') { const every = Number(opt('progress', 5)) * 1000, tp = performance.now(); const tick = () => { const ps = doc.__passStats || []; log(`[progress] t=${((performance.now() - tp) / 1000).toFixed(1)}s elements=${doc.getElementsByTagName('*').length} layoutPasses=${ps.length} styleMs=${ps.reduce((a, x) => a + x.styleMs, 0).toFixed(0)} layoutMs=${ps.reduce((a, x) => a + x.layoutMs, 0).toFixed(0)}`); os.setTimeout(tick, every); }; os.setTimeout(tick, every); }   // --progress <seconds>: a timeline line every N seconds (a gap shows a long synchronous stretch)
await runScenario(ctx, { seconds, stableRounds: Number(opt('stable', 25)) });
const done = performance.now();
if (globalThis.__packVerify) { log('pack verify: ' + JSON.stringify(globalThis.__packStats)); }
log('style-only passes (previous layout kept): ' + (doc.__styleOnlyPasses || 0) + ' of ' + (doc.__passStats || []).length + (doc.__verifyStyleOnly ? '; verified ' + (doc.__styleOnlyChecked || 0) + ' boxes, mismatches ' + JSON.stringify(doc.__styleOnlyMismatches || []) : ''));
summarizeRun(ctx, { tImport, tLoaded, done, t00, errors, consoleLog, rssAfterImport, missing, unsupported });
if (globalThis.__gcStats) { const g = globalThis.__gcStats(), w = winHost ? winHost.stats() : { gcRuns: 0, gcMs: 0 }; log(`garbage collector (${gcIdle ? 'at idle moments' : 'stock schedule'}): ${w.gcRuns} collections at idle moments (${Math.round(w.gcMs)} ms), ${g[1]} forced from inside an allocation, heap ${Math.round(g[2] / 1048576)} MB (soft limit ${Math.round(g[3] / 1048576)} MB, hard ${Math.round(g[4] / 1048576)} MB)`); }
if (globalThis.__codeCacheDir) { const c = globalThis.__codeCacheDir(); log(`code cache: ${c.dir ?? 'off'}; this process: ${c.hits} modules read from the cache (${c.renamed} compiled under another path), ${c.writes} written`); }
if (timelineDir) { timelineMark('harness: workbench stable'); timelineReport(timelineDir, log, t00Epoch); timelinePrinted = true; }
if (opt('scenario')) { const sc = await import(opt('scenario')); await sc.run(ctx); }
if (styleNative) { log('native style: ' + JSON.stringify(styleNative.stats) + ' C ' + JSON.stringify(styleNative.engine.nativeStats()) + ' mismatches ' + styleNative.mismatches.length + (styleNative.mismatches.length ? '\n  ' + styleNative.mismatches.slice(0, 30).join('\n  ') : '') + '; compute mismatches ' + styleNative.computeMismatches.length + (styleNative.computeMismatches.length ? '\n  ' + styleNative.computeMismatches.slice(0, 30).join('\n  ') : '') + '; selector mismatches ' + styleNative.selectorMismatches.length + (styleNative.selectorMismatches.length ? '\n  ' + styleNative.selectorMismatches.slice(0, 10).map(t => JSON.stringify(t.slice(0, 200))).join('\n  ') : '') + '; sheet mismatches ' + styleNative.sheetMismatches.length + (styleNative.sheetMismatches.length ? '\n  ' + styleNative.sheetMismatches.slice(0, 5).map(t => JSON.stringify(t.slice(0, 200))).join('\n  ') : '')); }
log('--- main process output (last 40 lines)\n' + mainLog.join('').split('\n').slice(-40).join('\n'));
if (opt('ppm')) { let backend; if (opt('backend', 'js').startsWith('native')) { const { NativeBackend } = await import('../../07-native-render/host/native_backend.js'); backend = new NativeBackend(W, H, { exact: opt('backend') === 'native-exact' }); } const r = paintDocument(doc, W, H, backend); const u8 = toPPM(r.px, r.w, r.h); const f = std.open(opt('ppm'), 'wb'); f.write(u8.buffer, u8.byteOffset, u8.byteLength); f.close(); log('painted ' + JSON.stringify(r.stats)); }
if (winHost) { log('[harness] window mode: close the window to exit'); return; }
child.kill(); std.exit(0);
}
main().catch(e => { std.err.puts('FATAL ' + (e && e.message) + '\n' + (e && e.stack || e) + '\n'); std.exit(1); });
