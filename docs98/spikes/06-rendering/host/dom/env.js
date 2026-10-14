// Browser environment on top of dom.js / css.js / layout.js: Document, window globals, geometry queries (getBoundingClientRect, offset*, client*, scroll*, Range rects),
// getComputedStyle, rAF and timers, observers, storage, navigator and the other globals a page like Monaco expects. `installEnvironment(opts)` makes globalThis the window.
import * as D from './dom.js';
import { CSSStyleSheet, serializeValue, parseColor, PROPS, resolveLen } from './css.js';
import { Layout } from './layout.js';
import { resolveFont, fontMetrics, advance, registerFontFace, setOpentype } from './fonts.js';
import { parseSelector, matches } from './selectors.js';

const { Node, Element, Text, Comment, DocumentFragment, EventTarget, tagClasses, SVG_NS, HTMLElement, SVGElement, HTMLUnknownElement, mixin, noteMissing } = D;
const XHTML = 'http://www.w3.org/1999/xhtml';

class DOMRect { constructor(x = 0, y = 0, w = 0, h = 0) { this.x = x; this.y = y; this.width = w; this.height = h; this.top = h < 0 ? y + h : y; this.left = w < 0 ? x + w : x; this.right = Math.max(x, x + w); this.bottom = Math.max(y, y + h); } toJSON() { return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, right: this.right, bottom: this.bottom, left: this.left }; } static fromRect(r = {}) { return new DOMRect(r.x, r.y, r.width, r.height); } }

