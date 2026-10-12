// A stand-in for Electron's main-process API, written to let VS Code's own electron-main bundle (out/main.js) run unmodified under Node (later QuickJS).
// Windows are not drawn here: a BrowserWindow is a record whose web contents live in a renderer harness, connected over an IPC channel (process.send).
// Anything not implemented yet is a logging no-op (set ELECTRON_STUB_LOG=file) so a run shows what the real main process asks of Electron.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import osMod from 'node:os';
import { pathToFileURL } from 'node:url';
import { encode, decode } from './codec98.js';

const LOG = process.env.ELECTRON_STUB_LOG || null;
const log = (m) => { if (LOG) { fs.appendFileSync(LOG, m + '\n'); } };
const show = (a) => { try { return typeof a === 'function' ? '[fn]' : JSON.stringify(a)?.slice(0, 100); } catch { return '?'; } };
const seen = new Set();

/** An object whose unknown properties are logged functions returning more of the same. */
function recorder(name, impl = {}) {
	return new Proxy(function () { }, {
		get(t, p) {
			if (p in impl) { return impl[p]; }
			if (p === Symbol.toPrimitive) { return () => ''; }
			if (p === 'then' || typeof p === 'symbol' || p === 'toJSON' || p === 'inspect') { return undefined; }
			const k = name + '.' + String(p); if (!seen.has(k)) { seen.add(k); log('GET ' + k); }
			return recorder(k);
		},
		apply(t, thisArg, args) { log('CALL ' + name + '(' + args.map(show).join(', ') + ')'); return recorder(name + '()'); },
		construct(t, args) { log('NEW ' + name + '(' + args.map(show).join(', ') + ')'); return recorder('new ' + name); },
	});
}
/** Wraps an instance so that unknown methods are logged no-ops instead of TypeErrors. */
function lenient(obj, name) {
	return new Proxy(obj, { get(t, p, r) { if (p in t || typeof p === 'symbol' || p === 'then' || p === 'toJSON') { return Reflect.get(t, p, r); } const k = name + '.' + String(p); if (!seen.has(k)) { seen.add(k); log('GET ' + k); } return (...a) => { log('CALL ' + k + '(' + a.map(show).join(', ') + ')'); }; } });
}

// ---- channel to the renderer harness
const clean = (v, path = 'msg') => encode(v, (p) => log('LEAK function at ' + p), path);   // JSON-safe (binary as { $u8 }); functions that leaked in as data are dropped and reported
const toRenderer = (msg) => { if (process.send) { process.send(clean(msg, 'msg')); } else { log('NOSEND ' + show(msg)); } };

// ---- app
class App extends EventEmitter {
	constructor() {
		super(); this._paths = {}; this._switches = new Map();
		this.commandLine = { appendSwitch: (k, v) => { this._switches.set(k, v ?? ''); }, hasSwitch: (k) => this._switches.has(k), getSwitchValue: (k) => this._switches.get(k) ?? '', removeSwitch: (k) => this._switches.delete(k), appendArgument() { } };
		this.dock = recorder('app.dock'); this.isPackaged = false; this.accessibilitySupportEnabled = false;
	}
	whenReady() { return Promise.resolve(); } isReady() { return true; }
	getPreferredSystemLanguages() { return ['en-US']; } getLocale() { return 'en-US'; } getSystemLocale() { return 'en-US'; } getLocaleCountryCode() { return 'US'; }
	getPath(name) {
		if (this._paths[name]) { return this._paths[name]; }
		const home = osMod.homedir(), temp = osMod.tmpdir(), userData = this._paths.userData || path.join(temp, 'userData98');
		return ({ home, temp, userData, appData: osMod.platform() === 'win32' ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming')) : temp, logs: path.join(userData, 'logs'), exe: process.execPath,
			desktop: path.join(home, 'Desktop'), documents: path.join(home, 'Documents'), downloads: path.join(home, 'Downloads'), crashDumps: path.join(temp, 'crashDumps98') })[name] ?? temp;
	}
	setPath(name, p) { this._paths[name] = p; }
	getAppPath() { return process.env.APP98_ROOT || process.cwd(); }
	getName() { return 'code-oss'; } getVersion() { return '1.0.0'; }
	setAppLogsPath() { } setDesktopName() { } enableSandbox() { } disableHardwareAcceleration() { } setAppUserModelId() { } setUserTasks() { } setBadgeCount() { } addRecentDocument() { } clearRecentDocuments() { } relaunch() { } setJumpList() { } setAsDefaultProtocolClient() { }
	requestSingleInstanceLock() { return true; } releaseSingleInstanceLock() { }
	getGPUFeatureStatus() { return {}; } getAppMetrics() { return []; } getGPUInfo() { return Promise.resolve({}); }
	quit() { log('app.quit'); this.emit('before-quit', { preventDefault() { } }); setImmediate(() => process.exit(0)); } exit(c) { log('app.exit ' + c); process.exit(c ?? 0); }
	focus() { } hide() { } show() { }
}
export const app = lenient(new App(), 'app');
// the real main waits for 'ready'; emit it after its module graph has registered listeners
const IS_MAIN = process.type === 'browser';   // the same module is also loaded (as `electron`) inside utility processes, where none of the main-process behaviour applies
if (IS_MAIN) { setImmediate(() => { log('EMIT ready'); app.emit('ready'); }); }

