import { decodeSvg } from './svg.js';
// Image decoders in plain JavaScript: PNG (all colour types and bit depths, interlaced or not), GIF (first frame), JPEG (baseline and progressive, 8 bit, grey or YCbCr), BMP.
// decodeImage(bytes) -> { w, h, data: Uint8Array RGBA (straight alpha) } or throws. Used by <img> and CSS background images (layout.js asks the document, paint.js draws).

// ---- inflate (RFC 1951) -------------------------------------------------------------------------------------------------------------------
function buildHuffman(lengths, n) {
	const count = new Uint16Array(16), symbol = new Uint16Array(n); for (let i = 0; i < n; i++) { count[lengths[i]]++; } count[0] = 0;
	const offs = new Uint16Array(16); for (let i = 1; i < 16; i++) { offs[i] = offs[i - 1] + count[i - 1]; } for (let i = 0; i < n; i++) { if (lengths[i]) { symbol[offs[lengths[i]]++] = i; } }
	return { count, symbol };
}
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258], LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577], DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
let FIXED = null;
/** raw deflate stream starting at src[start] (after the 2 byte zlib header for PNG) */
export function inflate(src, start = 0, sizeHint = 0) {
	let pos = start, bitBuf = 0, bitCnt = 0, out = new Uint8Array(Math.max(1024, sizeHint)), op = 0;
	const bits = (n) => { while (bitCnt < n) { if (pos >= src.length) { throw new Error('inflate: truncated'); } bitBuf |= src[pos++] << bitCnt; bitCnt += 8; } const v = bitBuf & ((1 << n) - 1); bitBuf >>>= n; bitCnt -= n; return v; };
	const decode = (h) => { let code = 0, first = 0, index = 0; for (let len = 1; len < 16; len++) { code |= bits(1); const count = h.count[len]; if (code - count < first) { return h.symbol[index + (code - first)]; } index += count; first += count; first <<= 1; code <<= 1; } throw new Error('inflate: bad code'); };
	const ensure = (n) => { if (op + n > out.length) { let len = out.length * 2; while (len < op + n) { len *= 2; } const nb = new Uint8Array(len); nb.set(out.subarray(0, op)); out = nb; } };
	let last;
	do {
		last = bits(1); const type = bits(2);
		if (type === 0) { bitBuf = 0; bitCnt = 0; const len = src[pos] | (src[pos + 1] << 8); pos += 4; ensure(len); out.set(src.subarray(pos, pos + len), op); op += len; pos += len; }
		else if (type === 1 || type === 2) {
			let lit, dist;
			if (type === 1) { if (!FIXED) { const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288); FIXED = { lit: buildHuffman(l, 288), dist: buildHuffman(new Uint8Array(30).fill(5), 30) }; } lit = FIXED.lit; dist = FIXED.dist; }
			else {
				const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4; const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]; const lengths = new Uint8Array(320);
				for (let i = 0; i < ncode; i++) { lengths[order[i]] = bits(3); } const lencode = buildHuffman(lengths, 19); lengths.fill(0);
				let idx = 0; while (idx < nlen + ndist) { let sym = decode(lencode); if (sym < 16) { lengths[idx++] = sym; } else { let len = 0, rep; if (sym === 16) { len = lengths[idx - 1]; rep = 3 + bits(2); } else if (sym === 17) { rep = 3 + bits(3); } else { rep = 11 + bits(7); } while (rep--) { lengths[idx++] = len; } } }
				lit = buildHuffman(lengths.subarray(0, nlen), nlen); dist = buildHuffman(lengths.subarray(nlen, nlen + ndist), ndist);
			}
			for (;;) {
				const sym = decode(lit); if (sym < 256) { ensure(1); out[op++] = sym; continue; } if (sym === 256) { break; }
				const s = sym - 257; const len = LBASE[s] + bits(LEXT[s]); const ds = decode(dist); const d = DBASE[ds] + bits(DEXT[ds]); ensure(len); for (let i = 0; i < len; i++) { out[op] = out[op - d]; op++; }
			}
		} else { throw new Error('inflate: bad block'); }
	} while (!last);
	return out.subarray(0, op);
}

