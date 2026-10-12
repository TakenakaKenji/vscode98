// Process-side runtime tracer: preload into every Node/Electron process via NODE_OPTIONS=--require=<this file>.
//
// Records, per process, how often each Node built-in function, `process.*` member, Electron API method, IPC channel
// and native addon is used, and dumps it to $VSCODE98_TRACE_DIR/<pid>.json every 1.5 s and on exit.
//
// It is observational: wrappers forward to the original function with the same `this`/arguments.
// Environment variable *names* are recorded; values never are.
//
// Usage: VSCODE98_TRACE_DIR=/some/dir NODE_OPTIONS="--require=/abs/path/node_hook.cjs" <launch VS Code>
'use strict';

const TRACE_DIR = process.env.VSCODE98_TRACE_DIR;
if (!TRACE_DIR || globalThis.__vscode98NodeHook) { return; }
globalThis.__vscode98NodeHook = true;

// Capture what the hook itself needs BEFORE patching, so its own I/O is never counted.
const realFs = require('fs');
const writeFileSync = realFs.writeFileSync, renameSync = realFs.renameSync, mkdirSync = realFs.mkdirSync;
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');

const counts = Object.create(null);
// Debug aid: VSCODE98_TRACE_STACKS='<regex>' stores the stack of the first call of every matching key (paths shortened) in the dump under `stacks`.
const stackProbe = process.env.VSCODE98_TRACE_STACKS ? new RegExp(process.env.VSCODE98_TRACE_STACKS) : null;
const stacks = Object.create(null);
const appKeys = new Set();   // keys that were called from non-`node:` code (the app, not Node's own internals) at least once in their first 5 calls
const hit = (k) => {
	const n = counts[k] | 0;
	counts[k] = n + 1;
	if (stackProbe && (n === 0 || n === 4000) && stackProbe.test(k)) { const l = Error.stackTraceLimit; Error.stackTraceLimit = 12; stacks[k + '@' + n] = new Error().stack.split('\n').slice(2, 12).map(s => s.trim().replace(/\(?file:\/\/[^)]*\/out\//, '(out/')); Error.stackTraceLimit = l; }
	if (n < 5 && !appKeys.has(k)) {
		const limit = Error.stackTraceLimit; Error.stackTraceLimit = 14;
		const stack = new Error().stack; Error.stackTraceLimit = limit;
		const lines = stack.split('\n').slice(1);
		// Decide by the IMMEDIATE caller: the first frame that is not this hook. `node:`-prefixed frames are Node's own code.
		for (const line of lines) {
			if (line.includes('node_hook.cjs')) { continue; }
			if (!/\(node:|^\s*at node:|\(<anonymous>\)|^\s*at <anonymous>/.test(line) && /\((file:\/\/|\/)|^\s*at (file:\/\/|\/)/.test(line)) { appKeys.add(k); }
			break;
		}
	}
};
const patched = new WeakSet();

// ---------------------------------------------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------------------------------------------
function copyProps(from, to) {
	try {
		for (const key of Reflect.ownKeys(from)) {
			if (key === 'length' || key === 'name' || key === 'prototype') { continue; }
			try { Object.defineProperty(to, key, Object.getOwnPropertyDescriptor(from, key)); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}

/** Wrap a plain function so each call increments counts[label]. `keyArg`: also include the first string argument. */
function wrapFn(orig, label, keyArg) {
	if (patched.has(orig)) { return orig; }
	const w = function () {
		const a0 = arguments[0];
		if (keyArg === 'cmd' && typeof a0 === 'string') {
			// record only the program name (basename of the first token), never arguments
			hit(label + '(' + a0.trim().split(/\s+/)[0].split('/').pop().slice(0, 60) + ')');
		} else {
			hit(keyArg && typeof a0 === 'string' ? label + '(' + a0 + ')' : label + '()');
		}
		return new.target ? Reflect.construct(orig, arguments, new.target) : Reflect.apply(orig, this, arguments);
	};
	copyProps(orig, w);
	try { Object.defineProperty(w, 'name', { value: orig.name, configurable: true }); } catch { /* ignore */ }
	w.prototype = orig.prototype;
	patched.add(w);
	return w;
}

const EVENT_KEYS = new Set(['on', 'once', 'addListener', 'prependListener', 'handle', 'handleOnce']);
const CP_CMD_KEYS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);

/** Patch own function properties of `obj` (and its prototype chain up to Object/EventEmitter prototypes) in place. */
function patchObject(obj, prefix, opts) {
	if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) { return; }
	const stop = new Set([Object.prototype, Function.prototype, EventEmitter.prototype]);
	for (let o = obj; o && !stop.has(o); o = Object.getPrototypeOf(o)) {
		for (const key of Object.getOwnPropertyNames(o)) {
			if (key === 'constructor' || key === 'prototype' || key === 'caller' || key === 'callee' || key === 'arguments') { continue; }
			let d; try { d = Object.getOwnPropertyDescriptor(o, key); } catch { continue; }
			if (!d || d.get || d.set || typeof d.value !== 'function' || !d.configurable) { continue; }
			if (patched.has(d.value)) { continue; }
			if (opts && opts.skipPrivate && key[0] === '_') { continue; }
			const isCtor = /^[A-Z]/.test(key) && d.value.prototype && Object.getOwnPropertyNames(d.value.prototype).length > 1;
			if (isCtor) {
				// classes: patch prototype methods ("Class#.method") and statics, only when the caller asked for it (curated modules)
				if (opts && opts.classes) { const sub = { skipPrivate: true }; patchObject(d.value.prototype, prefix + '.' + key + '#', sub); patchObject(d.value, prefix + '.' + key, sub); }
				continue;
			}
			try {
				const label = prefix + '.' + key;
				Object.defineProperty(obj === o ? o : obj, key, { ...d, value: wrapFn(d.value, label, prefix === 'child_process' && CP_CMD_KEYS.has(key) ? 'cmd' : EVENT_KEYS.has(key)) });
			} catch { /* ignore */ }
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Node built-in modules
// ---------------------------------------------------------------------------------------------------------------
const CLASS_MODULES = new Set(['net', 'http', 'https', 'child_process', 'readline', 'worker_threads', 'dgram', 'tls', 'zlib', 'fs', 'stream', 'inspector', 'http2']);
const BUILTINS = ['original-fs', 'fs', 'child_process', 'net', 'dgram', 'dns', 'http', 'https', 'http2', 'tls', 'os', 'crypto', 'zlib', 'worker_threads', 'cluster',
	'readline', 'vm', 'v8', 'inspector', 'perf_hooks', 'util', 'url', 'querystring', 'string_decoder', 'module', 'async_hooks', 'tty', 'stream', 'buffer'];
for (const name of BUILTINS) {
	try {
		const m = require(name);
		patchObject(m, name, { classes: CLASS_MODULES.has(name) });
		if ((name === 'fs' || name === 'original-fs') && m.promises) { patchObject(m.promises, name + '.promises'); }
		if (name === 'dns' && m.promises) { patchObject(m.promises, 'dns.promises'); }
	} catch { /* module not available in this process */ }
}

// ---------------------------------------------------------------------------------------------------------------
// Propagation into Node children. VS Code strips NODE_OPTIONS from the environment it hands to extension-host children
// (see `dangerousEnvVariables` in src/vs/base/common/processes.ts), so tsserver / language servers / workers never load this hook
// through the environment. Instead, wrap fork/spawn/execFile so that children which are Node (the same executable in
// ELECTRON_RUN_AS_NODE mode, or a plain `node`) get `--require=<this file>` and VSCODE98_TRACE_DIR. Programs such as rg and git are untouched.
// ---------------------------------------------------------------------------------------------------------------
const HOOK_FILE = __filename;
const rawEnv = process.env;                 // captured before the Proxy below, so the hook's own reads are not counted
const realExecPath = process.execPath;
const realExecArgv = process.execArgv.slice();
const cp = require('child_process');
const childLaunches = Object.create(null);   // "<program or script basename>" -> count, for the report (never arguments)

function withHookEnv(options) { const e = Object.assign({}, (options && options.env) || rawEnv); e.VSCODE98_TRACE_DIR = TRACE_DIR; return e; }
function hasHook(list) { return list.some(a => typeof a === 'string' && a.includes(HOOK_FILE)); }
function isNodeChild(cmd, env) {
	const base = path.basename(String(cmd)).toLowerCase();
	return /^node(\.exe)?$/.test(base) || (cmd === realExecPath && !!env.ELECTRON_RUN_AS_NODE);
}
/** Split (cmd, [args], [options], [callback]) in any of the shapes Node accepts. */
function splitArgs(argv) {
	let args = [], options, cb;
	for (let i = 1; i < argv.length; i++) {
		const v = argv[i];
		if (Array.isArray(v)) { args = v; } else if (typeof v === 'function') { cb = v; } else if (v && typeof v === 'object') { options = v; }
	}
	return { args, options, cb };
}
function wrapChildLauncher(name) {
	const orig = cp[name];
	if (typeof orig !== 'function') { return; }
	const w = function () {
		try {
			const cmd = arguments[0];
			if (typeof cmd === 'string') {
				const { args, options, cb } = splitArgs(arguments);
				const env = (options && options.env) || rawEnv;
				let nextArgs = args, nextOptions = options;
				if (name === 'fork') {
					if (!process.versions.electron || env.ELECTRON_RUN_AS_NODE) {
						const base = (options && options.execArgv) || realExecArgv;
						nextOptions = Object.assign({}, options, { env: withHookEnv(options), execArgv: hasHook(base) ? base : [...base, '--require=' + HOOK_FILE] });
						childLaunches['fork:' + path.basename(cmd)] = (childLaunches['fork:' + path.basename(cmd)] | 0) + 1;
					}
				} else if (isNodeChild(cmd, env) && !hasHook(args)) {
					nextArgs = ['--require=' + HOOK_FILE, ...args];
					nextOptions = Object.assign({}, options, { env: withHookEnv(options) });
					const script = args.find(a => typeof a === 'string' && !a.startsWith('-'));
					childLaunches[name + ':' + (script ? path.basename(script) : 'node')] = (childLaunches[name + ':' + (script ? path.basename(script) : 'node')] | 0) + 1;
				}
				if (nextArgs !== args || nextOptions !== options) {
					const call = [cmd, nextArgs]; if (nextOptions) { call.push(nextOptions); } if (cb) { call.push(cb); }
					return Reflect.apply(orig, this, call);
				}
			}
		} catch { /* never break the app */ }
		return Reflect.apply(orig, this, arguments);
	};
	copyProps(orig, w);
	try { Object.defineProperty(w, 'name', { value: orig.name, configurable: true }); } catch { /* ignore */ }
	patched.add(w);
	cp[name] = w;
}
for (const name of ['fork', 'spawn', 'spawnSync', 'execFile', 'execFileSync']) { try { wrapChildLauncher(name); } catch { /* ignore */ } }

try { Module.syncBuiltinESMExports(); } catch { /* ignore */ }

// ---------------------------------------------------------------------------------------------------------------
// process.*  (functions + selected data properties; env var NAMES only)
// ---------------------------------------------------------------------------------------------------------------
for (const key of ['cwd', 'chdir', 'umask', 'uptime', 'hrtime', 'memoryUsage', 'cpuUsage', 'resourceUsage', 'kill', 'exit', 'nextTick', 'send', 'emitWarning',
	'getuid', 'getgid', 'geteuid', 'dlopen', 'binding', 'abort', 'disconnect', 'setUncaughtExceptionCaptureCallback', 'getActiveResourcesInfo']) {
	const f = process[key];
	if (typeof f === 'function' && !patched.has(f)) {
		try { const w = wrapFn(f, 'process.' + key, false); if (f.bigint) { w.bigint = f.bigint; } process[key] = w; } catch { /* ignore */ }
	}
}
for (const key of ['on', 'once', 'addListener', 'off', 'removeListener']) {
	const f = process[key];
	if (typeof f === 'function') { try { process[key] = wrapFn(f, 'process.' + key, true); } catch { /* ignore */ } }
}
for (const key of ['platform', 'arch', 'argv', 'execArgv', 'execPath', 'pid', 'ppid', 'versions', 'version', 'release', 'title', 'exitCode', 'config', 'features', 'connected', 'channel', 'parentPort']) {
	try {
		const d = Object.getOwnPropertyDescriptor(process, key);
		if (!d || !d.configurable || d.get || d.set) { continue; }
		let value = d.value;
		Object.defineProperty(process, key, { configurable: true, enumerable: d.enumerable, get() { hit('process.' + key + ' (get)'); return value; }, set(v) { hit('process.' + key + ' (set)'); value = v; } });
	} catch { /* ignore */ }
}
try {
	const realEnv = process.env;
	process.env = new Proxy(realEnv, {
		// Forward to the real target WITHOUT the proxy as receiver: process.env is an exotic object and rejects proxied receivers.
		get(t, k) { if (typeof k === 'string') { hit('env.get:' + k); } return Reflect.get(t, k); },
		set(t, k, v) { if (typeof k === 'string') { hit('env.set:' + k); } return Reflect.set(t, k, v); },
		has(t, k) { if (typeof k === 'string') { hit('env.has:' + k); } return Reflect.has(t, k); },
		deleteProperty(t, k) { if (typeof k === 'string') { hit('env.delete:' + k); } return Reflect.deleteProperty(t, k); },
		ownKeys(t) { hit('env.enumerate'); return Reflect.ownKeys(t); }
	});
} catch { /* ignore */ }

// Native addons (every .node load goes through process.dlopen)
const nativeAddons = new Set();
try {
	const origDlopen = process.dlopen;
	if (typeof origDlopen === 'function') {
		process.dlopen = function (mod, filename) { try { nativeAddons.add(path.basename(String(filename))); hit('native:' + path.basename(String(filename))); } catch { /* ignore */ } return Reflect.apply(origDlopen, this, arguments); };
	}
} catch { /* ignore */ }

// ---------------------------------------------------------------------------------------------------------------
// Electron (main process only): API methods, event names, IPC channels
// ---------------------------------------------------------------------------------------------------------------
const shapes = {};   // debug aid (VSCODE98_TRACE_SHAPES=1): own-property layout of electron instances, to see why prototype patching misses methods
function describeChain(obj) {
	const out = [];
	for (let o = obj, i = 0; o && i < 8; o = Object.getPrototypeOf(o), i++) {
		const names = Object.getOwnPropertyNames(o); let fns = 0, nonConfig = 0, accessors = 0; const sample = [];
		for (const n of names) { const d = Object.getOwnPropertyDescriptor(o, n); if (!d) { continue; } if (d.get || d.set) { accessors++; } else if (typeof d.value === 'function') { fns++; if (sample.length < 6) { sample.push(n); } } if (!d.configurable) { nonConfig++; } }
		out.push({ ctor: o.constructor && o.constructor.name, own: names.length, fns, accessors, nonConfig, sample });
	}
	return out;
}
function patchElectron() {
	let electron;
	try { electron = require('electron'); } catch { return; }
	if (!electron || typeof electron !== 'object' || !process.versions.electron) { return; }

	const wrapIpc = (obj, kind) => {
		if (!obj) { return; }
		const wrappers = new WeakMap(); // original listener -> wrapper (so removeListener/removeHandler keep working)
		for (const key of ['on', 'once', 'addListener', 'handle', 'handleOnce']) {
			const f = obj[key]; if (typeof f !== 'function') { continue; }
			obj[key] = function (channel, listener) {
				if (typeof channel === 'string' && typeof listener === 'function') {
					hit('electron.' + kind + '.' + key + '(' + channel + ')');
					let w = wrappers.get(listener);
					if (!w) { w = function () { hit('electron.' + kind + '.recv(' + channel + ')'); return Reflect.apply(listener, this, arguments); }; wrappers.set(listener, w); }
					return Reflect.apply(f, this, [channel, w]);
				}
				return Reflect.apply(f, this, arguments);
			};
		}
		for (const key of ['removeListener', 'off']) {
			const f = obj[key]; if (typeof f !== 'function') { continue; }
			obj[key] = function (channel, listener) { return Reflect.apply(f, this, [channel, wrappers.get(listener) || listener]); };
		}
	};

	const wrapEvents = (obj, prefix) => {
		if (!obj) { return; }
		for (const key of ['on', 'once', 'addListener']) {
			const f = obj[key];
			if (typeof f !== 'function' || Object.prototype.hasOwnProperty.call(obj, key)) { continue; }
			try { Object.defineProperty(obj, key, { value: wrapFn(f, prefix + '.' + key, true), configurable: true, writable: true }); } catch { /* ignore */ }
		}
	};
	// Some modules (screen, ...) throw if touched before the app 'ready' event, so patch each one separately and retry the failures after 'ready'.
	// (An earlier version let that throw escape, which silently skipped every module after `screen` and the webContents/session hooks.)
	const patchModule = (name) => {
		let v; v = electron[name];
		if (!v || (typeof v !== 'object' && typeof v !== 'function')) { return; }
		if (name === 'ipcMain') { wrapIpc(v, 'ipcMain'); patchObject(v, 'electron.ipcMain'); return; }
		if (typeof v === 'function') { patchObject(v, 'electron.' + name, { skipPrivate: true }); if (v.prototype) { patchObject(v.prototype, 'electron.' + name + '#', { skipPrivate: true }); wrapEvents(v.prototype, 'electron.' + name + '#'); } }
		else { patchObject(v, 'electron.' + name, { skipPrivate: true }); wrapEvents(v, 'electron.' + name); }
	};
	const deferred = [];
	for (const name of Object.keys(electron)) {
		try { patchModule(name); } catch { deferred.push(name); }
	}
	shapes.deferredModules = deferred;
	if (deferred.length) {
		electron.app.whenReady().then(() => { for (const name of deferred) { try { patchModule(name); } catch (e) { (shapes.stillFailed = shapes.stillFailed || []).push(name + ': ' + String(e && e.message).slice(0, 80)); } } }).catch(() => { });
	}
	// Instances created later: webContents / sessions
	shapes.reached = true;
	try {
		electron.app.on('web-contents-created', (_e, wc) => { shapes.wcCreated = (shapes.wcCreated | 0) + 1; if (rawEnv.VSCODE98_TRACE_SHAPES && !shapes.wc) { try { shapes.wc = describeChain(wc); } catch (e) { shapes.wcErr = String(e && e.message); } } const p = Object.getPrototypeOf(wc); if (!patched.has(p)) { patched.add(p); patchObject(p, 'electron.webContents#', { skipPrivate: true }); wrapEvents(p, 'electron.webContents#'); } });
		electron.app.whenReady().then(() => {
			try { const s = electron.session.defaultSession; if (s) { const p = Object.getPrototypeOf(s); patchObject(p, 'electron.session#', { skipPrivate: true }); wrapEvents(p, 'electron.session#'); if (s.protocol) { patchObject(s.protocol, 'electron.session.protocol'); } if (s.webRequest) { patchObject(s.webRequest, 'electron.session.webRequest'); } } } catch { /* ignore */ }
		}).catch(() => { });
	} catch (e) { shapes.regErr = String(e && e.stack).slice(0, 400); }
}
if (process.type === 'browser') { try { patchElectron(); } catch (e) { shapes.patchErr = String(e && e.stack).slice(0, 400); /* never break the app */ } }

// ---------------------------------------------------------------------------------------------------------------
// Dump
// ---------------------------------------------------------------------------------------------------------------
try { mkdirSync(TRACE_DIR, { recursive: true }); } catch { /* ignore */ }
const startedAt = Date.now();
function dump(final) {
	try {
		const out = {
			pid: process.pid, ppid: process.ppid, final: !!final, uptimeMs: Date.now() - startedAt,
			type: process.type || 'node', entry: process.env.VSCODE_ESM_ENTRYPOINT || null, argv1: process.argv[1] ? String(process.argv[1]).slice(-120) : null,
			execArgv: process.execArgv.slice(0, 8), electron: process.versions.electron || null, node: process.versions.node, platform: process.platform,
			loadedBuiltinsNote: 'includes the ~28 modules this hook loads itself; do not use', nativeAddons: [...nativeAddons].sort(), appCalled: [...appKeys].sort(), childLaunches, shapes, stacks, counts
		};
		const f = path.join(TRACE_DIR, process.pid + '.json');
		writeFileSync(f + '.tmp', JSON.stringify(out)); renameSync(f + '.tmp', f);
	} catch { /* ignore */ }
}
const timer = setInterval(() => dump(false), 1500); if (timer.unref) { timer.unref(); }
process.on('exit', () => dump(true));
dump(false);