// ---- ipcMain: messages arrive from the renderer harness
class IpcMain extends EventEmitter {
	constructor() { super(); this.handlers = new Map(); }
	handle(ch, fn) { if (this.handlers.has(ch)) { throw new Error(`Attempted to register a second handler for '${ch}'`); } this.handlers.set(ch, fn); }
	handleOnce(ch, fn) { this.handle(ch, (...a) => { this.removeHandler(ch); return fn(...a); }); }
	removeHandler(ch) { this.handlers.delete(ch); }
}
export const ipcMain = new IpcMain();

// ---- web contents / windows
let nextWebContentsId = 1, nextWindowId = 1;
const windows = new Map(), contents = new Map();
class WebContents extends EventEmitter {
	constructor(win, options) {
		super(); this.id = nextWebContentsId++; this._win = win; this._url = 'about:blank'; this._options = options; this._zoom = 0; this._destroyed = false; this.session = session.defaultSession; this.ipc = new EventEmitter();
		this.mainFrame = { url: this._url, parent: null, top: null, processId: 1, routingId: 1, frameTreeNodeId: 1, send: (ch, ...a) => this.send(ch, ...a), postMessage: (ch, msg, tr) => this.postMessage(ch, msg, tr), ipc: this.ipc, on: () => { }, isDestroyed: () => false };
		contents.set(this.id, this);
	}
	send(channel, ...args) { toRenderer({ t: 'send', wc: this.id, channel, args }); }
	postMessage(channel, message, transfer) { const h = holderForWc(this); giveTo(h, transfer || []); toRenderer({ t: 'postMessage', wc: this.id, channel, message, ports: (transfer || []).map(p => p.id) }); }
	loadURL(url) { this._url = url; this.mainFrame.url = url; toRenderer({ t: 'loadURL', wc: this.id, url, options: this._options }); return Promise.resolve(); }
	getURL() { return this._url; } isDestroyed() { return this._destroyed; } isLoading() { return false; } isOffscreen() { return false; } isDevToolsOpened() { return false; }
	getOSProcessId() { return process.pid; } getProcessId() { return 1; } getType() { return 'window'; }
	setZoomLevel(l) { this._zoom = l; } getZoomLevel() { return this._zoom; } setZoomFactor() { } getZoomFactor() { return 1; }
	setWindowOpenHandler() { } setBackgroundThrottling() { } setAudioMuted() { } setFrameRate() { } setVisualZoomLevelLimits() { return Promise.resolve(); }
	focus() { } close() { } openDevTools() { } closeDevTools() { } toggleDevTools() { } reload() { } reloadIgnoringCache() { } stop() { } inspectElement() { } executeJavaScript() { return Promise.resolve(); } capturePage() { return Promise.resolve(recorder('nativeImage')); }
	destroy() { this._destroyed = true; contents.delete(this.id); this.emit('destroyed'); }
}
const wcProxy = (wc) => lenient(wc, 'webContents');
class BrowserWindow extends EventEmitter {
	constructor(options = {}) {
		super(); this.id = nextWindowId++; this._options = options; this._destroyed = false; this._title = options.title || ''; this._maximized = false; this._fullscreen = false; this._visible = false;
		this._bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 1280, height: options.height ?? 800 };
		this.webContents = wcProxy(new WebContents(this, options.webPreferences || {})); this._wc = this.webContents;
		windows.set(this.id, this); toRenderer({ t: 'createWindow', id: this.id, wc: this.webContents.id, options: JSON.parse(JSON.stringify(options, (k, v) => typeof v === 'function' ? undefined : v)) });
	}
	static getAllWindows() { return [...windows.values()]; } static getFocusedWindow() { return null; } static fromId(id) { return windows.get(id) ?? null; }
	static fromWebContents(wc) { for (const w of windows.values()) { if (w.webContents.id === wc.id) { return w; } } return null; }
	loadURL(u) { return this.webContents.loadURL(u); } loadFile() { return Promise.resolve(); }
	getBounds() { return { ...this._bounds }; } getNormalBounds() { return { ...this._bounds }; } getContentBounds() { return { ...this._bounds }; } setBounds(b) { Object.assign(this._bounds, b); } setSize(w, h) { this._bounds.width = w; this._bounds.height = h; } getSize() { return [this._bounds.width, this._bounds.height]; } getPosition() { return [this._bounds.x, this._bounds.y]; } setPosition(x, y) { this._bounds.x = x; this._bounds.y = y; } getContentSize() { return [this._bounds.width, this._bounds.height]; }
	isMaximized() { return this._maximized; } maximize() { this._maximized = true; } unmaximize() { this._maximized = false; } isFullScreen() { return this._fullscreen; } setFullScreen(f) { this._fullscreen = !!f; } isMinimized() { return false; } minimize() { } restore() { } isVisible() { return this._visible; } show() { this._visible = true; this.emit('show'); } showInactive() { this._visible = true; } hide() { this._visible = false; } focus() { this.emit('focus'); } isFocused() { return true; } blur() { } isDestroyed() { return this._destroyed; }
	getTitle() { return this._title; } setTitle(t) { this._title = t; } setRepresentedFilename() { } setDocumentEdited() { } setMenuBarVisibility() { } isMenuBarVisible() { return false; } setAutoHideMenuBar() { } setBackgroundColor() { } setTitleBarOverlay() { } setAspectRatio() { } setMinimumSize(w, h) { this._min = [w, h]; } getMinimumSize() { return this._min ?? [0, 0]; } getMaximumSize() { return [0, 0]; } setOpacity() { } setSimpleFullScreen() { } isSimpleFullScreen() { return false; } moveTop() { } setParentWindow() { } setHasShadow() { } setWindowButtonVisibility() { } setContentProtection() { } getNativeWindowHandle() { return Buffer.alloc(8); } isAlwaysOnTop() { return false; } setAlwaysOnTop() { } isNormal() { return true; } isEnabled() { return true; } setEnabled() { }
	close() { if (this._destroyed) { return; } const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; this.emit('close', ev); if (!ev.defaultPrevented) { this.destroy(); } }
	destroy() { if (this._destroyed) { return; } this._destroyed = true; windows.delete(this.id); this.emit('closed'); toRenderer({ t: 'destroyWindow', id: this.id }); }
}
export { BrowserWindow };
export const webContents = { fromId: (id) => contents.get(id) ? wcProxy(contents.get(id)) : undefined, getAllWebContents: () => [...contents.values()].map(wcProxy), getFocusedWebContents: () => null };

