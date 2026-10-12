// Spike 2b: globals a Node-side VS Code bundle expects before it starts, implemented on QuickJS (qjs:std / qjs:os). Deliberately minimal:
// each addition here is a requirement the bundles proved they have at module-evaluation time. Everything not implemented falls through to
// lenient stubs (see __stub below) so we can keep going and record what is touched.
import * as std from 'qjs:std';
import * as os from 'qjs:os';

// ---- lenient stubs + call log -------------------------------------------------------------------------------------------------------------
const stubCalls = new Map();         // "module.name" -> { calls, firstStack }
globalThis.__stubCalls = stubCalls;
function record(key) {
	let e = stubCalls.get(key);
	if (!e) { e = { calls: 0, firstStack: String(new Error().stack).split('\n').slice(3, 6).map(s => s.trim()).join(' | ') }; stubCalls.set(key, e); }
	e.calls++;
}
function lenient(key) {
	const target = function () { };
	const handler = {
		apply() { record(key); return lenient(key + '()'); },
		construct() { record(key + ' (new)'); return lenient(key + '#instance'); },
		get(_t, prop) {
			if (prop === 'then') { return undefined; }                             // never look like a thenable
			if (prop === Symbol.toPrimitive) { return () => ''; }
			if (prop === Symbol.iterator) { return function* () { }; }
			if (prop === Symbol.asyncIterator) { return undefined; }
			if (typeof prop === 'symbol') { return undefined; }
			if (prop === 'prototype') { return target.prototype; }
			return lenient(key + '.' + String(prop));
		},
		has() { return true; },
	};
	return new Proxy(target, handler);
}
globalThis.__stub = (mod, name) => lenient(mod + '.' + name);

// ---- process --------------------------------------------------------------------------------------------------------------------------------
const listeners = new Map();
const processObj = {
	platform: 'linux', arch: 'x64', pid: 4242, ppid: 1, title: 'qjs-host', version: 'v24.0.0', versions: { node: '24.0.0', v8: '0', quickjs: '0.17.0' },
	release: { name: 'node' }, argv: ['qjs', ...(globalThis.scriptArgs || []).slice(1)], execArgv: [], execPath: '/usr/bin/qjs', exitCode: undefined,
	env: new Proxy({}, { get: (_t, k) => typeof k === 'string' ? std.getenv(k) : undefined, has: (_t, k) => std.getenv(k) !== undefined, ownKeys: () => Object.keys(std.getenviron()), getOwnPropertyDescriptor: (_t, k) => (std.getenv(k) !== undefined ? { value: std.getenv(k), enumerable: true, configurable: true, writable: true } : undefined), set: (_t, k, v) => { std.setenv(k, String(v)); return true; }, deleteProperty: (_t, k) => { std.unsetenv(k); return true; } }),
	cwd: () => os.getcwd()[0], chdir: (d) => os.chdir(d), exit: (c) => std.exit(c ?? 0), kill() { }, umask: () => 0o22, uptime: () => performance.now() / 1000,
	nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)), hrtime: Object.assign((prev) => { const t = performance.now(); const s = Math.floor(t / 1000), n = Math.floor((t % 1000) * 1e6); return prev ? [s - prev[0], n - prev[1]] : [s, n]; }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
	memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), cpuUsage: () => ({ user: 0, system: 0 }), emitWarning() { }, getuid: () => 0, getgid: () => 0, geteuid: () => 0,
	on(ev, fn) { (listeners.get(ev) ?? listeners.set(ev, []).get(ev)).push(fn); return processObj; }, once(ev, fn) { return processObj.on(ev, fn); },
	off(ev, fn) { const l = listeners.get(ev); if (l) { l.splice(l.indexOf(fn) >>> 0, 1); } return processObj; }, removeListener(ev, fn) { return processObj.off(ev, fn); }, removeAllListeners() { listeners.clear(); return processObj; },
	emit(ev, ...a) { (listeners.get(ev) || []).slice().forEach(f => f(...a)); return !!(listeners.get(ev) || []).length; }, listenerCount: (ev) => (listeners.get(ev) || []).length,
	stdout: { write: (s) => { std.out.puts(String(s)); return true; }, isTTY: false, fd: 1, on() { }, once() { } }, stderr: { write: (s) => { std.err.puts(String(s)); return true; }, isTTY: false, fd: 2, on() { }, once() { } }, stdin: { isTTY: false, fd: 0, on() { }, once() { }, setEncoding() { }, resume() { }, pause() { } },
	config: { variables: {} }, features: {}, binding() { throw new Error('process.binding is not supported'); },
};
// utility-process style parent channel (Electron's process.parentPort): the extension host waits for one 'message' event that carries its renderer's MessagePort
const parentListeners = new Map();
processObj.parentPort = { on(ev, fn) { (parentListeners.get(ev) ?? parentListeners.set(ev, []).get(ev)).push(fn); return this; }, once(ev, fn) { return this.on(ev, fn); }, postMessage() { }, off() { return this; } };
globalThis.__parentPortListeners = parentListeners;
globalThis.process = processObj;
globalThis.__processListeners = listeners;

