// Software painter for the rendering spike: walks the laid-out box tree in (approximate) CSS paint order and draws into an RGBA framebuffer:
// backgrounds (with border-radius), solid borders, inline-box backgrounds, text (glyph outlines from opentype.js rasterised with an analytic coverage accumulator and
// cached per font/glyph/size/sub-pixel offset), underline/line-through, overflow clipping, scroll offsets, translate/scale transforms (translation exact), group opacity.
// Not painted (recorded in `unpainted`): gradients, images, canvas, box-shadow, outlines, rounded borders, text-shadow, filters, blend modes.
import { resolveFont, advance, fontMetrics, kern } from './fonts.js';
import { parseContent } from './layout.js';
import { paintTextControl, paintSelect } from './textcontrol.js';
import { isHoisted, itemsOf, clipApplies, pathBetween } from './stacking.js';
import { textNodesOf } from './dom.js';

export const unpainted = new Map();
const note = (k) => unpainted.set(k, (unpainted.get(k) || 0) + 1);

export let textGamma = 1; const GAMMA = new Uint8Array(256); export function setTextGamma(g) { textGamma = g; for (let i = 0; i < 256; i++) { GAMMA[i] = Math.round(255 * Math.pow(i / 255, g)); } } setTextGamma(1);
class Surface {
	constructor(w, h) { this.w = w; this.h = h; this.px = new Uint8ClampedArray(w * h * 4); }
	fill(r, g, b, a) { for (let i = 0; i < this.px.length; i += 4) { this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b; this.px[i + 3] = a; } }
}
// blend src (r,g,b with alpha a in 0..1) over the pixel at index i
function blend(px, i, r, g, b, a) {
	if (a <= 0) { return; }
	if (a >= 1) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; return; }
	if (px[i + 3] === 255) { const ia = 1 - a; px[i] = r * a + px[i] * ia; px[i + 1] = g * a + px[i + 1] * ia; px[i + 2] = b * a + px[i + 2] * ia; return; }
	const da = px[i + 3] / 255; const oa = a + da * (1 - a);
	if (oa <= 0) { return; }
	px[i] = (r * a + px[i] * da * (1 - a)) / oa; px[i + 1] = (g * a + px[i + 1] * da * (1 - a)) / oa; px[i + 2] = (b * a + px[i + 2] * da * (1 - a)) / oa; px[i + 3] = oa * 255;
}
/** The JavaScript software backend: executes drawing operations immediately into an RGBA surface. A second backend (native/render.js) records the same operations as a display list for the C rasterizer. */
export class JsBackend {
	constructor(w, h) { this.S = new Surface(w, h); this.S.fill(255, 255, 255, 255); this.clipStack = [[0, 0, w, h]]; this.glyphCache = new Map(); this.layers = []; this.stats = { rects: 0, glyphs: 0, glyphMisses: 0 }; }
	get pixels() { return this.S.px; }
	finish() { return this.S.px; }
	get clip() { return this.clipStack[this.clipStack.length - 1]; }
	pushClip(x0, y0, x1, y1) { const c = this.clip; this.clipStack.push([Math.max(c[0], x0), Math.max(c[1], y0), Math.min(c[2], x1), Math.min(c[3], y1)]); }
	popClip() { this.clipStack.pop(); }
	resetClip() { this.clipStack.push([0, 0, this.S.w, this.S.h]); }   // a fixed box ignores the overflow clips of its ancestors
	fillRect(x, y, w, h, color, alphaMul = 1) {
		if (!color || color[3] <= 0 || w <= 0 || h <= 0) { return; } this.stats.rects++;
		const c = this.clip; const x0 = Math.max(c[0], x), y0 = Math.max(c[1], y), x1 = Math.min(c[2], x + w), y1 = Math.min(c[3], y + h); if (x1 <= x0 || y1 <= y0) { return; }
		const S = this.S, px = S.px, W = S.w; const cr = color[0], cg = color[1], cb = color[2], ca = color[3] * alphaMul;
		// interior pixels with full coverage take a fast path (opaque: plain stores; translucent: constant-alpha blend); the 1px fringe keeps per-pixel coverage
		const fx0 = Math.ceil(x0), fx1 = Math.floor(x1), fy0 = Math.ceil(y0), fy1 = Math.floor(y1);
		if (fx1 > fx0 && fy1 > fy0) {
			if (ca >= 1) { for (let yy = fy0; yy < fy1; yy++) { let i = (yy * W + fx0) * 4; for (let xx = fx0; xx < fx1; xx++, i += 4) { px[i] = cr; px[i + 1] = cg; px[i + 2] = cb; px[i + 3] = 255; } } }
			else { for (let yy = fy0; yy < fy1; yy++) { let i = (yy * W + fx0) * 4; for (let xx = fx0; xx < fx1; xx++, i += 4) { blend(px, i, cr, cg, cb, ca); } } }
		}
		const edge = (xa, ya, xb, yb) => { for (let yy = ya; yy < yb; yy++) { const cy = Math.min(yy + 1, y1) - Math.max(yy, y0); if (cy <= 0) { continue; } for (let xx = xa; xx < xb; xx++) { const cx = Math.min(xx + 1, x1) - Math.max(xx, x0); const cov = cx * cy; if (cov > 0) { blend(px, (yy * W + xx) * 4, cr, cg, cb, ca * cov); } } } };
		const ix0 = Math.floor(x0), iy0 = Math.floor(y0), ix1 = Math.ceil(x1), iy1 = Math.ceil(y1);
		if (fx1 > fx0 && fy1 > fy0) { edge(ix0, iy0, ix1, fy0); edge(ix0, fy1, ix1, iy1); edge(ix0, fy0, fx0, fy1); edge(fx1, fy0, ix1, fy1); } else { edge(ix0, iy0, ix1, iy1); }
	}
	fillRoundRect(x, y, w, h, radii, color, alphaMul = 1) {   // radii: [tl, tr, br, bl] in px
		if (!color || color[3] <= 0 || w <= 0 || h <= 0) { return; } if (!radii || radii.every(r => r <= 0)) { return this.fillRect(x, y, w, h, color, alphaMul); }
		const S = this.S, px = S.px, c = this.clip; const x0 = Math.max(c[0], x), y0 = Math.max(c[1], y), x1 = Math.min(c[2], x + w), y1 = Math.min(c[3], y + h);
		const rmax = Math.min(w, h) / 2; const [tl, tr, br, bl] = radii.map(r => Math.min(r, rmax));
		for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
			const cxp = xx + 0.5, cyp = yy + 0.5; let r = 0, ox = 0, oy = 0;
			if (cxp < x + tl && cyp < y + tl) { r = tl; ox = x + tl; oy = y + tl; } else if (cxp > x + w - tr && cyp < y + tr) { r = tr; ox = x + w - tr; oy = y + tr; } else if (cxp > x + w - br && cyp > y + h - br) { r = br; ox = x + w - br; oy = y + h - br; } else if (cxp < x + bl && cyp > y + h - bl) { r = bl; ox = x + bl; oy = y + h - bl; }
			let cov = 1; if (r > 0) { const d = Math.hypot(cxp - ox, cyp - oy); cov = Math.max(0, Math.min(1, r - d + 0.5)); }
			const ex = Math.min(xx + 1, x1) - Math.max(xx, x0), ey = Math.min(yy + 1, y1) - Math.max(yy, y0); cov *= ex * ey; if (cov > 0) { blend(px, (yy * S.w + xx) * 4, color[0], color[1], color[2], color[3] * alphaMul * cov); }
		}
	}
	// ---- glyphs
	glyph(font, cp, size, fx) {
		const key = font.__path + '|' + cp + '|' + size + '|' + fx; let g = this.glyphCache.get(key); if (g) { return g; } this.stats.glyphMisses++;
		const glyph = font.charToGlyph(String.fromCodePoint(cp)); const path = glyph.getPath(fx, 0, size); const edges = []; let sx = 0, sy = 0, cx = 0, cy = 0;
		const line = (x0, y0, x1, y1) => { if (y0 !== y1) { edges.push([x0, y0, x1, y1]); } };
		const quad = (x0, y0, x1, y1, x2, y2) => { const n = 8; let px = x0, py = y0; for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; const x = u * u * x0 + 2 * u * t * x1 + t * t * x2, y = u * u * y0 + 2 * u * t * y1 + t * t * y2; line(px, py, x, y); px = x; py = y; } };
		const cubic = (x0, y0, x1, y1, x2, y2, x3, y3) => { const n = 10; let px = x0, py = y0; for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; const x = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, y = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3; line(px, py, x, y); px = x; py = y; } };
		for (const c of path.commands) { switch (c.type) { case 'M': if (cx !== sx || cy !== sy) { line(cx, cy, sx, sy); } sx = cx = c.x; sy = cy = c.y; break; case 'L': line(cx, cy, c.x, c.y); cx = c.x; cy = c.y; break; case 'Q': quad(cx, cy, c.x1, c.y1, c.x, c.y); cx = c.x; cy = c.y; break; case 'C': cubic(cx, cy, c.x1, c.y1, c.x2, c.y2, c.x, c.y); cx = c.x; cy = c.y; break; case 'Z': line(cx, cy, sx, sy); cx = sx; cy = sy; break; } }
		if (cx !== sx || cy !== sy) { line(cx, cy, sx, sy); }      // CFF outlines (Inter) have no explicit Z: close the last contour
		if (!edges.length) { g = { empty: true }; this.glyphCache.set(key, g); return g; }
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; for (const e of edges) { minX = Math.min(minX, e[0], e[2]); maxX = Math.max(maxX, e[0], e[2]); minY = Math.min(minY, e[1], e[3]); maxY = Math.max(maxY, e[1], e[3]); }
		const left = Math.floor(minX) - 1, top = Math.floor(minY) - 1, w = Math.ceil(maxX) + 1 - left, h = Math.ceil(maxY) + 1 - top;
		// non-zero winding rule by scanline sampling (4 sub-scanlines per pixel, exact horizontal span coverage): fonts such as Inter keep overlapping contours,
		// which a signed-area accumulator would cancel into holes
		const cov = new Uint8Array(w * h); const SUB = 4; const rowAcc = new Float32Array(w + 1);
		const E = edges.map(([x0r, y0r, x1r, y1r]) => (y0r < y1r ? { x0: x0r - left, y0: y0r - top, x1: x1r - left, y1: y1r - top, dir: 1 } : { x0: x1r - left, y0: y1r - top, x1: x0r - left, y1: y0r - top, dir: -1 }));
		E.forEach(e => { e.dxdy = (e.x1 - e.x0) / (e.y1 - e.y0); });
		for (let y = 0; y < h; y++) {
			rowAcc.fill(0);
			for (let sy = 0; sy < SUB; sy++) {
				const ys = y + (sy + 0.5) / SUB; const xs = [];
				for (const e of E) { if (ys >= e.y0 && ys < e.y1) { xs.push([e.x0 + (ys - e.y0) * e.dxdy, e.dir]); } }
				if (xs.length < 2) { continue; } xs.sort((p, q) => p[0] - q[0]);
				let wind = 0;
				for (let i = 0; i < xs.length - 1; i++) {
					wind += xs[i][1]; if (wind === 0) { continue; }
					const xa = Math.max(0, xs[i][0]), xb = Math.min(w, xs[i + 1][0]); if (xb <= xa) { continue; }
					const ia = Math.floor(xa), ib = Math.floor(xb);
					if (ia === ib) { rowAcc[ia] += xb - xa; } else { rowAcc[ia] += ia + 1 - xa; for (let xi = ia + 1; xi < ib; xi++) { rowAcc[xi] += 1; } if (ib < w) { rowAcc[ib] += xb - ib; } }
				}
			}
			for (let x = 0; x < w; x++) { cov[y * w + x] = Math.min(255, Math.round(rowAcc[x] / SUB * 255)); }
		}
		g = { left, top, w, h, cov }; this.glyphCache.set(key, g); return g;
	}
	glyphRun(font, size, ls, wsp, x, by, color, alphaMul, text) {
		const S = this.S, c = this.clip; let prevCp = 0;
		for (const ch of text) {
			const cp = ch.codePointAt(0); const adv = advance(font, cp, size); if (ls === 0 && prevCp) { x += kern(font, prevCp, cp, size); } prevCp = cp;
			if (cp !== 32 && cp !== 160 && cp !== 9) {
				const fx = Math.round((x - Math.floor(x)) * 4) / 4; const g = this.glyph(font, cp, size, fx); this.stats.glyphs++;
				if (!g.empty) { const gx = Math.floor(x) + g.left, gy = by + g.top; for (let yy = 0; yy < g.h; yy++) { const py = gy + yy; if (py < c[1] || py >= c[3]) { continue; } for (let xx = 0; xx < g.w; xx++) { const px_ = gx + xx; if (px_ < c[0] || px_ >= c[2]) { continue; } let cv = g.cov[yy * g.w + xx]; if (cv) { cv = GAMMA[cv]; blend(S.px, (py * S.w + px_) * 4, color[0], color[1], color[2], color[3] * alphaMul * cv / 255); } } } }
			}
			x += adv + ls + (cp === 32 ? wsp : 0);
		}
	}
	/** draws a decoded image { w, h, data (RGBA) } scaled into the rectangle (x, y, w, h): bilinear when scaling, clipped */
	drawImage(im, x, y, w, h, alphaMul = 1) {
		if (w <= 0 || h <= 0 || !im) { return; } const c = this.clip; const x0 = Math.max(c[0], Math.round(x)), y0 = Math.max(c[1], Math.round(y)), x1 = Math.min(c[2], Math.round(x + w)), y1 = Math.min(c[3], Math.round(y + h)); if (x1 <= x0 || y1 <= y0) { return; }
		const S = this.S, px = S.px, W = S.w, d = im.data, sx = im.w / w, sy = im.h / h;
		for (let yy = y0; yy < y1; yy++) {
			const fy = Math.min(im.h - 1, Math.max(0, (yy + 0.5 - y) * sy - 0.5)), iy = Math.floor(fy), ty = fy - iy, iy2 = Math.min(iy + 1, im.h - 1);
			for (let xx = x0; xx < x1; xx++) {
				const fx = Math.min(im.w - 1, Math.max(0, (xx + 0.5 - x) * sx - 0.5)), ix = Math.floor(fx), tx = fx - ix, ix2 = Math.min(ix + 1, im.w - 1); const a = (iy * im.w + ix) * 4, b = (iy * im.w + ix2) * 4, c2 = (iy2 * im.w + ix) * 4, e = (iy2 * im.w + ix2) * 4;
				const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty; const al = d[a + 3] * w00 + d[b + 3] * w10 + d[c2 + 3] * w01 + d[e + 3] * w11; if (al <= 0) { continue; }
				const pa = (k) => d[a + k] * d[a + 3] * w00 + d[b + k] * d[b + 3] * w10 + d[c2 + k] * d[c2 + 3] * w01 + d[e + k] * d[e + 3] * w11;   // premultiplied interpolation
				blend(px, (yy * W + xx) * 4, pa(0) / al, pa(1) / al, pa(2) / al, al / 255 * alphaMul);
			}
		}
	}
	pushLayer() { this.layers.push(this.S); this.S = new Surface(this.S.w, this.S.h); }
	popLayer(alpha) { const sub = this.S; this.S = this.layers.pop(); for (let i = 0; i < sub.px.length; i += 4) { if (sub.px[i + 3]) { blend(this.S.px, i, sub.px[i], sub.px[i + 1], sub.px[i + 2], sub.px[i + 3] / 255 * alpha); } } }
}
const SELECTION_BG = [51, 144, 255, 0.45];
class Painter {
	constructor(doc, backend) { this.doc = doc; this.b = backend; }
	get stats() { return this.b.stats; }
	fillRect(x, y, w, h, color, alphaMul = 1) { this.b.fillRect(x, y, w, h, color, alphaMul); }
	fillRoundRect(x, y, w, h, radii, color, alphaMul = 1) { this.b.fillRoundRect(x, y, w, h, radii, color, alphaMul); }
	pushClip(x0, y0, x1, y1) { this.b.pushClip(x0, y0, x1, y1); }
	popClip() { this.b.popClip(); }
	resetClip() { this.b.resetClip(); }
	/** text node -> [from, to) covered by the document selection (computed once per frame; empty when the selection is collapsed) */
	selectedText() {
		if (this.__sel) { return this.__sel; } const sel = this.doc.__selection; this.__sel = new Map();
		if (sel && sel.__an && !sel.isCollapsed) { const r = sel.getRangeAt(0); for (const [n, from, to] of textNodesOf(r.startContainer, r.startOffset, r.endContainer, r.endOffset)) { this.__sel.set(n, [from, to]); } }
		return this.__sel;
	}
	drawText(frag, dx, dy, alphaMul) {
		const v = frag.v, color = v.color; if (!color || color[3] <= 0 || v.visibility === 'hidden') { return; }
		if (frag.node) { const m = this.selectedText(); const sr = m.size && m.get(frag.node); if (sr) { const a = Math.max(sr[0], frag.src), b = Math.min(sr[1], frag.srcEnd); if (a < b) { const n = frag.srcEnd - frag.src; const cut = (o) => (frag.text.length === n ? o - frag.src : Math.round((o - frag.src) * frag.text.length / Math.max(1, n))); const wpre = this.doc.__measure(frag, frag.text.slice(0, cut(a))), wmid = this.doc.__measure(frag, frag.text.slice(cut(a), cut(b))); this.fillRect(frag.ax + dx + wpre, frag.ay + dy, wmid, frag.asc + frag.desc, SELECTION_BG, alphaMul); } } }
		const font = frag.font, size = frag.size, ls = frag.ls; const x = frag.ax + dx; const by = Math.round(frag.abaseline + dy);
		const wsp = typeof v['word-spacing'] === 'number' ? v['word-spacing'] : 0;
		this.b.glyphRun(font, size, ls, wsp, x, by, color, alphaMul, frag.text);
		const tdl = v['text-decoration-line']; if (tdl && tdl !== 'none') { const thick = Math.max(1, Math.round(size / 14)); const w = frag.w; if (tdl.includes('underline')) { this.fillRect(frag.ax + dx, by + Math.round(size * 0.1), w, thick, v['text-decoration-color'] || color, alphaMul); } if (tdl.includes('line-through')) { this.fillRect(frag.ax + dx, by - Math.round(size * 0.3), w, thick, v['text-decoration-color'] || color, alphaMul); } if (tdl.includes('overline')) { this.fillRect(frag.ax + dx, by - frag.asc, w, thick, color, alphaMul); } }
	}
	// ---- boxes
	paintBackgroundAndBorders(b, dx, dy, alphaMul, rectOverride) {
		const v = b.v; if (!v || v.visibility === 'hidden') { return; }
		const x = (rectOverride ? rectOverride.x : b.ax) + dx, y = (rectOverride ? rectOverride.y : b.ay) + dy, w = rectOverride ? rectOverride.w : b.w, h = rectOverride ? rectOverride.h : b.h;
		const radii = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'].map(k => { const r = v[k]; const l = typeof r === 'number' ? r : (r && r.pct !== undefined ? r.pct / 100 * Math.min(w, h) : 0); return l; });
		if (v['background-color'] && v['background-color'][3] > 0) { this.fillRoundRect(x, y, w, h, radii, v['background-color'], alphaMul); }
		if (v['background-image'] && v['background-image'] !== 'none') { this.paintBackgroundImage(b, v, x, y, w, h, alphaMul); }
		if (v['box-shadow'] && v['box-shadow'] !== 'none') { note('box-shadow'); } if (v['outline-style'] && v['outline-style'] !== 'none') { note('outline'); } if (v.filter && v.filter !== 'none') { note('filter'); }
		const bt = b.bt, bb = b.bb, bl = b.bl, br = b.br; if (!(bt || bb || bl || br)) { return; }
		if (radii.some(r => r > 0)) { note('rounded border (drawn square)'); }
		const draw = (side, rx, ry, rw, rh) => { const st = v[`border-${side}-style`]; if (st === 'none' || st === 'hidden') { return; } const col = v[`border-${side}-color`]; if (!col || col === 'currentcolor') { return; } if (st === 'dashed' || st === 'dotted' || st === 'double') { note('border-style ' + st); } this.fillRect(rx, ry, rw, rh, col, alphaMul); };
		draw('top', x, y, w, bt); draw('bottom', x, y + h - bb, w, bb); draw('left', x, y + bt, bl, h - bt - bb); draw('right', x + w - br, y + bt, br, h - bt - bb);
	}
	/** entry point for any box: a position:fixed box is positioned against the viewport, the overflow clips of its ancestors (a menu bar button, say) do not apply to it, only its own */
	paintBox(b, dx, dy, alphaMul) {
		if (b.pos === 'fixed' && b.el) { this.resetClip(); const bc = this.baseClip; if (bc) { this.pushClip(bc[0], bc[1], bc[2], bc[3]); } try { this.paintBox0(b, dx, dy, alphaMul); } finally { if (bc) { this.popClip(); } this.popClip(); } return; }
		this.paintBox0(b, dx, dy, alphaMul);
	}
	/** background-image: url(...) with background-size, -position and -repeat, drawn inside the padding box (gradients are not drawn) */
	paintBackgroundImage(b, v, x, y, w, h, alphaMul) {
		const m = /^url\(\s*(["']?)([\s\S]*?)\1\s*\)/i.exec(String(v['background-image']).trim()); if (!m) { note('gradient background'); return; }
		const im = this.doc.__imageByUrl(m[2]); if (!im) { return; }
		const ax = x + (b.bl || 0), ay = y + (b.bt || 0), aw = w - (b.bl || 0) - (b.br || 0), ah = h - (b.bt || 0) - (b.bb || 0); if (aw <= 0 || ah <= 0) { return; }
		const num = (t, ref) => (t === undefined || t === 'auto' ? null : /%$/.test(t) ? parseFloat(t) / 100 * ref : parseFloat(t) * (/(em|rem)$/.test(t) ? (v['font-size'] || 16) : 1));
		const st = String(v['background-size'] || 'auto').trim().toLowerCase().split(/\s+/); const nw = im.iw || im.w, nh = im.ih || im.h; let iw = nw, ih = nh;
		if (st[0] === 'cover' || st[0] === 'contain') { const k = st[0] === 'cover' ? Math.max(aw / nw, ah / nh) : Math.min(aw / nw, ah / nh); iw = nw * k; ih = nh * k; }
		else { const sw = num(st[0], aw), sh = num(st[1], ah); if (sw !== null && sh !== null) { iw = sw; ih = sh; } else if (sw !== null) { iw = sw; ih = sw * nh / nw; } else if (sh !== null) { ih = sh; iw = sh * nw / nh; } }
		if (iw <= 0 || ih <= 0) { return; }
		const pt = String(v['background-position'] || '0% 0%').trim().toLowerCase().split(/\s+/); const kx = { left: '0%', center: '50%', right: '100%' }, ky = { top: '0%', center: '50%', bottom: '100%' };
		let px = pt[0], py = pt[1]; if (px === 'top' || px === 'bottom') { const t = px; px = py; py = t; } px = kx[px] ?? px; py = ky[py] ?? py ?? '50%'; if (pt.length === 1 && ky[pt[0]] && !kx[pt[0]]) { py = ky[pt[0]]; px = '50%'; }
		const ox = /%$/.test(px) ? (aw - iw) * parseFloat(px) / 100 : parseFloat(px) || 0, oy = /%$/.test(py) ? (ah - ih) * parseFloat(py) / 100 : parseFloat(py) || 0;
		const rep = String(v['background-repeat'] || 'repeat').toLowerCase(); const rx = rep === 'repeat' || rep === 'repeat-x' || rep === 'space' || rep === 'round', ry = rep === 'repeat' || rep === 'repeat-y' || rep === 'space' || rep === 'round';
		const x0 = rx ? ax + ((ox % iw) - iw) % iw : ax + ox, y0 = ry ? ay + ((oy % ih) - ih) % ih : ay + oy;
		this.pushClip(ax, ay, ax + aw, ay + ah); let n = 0;
		try { for (let yy = y0; yy < ay + ah && n < 2500; yy += ry ? ih : 1e9) { for (let xx = x0; xx < ax + aw && n < 2500; xx += rx ? iw : 1e9) { this.b.drawImage(im, xx, yy, iw, ih, alphaMul); n++; } } } finally { this.popClip(); }
	}
	/** an <img>: the decoded picture scaled into the content box */
	paintImage(b, dx, dy, alphaMul) {
		if (b.v.visibility === 'hidden') { return; } const im = this.doc.__imageFor(b.el); if (!im) { return; } const x = b.ax + dx + b.bl + (b.pl || 0), y = b.ay + dy + b.bt + (b.pt || 0), w = b.w - b.hx, h = b.h - b.vy; if (w > 0 && h > 0) { this.b.drawImage(im, x, y, w, h, alphaMul); }
	}
	/** the list marker of a list item: bullet shapes and numbers, outside the content box next to the first line */
	paintMarker(b, dx, dy, alphaMul) {
		const type = b.v['list-style-type'] || 'disc'; if (type === 'none' || b.v.visibility === 'hidden') { return; }
		const first = (n) => { if (n.frags && n.frags.length) { return n.frags[0]; } for (const c of n.children) { if (c.kind === 'text' || c.kind === 'inline') { continue; } const f = first(c); if (f) { return f; } } return null; };
		const fr = first(b); if (!fr || fr.abaseline === undefined) { return; } const size = fr.size, color = b.v.color, by = Math.round(fr.abaseline + dy); const right = b.ax + dx + b.bl + (b.pl || 0) - Math.max(4, Math.round(size * 0.3));
		if (type === 'disc' || type === 'circle' || type === 'square') {
			const d = Math.max(3, Math.round(size * 0.33)), x = right - d, y = by - Math.round(size * 0.3) - Math.round(d / 2) + 1;
			if (type === 'square') { this.fillRect(x, y, d, d, color, alphaMul); } else if (type === 'disc') { this.fillRoundRect(x, y, d, d, [d / 2, d / 2, d / 2, d / 2], color, alphaMul); } else { this.fillRoundRect(x, y, d, d, [d / 2, d / 2, d / 2, d / 2], color, alphaMul); const w = Math.max(1, Math.round(d / 4)); this.fillRoundRect(x + w, y + w, d - 2 * w, d - 2 * w, [d / 2, d / 2, d / 2, d / 2], b.v['background-color'] && b.v['background-color'][3] > 0 ? b.v['background-color'] : [0, 0, 0, 1], alphaMul); }
			return;
		}
		const par = b.el.parentElement; let n = 1; if (par) { const start = parseInt(par.getAttribute('start') || '', 10); if (!Number.isNaN(start)) { n = start; } for (const sib of par.__children) { if (sib === b.el) { break; } if (sib.nodeType === 1 && sib.localName === 'li') { n++; } } }
		const alpha = (k, up) => { let t = ''; for (let i = k; i > 0; i = Math.floor((i - 1) / 26)) { t = String.fromCharCode(97 + ((i - 1) % 26)) + t; } return up ? t.toUpperCase() : t; };
		const roman = (k, up) => { const m = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]; let t = ''; for (const [v, r] of m) { while (k >= v) { t += r; k -= v; } } return up ? t.toUpperCase() : t; };
		const label = (type === 'lower-alpha' || type === 'lower-latin' ? alpha(n, false) : type === 'upper-alpha' || type === 'upper-latin' ? alpha(n, true) : type === 'lower-roman' ? roman(n, false) : type === 'upper-roman' ? roman(n, true) : String(n)) + '. ';
		const w = this.doc.__measure({ font: fr.font, size: fr.size, ls: fr.ls }, label); this.b.glyphRun(fr.font, fr.size, fr.ls, 0, right + Math.max(4, Math.round(size * 0.3)) - w, by, color, alphaMul, label);
	}
	/** the document of an iframe, painted into the content box of the iframe element: clipped to it, with fixed boxes clipped to it too */
	paintFrame(b, dx, dy) {
		const cdoc = b.el.__frame.doc; cdoc.__ensureLayout(); const clay = cdoc.__layout; if (!clay || !clay.rootBox) { return; }
		const x0 = b.ax + dx + b.bl + (b.pl || 0), y0 = b.ay + dy + b.bt + (b.pt || 0), w = b.w - b.hx, h = b.h - b.vy; if (w <= 0 || h <= 0) { return; }
		const sub = new Painter(cdoc, this.b); let clip = [x0, y0, x0 + w, y0 + h]; const bc = this.baseClip; if (bc) { clip = [Math.max(clip[0], bc[0]), Math.max(clip[1], bc[1]), Math.min(clip[2], bc[2]), Math.min(clip[3], bc[3])]; } sub.baseClip = clip;
		this.pushClip(x0, y0, x0 + w, y0 + h); try { paintRoot(sub, cdoc, x0, y0, w, h); } finally { this.popClip(); }
	}
	/** paints a box that is either a stacking context root (it then also paints the positioned boxes and contexts that belong to it) or an atomic positioned/in-flow box */
	paintBox0(b, dx, dy, alphaMul) {
		const v = b.v; if (!v) { return; }
		// transforms: translation is exact; other matrices are approximated by their translation (recorded)
		let tdx = 0, tdy = 0; if (b.matrix) { tdx = b.matrix[4]; tdy = b.matrix[5]; if (b.matrix[0] !== 1 || b.matrix[3] !== 1 || b.matrix[1] || b.matrix[2]) { note('non-translate transform'); } dx += tdx; dy += tdy; }
		const opacity = typeof v.opacity === 'number' ? v.opacity : 1; if (opacity <= 0) { return; }
		const layered = opacity < 1; if (layered) { this.b.pushLayer(); }
		const clips = (v['overflow-x'] !== 'visible' || v['overflow-y'] !== 'visible'); const sx = b.el && b.el.__scrollLeft || 0, sy = b.el && b.el.__scrollTop || 0;
		this.paintBackgroundAndBorders(b, dx, dy, 1);
		if (v.display === 'list-item' && b.el) { this.paintMarker(b, dx, dy, alphaMul); }
		if (b.el && b.el.localName === 'img') { this.paintImage(b, dx, dy, alphaMul); }
		if (b.el && b.el.localName === 'iframe' && b.el.__frame) { this.paintFrame(b, dx, dy); }
		if (b.el && b.el.__tc) { paintTextControl(this, b, dx, dy); } else if (b.el && b.el.__tcSelect) { paintSelect(this, b, dx, dy); }
		const lay = this.doc.__layout; const items = lay ? itemsOf(lay, b) : null; const cdx = dx - sx, cdy = dy - sy;
		if (items) { for (const c of items.neg) { this.paintItem(c, b, dx, dy); } }
		if (clips) { const x0 = b.ax + dx + b.bl, y0 = b.ay + dy + b.bt; this.pushClip(x0, y0, x0 + b.w - b.bl - b.br, y0 + b.h - b.bt - b.bb); }
		// in-flow block-level children (positioned ones belong to a stacking context), then the inline content
		for (const c of b.children) { if (c.kind === 'text' || c.kind === 'inline' || isHoisted(c)) { continue; } this.paintBox(c, cdx, cdy, 1); }
		this.paintInline(b, cdx, cdy);
		if (clips) { this.popClip(); }
		if (items) { for (const c of items.zero) { this.paintItem(c, b, dx, dy); } for (const c of items.pos) { this.paintItem(c, b, dx, dy); } }
		if (layered) { this.b.popLayer(opacity * alphaMul); }
	}
	/** paints one positioned box or context of the stacking context `root` (whose own offset is dx,dy): the overflow clips and scroll offsets of the boxes in between apply to it as they would in the browser */
	paintItem(item, root, dx, dy) {
		let n = 0; let ox = dx, oy = dy;
		if (item.pos === 'fixed') { this.paintBox(item, 0, 0, 1); return; }
		for (const a of pathBetween(root, item)) {
			if (!clipApplies(a, item)) { continue; } const av = a.v; if (!av) { continue; }
			if (av['overflow-x'] !== 'visible' || av['overflow-y'] !== 'visible') { const x0 = a.ax + ox + a.bl, y0 = a.ay + oy + a.bt; this.pushClip(x0, y0, x0 + a.w - a.bl - a.br, y0 + a.h - a.bt - a.bb); n++; }
			ox -= a.el && a.el.__scrollLeft || 0; oy -= a.el && a.el.__scrollTop || 0;
		}
		try { this.paintBox(item, ox, oy, 1); } finally { while (n-- > 0) { this.popClip(); } }
	}
	paintInline(container, dx, dy) {
		// inline element backgrounds/borders (per line rect), then text, then atomic inlines
		const walk = (b) => { for (const c of b.children) { if (c.kind === 'inline' && c.__rects) { const v = c.v; if (v['background-color'] && v['background-color'][3] > 0 || c.bt || c.bb || c.bl || c.br) { c.__rects.rects.forEach((r, i) => { if (r.ax !== undefined) { const rect = { x: r.ax, y: r.ay, w: r.w, h: r.h }; this.paintBackgroundAndBorders(c, dx, dy, 1, rect); } }); } walk(c); } } };
		walk(container);
		for (const f of container.frags || []) { if (f.t === 'text' && f.ax !== undefined) { this.drawText(f, dx, dy, 1); } }
		const atomic = (b) => { for (const c of b.children) { if (c.kind === 'inline-block' && !c.oof && !isHoisted(c)) { this.paintBox(c, dx, dy, 1); } else if (c.kind === 'inline') { atomic(c); } } }; atomic(container);
	}
}
/** Paints the laid-out document through a backend (default: the JS software backend). Returns { px, w, h, stats }. */
/** the canvas background (html or body colour), then the root box, at offset (x, y) inside a w x h viewport */
function paintRoot(p, doc, x, y, w, h) {
	const lay = doc.__layout; const rb = lay.rootBox; let bg = rb.v['background-color']; if (!(bg && bg[3] > 0)) { const body = doc.body && lay.boxOf.get(doc.body); if (body && body.v['background-color'] && body.v['background-color'][3] > 0) { bg = body.v['background-color']; } }
	if (bg && bg[3] > 0) { p.fillRect(x, y, w, h, bg); }
	const saveBg = rb.v['background-color']; rb.v['background-color'] = [0, 0, 0, 0]; const body = doc.body && lay.boxOf.get(doc.body); const saveBodyBg = body && body.v['background-color']; if (body && !(saveBg && saveBg[3] > 0)) { body.v['background-color'] = [0, 0, 0, 0]; }
	p.paintBox(rb, x, y, 1); rb.v['background-color'] = saveBg; if (body && saveBodyBg) { body.v['background-color'] = saveBodyBg; }
}
/** Paints the laid-out document through a backend (default: the JS software backend). Returns { px, w, h, stats }. */
export function paintDocument(doc, width, height, backend = new JsBackend(width, height)) {
	doc.__ensureLayout(); const lay = doc.__layout; const p = new Painter(doc, backend);
	if (!lay.rootBox) { return { px: backend.finish(), w: width, h: height, stats: p.stats }; }
	paintRoot(p, doc, 0, 0, width, height);
	return { px: backend.finish(), w: width, h: height, stats: p.stats };
}
export function toPPM(px, w, h) { const header = `P6\n${w} ${h}\n255\n`; const out = new Uint8Array(header.length + w * h * 3); for (let i = 0; i < header.length; i++) { out[i] = header.charCodeAt(i); } let o = header.length; for (let i = 0; i < w * h; i++) { const a = px[i * 4 + 3] / 255; out[o++] = Math.round(px[i * 4] * a + 255 * (1 - a)); out[o++] = Math.round(px[i * 4 + 1] * a + 255 * (1 - a)); out[o++] = Math.round(px[i * 4 + 2] * a + 255 * (1 - a)); } return out; }
