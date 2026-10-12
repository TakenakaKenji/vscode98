// Minimal `util`: what the extension host and typical extensions call (promisify, inherits, deprecate, debuglog, format, inspect, types, TextEncoder/Decoder).
const custom = Symbol.for('nodejs.util.promisify.custom');
export function promisify(fn) {
	if (fn && fn[custom]) { return fn[custom]; }
	const p = function (...args) { return new Promise((res, rej) => fn.call(this, ...args, (err, ...vals) => err ? rej(err) : res(vals.length > 1 ? vals : vals[0]))); };
	Object.defineProperty(p, 'name', { value: fn.name }); return p;
}
promisify.custom = custom;
export function callbackify(fn) { return function (...a) { const cb = a.pop(); fn.apply(this, a).then(v => queueMicrotask(() => cb(null, v)), e => queueMicrotask(() => cb(e))); }; }
export function inherits(ctor, superCtor) { Object.setPrototypeOf(ctor.prototype, superCtor.prototype); Object.setPrototypeOf(ctor, superCtor); ctor.super_ = superCtor; }
export function deprecate(fn) { return fn; }
export function debuglog() { const f = () => { }; f.enabled = false; return f; }
export function format(f, ...args) {
	if (typeof f !== 'string') { return [f, ...args].map(a => typeof a === 'string' ? a : inspect(a)).join(' '); }
	let i = 0; const out = f.replace(/%[sdifjoO%]/g, m => { if (m === '%%') { return '%'; } if (i >= args.length) { return m; } const a = args[i++]; return m === '%s' ? String(a) : m === '%d' || m === '%i' ? String(Number(a)) : m === '%f' ? String(parseFloat(a)) : m === '%j' ? JSON.stringify(a) : inspect(a); });
	return [out, ...args.slice(i).map(a => typeof a === 'string' ? a : inspect(a))].join(' ');
}
export function inspect(v, opts) { if (typeof v === 'string') { return `'${v}'`; } if (v instanceof Error) { return v.stack || String(v); } try { return JSON.stringify(v, (k, x) => typeof x === 'bigint' ? x + 'n' : typeof x === 'function' ? `[Function ${x.name}]` : x, 2) ?? String(v); } catch { return String(v); } }
inspect.custom = Symbol.for('nodejs.util.inspect.custom');
export function isDeepStrictEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
export const types = { isPromise: (v) => v instanceof Promise, isRegExp: (v) => v instanceof RegExp, isDate: (v) => v instanceof Date, isNativeError: (v) => v instanceof Error, isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView), isUint8Array: (v) => v instanceof Uint8Array, isArrayBuffer: (v) => v instanceof ArrayBuffer, isProxy: () => false };
export const TextEncoder = globalThis.TextEncoder, TextDecoder = globalThis.TextDecoder;
export function stripVTControlCharacters(s) { return String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''); }
export default { promisify, callbackify, inherits, deprecate, debuglog, format, inspect, isDeepStrictEqual, types, TextEncoder, TextDecoder, stripVTControlCharacters };