// ---- timers (on os.setTimeout), microtask, structuredClone, misc ---------------------------------------------------------------------------
let timerId = 0; const timers = new Map();
globalThis.setTimeout = (fn, ms = 0, ...args) => { const id = ++timerId; timers.set(id, os.setTimeout(() => { timers.delete(id); fn(...args); }, ms)); return { id, ref() { return this; }, unref() { return this; }, hasRef: () => true, refresh() { return this; }, [Symbol.toPrimitive]: () => id }; };
globalThis.clearTimeout = (t) => { const id = t && typeof t === 'object' ? t.id : t; const h = timers.get(id); if (h !== undefined) { os.clearTimeout(h); timers.delete(id); } };
globalThis.setInterval = (fn, ms = 0, ...args) => { const id = ++timerId; const tick = () => { timers.set(id, os.setTimeout(() => { fn(...args); if (timers.has(id)) { tick(); } }, ms)); }; tick(); return { id, ref() { return this; }, unref() { return this; }, [Symbol.toPrimitive]: () => id }; };
globalThis.clearInterval = globalThis.clearTimeout;
globalThis.setImmediate = (fn, ...a) => globalThis.setTimeout(fn, 0, ...a);
globalThis.clearImmediate = globalThis.clearTimeout;
// Dynamic import() with a runtime-computed specifier (the extension host does import(uri.toString()) for ESM extensions). gen_shims.mjs rewrites such calls to this.
const realImport = new Function('s', 'return import(s)');
globalThis.__dynImport = (spec) => { let s = String(spec); if (s.startsWith('file://')) { s = decodeURIComponent(s.slice(7)); } return realImport(s); };
globalThis.structuredClone ??= (v) => JSON.parse(JSON.stringify(v));
globalThis.self ??= globalThis;
globalThis.global ??= globalThis;

// ---- TextEncoder / TextDecoder (UTF-8 only) -----------------------------------------------------------------------------------------------
globalThis.TextEncoder ??= class TextEncoder {
	get encoding() { return 'utf-8'; }
	encode(s = '') { const out = []; for (const ch of String(s)) { let c = ch.codePointAt(0); if (c < 0x80) { out.push(c); } else if (c < 0x800) { out.push(0xC0 | c >> 6, 0x80 | c & 63); } else if (c < 0x10000) { out.push(0xE0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63); } else { out.push(0xF0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63); } } return new Uint8Array(out); }
};
globalThis.TextDecoder ??= class TextDecoder {
	constructor(label = 'utf-8') { this.encoding = String(label).toLowerCase(); }
	decode(buf) { if (!buf) { return ''; } const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer ?? buf); let s = ''; for (let i = 0; i < b.length;) { const c = b[i++]; if (c < 0x80) { s += String.fromCharCode(c); } else if (c < 0xE0) { s += String.fromCharCode((c & 31) << 6 | b[i++] & 63); } else if (c < 0xF0) { s += String.fromCharCode((c & 15) << 12 | (b[i++] & 63) << 6 | b[i++] & 63); } else { const cp = (c & 7) << 18 | (b[i++] & 63) << 12 | (b[i++] & 63) << 6 | b[i++] & 63; s += String.fromCodePoint(cp); } } return s; }
};
globalThis.AbortController ??= class AbortController { constructor() { const l = []; this.signal = { aborted: false, reason: undefined, addEventListener: (t, f) => l.push(f), removeEventListener() { }, throwIfAborted() { } }; this._l = l; } abort(r) { this.signal.aborted = true; this.signal.reason = r; this._l.forEach(f => f()); } };
if (typeof globalThis.Intl === 'undefined') { globalThis.Intl = { Collator: class { compare(a, b) { return a.localeCompare(b); } resolvedOptions() { return { locale: 'en' }; } } }; }

