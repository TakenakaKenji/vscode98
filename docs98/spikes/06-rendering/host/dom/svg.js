// A small SVG renderer: parses an SVG document and rasterizes it into an RGBA bitmap (decodeSvg(bytes, scale) -> { w, h, data }). It is what <img src="x.svg"> and CSS
// background images need for the workbench's icons, logos and the images of extension READMEs: paths (all commands, arcs as cubics), rect, circle, ellipse, line, polyline,
// polygon, groups with transforms, fill and stroke (solid colours, currentColor, linear and radial gradients approximated by their mean colour), opacity, fill-rule,
// inline <style> with simple selectors and style="" attributes, <use> of ids. Not supported: filters, masks, clip paths, text, markers, patterns, dashes.
const NAMED = { black: '#000', white: '#fff', red: '#f00', green: '#008000', blue: '#00f', gray: '#808080', grey: '#808080', yellow: '#ff0', orange: '#ffa500', purple: '#800080', transparent: 'rgba(0,0,0,0)', none: 'none', silver: '#c0c0c0', maroon: '#800000', navy: '#000080', teal: '#008080', lime: '#0f0', aqua: '#0ff', fuchsia: '#f0f', olive: '#808000' };
function parseColor(s, current) {
	s = String(s).trim().toLowerCase(); if (!s || s === 'none') { return null; } if (s === 'currentcolor') { return current || [0, 0, 0, 1]; } if (NAMED[s] && NAMED[s] !== s) { return parseColor(NAMED[s], current); }
	let m = /^#([0-9a-f]{3,8})$/.exec(s); if (m) { let h = m[1]; if (h.length === 3 || h.length === 4) { h = [...h].map((c) => c + c).join(''); } const v = (i) => parseInt(h.slice(i, i + 2), 16); return [v(0), v(2), v(4), h.length === 8 ? v(6) / 255 : 1]; }
	m = /^rgba?\(([^)]*)\)/.exec(s); if (m) { const p = m[1].split(/[\s,\/]+/).filter(Boolean).map((x) => (x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x))); return [p[0], p[1], p[2], p.length > 3 ? (m[1].includes('%') && String(p[3]).length ? p[3] / 255 : p[3]) : 1]; }
	return [0, 0, 0, 1];
}
const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
function parseTransform(s) {
	let m = [1, 0, 0, 1, 0, 0]; const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g; let t;
	while ((t = re.exec(s || ''))) {
		const a = t[2].split(/[\s,]+/).filter(Boolean).map(Number); let n;
		switch (t[1]) { case 'matrix': n = a; break; case 'translate': n = [1, 0, 0, 1, a[0], a[1] || 0]; break; case 'scale': n = [a[0], 0, 0, a[1] ?? a[0], 0, 0]; break; case 'rotate': { const r = a[0] * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r); n = [c, sn, -sn, c, 0, 0]; if (a.length > 2) { n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]]); } break; } case 'skewX': n = [1, 0, Math.tan(a[0] * Math.PI / 180), 1, 0, 0]; break; default: n = [1, Math.tan(a[0] * Math.PI / 180), 0, 1, 0, 0]; }
		m = mul(m, n);
	}
	return m;
}
// ---- XML ------------------------------------------------------------------------------------------------------------------------------------
function parseXml(src) {
	const root = { name: '#root', attrs: {}, children: [], text: '' }; const stack = [root]; const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g; let m;
	while ((m = re.exec(src))) {
		if (m[1] !== undefined) { stack[stack.length - 1].text += m[1]; continue; }
		if (m[6] !== undefined) { stack[stack.length - 1].text += m[6]; continue; } if (m[3] === undefined) { continue; }
		if (m[2]) { if (stack.length > 1) { stack.pop(); } continue; }
		const attrs = {}; const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let a; while ((a = ar.exec(m[4]))) { attrs[a[1]] = (a[2] ?? a[3]).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
		const el = { name: m[3].replace(/^svg:/, ''), attrs, children: [], text: '' }; stack[stack.length - 1].children.push(el); if (!m[5]) { stack.push(el); }
	}
	return root.children.find((c) => c.name === 'svg');
}
// ---- paths ---------------------------------------------------------------------------------------------------------------------------------
function arcToCubics(x1, y1, rx, ry, phi, fa, fs, x2, y2) {
	if (rx === 0 || ry === 0) { return [[x1, y1, x2, y2, x2, y2]]; } rx = Math.abs(rx); ry = Math.abs(ry); const c = Math.cos(phi), s = Math.sin(phi); const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2; const x1p = c * dx + s * dy, y1p = -s * dx + c * dy;
	const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry); if (lam > 1) { const k = Math.sqrt(lam); rx *= k; ry *= k; }
	const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p, den = rx * rx * y1p * y1p + ry * ry * x1p * x1p; let co = Math.sqrt(Math.max(0, num / den)); if (fa === fs) { co = -co; }
	const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx; const cx = c * cxp - s * cyp + (x1 + x2) / 2, cy = s * cxp + c * cyp + (y1 + y2) / 2;
	const ang = (ux, uy, vx, vy) => { const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
	const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry); let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry); if (!fs && dth > 0) { dth -= 2 * Math.PI; } else if (fs && dth < 0) { dth += 2 * Math.PI; }
	const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2))); const out = []; const d = dth / n; const t = 4 / 3 * Math.tan(d / 4);
	for (let i = 0; i < n; i++) {
		const a1 = th1 + i * d, a2 = a1 + d; const p = (a, ox, oy) => { const ex = rx * Math.cos(a), ey = ry * Math.sin(a); return [cx + c * ex - s * ey + ox, cy + s * ex + c * ey + oy]; };
		const e1 = [-rx * Math.sin(a1), ry * Math.cos(a1)], e2 = [-rx * Math.sin(a2), ry * Math.cos(a2)]; const P1 = p(a1, 0, 0), P2 = p(a2, 0, 0);
		out.push([P1[0] + t * (c * e1[0] - s * e1[1]), P1[1] + t * (s * e1[0] + c * e1[1]), P2[0] - t * (c * e2[0] - s * e2[1]), P2[1] - t * (s * e2[0] + c * e2[1]), P2[0], P2[1]]);
	}
	return out;
}
/** path data -> list of subpaths { pts: [[x, y]...], closed } in user units */
function flattenPath(d) {
	const tokens = String(d).match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []; const subs = []; let cur = null, x = 0, y = 0, sx = 0, sy = 0, lastC = null, lastQ = null, cmd = '', i = 0;
	const num = () => parseFloat(tokens[i++]); const flag = () => { const t = tokens[i]; if (t.length > 1 && /^[01]/.test(t)) { tokens[i] = t.slice(1); return +t[0]; } i++; return +t; };
	const line = (nx, ny) => { cur.pts.push([nx, ny]); x = nx; y = ny; };
	const cubic = (x1, y1, x2, y2, x3, y3) => { const n = 16; for (let k = 1; k <= n; k++) { const t = k / n, u = 1 - t; cur.pts.push([u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]); } x = x3; y = y3; lastC = [x2, y2]; };
	while (i < tokens.length) {
		if (/[a-zA-Z]/.test(tokens[i])) { cmd = tokens[i++]; } const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(); const ox = rel ? x : 0, oy = rel ? y : 0;
		if (C === 'Z') { if (cur) { cur.closed = true; x = sx; y = sy; subs.push(cur); cur = { pts: [[x, y]], closed: false }; } lastC = lastQ = null; continue; }
		if (C === 'M') { const nx = num() + ox, ny = num() + oy; if (cur && cur.pts.length > 1) { subs.push(cur); } cur = { pts: [[nx, ny]], closed: false }; x = sx = nx; y = sy = ny; cmd = rel ? 'l' : 'L'; lastC = lastQ = null; continue; }
		if (!cur) { cur = { pts: [[x, y]], closed: false }; }
		switch (C) {
			case 'L': line(num() + ox, num() + oy); lastC = lastQ = null; break; case 'H': line(num() + ox, y); lastC = lastQ = null; break; case 'V': line(x, num() + oy); lastC = lastQ = null; break;
			case 'C': { const a = num() + ox, b = num() + oy, c = num() + ox, dd = num() + oy, e = num() + ox, f = num() + oy; cubic(a, b, c, dd, e, f); lastQ = null; break; }
			case 'S': { const c1 = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y]; const c = num() + ox, dd = num() + oy, e = num() + ox, f = num() + oy; cubic(c1[0], c1[1], c, dd, e, f); lastQ = null; break; }
			case 'Q': { const qx = num() + ox, qy = num() + oy, ex = num() + ox, ey = num() + oy; cubic(x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), ex + 2 / 3 * (qx - ex), ey + 2 / 3 * (qy - ey), ex, ey); lastQ = [qx, qy]; lastC = null; break; }
			case 'T': { const q = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y]; const ex = num() + ox, ey = num() + oy; cubic(x + 2 / 3 * (q[0] - x), y + 2 / 3 * (q[1] - y), ex + 2 / 3 * (q[0] - ex), ey + 2 / 3 * (q[1] - ey), ex, ey); lastQ = q; lastC = null; break; }
			case 'A': { const rx = num(), ry = num(), rot = num(), fa = flag(), fs = flag(), ex = num() + ox, ey = num() + oy; const x0 = x, y0 = y; for (const cb of arcToCubics(x0, y0, rx, ry, rot * Math.PI / 180, fa, fs, ex, ey)) { cubic(cb[0], cb[1], cb[2], cb[3], cb[4], cb[5]); } x = ex; y = ey; lastC = lastQ = null; break; }
			default: i = tokens.length;
		}
	}
	if (cur && cur.pts.length > 1) { subs.push(cur); } return subs.filter((s) => s.pts.length > 1);
}
function strokeToPolys(subs, width) {
	const hw = width / 2, polys = [];
	for (const s of subs) {
		const p = s.pts; const n = p.length; const segs = s.closed ? n : n - 1;
		for (let i = 0; i < segs; i++) { const a = p[i], b = p[(i + 1) % n]; const dx = b[0] - a[0], dy = b[1] - a[1]; const len = Math.hypot(dx, dy); if (len === 0) { continue; } const nx = -dy / len * hw, ny = dx / len * hw; polys.push([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]); }
		for (let i = 0; i < n; i++) { if (!s.closed && (i === 0 || i === n - 1)) { continue; } const c = p[i]; const poly = []; for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; poly.push([c[0] + Math.cos(a) * hw, c[1] + Math.sin(a) * hw]); } polys.push(poly); }   // round joins
	}
	// one orientation for every piece: overlapping pieces of opposite winding would cancel under the non-zero rule
	for (const poly of polys) { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } if (a < 0) { poly.reverse(); } }
	return polys;
}
// ---- rasterizer: 4 sub-scanlines, exact horizontal coverage, non-zero or even-odd ---------------------------------------------------------
// The QuickJS hosts do the scanline loops in C (07-native-render/host/svg98.h, the same result to the bit; the JS loops were 0.9 s of the laptop's launch)
let nativeFill = typeof globalThis.__svgFill === 'function' ? globalThis.__svgFill : null, nativeRgba = typeof globalThis.__svgToRGBA8 === 'function' ? globalThis.__svgToRGBA8 : null;
/** on = false: the JS loops even when the host has the C ones (06-rendering/tests/svg_native_oracle.mjs compares both) */
export function useNativeSvg(on) { nativeFill = on && typeof globalThis.__svgFill === 'function' ? globalThis.__svgFill : null; nativeRgba = on && typeof globalThis.__svgToRGBA8 === 'function' ? globalThis.__svgToRGBA8 : null; }
function fillPolys(polys, W, H, evenOdd, color, out) {
	const SS = 4; const acc = new Float32Array(W + 2); const edges = []; let ymin = Infinity, ymax = -Infinity;
	for (const poly of polys) { for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; if (a[1] === b[1]) { continue; } edges.push(a[1] < b[1] ? [a[0], a[1], b[0], b[1], 1] : [b[0], b[1], a[0], a[1], -1]); ymin = Math.min(ymin, a[1], b[1]); ymax = Math.max(ymax, a[1], b[1]); } }
	if (!edges.length) { return; }
	if (nativeFill) { const f = new Float64Array(edges.length * 5); for (let i = 0; i < edges.length; i++) { f.set(edges[i], i * 5); } nativeFill(f, ymin, ymax, W, H, evenOdd, color[0], color[1], color[2], color[3], out); return; }
	const y0 = Math.max(0, Math.floor(ymin)), y1 = Math.min(H, Math.ceil(ymax));
	for (let y = y0; y < y1; y++) {
		acc.fill(0);
		for (let s = 0; s < SS; s++) {
			const sy = y + (s + 0.5) / SS; const xs = [];
			for (const e of edges) { if (sy >= e[1] && sy < e[3]) { xs.push([e[0] + (sy - e[1]) * (e[2] - e[0]) / (e[3] - e[1]), e[4]]); } }
			xs.sort((a, b) => a[0] - b[0]); let wind = 0;
			for (let k = 0; k < xs.length - 1; k++) { wind += xs[k][1]; const inside = evenOdd ? ((k + 1) & 1) === 1 : wind !== 0; if (!inside) { continue; } const xa = Math.max(0, xs[k][0]), xb = Math.min(W, xs[k + 1][0]); if (xb <= xa) { continue; } const ia = Math.floor(xa), ib = Math.floor(xb); if (ia === ib) { acc[ia] += (xb - xa) / SS; } else { acc[ia] += (ia + 1 - xa) / SS; for (let x = ia + 1; x < ib; x++) { acc[x] += 1 / SS; } if (ib < W) { acc[ib] += (xb - ib) / SS; } } }
		}
		for (let x = 0; x < W; x++) { const cov = Math.min(1, acc[x]); if (cov <= 0) { continue; } const a = cov * color[3]; const o = (y * W + x) * 4; const da = out[o + 3] / 255; const oa = a + da * (1 - a); if (oa <= 0) { continue; } out[o] = (color[0] * a + out[o] * da * (1 - a)) / oa; out[o + 1] = (color[1] * a + out[o + 1] * da * (1 - a)) / oa; out[o + 2] = (color[2] * a + out[o + 2] * da * (1 - a)) / oa; out[o + 3] = oa * 255; }
	}
}
// ---- document ------------------------------------------------------------------------------------------------------------------------------
function cssRules(svg) { const rules = []; const walk = (e) => { if (e.name === 'style') { const t = e.text.replace(/\/\*[\s\S]*?\*\//g, ''); const re = /([^{}]+)\{([^}]*)\}/g; let m; while ((m = re.exec(t))) { for (const sel of m[1].split(',')) { rules.push([sel.trim(), parseDecls(m[2])]); } } } e.children.forEach(walk); }; walk(svg); return rules; }
function parseDecls(s) { const o = {}; for (const d of String(s).split(';')) { const i = d.indexOf(':'); if (i > 0) { o[d.slice(0, i).trim()] = d.slice(i + 1).trim(); } } return o; }
const matchesSel = (sel, e) => { if (sel === '*') { return true; } const m = /^([\w-]*)((?:[.#][\w-]+)*)$/.exec(sel); if (!m) { return false; } if (m[1] && m[1] !== e.name) { return false; } const cl = (e.attrs.class || '').split(/\s+/); for (const q of (m[2].match(/[.#][\w-]+/g) || [])) { if (q[0] === '.' ? !cl.includes(q.slice(1)) : e.attrs.id !== q.slice(1)) { return false; } } return true; };
/** renders svg text at `scale` x its intrinsic size (default intrinsic) to RGBA */
/** the longest side of a rasterized SVG, in pixels */
const MAX_RASTER = 256;
export function decodeSvg(bytes, scale = 1, currentColor = null) {
	const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes); const svg = parseXml(text); if (!svg) { throw new Error('svg: no root'); }
	let vb = (svg.attrs.viewBox || '').split(/[\s,]+/).map(Number); const len = (s, ref) => { if (s === undefined) { return null; } const v = parseFloat(s); if (Number.isNaN(v)) { return null; } return /%$/.test(s) ? v * ref / 100 : /pt$/.test(s) ? v * 4 / 3 : /em$/.test(s) ? v * 16 : v; };
	let iw = len(svg.attrs.width, vb[2] || 300), ih = len(svg.attrs.height, vb[3] || 150); if (vb.length !== 4 || vb.some(Number.isNaN)) { vb = [0, 0, iw || 300, ih || 150]; } if (iw === null) { iw = ih !== null ? ih * vb[2] / vb[3] : vb[2]; } if (ih === null) { ih = iw * vb[3] / vb[2]; }
	const cap = Math.min(1, MAX_RASTER / Math.max(iw * scale, ih * scale, 1));   // the raster of a 1024 px logo would take seconds on an old machine; it is scaled to the destination box when drawn anyway
	const W = Math.max(1, Math.min(2048, Math.round(iw * scale * cap))), H = Math.max(1, Math.min(2048, Math.round(ih * scale * cap))); const out = new Float32Array(W * H * 4);
	const base = [W / vb[2], 0, 0, H / vb[3], -vb[0] * W / vb[2], -vb[1] * H / vb[3]]; const rules = cssRules(svg); const ids = new Map(); const index = (e) => { if (e.attrs.id) { ids.set(e.attrs.id, e); } e.children.forEach(index); }; index(svg);
	const gradColor = (ref) => { const m = /url\(\s*#([^)\s'"]+)/.exec(ref); const g = m && ids.get(m[1]); if (!g) { return null; } let stops = g.children.filter((c) => c.name === 'stop'); if (!stops.length && g.attrs['xlink:href']) { const gg = ids.get(g.attrs['xlink:href'].slice(1)); if (gg) { stops = gg.children.filter((c) => c.name === 'stop'); } } if (!stops.length) { return null; } const cols = stops.map((s) => { const st = { ...parseDecls(s.attrs.style || '') }; return parseColor(st['stop-color'] ?? s.attrs['stop-color'] ?? '#000', currentColor); }); const op = stops.map((s) => parseFloat(parseDecls(s.attrs.style || '')['stop-opacity'] ?? s.attrs['stop-opacity'] ?? 1)); const k = cols.length; return [cols.reduce((a, c) => a + c[0], 0) / k, cols.reduce((a, c) => a + c[1], 0) / k, cols.reduce((a, c) => a + c[2], 0) / k, cols.reduce((a, c, i) => a + c[3] * op[i], 0) / k]; };
	const draw = (e, inherited, m, depth) => {
		if (depth > 12 || ['defs', 'clipPath', 'mask', 'symbol', 'linearGradient', 'radialGradient', 'pattern', 'style', 'title', 'desc', 'metadata', 'filter', 'marker'].includes(e.name)) { return; }
		const style = { ...inherited }; const decl = {}; for (const [sel, d] of rules) { if (matchesSel(sel, e)) { Object.assign(decl, d); } } Object.assign(decl, parseDecls(e.attrs.style || ''));
		for (const k of ['fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'color', 'opacity', 'display', 'visibility']) { const v = decl[k] ?? e.attrs[k]; if (v !== undefined && v !== 'inherit') { style[k] = v; } }
		if (style.display === 'none' || style.visibility === 'hidden') { return; } const cur = style.color ? parseColor(style.color, currentColor) : currentColor; const mm = e.attrs.transform ? mul(m, parseTransform(e.attrs.transform)) : m;
		const polysOf = (subs) => subs.map((s) => (s.pts || s).map(([x, y]) => [mm[0] * x + mm[2] * y + mm[4], mm[1] * x + mm[3] * y + mm[5]]));
		let subs = null;
		switch (e.name) {
			case 'path': subs = flattenPath(e.attrs.d || ''); break;
			case 'rect': { const x = +e.attrs.x || 0, y = +e.attrs.y || 0, w = +e.attrs.width || 0, h = +e.attrs.height || 0; let rx = len(e.attrs.rx) ?? len(e.attrs.ry) ?? 0, ry = len(e.attrs.ry) ?? rx; rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2); subs = rx > 0 ? flattenPath(`M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`) : flattenPath(`M${x} ${y}H${x + w}V${y + h}H${x}Z`); break; }
			case 'circle': case 'ellipse': { const cx = +e.attrs.cx || 0, cy = +e.attrs.cy || 0, rx = e.name === 'circle' ? +e.attrs.r || 0 : +e.attrs.rx || 0, ry = e.name === 'circle' ? rx : +e.attrs.ry || 0; subs = flattenPath(`M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`); break; }
			case 'line': subs = [{ pts: [[+e.attrs.x1 || 0, +e.attrs.y1 || 0], [+e.attrs.x2 || 0, +e.attrs.y2 || 0]], closed: false }]; break;
			case 'polyline': case 'polygon': { const n = (e.attrs.points || '').split(/[\s,]+/).filter(Boolean).map(Number); const pts = []; for (let i = 0; i + 1 < n.length; i += 2) { pts.push([n[i], n[i + 1]]); } subs = [{ pts, closed: e.name === 'polygon' }]; break; }
			case 'use': { const t = ids.get((e.attrs.href || e.attrs['xlink:href'] || '').slice(1)); if (t) { draw(t, style, mul(mm, [1, 0, 0, 1, +e.attrs.x || 0, +e.attrs.y || 0]), depth + 1); } return; }
			default: for (const c of e.children) { draw(c, style, mm, depth + 1); } return;
		}
		const opacity = parseFloat(style.opacity ?? 1);
		if (subs && subs.length) {
			let fill = style.fill === undefined ? [0, 0, 0, 1] : /^url\(/.test(style.fill) ? gradColor(style.fill) : parseColor(style.fill, cur); if (style.fill !== undefined && style.fill !== 'none' && /^currentcolor$/i.test(style.fill)) { fill = cur; }
			if (fill) { fillPolys(polysOf(subs.map((s) => ({ pts: s.pts }))), W, H, style['fill-rule'] === 'evenodd', [fill[0], fill[1], fill[2], fill[3] * parseFloat(style['fill-opacity'] ?? 1) * opacity], out); }
			let stroke = style.stroke === undefined ? null : /^url\(/.test(style.stroke) ? gradColor(style.stroke) : parseColor(style.stroke, cur);
			if (stroke) { const sw = parseFloat(style['stroke-width'] ?? 1) || 1; const scale2 = Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2])); fillPolys(polysOf(strokeToPolys(subs, sw)).map((p) => p), W, H, false, [stroke[0], stroke[1], stroke[2], stroke[3] * parseFloat(style['stroke-opacity'] ?? 1) * opacity], out); void scale2; }
		}
	};
	draw(svg, {}, base, 0);
	let data; if (nativeRgba) { data = nativeRgba(out); } else { data = new Uint8Array(W * H * 4); for (let i = 0; i < data.length; i++) { data[i] = Math.max(0, Math.min(255, Math.round(out[i]))); } }
	return { w: W, h: H, data, iw, ih, vector: true };
}