export class Document extends Node {
	constructor(env) {
		super(); this.ownerDocument = null; this.__env = env; this.__dirty = true; this.__styleDirty = true; this.__layout = null; this.__activeElement = null; this.__sheets = new Map(); this.__rulesVersion = 0; this.__observers = new Set(); this.__layoutCount = 0; this.__layoutMs = 0; this.__styleMs = 0;
		const html = this.createElement('html'), head = this.createElement('head'), body = this.createElement('body'); html.appendChild(head); html.appendChild(body); this.appendChild(html);
		this.__hasFocus = true; this.readyState = 'complete'; this.visibilityState = 'visible'; this.hidden = false; this.cookie = ''; this.title = ''; this.characterSet = 'UTF-8'; this.contentType = 'text/html'; this.compatMode = 'CSS1Compat'; this.designMode = 'off'; this.dir = '';
		this.fonts = Object.assign(new EventTarget(), { ready: Promise.resolve(), status: 'loaded', load: () => Promise.resolve([]), check: () => true, add() { }, delete() { }, forEach() { }, [Symbol.iterator]: function* () { } });
		this.__selection = new D.Selection(this);
	}
	get nodeType() { return 9; } get nodeName() { return '#document'; } get documentElement() { return this.__children.find(c => c.nodeType === 1) ?? null; }
	get head() { return this.documentElement.__children.find(c => c.localName === 'head') ?? null; } get body() { return this.documentElement.__children.find(c => c.localName === 'body') ?? null; }
	get defaultView() { return this.__env.window; } get activeElement() { return this.__activeElement && this.__activeElement.isConnected ? this.__activeElement : this.body; }
	get location() { return this.__env.window.location; } get URL() { return this.__env.window.location.href; } get baseURI() { return this.URL; } get referrer() { return ''; } get domain() { return ''; }
	get scrollingElement() { return this.documentElement; } get styleSheets() { return this.__allSheets(); } get adoptedStyleSheets() { return this.__adopted ??= []; } set adoptedStyleSheets(v) { this.__adopted = v; this.__styleDirty = true; this.__dirty = true; this.__rulesVersion = (this.__rulesVersion || 0) + 1; }
	get textContent() { return null; } get fullscreenElement() { return null; } get pointerLockElement() { return null; } get currentScript() { return null; } get all() { return this.getElementsByTagName('*'); }
	hasFocus() { return this.__hasFocus; } execCommand() { return false; } queryCommandSupported() { return false; } getSelection() { return this.__selection; } exitFullscreen() { return Promise.resolve(); } exitPointerLock() { }
	createElement(name) { return this.__createElementNS(XHTML, String(name).toLowerCase()); } createElementNS(ns, name) { return this.__createElementNS(ns ?? XHTML, ns === XHTML || !ns ? String(name).toLowerCase() : name); }
	__createElementNS(ns, name) { const CE = this.__customs && this.__customs.get(name); if (CE) { Element.__pending = name; try { const e = new CE(); e.ownerDocument = this; return e; } finally { Element.__pending = undefined; } } const C = ns === SVG_NS ? SVGElement : (tagClasses[name] ?? (/^[a-z][a-z0-9]*$/.test(name) && !['font', 'center', 'marquee'].includes(name) && KNOWN_TAGS.has(name) ? HTMLElement : HTMLUnknownElement)); const e = new C(name, ns); e.ownerDocument = this; return e; }
	createTextNode(d) { const t = new Text(d); t.ownerDocument = this; return t; } createComment(d) { const t = new Comment(d); t.ownerDocument = this; return t; }
	createDocumentFragment() { const f = new DocumentFragment(); f.ownerDocument = this; return f; } createRange() { return new D.Range(this); } createEvent(t) { return new D.Event(''); }
	createTreeWalker(root, what, filter) { const nodes = []; const walk = (n) => { for (const c of n.__children) { if ((what & 1 && c.nodeType === 1) || (what & 4 && c.nodeType === 3) || what === 0xFFFFFFFF) { nodes.push(c); } walk(c); } }; walk(root); let i = -1; return { currentNode: root, nextNode() { i++; return nodes[i] ?? null; } }; }
	importNode(n, deep) { return n.cloneNode(deep); } adoptNode(n) { return n; } open() { } close() { } write() { } writeln() { }
	elementFromPoint(x, y) { return this.__hitTest(x, y, 1)[0] ?? null; }
	elementsFromPoint(x, y) { return this.__hitTest(x, y, Infinity); }
	/** the elements whose rectangle contains the point, innermost and last-painted first; stops after `limit` hits */
	__hitTest(x, y, limit) {
		this.__ensureLayout(); const out = [];
		const top = this.__topLayerBoxes(), topSet = top.set;
		const walk = (b, isRoot) => {
			const ch = b.children; for (let i = ch.length - 1; i >= 0; i--) { const c = ch[i]; if (c.kind === 'text' || !c.el || topSet.has(c)) { continue; } if (walk(c, false)) { return true; } }
			if (b.el && b.v.visibility !== 'hidden' && b.v['pointer-events'] !== 'none') { const r = this.__rect(b.el); if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) { out.push(b.el); if (out.length >= limit) { return true; } } }
			return false;
		};
		for (let i = top.list.length - 1; i >= 0; i--) { if (walk(top.list[i], false)) { return out; } }
		if (this.__layout && this.__layout.rootBox) { walk(this.__layout.rootBox, true); } return out;
	}
	/** the position:fixed boxes with a positive z-index (menus, dialogs), in paint order: the painter draws them above everything else, so hit testing must find them first (cached until the next layout pass) */
	__topLayerBoxes() {
		if (this.__topCache && this.__topCacheFor === this.__layout) { return this.__topCache; }
		const list = []; const lay = this.__layout;
		const collect = (b) => { for (const c of b.children) { if (c.kind === 'text' || !c.el) { continue; } const z = c.v['z-index']; if (c.pos === 'fixed' && typeof z === 'number' && z > 0) { list.push(c); } collect(c); } };
		if (lay && lay.rootBox) { collect(lay.rootBox); }
		const idx = new Map(list.map((b, i) => [b, i])); list.sort((a, b) => (a.v['z-index'] - b.v['z-index']) || (idx.get(a) - idx.get(b)));
		this.__topCacheFor = lay; return (this.__topCache = { list, set: new Set(list) });
	}
	/** The caret position nearest to a point, as a collapsed Range in a text node (the editor's mouse hit-testing of text needs it): the text under the element at the point whose line contains `y`, nearest in x. */
	caretRangeFromPoint(x, y) {
		this.__ensureLayout(); const lay = this.__layout; const el = lay && this.elementFromPoint(x, y); if (!el) { return null; }
		let best = null, bestD = Infinity;
		const scan = (n) => { for (const c of n.__children) { if (c.nodeType === 3) { for (const f of lay.fragsByText.get(c) || []) { if (y < f.ay || y >= f.ay + f.asc + f.desc) { continue; } const w = this.__measure(f, f.text); const d = x < f.ax ? f.ax - x : x > f.ax + w ? x - f.ax - w : 0; if (d < bestD) { bestD = d; best = { node: c, f }; } } } else if (c.nodeType === 1) { scan(c); } } };
		scan(el); const r = new D.Range(this);
		if (!best) { r.setStart(el, 0); r.setEnd(el, 0); return r; }
		const { node, f } = best; let acc = 0, idx = 0; for (const ch of f.text) { const a = advance(f.font, ch.codePointAt(0), f.size) + f.ls; if (x < f.ax + acc + a / 2) { break; } acc += a; idx += ch.length; }
		const off = f.text.length === f.srcEnd - f.src ? f.src + idx : f.src + Math.round(idx * (f.srcEnd - f.src) / Math.max(1, f.text.length));
		r.setStart(node, off); r.setEnd(node, off); return r;
	}
	caretPositionFromPoint() { return null; }
	__allSheets() { const out = []; const walk = (n) => { for (const c of n.__children) { if (c.nodeType !== 1) { continue; } if (c.localName === 'style' || (c.localName === 'link' && (c.getAttribute('rel') || '').toLowerCase() === 'stylesheet')) { const s = this.__ensureSheet(c); if (s) { out.push(s); } } walk(c); } }; walk(this); for (const s of this.__adopted || []) { s.__doc = this; out.push(s); } return out; }
	__ensureSheet(el) {
		let rec = this.__sheets.get(el); const text = el.localName === 'style' ? el.textContent : (el.__linkText ?? '');
		if (!rec || rec.text !== text) { const sheet = new CSSStyleSheet(text, el); rec = { sheet, text }; this.__sheets.set(el, rec); el.__sheet = sheet; this.__styleDirty = true; this.__dirty = true; this.__registerFontFaces(sheet); }
		return rec.sheet;
	}
	__registerFontFaces(sheet) { const env = this.__env; for (const r of sheet.cssRules) { if (r.type === 5 && env.onFontFace) { env.onFontFace(r.__decls); } } }
	// ---- geometry (layout is computed lazily, only when something is dirty)
	/** test oracle for style-only passes: lay everything out again from the same styles and compare every box (geometry) and the style each box holds */
	__checkStyleOnly(lay) {
		const fresh = new Layout(this, this.__env); fresh.skipStyle = true; fresh.dirtyLog = []; fresh.run(); const bad = (this.__styleOnlyMismatches ??= []); let n = 0;
		for (const [el, fb] of fresh.boxOf) { const ob = lay.boxOf.get(el); n++; if (!ob) { if (bad.length < 50) { bad.push('no box for ' + el.localName + '.' + (el.getAttribute('class') || '')); } continue; }
			if (ob.ax !== fb.ax || ob.ay !== fb.ay || ob.w !== fb.w || ob.h !== fb.h) { if (bad.length < 50) { bad.push('geometry of ' + el.localName + '.' + (el.getAttribute('class') || '') + ': ' + [ob.ax, ob.ay, ob.w, ob.h] + ' vs ' + [fb.ax, fb.ay, fb.w, fb.h]); } }
			if (ob.v !== el.__cs.values) { if (bad.length < 50) { bad.push('stale style of ' + el.localName + '.' + (el.getAttribute('class') || '')); } } }
		this.__styleOnlyChecked = (this.__styleOnlyChecked || 0) + n;
	}
	__ensureLayout() {
		const env = this.__env;
		if (this.__layout && !this.__dirty) { return; }
		const t0 = performance.now(); const dirty = this.__dirtyLog || []; this.__dirtyLog = []; let lay = this.__layout, reused = false;
		if (lay && !this.__noStyleOnly) { const ts = performance.now(); const r = Layout.styleOnly(this, env, lay, dirty); if (r === true) { reused = true; lay.styleMs = performance.now() - ts; lay.layoutMs = 0; lay.styleInfo = this.__styleInfo; if (this.__verifyStyleOnly) { this.__checkStyleOnly(lay); } } else { lay = null; this.__stylesResolved = r === null; this.__preStyleMs = r === null ? performance.now() - ts : 0; } } else { lay = null; }
		if (!reused) { lay = new Layout(this, env); lay.dirtyLog = dirty; lay.skipStyle = this.__stylesResolved === true; lay.preStyleMs = this.__preStyleMs || 0; this.__stylesResolved = false; this.__preStyleMs = 0; lay.run(); }
		if (this.__passStats) { this.__passStats.push(summarizeDirty(dirty, this, lay, t0)); } this.__layout = lay; this.__topCache = null; this.__dirty = false; this.__styleDirty = false; this.__layoutCount++; this.__layoutMs += performance.now() - t0; if (!reused) { this.__applyTransforms(lay); } else { this.__styleOnlyPasses = (this.__styleOnlyPasses || 0) + 1; }
		if (this.__scrollClampPending) { this.__scrollClampPending = false; }
	}
	__applyTransforms(lay) {   // 2D affine per box from `transform` (translate / scale / matrix / rotate approximated)
		const parse = (s, bw, bh) => { if (!s || s === 'none') { return null; } let m = [1, 0, 0, 1, 0, 0]; const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]; const px = (x, base) => { const v = parseFloat(x); return /%/.test(x) ? v / 100 * base : (Number.isNaN(v) ? 0 : v); }; const re = /(\w+)\(([^)]*)\)/g; let k; while ((k = re.exec(s))) { const a = k[2].split(',').map(x => x.trim()); let t = null; switch (k[1].toLowerCase()) { case 'translate': t = [1, 0, 0, 1, px(a[0], bw), px(a[1] ?? '0', bh)]; break; case 'translate3d': t = [1, 0, 0, 1, px(a[0], bw), px(a[1], bh)]; break; case 'translatex': t = [1, 0, 0, 1, px(a[0], bw), 0]; break; case 'translatey': t = [1, 0, 0, 1, 0, px(a[0], bh)]; break; case 'scale': t = [parseFloat(a[0]), 0, 0, parseFloat(a[1] ?? a[0]), 0, 0]; break; case 'scalex': t = [parseFloat(a[0]), 0, 0, 1, 0, 0]; break; case 'scaley': t = [1, 0, 0, parseFloat(a[0]), 0, 0]; break; case 'matrix': t = a.map(parseFloat); break; case 'rotate': { const r = parseFloat(a[0]) * (/rad/.test(a[0]) ? 1 : Math.PI / 180); t = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]; break; } default: break; } if (t) { m = mul(m, t); } } return m; };
		const walk = (b) => { const tr = b.v ? b.v.transform : null; if (tr && tr !== 'none' && b.el) { const m = parse(tr, b.w, b.h); if (m) { b.matrix = m; } } for (const c of b.children) { if (c.kind !== 'text') { walk(c); } } };
		if (lay.rootBox) { walk(lay.rootBox); }
	}
	__boxFor(el) { this.__ensureLayout(); return this.__layout ? this.__layout.boxOf.get(el) : null; }
	__rawRect(el, box) {   // untransformed absolute rect of an element box (inline: union of line rects)
		if (box.kind === 'inline' && box.__rects) { const rs = box.__rects.rects.filter(r => r.ax !== undefined); if (!rs.length) { return null; } let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const r of rs) { x0 = Math.min(x0, r.ax); y0 = Math.min(y0, r.ay); x1 = Math.max(x1, r.ax + r.w); y1 = Math.max(y1, r.ay + r.h); } return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; }
		return { x: box.ax, y: box.ay, w: box.w, h: box.h };
	}
	__rect(el) {
		const box = this.__boxFor(el); if (!box || !el.isConnected) { return new DOMRect(0, 0, 0, 0); } const raw = this.__rawRect(el, box); if (!raw) { return new DOMRect(0, 0, 0, 0); }
		{   // the common case (no transform and no scrolled ancestor on the way up) needs no corner arithmetic: same numbers as the general path below, without the temporary arrays
			let simple = true; for (let b = box; b; b = b.parent) { if (b.matrix && b.el) { simple = false; break; } const p = b.parent; if (p && p.el && b.el && (p.el.__scrollTop || p.el.__scrollLeft)) { simple = false; break; } }
			if (simple) { return new DOMRect(raw.x, raw.y, (raw.x + raw.w) - raw.x, (raw.y + raw.h) - raw.y); }
		}
		let pts = [[raw.x, raw.y], [raw.x + raw.w, raw.y], [raw.x, raw.y + raw.h], [raw.x + raw.w, raw.y + raw.h]]; let sx = 0, sy = 0;
		for (let b = box; b; b = b.parent) {
			const v = b.v; if (b.matrix && b.el) { const m = b.matrix; const ox = b.ax + b.w / 2, oy = b.ay + b.h / 2; pts = pts.map(([x, y]) => { const dx = x - ox, dy = y - oy; return [ox + m[0] * dx + m[2] * dy + m[4], oy + m[1] * dx + m[3] * dy + m[5]]; }); }
			if (b.parent && b.el && b.parent.el && (b.parent.el.__scrollTop || b.parent.el.__scrollLeft)) { const p = b.parent.el; const sc = p.__cs && p.__cs.values; if (sc && (sc['overflow-x'] !== 'visible' || sc['overflow-y'] !== 'visible') && b.pos !== 'fixed') { const cbIs = b.pos !== 'absolute' || (b.parent.pos !== 'static'); if (cbIs) { pts = pts.map(([x, y]) => [x - (p.__scrollLeft || 0), y - (p.__scrollTop || 0)]); } } }
		}
		const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); const x0 = Math.min(...xs), y0 = Math.min(...ys); return new DOMRect(x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0);
	}
	__box(el, what) {
		const box = this.__boxFor(el); if (!box || !el.isConnected) { return 0; }
		const raw = this.__rawRect(el, box); if (!raw) { return 0; }
		switch (what) {
			case 'offsetWidth': return raw.w; case 'offsetHeight': return raw.h;
			case 'clientWidth': { if (box.kind === 'inline') { return 0; } const sb = this.__scrollbar(box, 'v'); return box.w - box.bl - box.br - sb; } case 'clientHeight': { if (box.kind === 'inline') { return 0; } if (el === this.documentElement) { return this.__env.vh; } const sb = this.__scrollbar(box, 'h'); return box.h - box.bt - box.bb - sb; }
			case 'clientTop': return box.bt; case 'clientLeft': return box.bl;
			case 'scrollWidth': return box.scrollW ?? 0; case 'scrollHeight': return box.scrollH ?? 0;
			case 'offsetLeft': case 'offsetTop': { const op = this.__offsetParentBox(box); const px = op ? op.ax + op.bl : 0, py = op ? op.ay + op.bt : 0; return what === 'offsetLeft' ? raw.x - px : raw.y - py; }
		}
		return 0;
	}
	__scrollbar(box, axis) { const v = box.v; const ov = axis === 'v' ? v['overflow-y'] : v['overflow-x']; const need = ov === 'scroll' || (ov === 'auto' && (axis === 'v' ? box.scrollH > box.h - box.bt - box.bb + 0.5 : box.scrollW > box.w - box.bl - box.br + 0.5)); return need && this.__env.scrollbarSize ? this.__env.scrollbarSize : 0; }
	__offsetParentBox(box) { for (let p = box.parent; p; p = p.parent) { if (p.pos !== 'static' || p.el === this.body || ['td', 'th', 'table'].includes(p.el && p.el.localName)) { return p; } } return null; }
	__offsetParent(el) { const box = this.__boxFor(el); if (!box || el.localName === 'body' || el.localName === 'html') { return null; } if (box.pos === 'fixed') { return null; } const p = this.__offsetParentBox(box); return p ? p.el : this.body; }
	__setScroll(el, axis, v) {
		this.__ensureLayout(); const box = this.__layout.boxOf.get(el); let max = Infinity;
		if (box) { const cs = box.v; if (axis === 'top') { max = Math.max(0, (box.scrollH || 0) - (box.h - box.bt - box.bb)); } else { max = Math.max(0, (box.scrollW || 0) - (box.w - box.bl - box.br)); } if (box.kind === 'inline') { max = 0; } if (cs['overflow-x'] === 'visible' && cs['overflow-y'] === 'visible' && el !== this.documentElement) { max = 0; } }
		v = Math.max(0, Math.min(v, max)); const key = axis === 'top' ? '__scrollTop' : '__scrollLeft'; if (el[key] !== v) { el[key] = v; el.dispatchEvent(new D.Event('scroll')); }
	}
	__rangeRects(range) {
		this.__ensureLayout(); const rects = []; const lay = this.__layout; const sc = range.startContainer, ec = range.endContainer;
		const textRects = (node, s, e) => { const frs = lay.fragsByText.get(node) || []; for (const f of frs) { const fs = f.src, fe = f.srcEnd; const a = Math.max(s, fs), b = Math.min(e, fe); if (a > b || (a === b && !(s === e && a >= fs && a <= fe))) { continue; } const pre = f.text.length === fe - fs ? f.text.slice(0, a - fs) : f.text.slice(0, Math.min(f.text.length, Math.round((a - fs) * f.text.length / Math.max(1, fe - fs)))); const mid = f.text.length === fe - fs ? f.text.slice(a - fs, b - fs) : ''; const wpre = this.__measure(f, pre), wmid = this.__measure(f, mid); rects.push(new DOMRect(f.ax + wpre, f.ay, wmid, f.asc + f.desc)); } };
		if (sc === ec && sc.nodeType === 3) { textRects(sc, range.startOffset, range.endOffset); }
		else if (sc === ec && sc.nodeType === 1) { const kids = sc.__children.slice(range.startOffset, range.endOffset); for (const k of kids) { if (k.nodeType === 3) { textRects(k, 0, k.length); } else if (k.nodeType === 1) { const r = this.__rect(k); if (r.width || r.height) { rects.push(r); } } } }
		else if (sc.nodeType === 3 && ec.nodeType === 3) { const walk = (n) => { for (const c of n.__children) { if (c.nodeType === 3) { if (sc === c && ec === c) { textRects(c, range.startOffset, range.endOffset); } else if (c === sc) { textRects(c, range.startOffset, c.length); } else if (c === ec) { textRects(c, 0, range.endOffset); } else if (inside) { textRects(c, 0, c.length); } } else if (c.nodeType === 1) { walk(c); } } }; let inside = false; const root = sc.getRootNode(); const flat = []; const collect = (n) => { for (const c of n.__children) { if (c.nodeType === 3) { flat.push(c); } else if (c.nodeType === 1) { collect(c); } } }; collect(root); const i0 = flat.indexOf(sc), i1 = flat.indexOf(ec); for (let i = i0; i <= i1 && i >= 0; i++) { textRects(flat[i], i === i0 ? range.startOffset : 0, i === i1 ? range.endOffset : flat[i].length); } }
		let total = new DOMRect(0, 0, 0, 0); if (rects.length) { const x0 = Math.min(...rects.map(r => r.left)), y0 = Math.min(...rects.map(r => r.top)), x1 = Math.max(...rects.map(r => r.right)), y1 = Math.max(...rects.map(r => r.bottom)); total = new DOMRect(x0, y0, x1 - x0, y1 - y0); }
		return { rects, total };
	}
	__measure(f, s) { let w = 0; for (const ch of s) { w += advance(f.font, ch.codePointAt(0), f.size) + f.ls; } return w; }
	__canvasContext(canvas, kind) { if (kind !== '2d') { return null; } return canvas.__ctx ??= new Canvas2D(this, canvas); }
}
mixin(Document, D.ParentNodeMixin);
const KNOWN_TAGS = new Set('a abbr address article aside audio b bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr'.split(' '));