// ---- PNG -----------------------------------------------------------------------------------------------------------------------------------
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
function decodePng(b) {
	let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, plte = null, trns = null; const idat = [];
	while (pos + 8 <= b.length) {
		const len = be32(b, pos), type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]), d = b.subarray(pos + 8, pos + 8 + len); pos += 12 + len;
		if (type === 'IHDR') { w = be32(d, 0); h = be32(d, 4); depth = d[8]; ctype = d[9]; interlace = d[12]; } else if (type === 'PLTE') { plte = d; } else if (type === 'tRNS') { trns = d; } else if (type === 'IDAT') { idat.push(d); } else if (type === 'IEND') { break; }
	}
	if (!w || !h) { throw new Error('png: no IHDR'); }
	let total = 0; for (const d of idat) { total += d.length; } const z = new Uint8Array(total); { let o = 0; for (const d of idat) { z.set(d, o); o += d.length; } }
	const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype]; const bpp = Math.max(1, (channels * depth) >> 3); const bitsPerPixel = channels * depth;
	const raw = inflate(z, 2, w * h * 4 + h); const rgba = new Uint8Array(w * h * 4);
	const maxv = (1 << depth) - 1;
	/** unfilters one pass image of pw x ph pixels starting at raw[off]; calls put(x, y, sample reader) */
	const pass = (off, pw, ph, put) => {
		const stride = (pw * bitsPerPixel + 7) >> 3; let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
		for (let y = 0; y < ph; y++) {
			const f = raw[off++]; const line = raw.subarray(off, off + stride); off += stride;
			for (let i = 0; i < stride; i++) {
				const x = line[i], a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0; let v;
				switch (f) { case 0: v = x; break; case 1: v = x + a; break; case 2: v = x + up; break; case 3: v = x + ((a + up) >> 1); break; case 4: { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); break; } default: throw new Error('png: bad filter'); }
				cur[i] = v & 255;
			}
			put(y, cur, pw); const t = prev; prev = cur; cur = t;
		}
		return off;
	};
	const sample = (row, i) => { if (depth === 8) { return row[i]; } if (depth === 16) { return (row[i * 2] << 8) | row[i * 2 + 1]; } const per = 8 / depth; const byte = row[(i / per) | 0]; const shift = 8 - depth * ((i % per) + 1); return (byte >> shift) & maxv; };
	const to8 = (v) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round(v * 255 / maxv));
	const convert = (row, pw, y, xmap) => {
		for (let x = 0; x < pw; x++) {
			const o = (y * w + xmap(x)) * 4;
			switch (ctype) {
				case 0: { const g = sample(row, x); const v = to8(g); rgba[o] = rgba[o + 1] = rgba[o + 2] = v; rgba[o + 3] = trns && ((trns[0] << 8) | trns[1]) === g ? 0 : 255; break; }
				case 2: { const r = sample(row, x * 3), g = sample(row, x * 3 + 1), bl = sample(row, x * 3 + 2); rgba[o] = to8(r); rgba[o + 1] = to8(g); rgba[o + 2] = to8(bl); rgba[o + 3] = trns && ((trns[0] << 8) | trns[1]) === r && ((trns[2] << 8) | trns[3]) === g && ((trns[4] << 8) | trns[5]) === bl ? 0 : 255; break; }
				case 3: { const i = sample(row, x); rgba[o] = plte[i * 3]; rgba[o + 1] = plte[i * 3 + 1]; rgba[o + 2] = plte[i * 3 + 2]; rgba[o + 3] = trns && i < trns.length ? trns[i] : 255; break; }
				case 4: { const v = to8(sample(row, x * 2)); rgba[o] = rgba[o + 1] = rgba[o + 2] = v; rgba[o + 3] = to8(sample(row, x * 2 + 1)); break; }
				case 6: { rgba[o] = to8(sample(row, x * 4)); rgba[o + 1] = to8(sample(row, x * 4 + 1)); rgba[o + 2] = to8(sample(row, x * 4 + 2)); rgba[o + 3] = to8(sample(row, x * 4 + 3)); break; }
			}
		}
	};
	if (!interlace) { pass(0, w, h, (y, row, pw) => convert(row, pw, y, (x) => x)); }
	else {
		const P = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]; let off = 0;
		for (const [x0, y0, dx, dy] of P) { const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy); if (pw <= 0 || ph <= 0) { continue; } off = pass(off, pw, ph, (py, row, n) => convert(row, n, y0 + py * dy, (x) => x0 + x * dx)); }
	}
	return { w, h, data: rgba };
}

