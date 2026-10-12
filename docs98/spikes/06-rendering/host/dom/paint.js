// Software painter for the rendering spike: walks the laid-out box tree in (approximate) CSS paint order and draws into an RGBA framebuffer:
// backgrounds (with border-radius), solid borders, inline-box backgrounds, text (glyph outlines from opentype.js rasterised with an analytic coverage accumulator and
// cached per font/glyph/size/sub-pixel offset), underline/line-through, overflow clipping, scroll offsets, translate/scale transforms (translation exact), group opacity.
// Not painted (recorded in `unpainted`): gradients, images, canvas, box-shadow, outlines, rounded borders, text-shadow, filters, blend modes.
import { resolveFont, advance, fontMetrics } from './fonts.js';
import { parseContent } from './layout.js';

export const unpainted = new Map();
const note = (k) => unpainted.set(k, (unpainted.get(k) || 0) + 1);

class Surface {
	constructor(w, h) { this.w = w; this.h = h; this.px = new Uint8ClampedArray(w * h * 4); }
	fill(r, g, b, a) { for (let i = 0; i < this.px.length; i += 4) { this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b; this.px[i + 3] = a; } }
}
// blend src (r,g,b with alpha a in 0..1) over the pixel at index i
function blend(px, i, r, g, b, a) {
	if (a <= 0) { return; }
	const da = px[i + 3] / 255; const oa = a + da * (1 - a);
	if (oa <= 0) { return; }
	px[i] = (r * a + px[i] * da * (1 - a)) / oa; px[i + 1] = (g * a + px[i + 1] * da * (1 - a)) / oa; px[i + 2] = (b * a + px[i + 2] * da * (1 - a)) / oa; px[i + 3] = oa * 255;
}
class Painter {
	constructor(doc, w, h) { this.doc = doc; this.S = new Surface(w, h); this.S.fill(255, 255, 255, 255); this.clipStack = [[0, 0, w, h]]; this.glyphCache = new Map(); this.stats = { rects: 0, glyphs: 0, glyphMisses: 0 }; }
	get clip() { return this.clipStack[this.clipStack.length - 1]; }
	pushClip(x0, y0, x1, y1) { const c = this.clip; this.clipStack.push([Math.max(c[0], x0), Math.max(c[1], y0), Math.min(c[2], x1), Math.min(c[3], y1)]); }
	popClip() { this.clipStack.pop(); }
	fillRect(x, y, w, h, color, alphaMul = 1) {
		if (!color || color[3] <= 0 || w <= 0 || h <= 0) { return; } this.stats.rects++;
		const c = this.clip; const x0 = Math.max(c[0], x), y0 = Math.max(c[1], y), x1 = Math.min(c[2], x + w), y1 = Math.min(c[3], y + h); if (x1 <= x0 || y1 <= y0) { return; }
		const S = this.S, px = S.px; const ix0 = Math.floor(x0), iy0 = Math.floor(y0), ix1 = Math.ceil(x1), iy1 = Math.ceil(y1);
		for (let yy = iy0; yy < iy1; yy++) {
			const cy = Math.min(yy + 1, y1) - Math.max(yy, y0); for (let xx = ix0; xx < ix1; xx++) { const cx = Math.min(xx + 1, x1) - Math.max(xx, x0); const cov = cx * cy; if (cov <= 0) { continue; } blend(px, (yy * S.w + xx) * 4, color[0], color[1], color[2], color[3] * alphaMul * cov); }
		}
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
		for (const c of path.commands) { switch (c.type) { case 'M': sx = cx = c.x; sy = cy = c.y; break; case 'L': line(cx, cy, c.x, c.y); cx = c.x; cy = c.y; break; case 'Q': quad(cx, cy, c.x1, c.y1, c.x, c.y); cx = c.x; cy = c.y; break; case 'C': cubic(cx, cy, c.x1, c.y1, c.x2, c.y2, c.x, c.y); cx = c.x; cy = c.y; break; case 'Z': line(cx, cy, sx, sy); cx = sx; cy = sy; break; } }
		if (!edges.length) { g = { empty: true }; this.glyphCache.set(key, g); return g; }
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; for (const e of edges) { minX = Math.min(minX, e[0], e[2]); maxX = Math.max(maxX, e[0], e[2]); minY = Math.min(minY, e[1], e[3]); maxY = Math.max(maxY, e[1], e[3]); }
		const left = Math.floor(minX) - 1, top = Math.floor(minY) - 1, w = Math.ceil(maxX) + 1 - left, h = Math.ceil(maxY) + 1 - top; const acc = new Float32Array(w * h + 2);
		for (const [x0r, y0r, x1r, y1r] of edges) {   // font-rs style signed-area accumulation
			let x0 = x0r - left, y0 = y0r - top, x1 = x1r - left, y1 = y1r - top; let dir = 1; if (y0 > y1) { [x0, y0, x1, y1] = [x1, y1, x0, y0]; dir = -1; }
			const dxdy = (x1 - x0) / (y1 - y0); let x = x0; const yStart = Math.max(0, Math.floor(y0)), yEnd = Math.min(h, Math.ceil(y1));
			if (y0 < 0) { x -= y0 * dxdy; }
			for (let y = yStart; y < yEnd; y++) {
				const dy = Math.min(y + 1, y1) - Math.max(y, y0); const xnext = x + dxdy * dy; const d = dy * dir; let xa = Math.min(x, xnext), xb = Math.max(x, xnext);
				const x0f = Math.floor(xa), x0i = x0f, x1ceil = Math.ceil(xb), x1i = x1ceil; const row = y * w;
				if (x1i <= x0i + 1) { const xmf = 0.5 * (x + xnext) - x0f; acc[row + x0i] += d - d * xmf; acc[row + x0i + 1] += d * xmf; }
				else { const s = 1 / (xb - xa); const x0fr = xa - x0f; const a0 = 0.5 * s * (1 - x0fr) * (1 - x0fr); const x1f = xb - x1ceil + 1; const am = 0.5 * s * x1f * x1f; acc[row + x0i] += d * a0; if (x1i === x0i + 2) { acc[row + x0i + 1] += d * (1 - a0 - am); } else { const a1 = s * (1.5 - x0fr); acc[row + x0i + 1] += d * (a1 - a0); for (let xi = x0i + 2; xi < x1i - 1; xi++) { acc[row + xi] += d * s; } const a2 = a1 + (x1i - x0i - 3) * s; acc[row + x1i - 1] += d * (1 - a2 - am); } acc[row + x1i] += d * am; }
				x = xnext;
			}
		}
		const cov = new Uint8Array(w * h); for (let y = 0; y < h; y++) { let a = 0; for (let x = 0; x < w; x++) { a += acc[y * w + x]; cov[y * w + x] = Math.min(255, Math.round(Math.abs(a) * 255)); } }
		g = { left, top, w, h, cov }; this.glyphCache.set(key, g); return g;
	}
	drawText(frag, dx, dy, alphaMul) {
		const v = frag.v, color = v.color; if (!color || color[3] <= 0 || v.visibility === 'hidden') { return; }
		const font = frag.font, size = frag.size, ls = frag.ls; const S = this.S, c = this.clip; let x = frag.ax + dx; const by = Math.round(frag.abaseline + dy);
		const wsp = typeof v['word-spacing'] === 'number' ? v['word-spacing'] : 0;
		for (const ch of frag.text) {
			const cp = ch.codePointAt(0); const adv = advance(font, cp, size);
			if (cp !== 32 && cp !== 160 && cp !== 9) {
				const fx = Math.round((x - Math.floor(x)) * 4) / 4; const g = this.glyph(font, cp, size, fx); this.stats.glyphs++;
				if (!g.empty) { const gx = Math.floor(x) + g.left, gy = by + g.top; for (let yy = 0; yy < g.h; yy++) { const py = gy + yy; if (py < c[1] || py >= c[3]) { continue; } for (let xx = 0; xx < g.w; xx++) { const px_ = gx + xx; if (px_ < c[0] || px_ >= c[2]) { continue; } const cv = g.cov[yy * g.w + xx]; if (cv) { blend(S.px, (py * S.w + px_) * 4, color[0], color[1], color[2], color[3] * alphaMul * cv / 255); } } } }
			}
			x += adv + ls + (cp === 32 ? wsp : 0);
		}
		const tdl = v['text-decoration-line']; if (tdl && tdl !== 'none') { const thick = Math.max(1, Math.round(size / 14)); const w = frag.w; if (tdl.includes('underline')) { this.fillRect(frag.ax + dx, by + Math.round(size * 0.1), w, thick, v['text-decoration-color'] || color, alphaMul); } if (tdl.includes('line-through')) { this.fillRect(frag.ax + dx, by - Math.round(size * 0.3), w, thick, v['text-decoration-color'] || color, alphaMul); } if (tdl.includes('overline')) { this.fillRect(frag.ax + dx, by - frag.asc, w, thick, color, alphaMul); } }
	}
	// ---- boxes
	paintBackgroundAndBorders(b, dx, dy, alphaMul, rectOverride) {
		const v = b.v; if (!v || v.visibility === 'hidden') { return; }
		const x = (rectOverride ? rectOverride.x : b.ax) + dx, y = (rectOverride ? rectOverride.y : b.ay) + dy, w = rectOverride ? rectOverride.w : b.w, h = rectOverride ? rectOverride.h : b.h;
		const radii = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'].map(k => { const r = v[k]; const l = typeof r === 'number' ? r : (r && r.pct !== undefined ? r.pct / 100 * Math.min(w, h) : 0); return l; });
		if (v['background-color'] && v['background-color'][3] > 0) { this.fillRoundRect(x, y, w, h, radii, v['background-color'], alphaMul); }
		if (v['background-image'] && v['background-image'] !== 'none') { note('background-image'); }
		if (v['box-shadow'] && v['box-shadow'] !== 'none') { note('box-shadow'); } if (v['outline-style'] && v['outline-style'] !== 'none') { note('outline'); } if (v.filter && v.filter !== 'none') { note('filter'); }
		const bt = b.bt, bb = b.bb, bl = b.bl, br = b.br; if (!(bt || bb || bl || br)) { return; }
		if (radii.some(r => r > 0)) { note('rounded border (drawn square)'); }
		const draw = (side, rx, ry, rw, rh) => { const st = v[`border-${side}-style`]; if (st === 'none' || st === 'hidden') { return; } const col = v[`border-${side}-color`]; if (!col || col === 'currentcolor') { return; } if (st === 'dashed' || st === 'dotted' || st === 'double') { note('border-style ' + st); } this.fillRect(rx, ry, rw, rh, col, alphaMul); };
		draw('top', x, y, w, bt); draw('bottom', x, y + h - bb, w, bb); draw('left', x, y + bt, bl, h - bt - bb); draw('right', x + w - br, y + bt, br, h - bt - bb);
	}
	paintBox(b, dx, dy, alphaMul) {
		const v = b.v; if (!v) { return; }
		// transforms: translation is exact; other matrices are approximated by their translation (recorded)
		let tdx = 0, tdy = 0; if (b.matrix) { tdx = b.matrix[4]; tdy = b.matrix[5]; if (b.matrix[0] !== 1 || b.matrix[3] !== 1 || b.matrix[1] || b.matrix[2]) { note('non-translate transform'); } dx += tdx; dy += tdy; }
		const opacity = typeof v.opacity === 'number' ? v.opacity : 1; if (opacity <= 0) { return; }
		let layer = null; if (opacity < 1) { layer = this.S; const sub = new Surface(layer.w, layer.h); this.S = sub; }
		const clips = (v['overflow-x'] !== 'visible' || v['overflow-y'] !== 'visible'); const sx = b.el && b.el.__scrollLeft || 0, sy = b.el && b.el.__scrollTop || 0;
		this.paintBackgroundAndBorders(b, dx, dy, 1);
		if (clips) { const x0 = b.ax + dx + b.bl, y0 = b.ay + dy + b.bt; this.pushClip(x0, y0, x0 + b.w - b.bl - b.br, y0 + b.h - b.bt - b.bb); }
		const cdx = dx - sx, cdy = dy - sy;
		const children = b.children;
		const positioned = [], flow = [];
		for (const c of children) { if (c.kind === 'text') { continue; } if (c.kind === 'inline') { flow.push(c); continue; } ((c.pos !== 'static' || (c.matrix && c.el) || (typeof c.v.opacity === 'number' && c.v.opacity < 1)) ? positioned : flow).push(c); }
		const z = (c) => (typeof c.v['z-index'] === 'number' ? c.v['z-index'] : 0); const zIdx = (c) => (typeof c.v['z-index'] === 'number' ? c.v['z-index'] : null);
		const neg = positioned.filter(c => zIdx(c) !== null && zIdx(c) < 0).sort((a, b2) => z(a) - z(b2)), mid = positioned.filter(c => zIdx(c) === null || zIdx(c) === 0), pos = positioned.filter(c => zIdx(c) !== null && zIdx(c) > 0).sort((a, b2) => z(a) - z(b2));
		const fixedShift = (c) => (c.pos === 'fixed' ? [dx - cdx, dy - cdy] : [0, 0]);
		for (const c of neg) { const [fx, fy] = fixedShift(c); this.paintBox(c, cdx + fx, cdy + fy, 1); }
		// block-level in-flow children, then inline content
		for (const c of flow) { if (c.kind === 'inline') { continue; } this.paintBox(c, cdx, cdy, 1); }
		this.paintInline(b, cdx, cdy);
		for (const c of mid) { const [fx, fy] = fixedShift(c); this.paintBox(c, cdx + fx, cdy + fy, 1); }
		for (const c of pos) { const [fx, fy] = fixedShift(c); this.paintBox(c, cdx + fx, cdy + fy, 1); }
		if (clips) { this.popClip(); }
		if (layer) { const sub = this.S; this.S = layer; const a = opacity * alphaMul; for (let i = 0; i < sub.px.length; i += 4) { if (sub.px[i + 3]) { blend(this.S.px, i, sub.px[i], sub.px[i + 1], sub.px[i + 2], sub.px[i + 3] / 255 * a); } } }
	}
	paintInline(container, dx, dy) {
		// inline element backgrounds/borders (per line rect), then text, then atomic inlines
		const walk = (b) => { for (const c of b.children) { if (c.kind === 'inline' && c.__rects) { const v = c.v; if (v['background-color'] && v['background-color'][3] > 0 || c.bt || c.bb || c.bl || c.br) { c.__rects.rects.forEach((r, i) => { if (r.ax !== undefined) { const rect = { x: r.ax, y: r.ay, w: r.w, h: r.h }; this.paintBackgroundAndBorders(c, dx, dy, 1, rect); } }); } walk(c); } } };
		walk(container);
		for (const f of container.frags || []) { if (f.t === 'text' && f.ax !== undefined) { this.drawText(f, dx, dy, 1); } }
		const atomic = (b) => { for (const c of b.children) { if (c.kind === 'inline-block' && !c.oof) { this.paintBox(c, dx, dy, 1); } else if (c.kind === 'inline') { atomic(c); } } }; atomic(container);
	}
}
export function paintDocument(doc, width, height) {
	doc.__ensureLayout(); const lay = doc.__layout; const p = new Painter(doc, width, height);
	if (!lay.rootBox) { return { px: p.S.px, w: width, h: height, stats: p.stats }; }
	// canvas background: html or body background colour
	const rb = lay.rootBox; let bg = rb.v['background-color']; if (!(bg && bg[3] > 0)) { const body = doc.body && lay.boxOf.get(doc.body); if (body && body.v['background-color'] && body.v['background-color'][3] > 0) { bg = body.v['background-color']; } }
	if (bg && bg[3] > 0) { p.fillRect(0, 0, width, height, bg); }
	const saveBg = rb.v['background-color']; rb.v['background-color'] = [0, 0, 0, 0]; const body = doc.body && lay.boxOf.get(doc.body); const saveBodyBg = body && body.v['background-color']; if (body && !(saveBg && saveBg[3] > 0)) { body.v['background-color'] = [0, 0, 0, 0]; }
	p.paintBox(rb, 0, 0, 1); rb.v['background-color'] = saveBg; if (body && saveBodyBg) { body.v['background-color'] = saveBodyBg; }
	return { px: p.S.px, w: width, h: height, stats: p.stats };
}
export function toPPM(px, w, h) { const header = `P6\n${w} ${h}\n255\n`; const out = new Uint8Array(header.length + w * h * 3); for (let i = 0; i < header.length; i++) { out[i] = header.charCodeAt(i); } let o = header.length; for (let i = 0; i < w * h; i++) { const a = px[i * 4 + 3] / 255; out[o++] = Math.round(px[i * 4] * a + 255 * (1 - a)); out[o++] = Math.round(px[i * 4 + 1] * a + 255 * (1 - a)); out[o++] = Math.round(px[i * 4 + 2] * a + 255 * (1 - a)); } return out; }