class Canvas2D {
	constructor(doc, canvas) { this.canvas = canvas; this.__doc = doc; this.font = '10px sans-serif'; this.fillStyle = '#000'; this.strokeStyle = '#000'; this.globalAlpha = 1; this.textBaseline = 'alphabetic'; this.textAlign = 'start'; this.lineWidth = 1; this.ops = []; this.__state = []; }
	measureText(text) { const m = /^(?:(italic|oblique)\s+)?(?:(bold|\d{3})\s+)?(?:(?:normal|small-caps)\s+)?([\d.]+)px\s*(?:\/[\d.a-z]+)?\s+(.*)$/.exec(this.font.trim()); const size = m ? parseFloat(m[3]) : 10; const font = resolveFont(m ? m[4] : 'sans-serif', m && m[2] ? (m[2] === 'bold' ? 700 : +m[2]) : 400, m && m[1] ? 'italic' : 'normal'); let w = 0; for (const ch of String(text)) { w += advance(font, ch.codePointAt(0), size); } const fm = fontMetrics(font, size); return { width: w, actualBoundingBoxAscent: fm.ascent, actualBoundingBoxDescent: fm.descent, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w, fontBoundingBoxAscent: fm.ascent, fontBoundingBoxDescent: fm.descent }; }
	save() { this.__state.push({ font: this.font, fillStyle: this.fillStyle, globalAlpha: this.globalAlpha }); } restore() { Object.assign(this, this.__state.pop() ?? {}); }
	fillText(t, x, y) { this.ops.push(['fillText', t, x, y, this.font, this.fillStyle]); } strokeText() { } fillRect(x, y, w, h) { this.ops.push(['fillRect', x, y, w, h, this.fillStyle]); } clearRect() { this.ops.push(['clear']); } strokeRect() { }
	beginPath() { } closePath() { } moveTo() { } lineTo() { } arc() { } rect() { } fill() { } stroke() { } clip() { } scale() { } translate() { } rotate() { } transform() { } setTransform() { } resetTransform() { } drawImage() { } createLinearGradient() { return { addColorStop() { } }; }
	getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; } putImageData() { } createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
	setLineDash() { } getLineDash() { return []; } isPointInPath() { return false; }
}