// ---- GIF (first frame) ---------------------------------------------------------------------------------------------------------------------
function decodeGif(b) {
	const w = b[6] | (b[7] << 8), h = b[8] | (b[9] << 8); let pos = 13; let gct = null; const flags = b[10]; if (flags & 0x80) { const n = 3 << ((flags & 7) + 1); gct = b.subarray(pos, pos + n); pos += n; }
	let transparent = -1; const rgba = new Uint8Array(w * h * 4);
	while (pos < b.length) {
		const t = b[pos++];
		if (t === 0x21) { const label = b[pos++]; if (label === 0xF9) { const f = b[pos + 1]; if (f & 1) { transparent = b[pos + 4]; } } let sz; while ((sz = b[pos++]) !== 0) { pos += sz; } }
		else if (t === 0x2C) {
			const ix = b[pos] | (b[pos + 1] << 8), iy = b[pos + 2] | (b[pos + 3] << 8), iw = b[pos + 4] | (b[pos + 5] << 8), ih = b[pos + 6] | (b[pos + 7] << 8), lf = b[pos + 8]; pos += 9; let ct = gct; if (lf & 0x80) { const n = 3 << ((lf & 7) + 1); ct = b.subarray(pos, pos + n); pos += n; }
			const minCode = b[pos++]; const chunks = []; let sz; while ((sz = b[pos++]) !== 0) { chunks.push(b.subarray(pos, pos + sz)); pos += sz; } let total = 0; for (const c of chunks) { total += c.length; } const data = new Uint8Array(total); { let o = 0; for (const c of chunks) { data.set(c, o); o += c.length; } }
			const idx = new Uint8Array(iw * ih); const clear = 1 << minCode, eoi = clear + 1; let size = minCode + 1, next = eoi + 1; const prefix = new Uint16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097); let bitBuf = 0, bitCnt = 0, dp = 0, op = 0, old = -1, first = 0;
			while (op < idx.length) {
				while (bitCnt < size && dp < data.length) { bitBuf |= data[dp++] << bitCnt; bitCnt += 8; } if (bitCnt < size) { break; } let code = bitBuf & ((1 << size) - 1); bitBuf >>>= size; bitCnt -= size;
				if (code === clear) { size = minCode + 1; next = eoi + 1; old = -1; continue; } if (code === eoi) { break; }
				if (old === -1) { idx[op++] = suffix[code] = code; old = code; first = code; continue; }
				let inCode = code, sp = 0; if (code >= next) { stack[sp++] = first; code = old; } while (code >= clear) { stack[sp++] = suffix[code]; code = prefix[code]; } first = code; stack[sp++] = first; if (next < 4096) { prefix[next] = old; suffix[next] = first; next++; if ((next & ((1 << size) - 1)) === 0 && size < 12) { size++; } }
				old = inCode; while (sp > 0 && op < idx.length) { idx[op++] = stack[--sp]; }
			}
			const rows = []; if (lf & 0x40) { for (const [s, st] of [[0, 8], [4, 8], [2, 4], [1, 2]]) { for (let y = s; y < ih; y += st) { rows.push(y); } } } else { for (let y = 0; y < ih; y++) { rows.push(y); } }
			for (let r = 0; r < ih; r++) { const y = rows[r] + iy; if (y >= h) { continue; } for (let x = 0; x < iw; x++) { const c = idx[r * iw + x]; const X = x + ix; if (X >= w) { continue; } const o = (y * w + X) * 4; if (c === transparent || !ct) { rgba[o + 3] = 0; continue; } rgba[o] = ct[c * 3]; rgba[o + 1] = ct[c * 3 + 1]; rgba[o + 2] = ct[c * 3 + 2]; rgba[o + 3] = 255; } }
			return { w, h, data: rgba };
		} else if (t === 0x3B) { break; } else { break; }
	}
	throw new Error('gif: no image');
}

// ---- BMP (uncompressed 24/32 bit and 8 bit palette) ----------------------------------------------------------------------------------------
function decodeBmp(b) {
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); const off = dv.getUint32(10, true), hs = dv.getUint32(14, true); const w = dv.getInt32(18, true); let h = dv.getInt32(22, true); const bpp = dv.getUint16(28, true), comp = dv.getUint32(30, true); const flip = h > 0; h = Math.abs(h);
	if (comp !== 0 && comp !== 3) { throw new Error('bmp: compressed'); } const rgba = new Uint8Array(w * h * 4); const stride = ((w * bpp + 31) >> 5) << 2; let pal = null; if (bpp <= 8) { const n = dv.getUint32(46, true) || (1 << bpp); pal = b.subarray(14 + hs, 14 + hs + n * 4); }
	for (let y = 0; y < h; y++) { const sy = flip ? h - 1 - y : y; for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; let r, g, bl, a = 255; if (bpp === 24) { const p = off + sy * stride + x * 3; bl = b[p]; g = b[p + 1]; r = b[p + 2]; } else if (bpp === 32) { const p = off + sy * stride + x * 4; bl = b[p]; g = b[p + 1]; r = b[p + 2]; a = b[p + 3] || 255; } else if (bpp === 8) { const i = b[off + sy * stride + x]; bl = pal[i * 4]; g = pal[i * 4 + 1]; r = pal[i * 4 + 2]; } else { throw new Error('bmp: depth ' + bpp); } rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = bl; rgba[o + 3] = a; } }
	return { w, h, data: rgba };
}

