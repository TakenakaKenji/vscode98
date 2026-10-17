// Oracle for the native base64 of 05-child-process/host/b64_98.h: same results as codec98.js's JS loops, for every length 0..2000, every byte value,
import * as std from 'qjs:std';
// views with offsets, ArrayBuffers, odd-length and padded strings; then the speed of both on 4 MB.
import { toBase64, fromBase64, toBase64Js, fromBase64Js } from '../host/codec98.js';
let bad = 0; const fail = (m) => { if (bad++ < 10) { print('FAIL ' + m); } };
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
if (toBase64 === toBase64Js || fromBase64 === fromBase64Js) { print('FAIL the host has no native base64'); std.exit(1); }
let seed = 1; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
for (let n = 0; n <= 2000; n++) {
	const u = new Uint8Array(n + 7); for (let i = 0; i < u.length; i++) { u[i] = n < 256 ? (i + n) & 255 : rnd(); }
	const v = new Uint8Array(u.buffer, 3, n);
	const a = toBase64(v), b = toBase64Js(v); if (a !== b) { fail(`encode n=${n}`); continue; }
	if (!eq(fromBase64(a), fromBase64Js(b)) || !eq(fromBase64(a), v)) { fail(`decode n=${n}`); }
}
{ const ab = new Uint8Array([1, 2, 3, 250, 251]).buffer; if (toBase64(ab) !== toBase64Js(new Uint8Array(ab))) { fail('ArrayBuffer'); } }
{ const f = new Float64Array([Math.PI, -1e300]); const u = new Uint8Array(f.buffer); if (toBase64(f) !== toBase64Js(u)) { fail('Float64Array'); } }
for (const s of ['é', 'éé==', 'a😀bc', '😀😀😀😀', '', 'A', 'AB', 'ABC', 'ABCD', 'ABCDE', 'ABCDEF', 'ABCDEFG', 'QQ==', 'QUI=', 'QQ', 'Q===', '====', '!!!!', 'é€AB', 'AAAA\nBBBB'] ) {
	const a = fromBase64(s), b = fromBase64Js(s); if (!eq(a, b)) { fail(`decode '${s}': ${[...a]} vs ${[...b]}`); }
}
const big = new Uint8Array(4 << 20); for (let i = 0; i < big.length; i++) { big[i] = rnd(); }
const time = (f) => { const t = Date.now(); const r = f(); return [Date.now() - t, r]; };
const [te, s1] = time(() => toBase64(big)), [tj, s2] = time(() => toBase64Js(big));
const [de, d1] = time(() => fromBase64(s1)), [dj, d2] = time(() => fromBase64Js(s2));
if (s1 !== s2 || !eq(d1, big) || !eq(d2, big)) { fail('4 MB round trip'); }
print(`4 MB: encode native ${te} ms, JS ${tj} ms; decode native ${de} ms, JS ${dj} ms`);
print(bad ? `SUMMARY ${bad} failed` : 'SUMMARY all passed');
