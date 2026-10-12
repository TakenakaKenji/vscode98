// IPC between our processes is JSON lines (what QuickJS's fork() IPC and Node's `serialization: 'json'` speak). Binary data (VSBuffer messages, Buffers) has no JSON form,
// so typed arrays travel as { $u8: <base64> } and are revived on the other side. Plain JSON-able values pass through untouched.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const REV = new Uint8Array(128); for (let i = 0; i < 64; i++) { REV[B64.charCodeAt(i)] = i; }
export function toBase64(u8) {
	let out = ''; const n = u8.length; let i = 0;
	for (; i + 2 < n; i += 3) { const v = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2]; out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63]; }
	if (i < n) { const v = (u8[i] << 16) | ((i + 1 < n ? u8[i + 1] : 0) << 8); out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + (i + 1 < n ? B64[(v >> 6) & 63] : '=') + '='; }
	return out;
}
export function fromBase64(s) {
	const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0; const n = (s.length / 4) * 3 - pad; const out = new Uint8Array(n); let o = 0;
	for (let i = 0; i < s.length; i += 4) {
		const v = (REV[s.charCodeAt(i)] << 18) | (REV[s.charCodeAt(i + 1)] << 12) | (REV[s.charCodeAt(i + 2)] << 6) | REV[s.charCodeAt(i + 3)];
		if (o < n) { out[o++] = (v >> 16) & 255; } if (o < n) { out[o++] = (v >> 8) & 255; } if (o < n) { out[o++] = v & 255; }
	}
	return out;
}
/** value -> JSON-safe value (typed arrays and ArrayBuffers become { $u8 }, functions and undefined are dropped, `onLeak(path)` is told about dropped functions) */
export function encode(v, onLeak, path = '', depth = 0) {
	if (typeof v === 'function') { onLeak?.(path); return undefined; }
	if (v === null || typeof v !== 'object') { return v; }
	if (ArrayBuffer.isView(v)) { return { $u8: toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) }; }
	if (v instanceof ArrayBuffer) { return { $u8: toBase64(new Uint8Array(v)) }; }
	if (depth > 60) { return undefined; }
	if (Array.isArray(v)) { return v.map((x, i) => encode(x, onLeak, path + '[' + i + ']', depth + 1) ?? null); }
	if (v.type === 'Buffer' && Array.isArray(v.data)) { return { $u8: toBase64(Uint8Array.from(v.data)) }; }
	const o = {}; for (const k of Object.keys(v)) { const c = encode(v[k], onLeak, path + '.' + k, depth + 1); if (c !== undefined) { o[k] = c; } } return o;
}
export function decode(v) {
	if (v === null || typeof v !== 'object') { return v; }
	if (Array.isArray(v)) { return v.map(decode); }
	if (typeof v.$u8 === 'string' && Object.keys(v).length === 1) { return fromBase64(v.$u8); }
	const o = {}; for (const k of Object.keys(v)) { o[k] = decode(v[k]); } return o;
}