// ---- JPEG ------------------------------------------------------------------------------------------------------------------------------------
const ZZ = new Uint8Array([0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]);
function decodeJpeg(b) {
	let pos = 2; const qt = []; const dcT = [], acT = []; let frame = null, progressive = false, restart = 0, adobe = -1;
	const u16 = () => { const v = (b[pos] << 8) | b[pos + 1]; pos += 2; return v; };
	const buildH = (counts, symbols) => { const codes = []; let code = 0, k = 0; const lookup = new Map(); for (let len = 1; len <= 16; len++) { for (let i = 0; i < counts[len - 1]; i++) { lookup.set((len << 16) | code, symbols[k++]); code++; } code <<= 1; } return lookup; };
	let comps = null; let mcusX = 0, mcusY = 0, hmax = 1, vmax = 1;
	const scans = [];
	while (pos < b.length) {
		if (b[pos] !== 0xFF) { pos++; continue; } let m = b[pos + 1]; pos += 2; if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7) || m === 0xFF) { if (m === 0xFF) { pos--; } continue; } if (m === 0xD9) { break; }
		const len = u16(); const end = pos + len - 2;
		if (m === 0xDB) { while (pos < end) { const pq = b[pos] >> 4, t = b[pos] & 15; pos++; const tbl = new Int32Array(64); for (let i = 0; i < 64; i++) { tbl[ZZ[i]] = pq ? u16() : b[pos++]; } qt[t] = tbl; } }
		else if (m === 0xC4) { while (pos < end) { const tc = b[pos] >> 4, th = b[pos] & 15; pos++; const counts = b.subarray(pos, pos + 16); pos += 16; let n = 0; for (let i = 0; i < 16; i++) { n += counts[i]; } const syms = b.subarray(pos, pos + n); pos += n; (tc ? acT : dcT)[th] = buildH(counts, syms); } }
		else if (m === 0xC0 || m === 0xC1 || m === 0xC2) { progressive = m === 0xC2; const prec = b[pos++]; if (prec !== 8) { throw new Error('jpeg: precision ' + prec); } const h = u16(), w = u16(), nc = b[pos++]; comps = []; for (let i = 0; i < nc; i++) { comps.push({ id: b[pos], h: b[pos + 1] >> 4, v: b[pos + 1] & 15, tq: b[pos + 2] }); pos += 3; } frame = { w, h }; hmax = Math.max(...comps.map((c) => c.h)); vmax = Math.max(...comps.map((c) => c.v)); mcusX = Math.ceil(w / (8 * hmax)); mcusY = Math.ceil(h / (8 * vmax)); for (const c of comps) { c.bw = mcusX * c.h; c.bh = mcusY * c.v; c.coef = new Int16Array(c.bw * c.bh * 64); c.pred = 0; } }
		else if (m === 0xC3 || (m >= 0xC5 && m <= 0xCF && m !== 0xC8 && m !== 0xCC)) { throw new Error('jpeg: unsupported coding'); }
		else if (m === 0xDD) { restart = u16(); }
		else if (m === 0xEE) { if (b[pos] === 0x41 && b[pos + 1] === 0x64) { adobe = b[pos + 11]; } }
		else if (m === 0xDA) {
			const ns = b[pos++]; const sc = []; for (let i = 0; i < ns; i++) { const c = comps.find((x) => x.id === b[pos]); sc.push({ c, dc: b[pos + 1] >> 4, ac: b[pos + 1] & 15 }); pos += 2; } const ss = b[pos++], se = b[pos++], ah = b[pos] >> 4, al = b[pos] & 15; pos++;
			// entropy coded segment: find its end (a marker other than RSTn), unstuff
			const start = pos; let e = pos; while (e < b.length - 1) { if (b[e] === 0xFF && b[e + 1] !== 0 && !(b[e + 1] >= 0xD0 && b[e + 1] <= 0xD7)) { break; } e++; }
			decodeScan(b, start, e, sc, ss, se, ah, al); pos = e; continue;
		}
		pos = end;
	}
	if (!frame) { throw new Error('jpeg: no frame'); }
	function decodeScan(b, p, e, sc, ss, se, ah, al) {
		let bitBuf = 0, bitCnt = 0, eobrun = 0; const readBit = () => { if (bitCnt === 0) { if (p >= e) { return 0; } let v = b[p++]; if (v === 0xFF) { const n = b[p]; if (n === 0) { p++; } else if (n >= 0xD0 && n <= 0xD7) { /* restart handled by caller */ } } bitBuf = v; bitCnt = 8; } bitCnt--; return (bitBuf >> bitCnt) & 1; };
		const receive = (n) => { let v = 0; while (n--) { v = (v << 1) | readBit(); } return v; };
		const extend = (v, n) => (n === 0 ? 0 : v < (1 << (n - 1)) ? v - (1 << n) + 1 : v);
		const decodeH = (h) => { let code = 0; for (let len = 1; len <= 16; len++) { code = (code << 1) | readBit(); const s = h.get((len << 16) | code); if (s !== undefined) { return s; } } throw new Error('jpeg: bad huffman code'); };
		const single = sc.length === 1; const total = single ? Math.ceil(Math.ceil(frame.w * sc[0].c.h / hmax) / 8) * Math.ceil(Math.ceil(frame.h * sc[0].c.v / vmax) / 8) : mcusX * mcusY; const bwS = single ? Math.ceil(Math.ceil(frame.w * sc[0].c.h / hmax) / 8) : 0;
		let n = 0; for (const s of sc) { s.c.pred = 0; }
		const block = (c, tabs, bx, by) => {
			const coef = c.coef, base = (by * c.bw + bx) * 64;
			if (!progressive) {
				const t = decodeH(dcT[tabs.dc]); const diff = t === 0 ? 0 : extend(receive(t), t); c.pred += diff; coef[base] = c.pred; let k = 1;
				while (k < 64) { const rs = decodeH(acT[tabs.ac]); const s = rs & 15, r = rs >> 4; if (s === 0) { if (r < 15) { break; } k += 16; continue; } k += r; if (k > 63) { break; } coef[base + ZZ[k]] = extend(receive(s), s); k++; }
			} else if (ss === 0) {
				if (ah === 0) { const t = decodeH(dcT[tabs.dc]); const diff = t === 0 ? 0 : extend(receive(t), t); c.pred += diff; coef[base] = c.pred << al; } else { if (readBit()) { coef[base] |= 1 << al; } }
			} else if (ah === 0) {
				if (eobrun > 0) { eobrun--; return; } let k = ss;
				while (k <= se) { const rs = decodeH(acT[tabs.ac]); const s = rs & 15, r = rs >> 4; if (s === 0) { if (r < 15) { eobrun = (1 << r) - 1 + (r ? receive(r) : 0); break; } k += 16; continue; } k += r; if (k > 63) { break; } coef[base + ZZ[k]] = extend(receive(s), s) * (1 << al); k++; }
			} else {
				const p1 = 1 << al, m1 = -1 << al; let k = ss;
				if (eobrun <= 0) {
					while (k <= se) {
						const rs = decodeH(acT[tabs.ac]); let s = rs & 15, r = rs >> 4; let val = 0;
						if (s === 0) { if (r < 15) { eobrun = (1 << r) + (r ? receive(r) : 0); break; } } else { val = readBit() ? p1 : m1; }
						while (k <= se) { const z = base + ZZ[k]; if (coef[z] !== 0) { if (readBit() && (coef[z] & p1) === 0) { coef[z] += coef[z] >= 0 ? p1 : m1; } } else { if (r === 0) { if (val) { coef[z] = val; } k++; break; } r--; } k++; }
					}
				}
				if (eobrun > 0) { while (k <= se) { const z = base + ZZ[k]; if (coef[z] !== 0 && readBit() && (coef[z] & p1) === 0) { coef[z] += coef[z] >= 0 ? p1 : m1; } k++; } eobrun--; }
			}
		};
		for (let i = 0; i < total; i++) {
			if (restart && i > 0 && i % restart === 0) { bitCnt = 0; eobrun = 0; while (p < e && !(b[p] === 0xFF && b[p + 1] >= 0xD0 && b[p + 1] <= 0xD7)) { p++; } p += 2; for (const s of sc) { s.c.pred = 0; } }
			if (single) { const c = sc[0].c; block(c, { dc: sc[0].dc, ac: sc[0].ac }, i % bwS, (i / bwS) | 0); }
			else { const mx = i % mcusX, my = (i / mcusX) | 0; for (const s of sc) { for (let v = 0; v < s.c.v; v++) { for (let h = 0; h < s.c.h; h++) { block(s.c, { dc: s.dc, ac: s.ac }, mx * s.c.h + h, my * s.c.v + v); } } } }
		}
	}
	// dequantize + IDCT into component planes
	const C = new Float32Array(64); for (let u = 0; u < 8; u++) { for (let x = 0; x < 8; x++) { C[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos((2 * x + 1) * u * Math.PI / 16) / 2; } }
	const planes = comps.map((c) => {
		const pw = c.bw * 8, ph = c.bh * 8, out = new Uint8Array(pw * ph), q = qt[c.tq], tmp = new Float32Array(64), blk = new Float32Array(64);
		for (let by = 0; by < c.bh; by++) { for (let bx = 0; bx < c.bw; bx++) {
			const base = (by * c.bw + bx) * 64; for (let i = 0; i < 64; i++) { blk[i] = c.coef[base + i] * q[i]; }
			for (let y = 0; y < 8; y++) { for (let x = 0; x < 8; x++) { let s = 0; for (let u = 0; u < 8; u++) { s += C[u * 8 + x] * blk[y * 8 + u]; } tmp[y * 8 + x] = s; } }
			for (let x = 0; x < 8; x++) { for (let y = 0; y < 8; y++) { let s = 0; for (let v = 0; v < 8; v++) { s += C[v * 8 + y] * tmp[v * 8 + x]; } const val = Math.round(s + 128); out[(by * 8 + y) * pw + bx * 8 + x] = val < 0 ? 0 : val > 255 ? 255 : val; } }
		} }
		return { out, pw, c };
	});
	/** a component sample at pixel (x, y): chroma planes of subsampled images are interpolated (libjpeg's "fancy upsampling" is a triangle filter) */
	const sampleUp = (p, x, y) => {
		const fx = p.c.h / hmax, fy = p.c.v / vmax; if (fx === 1 && fy === 1) { return p.out[y * p.pw + x]; }
		const sx = Math.max(0, (x + 0.5) * fx - 0.5), sy = Math.max(0, (y + 0.5) * fy - 0.5); const x0 = Math.floor(sx), y0 = Math.floor(sy); const x1 = Math.min(x0 + 1, p.pw - 1), y1 = Math.min(y0 + 1, p.out.length / p.pw - 1); const ax = sx - x0, ay = sy - y0;
		return (p.out[y0 * p.pw + x0] * (1 - ax) + p.out[y0 * p.pw + x1] * ax) * (1 - ay) + (p.out[y1 * p.pw + x0] * (1 - ax) + p.out[y1 * p.pw + x1] * ax) * ay;
	};
	const { w, h } = frame; const rgba = new Uint8Array(w * h * 4); const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const o = (y * w + x) * 4; const s = planes.map((p) => sampleUp(p, x, y));
			if (planes.length === 1) { rgba[o] = rgba[o + 1] = rgba[o + 2] = s[0]; } else if (planes.length >= 3) { if (adobe === 0 && planes.length === 3) { rgba[o] = s[0]; rgba[o + 1] = s[1]; rgba[o + 2] = s[2]; } else { const Y = s[0], cb = s[1] - 128, cr = s[2] - 128; rgba[o] = clamp(Y + 1.402 * cr); rgba[o + 1] = clamp(Y - 0.344136 * cb - 0.714136 * cr); rgba[o + 2] = clamp(Y + 1.772 * cb); } }
			rgba[o + 3] = 255;
		}
	}
	return { w, h, data: rgba };
}

/** sniffs the format from the first bytes */
export function decodeImage(bytes) {
	const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) { return decodePng(b); }
	if (b[0] === 0xFF && b[1] === 0xD8) { return decodeJpeg(b); }
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) { return decodeGif(b); }
	if (b[0] === 0x42 && b[1] === 0x4D) { return decodeBmp(b); }
	{ let head = ''; for (let k = 0; k < Math.min(b.length, 600); k++) { head += String.fromCharCode(b[k]); } if (/<svg[\s>]/i.test(head)) { return decodeSvg(b, 2); } }   // vector images are rendered at twice their size (layout uses iw/ih)
	throw new Error('unsupported image format');
}