// ---- renderer harness -> main
if (IS_MAIN) process.on('message', (m0) => {
	const m = decode(m0); if (!m || !m.t) { return; }
	if (m.t === 'portMsg' || m.t === 'portClose') { handlePortMessage(m); return; }
	const wc = contents.get(m.wc); if (!wc) { log('MSG for unknown webContents ' + show(m)); return; }
	const event = { sender: wcProxy(wc), senderFrame: wc.mainFrame, processId: 1, frameId: 1, reply: (ch, ...a) => wc.send(ch, ...a), preventDefault() { } };
	if (m.t === 'send') { event.returnValue = undefined; if (!ipcMain.emit(m.channel, event, ...m.args)) { log('UNHANDLED send ' + m.channel); } }
	else if (m.t === 'invoke') {
		const h = ipcMain.handlers.get(m.channel);
		if (!h) { log('NO HANDLER ' + m.channel); toRenderer({ t: 'invokeResult', id: m.id, error: `No handler registered for '${m.channel}'` }); return; }
		Promise.resolve().then(() => h(event, ...m.args)).then(result => toRenderer({ t: 'invokeResult', id: m.id, result }), err => toRenderer({ t: 'invokeResult', id: m.id, error: String(err && err.message || err) }));
	}
});


// ---- message ports: the main process relays between the processes that hold the two ends of a channel
let nextPortId = 1;
const portTable = new Map();   // id -> { id, peer, holder: 'main' | Holder, obj?: MessagePortMain }
class MessagePortMain extends EventEmitter {
	constructor(id) { super(); this.id = id; this._started = false; this._queue = []; this._closed = false; }
	postMessage(data, transfer = []) { postFrom(this.id, data, transfer.map(p => p.id)); }
	start() { this._started = true; const q = this._queue; this._queue = []; for (const e of q) { this.emit('message', e); } }
	close() { if (this._closed) { return; } this._closed = true; this.emit('close'); const e = portTable.get(this.id); const peer = e && portTable.get(e.peer); if (peer && peer.holder !== 'main') { peer.holder.send({ t: 'portClose', id: peer.id }); } else if (peer?.obj) { peer.obj.emit('close'); } }
	_deliver(data, ids) { const ev = { data, ports: ids.map(i => portTable.get(i).obj ?? this._adopt(i)) }; if (!this._started) { this._queue.push(ev); } else { this.emit('message', ev); } }
	_adopt(id) { const e = portTable.get(id); e.obj = e.obj ?? new MessagePortMain(id); e.holder = 'main'; return e.obj; }
	on(ev, fn) { super.on(ev, fn); if (ev === 'message') { this.start(); } return this; }
}
export class MessageChannelMain {
	constructor() {
		const a = nextPortId++, b = nextPortId++; const pa = new MessagePortMain(a), pb = new MessagePortMain(b);
		portTable.set(a, { id: a, peer: b, holder: 'main', obj: pa }); portTable.set(b, { id: b, peer: a, holder: 'main', obj: pb });
		this.port1 = pa; this.port2 = pb;
	}
}
/** a port id was posted a message by its holder: forward to the holder of the peer; transferred ports change holder */
function postFrom(fromId, data, transferIds) {
	const e = portTable.get(fromId); const peer = e && portTable.get(e.peer); if (!peer) { return; }
	if (peer.holder === 'main') { peer.obj._deliver(data, transferIds); for (const i of transferIds) { portTable.get(i).holder = 'main'; } }
	else { for (const i of transferIds) { portTable.get(i).holder = peer.holder; } peer.holder.send({ t: 'portMsg', id: peer.id, data: clean(data), ports: transferIds }); }
}
/** main hands ports to another process together with a message */
function giveTo(holder, ports) { for (const p of ports) { portTable.get(p.id).holder = holder; } }
const holderOf = (sendFn) => ({ send: sendFn });
const windowHolders = new Map();   // webContents id -> holder
const holderForWc = (wc) => { let h = windowHolders.get(wc.id); if (!h) { h = holderOf((m) => toRenderer({ ...m, wc: wc.id })); windowHolders.set(wc.id, h); } return h; };
function handlePortMessage(m, holder) {
	if (m.t === 'portMsg') { postFrom(m.id, m.data, m.ports || []); return true; }
	if (m.t === 'portClose') { const e = portTable.get(m.id); const peer = e && portTable.get(e.peer); if (peer) { if (peer.holder === 'main') { peer.obj.emit('close'); } else { peer.holder.send({ t: 'portClose', id: peer.id }); } } return true; }
	return false;
}

