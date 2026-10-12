// Globals a real Node has and QuickJS (even with 02-node-shim/host/globals.js) lacks. Placeholders: enough for packages that mention them at load time.
const stub = (name) => { const c = class { constructor() { throw new Error(`${name} is not implemented in this host`); } }; Object.defineProperty(c, 'name', { value: name }); return c; };
for (const n of ['ReadableStream', 'WritableStream', 'TransformStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy', 'TextDecoderStream', 'TextEncoderStream', 'CompressionStream', 'DecompressionStream', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader', 'WritableStreamDefaultWriter']) {
	if (typeof globalThis[n] === 'undefined') { Object.defineProperty(globalThis, n, { value: stub(n), writable: true, configurable: true }); }
}
const def = (n, v) => { if (typeof globalThis[n] === 'undefined') { Object.defineProperty(globalThis, n, { value: v, writable: true, configurable: true }); } };
def('Blob', class Blob { constructor(parts = [], o = {}) { this._parts = parts; this.type = o.type || ''; this.size = parts.reduce((n, p) => n + (typeof p === 'string' ? new TextEncoder().encode(p).length : p.byteLength ?? p.size ?? 0), 0); } async text() { return this._parts.map(p => typeof p === 'string' ? p : new TextDecoder().decode(p)).join(''); } async arrayBuffer() { return new TextEncoder().encode(await this.text()).buffer; } slice() { return this; } });
def('File', class File extends globalThis.Blob { constructor(parts, name, o = {}) { super(parts, o); this.name = name; this.lastModified = o.lastModified ?? Date.now(); } });
def('FormData', class FormData { constructor() { this._m = []; } append(k, v) { this._m.push([k, v]); } get(k) { return (this._m.find(e => e[0] === k) || [])[1] ?? null; } });
def('Headers', class Headers { constructor(init) { this._m = new Map(); if (init) { for (const [k, v] of (Array.isArray(init) ? init : init instanceof Headers ? init._m : Object.entries(init))) { this._m.set(String(k).toLowerCase(), String(v)); } } } get(k) { return this._m.get(String(k).toLowerCase()) ?? null; } set(k, v) { this._m.set(String(k).toLowerCase(), String(v)); } has(k) { return this._m.has(String(k).toLowerCase()); } append(k, v) { this.set(k, v); } delete(k) { this._m.delete(String(k).toLowerCase()); } forEach(f) { this._m.forEach((v, k) => f(v, k, this)); } [Symbol.iterator]() { return this._m.entries(); } });
def('Request', stub('Request')); def('Response', stub('Response'));
def('fetch', async (u) => { throw new TypeError('fetch failed: network access is not implemented in this host (' + u + ')'); });
def('WebSocket', stub('WebSocket')); def('Worker', stub('Worker')); def('BroadcastChannel', class BroadcastChannel { constructor(n) { this.name = n; } postMessage() { } close() { } addEventListener() { } removeEventListener() { } });
def('DOMException', class DOMException extends Error { constructor(m = '', name = 'Error') { super(m); this.name = name; } });
def('structuredClone', (v) => JSON.parse(JSON.stringify(v)));
def('Event', class Event { constructor(type, o = {}) { this.type = type; this.defaultPrevented = false; this.cancelable = !!o.cancelable; this.bubbles = !!o.bubbles; this.timeStamp = Date.now(); } preventDefault() { if (this.cancelable) { this.defaultPrevented = true; } } stopPropagation() { } stopImmediatePropagation() { this._stop = true; } });
def('EventTarget', class EventTarget { constructor() { this._l = new Map(); } addEventListener(t, f, o) { let l = this._l.get(t); if (!l) { l = []; this._l.set(t, l); } if (!l.some(x => x.f === f)) { l.push({ f, once: !!(o && o.once) }); } } removeEventListener(t, f) { const l = this._l.get(t); if (l) { const i = l.findIndex(x => x.f === f); if (i >= 0) { l.splice(i, 1); } } } dispatchEvent(ev) { ev.target = this; for (const x of [...(this._l.get(ev.type) || [])]) { if (x.once) { this.removeEventListener(ev.type, x.f); } typeof x.f === 'function' ? x.f.call(this, ev) : x.f.handleEvent(ev); if (ev._stop) { break; } } const h = this['on' + ev.type]; if (typeof h === 'function') { h.call(this, ev); } return !ev.defaultPrevented; } });
def('AbortSignal', class AbortSignal extends globalThis.EventTarget {
	constructor() { super(); this.aborted = false; this.reason = undefined; }
	throwIfAborted() { if (this.aborted) { throw this.reason; } }
	static abort(reason) { const s = new AbortSignal(); s.aborted = true; s.reason = reason ?? new DOMException('This operation was aborted', 'AbortError'); return s; }
	static timeout(ms) { const s = new AbortSignal(); setTimeout(() => s._abort(new DOMException('The operation timed out.', 'TimeoutError')), ms); return s; }
	static any(signals) { const s = new AbortSignal(); for (const x of signals) { if (x.aborted) { s._abort(x.reason); break; } x.addEventListener('abort', () => s._abort(x.reason)); } return s; }
	_abort(reason) { if (this.aborted) { return; } this.aborted = true; this.reason = reason ?? new DOMException('This operation was aborted', 'AbortError'); this.dispatchEvent(new Event('abort')); }
});
def('AbortController', class AbortController { constructor() { this.signal = new AbortSignal(); } abort(reason) { this.signal._abort(reason); } });
def('MessagePort', class MessagePort extends globalThis.EventTarget { postMessage() { } start() { } close() { } });
def('MessageChannel', class MessageChannel { constructor() { this.port1 = new MessagePort(); this.port2 = new MessagePort(); } });
def('MessageEvent', class MessageEvent extends globalThis.Event { constructor(t, o = {}) { super(t, o); this.data = o.data; this.origin = o.origin ?? ''; this.ports = o.ports ?? []; this.source = o.source ?? null; } });
def('CloseEvent', class CloseEvent extends globalThis.Event { constructor(t, o = {}) { super(t, o); this.code = o.code ?? 0; this.reason = o.reason ?? ''; this.wasClean = !!o.wasClean; } });
def('ErrorEvent', class ErrorEvent extends globalThis.Event { constructor(t, o = {}) { super(t, o); this.message = o.message ?? ''; this.error = o.error; } });
def('CustomEvent', class CustomEvent extends globalThis.Event { constructor(t, o = {}) { super(t, o); this.detail = o.detail ?? null; } });