// ---- crypto (Web Crypto subset), Buffer, URL ---------------------------------------------------------------------------------------------
globalThis.crypto ??= {
	getRandomValues(a) { for (let i = 0; i < a.length; i++) { a[i] = Math.floor(Math.random() * 256); } return a; },
	randomUUID() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); },
	subtle: globalThis.__stub('crypto', 'subtle'),
};
class BufferImpl extends Uint8Array {
	static from(v, enc = 'utf8') {
		if (typeof v === 'string') { if (enc === 'hex') { const b = new BufferImpl(v.length / 2); for (let i = 0; i < b.length; i++) { b[i] = parseInt(v.substr(i * 2, 2), 16); } return b; } if (enc === 'base64') { const bin = atob(v); const b = new BufferImpl(bin.length); for (let i = 0; i < bin.length; i++) { b[i] = bin.charCodeAt(i); } return b; } const u = new TextEncoder().encode(v); const b = new BufferImpl(u.length); b.set(u); return b; }
		if (v instanceof ArrayBuffer) { return new BufferImpl(v); }
		const b = new BufferImpl(v.length); b.set(v); return b;
	}
	static alloc(n, fill = 0) { const b = new BufferImpl(n); if (fill) { b.fill(fill); } return b; }
	static allocUnsafe(n) { return new BufferImpl(n); }
	static isBuffer(b) { return b instanceof BufferImpl; }
	static byteLength(s) { return typeof s === 'string' ? new TextEncoder().encode(s).length : s.byteLength; }
	static concat(list, total) { total ??= list.reduce((n, b) => n + b.length, 0); const out = new BufferImpl(total); let o = 0; for (const b of list) { out.set(b, o); o += b.length; } return out; }
	toString(enc = 'utf8', s = 0, e = this.length) {
		const v = this.subarray(s, e);
		if (enc === 'hex') { return Array.from(v, x => x.toString(16).padStart(2, '0')).join(''); }
		if (enc === 'base64') { let bin = ''; v.forEach(x => bin += String.fromCharCode(x)); return btoa(bin); }
		return new TextDecoder().decode(v);
	}
	toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
	equals(o) { return this.length === o.length && this.every((x, i) => x === o[i]); }
	slice(s, e) { return this.subarray(s, e); }
	readUInt32BE(o = 0) { return ((this[o] << 24) | (this[o + 1] << 16) | (this[o + 2] << 8) | this[o + 3]) >>> 0; }
	writeUInt32BE(v, o = 0) { this[o] = v >>> 24; this[o + 1] = v >>> 16; this[o + 2] = v >>> 8; this[o + 3] = v; return o + 4; }
	readUInt8(o = 0) { return this[o]; } writeUInt8(v, o = 0) { this[o] = v; return o + 1; }
}
globalThis.Buffer ??= BufferImpl;
globalThis.URLSearchParams ??= class URLSearchParams {
	constructor(init = '') { this._l = []; if (typeof init === 'string') { init.replace(/^\?/, '').split('&').filter(Boolean).forEach(kv => { const [k, v = ''] = kv.split('='); this._l.push([decodeURIComponent(k), decodeURIComponent(v)]); }); } else if (init) { for (const [k, v] of (Array.isArray(init) ? init : Object.entries(init))) { this._l.push([k, String(v)]); } } }
	get(k) { const e = this._l.find(x => x[0] === k); return e ? e[1] : null; } getAll(k) { return this._l.filter(x => x[0] === k).map(x => x[1]); } has(k) { return this._l.some(x => x[0] === k); }
	set(k, v) { this.delete(k); this._l.push([k, String(v)]); } append(k, v) { this._l.push([k, String(v)]); } delete(k) { this._l = this._l.filter(x => x[0] !== k); }
	forEach(f) { this._l.forEach(([k, v]) => f(v, k, this)); } entries() { return this._l[Symbol.iterator](); } keys() { return this._l.map(x => x[0])[Symbol.iterator](); } values() { return this._l.map(x => x[1])[Symbol.iterator](); } [Symbol.iterator]() { return this.entries(); }
	toString() { return this._l.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); }
};
globalThis.URL ??= class URL {
	constructor(url, base) {
		let u = String(url);
		if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) { if (base === undefined) { throw new TypeError('Invalid URL: ' + u); } const b = new URL(String(base)); u = u.startsWith('//') ? b.protocol + u : u.startsWith('/') ? b.origin + u : b.origin + b.pathname.replace(/[^/]*$/, '') + u; }
		const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(u); if (!m) { throw new TypeError('Invalid URL: ' + u); }
		this.protocol = m[1].toLowerCase(); const auth = m[2] ?? ''; const at = auth.lastIndexOf('@'); const hostport = at >= 0 ? auth.slice(at + 1) : auth; if (at >= 0) { const [us, pw = ''] = auth.slice(0, at).split(':'); this.username = us; this.password = pw; } else { this.username = ''; this.password = ''; }
		const pm = /^(.*?)(?::(\d+))?$/.exec(hostport); this.hostname = pm[1].toLowerCase(); this.port = pm[2] ?? ''; this.host = this.hostname + (this.port ? ':' + this.port : '');
		const segs = []; for (const s of (m[3] || (m[2] !== undefined ? '/' : '')).split('/')) { if (s === '..') { if (segs.length > 1) { segs.pop(); } } else if (s !== '.') { segs.push(s); } } this.pathname = segs.join('/') || (m[2] !== undefined ? '/' : '');
		this.search = m[4] && m[4] !== '?' ? m[4] : ''; this.hash = m[5] && m[5] !== '#' ? m[5] : ''; this.searchParams = new URLSearchParams(this.search);
	}
	get origin() { return this.protocol === 'file:' ? 'null' : this.protocol + '//' + this.host; }
	get href() { const q = this.searchParams.toString(); return this.protocol + (this.host || this.protocol === 'file:' ? '//' : '') + (this.username ? this.username + (this.password ? ':' + this.password : '') + '@' : '') + this.host + this.pathname + (q ? '?' + q : this.search) + this.hash; }
	toString() { return this.href; } toJSON() { return this.href; }
};