// ---- utility processes: real child processes with `process.parentPort`
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
class UtilityProcess extends EventEmitter {
	constructor(modulePath, args, options) {
		super(); this.pid = undefined; this._killed = false;
		const execArgv = (options.execArgv || []).filter(a => !a.startsWith('--js-flags'));
		const stdio = options.stdio === 'inherit' ? ['inherit', 'inherit', 'inherit', 'ipc'] : ['ignore', 'pipe', 'pipe', 'ipc'];
		this._child = fork(fileURLToPath(new URL('./util_child_main.mjs', import.meta.url)), args, { execArgv, env: { ...(options.env || process.env), UTIL_TARGET: modulePath, APP98_ROOT: process.env.APP98_ROOT, ELECTRON_STUB_LOG: (process.env.ELECTRON_STUB_LOG || '') + '.' + options.serviceName }, serialization: 'json', stdio, cwd: process.cwd() });
		this.stdout = this._child.stdout; this.stderr = this._child.stderr; if (process.env.UTILITY_OUT) { for (const [st, tag] of [[this.stdout, 'out'], [this.stderr, 'err']]) { st?.on('data', (d) => fs.appendFileSync(process.env.UTILITY_OUT, `[${options.serviceName} ${tag}] ${d}`)); } } this.holder = holderOf((m) => this._child.send(clean(m)));
		this._child.once('spawn', () => { this.pid = this._child.pid; this.emit('spawn'); });
		this._child.on('exit', (code, signal) => { log(`utility ${options.serviceName} exit ${code} ${signal}`); this.emit('exit', code ?? 0); });
		this._child.on('error', (e) => { log('utility error ' + e); if (this.listenerCount('error')) { this.emit('error', 'FatalError', e.message); } });   // Electron's 'error' is for V8 fatal errors; an EventEmitter without a listener would throw
		this._child.on('message', (m0) => { const m = decode(m0); if (handlePortMessage(m, this.holder)) { return; } if (m.t === 'upm') { this.emit('message', m.data); } });
	}
	postMessage(message, transfer = []) { giveTo(this.holder, transfer); this._child.send(clean({ t: 'upm', data: message, ports: transfer.map(p => p.id) })); }
	kill() { if (this._killed) { return false; } this._killed = true; return this._child.kill(); }
}
export const utilityProcess = { fork: (modulePath, args = [], options = {}) => new UtilityProcess(modulePath, args, options) };

