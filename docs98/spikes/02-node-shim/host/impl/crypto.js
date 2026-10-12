// `crypto` for the host: hashes (md5, sha1, sha256, sha512) and HMAC in plain JavaScript, randomness from /dev/urandom. Enough for what VS Code's main/shared/extension host use
// (workspace ids, cache keys, tokens, websocket handshakes); ciphers, key derivation and the web crypto API are not implemented.
import * as std from 'qjs:std';

const toBytes = (d, enc) => typeof d === 'string' ? (enc === 'hex' ? Uint8Array.from(d.match(/../g) || [], h => parseInt(h, 16)) : enc === 'base64' ? Uint8Array.from(atob(d), c => c.charCodeAt(0)) : new TextEncoder().encode(d)) : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
const rotl = (x, n) => (x << n) | (x >>> (32 - n)), rotr = (x, n) => (x >>> n) | (x << (32 - n));
function pad(bytes, bigEndian, blockSize = 64, lenBytes = 8) {
	const n = bytes.length, total = Math.ceil((n + 1 + lenBytes) / blockSize) * blockSize; const out = new Uint8Array(total); out.set(bytes); out[n] = 0x80;
	const bits = n * 8, view = new DataView(out.buffer);
	if (bigEndian) { view.setUint32(total - 4, bits >>> 0); view.setUint32(total - 8, Math.floor(bits / 4294967296)); } else { view.setUint32(total - 8, bits >>> 0, true); view.setUint32(total - 4, Math.floor(bits / 4294967296), true); }
	return out;
}
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
function md5(bytes) {
	const m = pad(bytes, false), v = new DataView(m.buffer); let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
	for (let o = 0; o < m.length; o += 64) {
		let A = a0, B = b0, C = c0, D = d0;
		for (let i = 0; i < 64; i++) {
			let F, g; if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
			F = (F + A + MD5_K[i] + v.getUint32(o + g * 4, true)) | 0; A = D; D = C; C = B; B = (B + rotl(F, MD5_S[i])) | 0;
		}
		a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
	}
	const out = new Uint8Array(16), ov = new DataView(out.buffer); ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true); return out;
}
function sha1(bytes) {
	const m = pad(bytes, true), v = new DataView(m.buffer); let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0; const w = new Int32Array(80);
	for (let o = 0; o < m.length; o += 64) {
		for (let i = 0; i < 16; i++) { w[i] = v.getInt32(o + i * 4); } for (let i = 16; i < 80; i++) { w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1); }
		let a = h0, b = h1, c = h2, d = h3, e = h4;
		for (let i = 0; i < 80; i++) { let f, k; if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; } else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; } else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; } else { f = b ^ c ^ d; k = 0xCA62C1D6; } const t = (rotl(a, 5) + f + e + k + w[i]) | 0; e = d; d = c; c = rotl(b, 30); b = a; a = t; }
		h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
	}
	const out = new Uint8Array(20), ov = new DataView(out.buffer); [h0, h1, h2, h3, h4].forEach((h, i) => ov.setInt32(i * 4, h)); return out;
}
const K256 = Int32Array.from([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
function sha256(bytes) {
	const m = pad(bytes, true), v = new DataView(m.buffer); const h = Int32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]); const w = new Int32Array(64);
	for (let o = 0; o < m.length; o += 64) {
		for (let i = 0; i < 16; i++) { w[i] = v.getInt32(o + i * 4); }
		for (let i = 16; i < 64; i++) { const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0; }
		let [a, b, c, d, e, f, g, hh] = h;
		for (let i = 0; i < 64; i++) { const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g), t1 = (hh + S1 + ch + K256[i] + w[i]) | 0, S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), mj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + mj) | 0; hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0; }
		h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
	}
	const out = new Uint8Array(32), ov = new DataView(out.buffer); for (let i = 0; i < 8; i++) { ov.setInt32(i * 4, h[i]); } return out;
}
const K512 = [0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn, 0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n, 0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n, 0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n, 0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n, 0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n, 0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n, 0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n, 0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn, 0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn, 0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n, 0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n, 0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n, 0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n, 0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn, 0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn, 0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n, 0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn, 0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn, 0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n];
function sha512(bytes) {
	const m = pad(bytes, true, 128, 16), v = new DataView(m.buffer); const M = (1n << 64n) - 1n; const r = (x, n) => ((x >> n) | (x << (64n - n))) & M;
	const h = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n, 0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n]; const w = new Array(80);
	for (let o = 0; o < m.length; o += 128) {
		for (let i = 0; i < 16; i++) { w[i] = v.getBigUint64(o + i * 8); }
		for (let i = 16; i < 80; i++) { const s0 = r(w[i - 15], 1n) ^ r(w[i - 15], 8n) ^ (w[i - 15] >> 7n), s1 = r(w[i - 2], 19n) ^ r(w[i - 2], 61n) ^ (w[i - 2] >> 6n); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M; }
		let [a, b, c, d, e, f, g, hh] = h;
		for (let i = 0; i < 80; i++) { const S1 = r(e, 14n) ^ r(e, 18n) ^ r(e, 41n), ch = (e & f) ^ (~e & M & g), t1 = (hh + S1 + ch + K512[i] + w[i]) & M, S0 = r(a, 28n) ^ r(a, 34n) ^ r(a, 39n), mj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + mj) & M; hh = g; g = f; f = e; e = (d + t1) & M; d = c; c = b; b = a; a = (t1 + t2) & M; }
		[a, b, c, d, e, f, g, hh].forEach((x, i) => { h[i] = (h[i] + x) & M; });
	}
	const out = new Uint8Array(64), ov = new DataView(out.buffer); h.forEach((x, i) => ov.setBigUint64(i * 8, x)); return out;
}
const ALGS = { md5: [md5, 64], sha1: [sha1, 64], sha256: [sha256, 64], sha512: [sha512, 128] };
const alg = (name) => { const a = ALGS[String(name).toLowerCase().replace('-', '')]; if (!a) { throw new Error(`Digest method not supported: ${name}`); } return a; };
const concat = (parts) => { const n = parts.reduce((s, p) => s + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
function format(bytes, enc) {
	if (enc === 'hex') { let s = ''; for (const b of bytes) { s += HEX[b]; } return s; }
	if (enc === 'base64' || enc === 'base64url') { let s = ''; for (const b of bytes) { s += String.fromCharCode(b); } const b64 = btoa(s); return enc === 'base64url' ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64; }
	if (enc === 'latin1' || enc === 'binary') { let s = ''; for (const b of bytes) { s += String.fromCharCode(b); } return s; }
	return globalThis.Buffer ? globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
}
export function createHash(name) { const [fn] = alg(name); const parts = []; const h = { update(d, enc) { parts.push(toBytes(d, enc)); return h; }, digest(enc) { return format(fn(concat(parts)), enc); }, copy() { const c = createHash(name); for (const p of parts) { c.update(p); } return c; } }; return h; }
export function createHmac(name, key) {
	const [fn, block] = alg(name); let k = toBytes(key); if (k.length > block) { k = fn(k); } const kp = new Uint8Array(block); kp.set(k); const parts = [];
	const h = { update(d, enc) { parts.push(toBytes(d, enc)); return h; }, digest(enc) { const ip = kp.map(b => b ^ 0x36), op = kp.map(b => b ^ 0x5c); return format(fn(concat([op, fn(concat([ip, ...parts]))])), enc); } }; return h;
}
let urandom; const rnd = (n) => { urandom ??= std.open('/dev/urandom', 'rb'); const ab = new ArrayBuffer(n); if (urandom) { urandom.read(ab, 0, n); } else { const v = new Uint8Array(ab); for (let i = 0; i < n; i++) { v[i] = Math.floor(Math.random() * 256); } } return new Uint8Array(ab); };
export function randomBytes(n, cb) { const b = rnd(n); const out = globalThis.Buffer ? globalThis.Buffer.from(b.buffer) : b; if (cb) { queueMicrotask(() => cb(null, out)); return; } return out; }
export function randomUUID() { const b = rnd(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const h = format(b, 'hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }
export function randomInt(a, b) { const [lo, hi] = b === undefined ? [0, a] : [a, b]; const x = new DataView(rnd(4).buffer).getUint32(0); return lo + (x % (hi - lo)); }
export function getRandomValues(arr) { const r = rnd(arr.byteLength); new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(r); return arr; }
export function timingSafeEqual(a, b) { if (a.length !== b.length) { throw new RangeError('Input buffers must have the same byte length'); } let d = 0; for (let i = 0; i < a.length; i++) { d |= a[i] ^ b[i]; } return d === 0; }
export function getHashes() { return Object.keys(ALGS); }
export const webcrypto = { getRandomValues, randomUUID, subtle: {} };
export const constants = {};
export default { createHash, createHmac, randomBytes, randomUUID, randomInt, getRandomValues, timingSafeEqual, getHashes, webcrypto, constants };
