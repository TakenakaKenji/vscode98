// Display-list recorder + bridge to the native rasterizer (spike:render, render.c). Same drawing interface as JsBackend in 06-rendering/host/dom/paint.js.
// Fonts stay in JavaScript (opentype.js): the first time a glyph or kerning pair appears in a text run its advance, kerning value and outline (font units) are
// handed to C once; after that C needs nothing from JS to draw it.
import * as nr from 'spike:render';
import { nativeFontId, ensureAdvances, ensureOutline } from './native_fonts.js';
import { textGamma } from '../../06-rendering/host/dom/paint.js';

const OP_FILL_RECT = 1, OP_FILL_RRECT = 2, OP_PUSH_CLIP = 3, OP_POP_CLIP = 4, OP_PUSH_LAYER = 5, OP_POP_LAYER = 6, OP_GLYPH_RUN = 7;

export class NativeBackend {
	constructor(w, h) {
		this.w = w; this.h = h; this.pixels = new Uint8ClampedArray(w * h * 4); this.pixels.fill(255);
		this.buf = new Float64Array(1 << 14); this.n = 0; this.stats = { rects: 0, glyphs: 0, glyphMisses: 0 }; this.execMs = 0; this.commands = 0; 
		const g = new Uint8Array(256); for (let i = 0; i < 256; i++) { g[i] = Math.round(255 * Math.pow(i / 255, textGamma)); } nr.setGamma(g);
	}
	reserve(k) { if (this.n + k > this.buf.length) { let len = this.buf.length; while (len < this.n + k) { len *= 2; } const nb = new Float64Array(len); nb.set(this.buf.subarray(0, this.n)); this.buf = nb; } }
	fillRect(x, y, w, h, color, alphaMul = 1) {
		if (!color || color[3] <= 0 || w <= 0 || h <= 0) { return; } this.reserve(10); const b = this.buf; let n = this.n; b[n++] = OP_FILL_RECT; b[n++] = x; b[n++] = y; b[n++] = w; b[n++] = h; b[n++] = color[0]; b[n++] = color[1]; b[n++] = color[2]; b[n++] = color[3]; b[n++] = alphaMul; this.n = n; this.commands++;
	}
	fillRoundRect(x, y, w, h, radii, color, alphaMul = 1) {
		if (!color || color[3] <= 0 || w <= 0 || h <= 0) { return; } if (!radii || radii.every(r => r <= 0)) { return this.fillRect(x, y, w, h, color, alphaMul); }
		this.reserve(14); const b = this.buf; let n = this.n; b[n++] = OP_FILL_RRECT; b[n++] = x; b[n++] = y; b[n++] = w; b[n++] = h; b[n++] = radii[0]; b[n++] = radii[1]; b[n++] = radii[2]; b[n++] = radii[3]; b[n++] = color[0]; b[n++] = color[1]; b[n++] = color[2]; b[n++] = color[3]; b[n++] = alphaMul; this.n = n; this.commands++;
	}
	pushClip(x0, y0, x1, y1) { this.reserve(5); const b = this.buf; let n = this.n; b[n++] = OP_PUSH_CLIP; b[n++] = x0; b[n++] = y0; b[n++] = x1; b[n++] = y1; this.n = n; this.commands++; }
	popClip() { this.reserve(1); this.buf[this.n++] = OP_POP_CLIP; this.commands++; }
	pushLayer() { this.reserve(1); this.buf[this.n++] = OP_PUSH_LAYER; this.commands++; }
	popLayer(alpha) { this.reserve(2); this.buf[this.n++] = OP_POP_LAYER; this.buf[this.n++] = alpha; this.commands++; }
	glyphRun(font, size, ls, wsp, x, by, color, alphaMul, text) {
		const id = nativeFontId(font); ensureAdvances(font, id, text); const cps = []; const out = font.__nout;
		for (const ch of text) { const cp = ch.codePointAt(0); if (cp !== 32 && cp !== 160 && cp !== 9 && !out.has(cp)) { ensureOutline(font, id, cp); } cps.push(cp); }
		this.reserve(13 + cps.length); const b = this.buf; let n = this.n;
		b[n++] = OP_GLYPH_RUN; b[n++] = id; b[n++] = size; b[n++] = ls; b[n++] = wsp; b[n++] = x; b[n++] = by; b[n++] = color[0]; b[n++] = color[1]; b[n++] = color[2]; b[n++] = color[3]; b[n++] = alphaMul; b[n++] = cps.length;
		for (let i = 0; i < cps.length; i++) { b[n++] = cps[i]; } this.n = n; this.commands++;
	}
	finish() { const t = performance.now(); const s = nr.execute(this.pixels, this.w, this.h, this.buf, this.n); this.execMs = performance.now() - t; this.stats = s; return this.pixels; }
}