// ---- window -----------------------------------------------------------------------------------------------------------------------------------
class ResizeObserver { constructor(cb) { this.cb = cb; this.t = new Set(); } observe(el) { this.t.add(el); queueMicrotask(() => { try { const r = el.getBoundingClientRect(); this.cb([{ target: el, contentRect: r, borderBoxSize: [{ inlineSize: r.width, blockSize: r.height }], contentBoxSize: [{ inlineSize: r.width, blockSize: r.height }] }], this); } catch (e) { /* ignore */ } }); } unobserve(el) { this.t.delete(el); } disconnect() { this.t.clear(); } }
class IntersectionObserver { constructor(cb) { this.cb = cb; } observe() { } unobserve() { } disconnect() { } takeRecords() { return []; } }
class Storage { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(String(k), String(v)); } removeItem(k) { this.m.delete(k); } clear() { this.m.clear(); } key(i) { return [...this.m.keys()][i] ?? null; } get length() { return this.m.size; } }

/** What made a layout pass necessary, and how much of the tree a perfect incremental invalidation would have had to restyle (an estimate, for the incremental style design). */
function summarizeDirty(log, doc, lay, t0) {
	const counts = { ins: 0, rem: 0, text: 0, 'attr:class': 0, 'attr:style': 0, 'attr:other': 0 }; const need = new Set(); const subtree = (n) => { if (n.nodeType !== 1 || need.has(n)) { return; } need.add(n); for (const c of n.__children) { subtree(c); } };
	for (const [kind, what, node, arg] of log) {
		if (what === 'ins') { counts.ins++; subtree(arg); if (node.nodeType === 1) { need.add(node); for (const c of node.__children) { if (c.nodeType === 1) { need.add(c); } } } }
		else if (what === 'rem') { counts.rem++; if (node.nodeType === 1) { need.add(node); for (const c of node.__children) { if (c.nodeType === 1) { need.add(c); } } } }
		else if (what === 'text') { counts.text++; }
		else if (what === 'attr') { if (arg === 'class') { counts['attr:class']++; subtree(node); } else if (arg === 'style') { counts['attr:style']++; need.add(node); } else { counts['attr:other']++; if (kind === 'style') { subtree(node); } } }
	}
	let live = 0; for (const n of need) { if (n.isConnected) { live++; } }
	return { total: lay.__elementCount ?? doc.__styleCount, mutations: log.length, counts, restyleEstimate: live, styleMs: lay.styleMs, layoutMs: lay.layoutMs, ms: performance.now() - t0, style: lay.styleInfo };
}
export function installEnvironment(opts = {}) {
	const g = opts.global ?? globalThis; const env = { vw: opts.width ?? 800, vh: opts.height ?? 520, dpr: 1, dark: false, rootFontSize: 16, scrollbarSize: opts.scrollbarSize ?? 0, window: g };
	if (opts.opentype) { setOpentype(opts.opentype); }
	env.onFontFace = (decls) => { try { let family, src; for (const d of decls) { if (d.name === 'font-family') { family = d.value; } else if (d.name === 'src') { src = d.value; } } const m = src && /url\(\s*["']?((?:data|file|vscode-file|https?):[^"')]+)["']?\s*\)/.exec(src); if (family && m && opts.opentype) { let buf; if (m[1].startsWith('data:')) { const b64 = m[1].slice(m[1].indexOf(',') + 1); buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer; } else if (opts.readUrl) { buf = opts.readUrl(m[1]); } else { buf = globalThis.__readFileBytes(decodeURIComponent(m[1].replace(/^[a-z-]+:\/\/(vscode-app)?/, '').replace(/[?#].*$/, ''))); } const font = opts.opentype.parse(buf); font.__adv = new Map(); registerFontFace(family, font); } } catch (e) { noteMissing('font-face parse: ' + (e && e.message)); } };
	const doc = new Document(env); env.document = doc;
	const timers = { rafs: new Map(), nextRaf: 1 };
	const defineGlobal = (k, v) => Object.defineProperty(g, k, { value: v, writable: true, configurable: true, enumerable: false });
	const et = new EventTarget(); for (const k of ['addEventListener', 'removeEventListener', 'dispatchEvent']) { defineGlobal(k, (...a) => et[k](...a)); }
	et.__parentForEvents = () => null;
	Object.defineProperty(g, '__l', { get() { return et.__l; }, set(v) { et.__l = v; }, configurable: true }); defineGlobal('__parentForEvents', () => null);   // the window is the last node of an event path: its listeners live in `et`
	defineGlobal('window', g); defineGlobal('self', g); defineGlobal('top', g); defineGlobal('parent', g); defineGlobal('frames', g); defineGlobal('globalThis', g); defineGlobal('document', doc);
	const loc = { href: 'file:///index.html', origin: 'file://', protocol: 'file:', host: '', hostname: '', port: '', pathname: '/index.html', search: '', hash: '', assign() { }, replace() { }, reload() { }, toString() { return this.href; } }; defineGlobal('location', loc);
	defineGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36', platform: 'Linux x86_64', language: 'en-US', languages: ['en-US', 'en'], hardwareConcurrency: 4, maxTouchPoints: 0, onLine: true, cookieEnabled: true, vendor: 'Google Inc.', appVersion: '5.0 (X11)', clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') }, sendBeacon() { return true; }, webdriver: false, serviceWorker: undefined, mediaDevices: undefined, getGamepads() { return []; }, permissions: { query: () => Promise.resolve({ state: 'denied' }) }, locks: undefined, userAgentData: undefined, keyboard: undefined });
	for (const [k, v] of [['innerWidth', env.vw], ['innerHeight', env.vh], ['outerWidth', env.vw], ['outerHeight', env.vh], ['devicePixelRatio', 1], ['scrollX', 0], ['scrollY', 0], ['pageXOffset', 0], ['pageYOffset', 0], ['screenX', 0], ['screenY', 0], ['isSecureContext', true], ['origin', 'file://'], ['name', ''], ['closed', false], ['length', 0], ['opener', null], ['frameElement', null]]) { defineGlobal(k, v); }
	defineGlobal('screen', { width: env.vw, height: env.vh, availWidth: env.vw, availHeight: env.vh, availLeft: 0, availTop: 0, colorDepth: 24, pixelDepth: 24, orientation: { type: 'landscape-primary', angle: 0, addEventListener() { } } });
	defineGlobal('history', { length: 1, state: null, pushState() { }, replaceState() { }, back() { }, forward() { }, go() { } });
	defineGlobal('localStorage', new Storage()); defineGlobal('sessionStorage', new Storage());
	defineGlobal('getComputedStyle', (el, pseudo) => computedStyleFor(doc, el, pseudo));
	defineGlobal('matchMedia', (q) => { const m = { matches: false, media: q, onchange: null, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { }, dispatchEvent() { return true; } }; const L = /\(\s*([\w-]+)\s*(?::\s*([^)]+))?\)/g; let ok = true, k; let any = false; while ((k = L.exec(q))) { any = true; const v = (k[2] || '').trim(); switch (k[1]) { case 'min-width': ok = ok && env.vw >= parseFloat(v); break; case 'max-width': ok = ok && env.vw <= parseFloat(v); break; case 'prefers-color-scheme': ok = ok && v === 'light'; break; case 'prefers-reduced-motion': ok = ok && v === 'no-preference'; break; case 'hover': case 'any-hover': ok = ok && v === 'hover'; break; case 'pointer': case 'any-pointer': ok = ok && v === 'fine'; break; case 'min-resolution': ok = ok && 1 >= parseFloat(v); break; case '-webkit-min-device-pixel-ratio': ok = ok && 1 >= parseFloat(v); break; case 'forced-colors': ok = ok && v === 'none'; break; case 'prefers-contrast': ok = ok && v === 'no-preference'; break; case 'display-mode': ok = ok && v === 'browser'; break; default: ok = false; } } m.matches = any && ok; return m; });
	defineGlobal('requestAnimationFrame', (cb) => { const id = timers.nextRaf++; timers.rafs.set(id, cb); return id; }); defineGlobal('cancelAnimationFrame', (id) => timers.rafs.delete(id));
	defineGlobal('requestIdleCallback', (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 10 }), 0)); defineGlobal('cancelIdleCallback', (id) => clearTimeout(id));
	defineGlobal('scrollTo', () => { }); defineGlobal('scroll', () => { }); defineGlobal('scrollBy', () => { }); defineGlobal('focus', () => { }); defineGlobal('blur', () => { }); defineGlobal('print', () => { }); defineGlobal('open', () => null); defineGlobal('close', () => { }); defineGlobal('stop', () => { });
	defineGlobal('getSelection', () => doc.getSelection()); defineGlobal('postMessage', () => { }); defineGlobal('reportError', (e) => console.error(e));
	defineGlobal('CSS', { escape: (s) => String(s).replace(/[^\w-]/g, c => '\\' + c), supports: () => true, registerProperty() { } });
	for (const [k, v] of Object.entries({ Node, Element, HTMLElement, SVGElement, Text, Comment, DocumentFragment, Document, EventTarget, Event: D.Event, UIEvent: D.UIEvent, MouseEvent: D.MouseEvent, PointerEvent: D.PointerEvent, WheelEvent: D.WheelEvent, KeyboardEvent: D.KeyboardEvent, FocusEvent: D.FocusEvent, CustomEvent: D.CustomEvent, InputEvent: D.InputEvent, CompositionEvent: D.CompositionEvent, ClipboardEvent: D.ClipboardEvent, DragEvent: D.DragEvent, TouchEvent: D.TouchEvent, ErrorEvent: D.ErrorEvent, MessageEvent: D.MessageEvent, Range: D.Range, Selection: D.Selection, DOMException: D.DOMException, MutationObserver: D.MutationObserver, ResizeObserver, IntersectionObserver, DOMRect, DOMRectReadOnly: DOMRect, CSSStyleSheet, CSSStyleDeclaration: D.CSSStyleDeclaration, Storage, HTMLDivElement: D.HTMLDivElement, HTMLSpanElement: D.HTMLSpanElement, HTMLBodyElement: D.HTMLBodyElement, HTMLAnchorElement: D.HTMLAnchorElement, HTMLButtonElement: D.HTMLButtonElement, HTMLLabelElement: D.HTMLLabelElement, HTMLImageElement: D.HTMLImageElement, HTMLLinkElement: D.HTMLLinkElement, HTMLScriptElement: D.HTMLScriptElement, HTMLIFrameElement: D.HTMLIFrameElement, HTMLInputElement: D.HTMLInputElement, HTMLTextAreaElement: D.HTMLTextAreaElement, HTMLStyleElement: D.HTMLStyleElement, HTMLCanvasElement: D.HTMLCanvasElement, HTMLTemplateElement: D.HTMLTemplateElement, HTMLUListElement: D.HTMLUListElement, HTMLLIElement: D.HTMLLIElement, HTMLSelectElement: D.HTMLSelectElement, HTMLTableElement: D.HTMLTableElement, HTMLUnknownElement: D.HTMLUnknownElement, HTMLHeadElement: D.HTMLHeadElement, HTMLHtmlElement: D.HTMLHtmlElement, HTMLParagraphElement: D.HTMLParagraphElement, HTMLPreElement: D.HTMLPreElement, HTMLBRElement: D.HTMLBRElement })) { defineGlobal(k, v); }
	defineGlobal('customElements', { define(name, ctor) { (doc.__customs ??= new Map()).set(name, ctor); doc.__hasCustom = true; }, get(name) { return doc.__customs && doc.__customs.get(name); }, whenDefined() { return Promise.resolve(); }, upgrade() { } });
	defineGlobal('XMLSerializer', class { serializeToString(n) { return D.serialize(n); } }); defineGlobal('DOMParser', class { parseFromString(s) { const d = new Document(env); d.documentElement.__children.length = 0; d.body.innerHTML = s; return d; } });
	defineGlobal('FileReader', class extends EventTarget { readAsText() { } readAsDataURL() { } }); defineGlobal('HTMLMediaElement', class { }); defineGlobal('CanvasRenderingContext2D', Canvas2D); defineGlobal('Image', class { constructor() { return doc.createElement('img'); } }); defineGlobal('Option', class { });
	if (typeof g.MessageChannel === 'undefined') { defineGlobal('MessageChannel', class { constructor() { const mk = () => Object.assign(new EventTarget(), { postMessage(d) { const o = this.other; setTimeout(() => o.dispatchEvent(new D.MessageEvent('message', { data: d })), 0); }, start() { }, close() { }, onmessage: null }); this.port1 = mk(); this.port2 = mk(); this.port1.other = this.port2; this.port2.other = this.port1; for (const p of [this.port1, this.port2]) { p.addEventListener('message', (e) => { if (typeof p.onmessage === 'function') { p.onmessage(e); } }); } } }); }
	// the hooks the harness uses
	env.flushFrames = (max = 10) => { let n = 0; while (timers.rafs.size && n++ < max) { const list = [...timers.rafs.values()]; timers.rafs.clear(); for (const cb of list) { try { cb(performance.now()); } catch (e) { console.error('[rAF]', e && (e.stack || e)); } } doc.__ensureLayout(); } return n; };
	env.pendingFrames = () => timers.rafs.size;
	env.doc = doc; g.__env = env; return env;
}

// ---- getComputedStyle -------------------------------------------------------------------------------------------------------------------------
export function computedStyleFor(doc, el, pseudo) {
	doc.__ensureLayout(); const cs = el.__cs; const box = doc.__layout && doc.__layout.boxOf.get(el); const vals = cs ? cs.values : {};
	const dashOf = (n) => n.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
	const get = (n) => {
		const k = n.startsWith('--') ? n : dashOf(n === 'cssFloat' ? 'float' : n); if (k.startsWith('--')) { return cs ? (cs.vars.get(k) ?? '') : ''; }
		if (!cs) { return ''; }
		if (box && (k === 'width' || k === 'height')) { const bb = vals['box-sizing'] === 'border-box'; if (box.kind === 'inline' || vals.display === 'none') { return 'auto'; } return (k === 'width' ? (bb ? box.w : box.w - box.hx) : (bb ? box.h : box.h - box.vy)) + 'px'; }
		if (box && /^(margin|padding)-(top|right|bottom|left)$/.test(k)) { const side = { top: 't', right: 'r', bottom: 'b', left: 'l' }[k.split('-')[1]]; return (k.startsWith('margin') ? box['m' + side] : box['p' + side]) + 'px'; }
		if (k === 'line-height') { const l = vals['line-height']; if (l === 'normal') { return 'normal'; } return typeof l === 'number' ? l + 'px' : (l && l.num !== undefined ? (l.num * vals['font-size']) + 'px' : serializeValue(k, l)); }
		if (k === 'font-size') { return vals[k] + 'px'; } if (k === 'font-weight') { return String(vals[k]); }
		if (k in vals) { return serializeValue(k, vals[k]); } if (k === 'zoom') { return '1'; }   // an empty zoom would make DOM.getDomNodeZoomLevel() multiply by 0: the menu bar's dropdowns landed at 0,0
		return '';
	};
	const target = { getPropertyValue: get, getPropertyPriority: () => '', item: (i) => Object.keys(vals)[i] ?? '', get length() { return Object.keys(vals).length; }, setProperty() { }, removeProperty() { return ''; }, get cssText() { return ''; } };
	return new Proxy(target, { get(t, k) { if (typeof k === 'symbol' || k in t) { return t[k]; } return get(k); }, has() { return true; } });
}