// ---- the rest: logging recorders until a run needs more
export const session = { defaultSession: recorder('session.defaultSession'), fromPartition: () => recorder('session.partition') };
export const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 }, workArea: { x: 0, y: 0, width: 1280, height: 800 }, workAreaSize: { width: 1280, height: 800 }, size: { width: 1280, height: 800 }, scaleFactor: 1, rotation: 0, accelerometerSupport: 'unknown', colorDepth: 24, internal: false, touchSupport: 'unknown', monochrome: false, label: 'display98' }), getAllDisplays() { return [this.getPrimaryDisplay()]; }, getDisplayMatching() { return this.getPrimaryDisplay(); }, getDisplayNearestPoint() { return this.getPrimaryDisplay(); }, getCursorScreenPoint: () => ({ x: 0, y: 0 }) });
export const protocol = recorder('protocol'), crashReporter = recorder('crashReporter'), Menu = recorder('Menu', { setApplicationMenu() { }, getApplicationMenu() { return null; } }), contentTracing = recorder('contentTracing'), dialog = recorder('dialog'), desktopCapturer = recorder('desktopCapturer'), globalShortcut = recorder('globalShortcut');
export const powerMonitor = Object.assign(new EventEmitter(), { getSystemIdleState: () => 'active', getSystemIdleTime: () => 0, isOnBatteryPower: () => false, onBatteryPower: false });
export const systemPreferences = Object.assign(new EventEmitter(), { isAeroGlassEnabled: () => true, getColor: () => '000000', getAccentColor: () => '0078d7', isInvertedColorScheme: () => false, isHighContrastColorScheme: () => false, getUserDefault: () => undefined, getMediaAccessStatus: () => 'granted', canPromptTouchID: () => false });
export const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: true, shouldUseHighContrastColors: false, shouldUseInvertedColorScheme: false, themeSource: 'dark', inForcedColorsMode: false });
export const shell = recorder('shell'), net = recorder('net'), clipboard = recorder('clipboard'), safeStorage = recorder('safeStorage'), Notification = recorder('Notification'), powerSaveBlocker = recorder('powerSaveBlocker'), webFrameMain = recorder('webFrameMain'), MenuItem = recorder('MenuItem'), BaseWindow = recorder('BaseWindow'), WebContentsView = recorder('WebContentsView'), autoUpdater = recorder('autoUpdater'), nativeImage = recorder('nativeImage'), Tray = recorder('Tray'), JumpListCategory = recorder('JumpListCategory');
export const ipcRenderer = recorder('ipcRenderer'), contextBridge = recorder('contextBridge'), webFrame = recorder('webFrame'), webUtils = recorder('webUtils');
export default { app, BrowserWindow, ipcMain, webContents, session, screen, protocol, crashReporter, Menu, contentTracing, dialog, desktopCapturer, globalShortcut, powerMonitor, systemPreferences, nativeTheme, shell, net, clipboard, utilityProcess, safeStorage, Notification, powerSaveBlocker, webFrameMain, MenuItem, BaseWindow, WebContentsView, autoUpdater, nativeImage, Tray, MessageChannelMain, JumpListCategory };
