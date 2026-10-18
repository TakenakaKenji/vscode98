// Packs the styled box tree built by 06-rendering/host/dom/layout.js (Layout.build) into flat typed arrays for the native layout engine (layout.c).
// The field offsets below must match the F_* enum in layout.c. Strings (enum-like CSS values) become small integers, lengths become (tag, value) pairs
// (tag 0 keyword/auto, 1 px, 2 percent, 3 calc, 4 calc containing a percentage), calc() trees go to a node pool, text goes to a UTF-16 pool.
import { resolveFont, fontMetrics } from '../../06-rendering/host/dom/fonts.js';
import { nativeFontId, ensureAdvances } from './native_fonts.js';

export const F = {
	KIND: 0, PARENT: 1, DISPLAY: 2, FLAGS: 3, POS: 4, BORDERBOX: 5, MARGIN: 6, PADDING: 14, BORDER: 22, WIDTH: 26, HEIGHT: 28, MINW: 30, MINH: 32, MAXW: 34, MAXH: 36, OVX: 38, OVY: 39,
	FDIR: 40, FWRAP: 41, FGROW: 42, FSHRINK: 43, FBASIS: 44, ORDER: 46, AITEMS: 47, ASELF: 48, ACONTENT: 49, JUSTIFY: 50, ROWGAP: 51, COLGAP: 53, TOP: 55, LEFT: 57, RIGHT: 59, BOTTOM: 61,
	TALIGN: 63, WS: 64, BREAKALL: 65, OWRAP: 66, TAB: 67, LS: 68, WSP: 69, TTRANSFORM: 70, LH: 71, FSIZE: 72, FONT: 73, TEXT: 74, TEXTLEN: 75, TEXT2: 76, TEXT2LEN: 77, REPLW: 78, REPLH: 79, STRIDE: 80,
};
export const KIND = { block: 0, flex: 1, inline: 2, 'inline-block': 3, text: 4, br: 5 };
const KW = { auto: 0, none: 0, 'min-content': 1, 'max-content': 2, 'fit-content': 3 };
const POS = { static: 0, relative: 1, absolute: 2, fixed: 3 };
const ALIGN = { auto: 0, normal: 1, stretch: 2, center: 3, 'flex-end': 4, end: 4, 'self-end': 4, right: 4 };
const JUSTIFY = { center: 1, 'flex-end': 2, end: 2, right: 2, 'space-between': 3, 'space-around': 4, 'space-evenly': 5 };
const ACONTENT = { center: 1, 'flex-end': 2, end: 2, 'space-between': 3, stretch: 4, normal: 4 };
const FDIR = { row: 0, 'row-reverse': 1, column: 2, 'column-reverse': 3 };
const WS = { normal: 0, nowrap: 1, pre: 2, 'pre-wrap': 3, 'pre-line': 4, 'break-spaces': 5 };
const TALIGN = { center: 1, right: 2, end: 2 };
const TTR = { none: 0, uppercase: 1, lowercase: 2, capitalize: 3 };

/** Growable pools shared by one packing pass. */
export class Pack {
	constructor() { this.boxes = new Float64Array(1024 * F.STRIDE); this.n = 0; this.calc = new Float64Array(1024); this.nc = 0; this.text = new Uint16Array(1 << 15); this.nt = 0; this.list = []; }
	/** empties the pools, keeping their (grown) buffers: records are zeroed per box in packTree, calc nodes and text are written before they are read */
	reset() { this.n = 0; this.nc = 0; this.nt = 0; this.list = []; }
	allocBox() { if ((this.n + 1) * F.STRIDE > this.boxes.length) { const nb = new Float64Array(this.boxes.length * 2); nb.set(this.boxes); this.boxes = nb; } return this.n++; }
	calcNode(a, b, c, d) { if (this.nc + 4 > this.calc.length) { const nb = new Float64Array(this.calc.length * 2); nb.set(this.calc); this.calc = nb; } const i = this.nc; this.calc[i] = a; this.calc[i + 1] = b; this.calc[i + 2] = c; this.calc[i + 3] = d; this.nc += 4; return i; }
	addText(s) { const n = s.length; if (this.nt + n > this.text.length) { let len = this.text.length; while (len < this.nt + n) { len *= 2; } const nb = new Uint16Array(len); nb.set(this.text); this.text = nb; } const o = this.nt; for (let i = 0; i < n; i++) { this.text[o + i] = s.charCodeAt(i); } this.nt += n; return o; }
}
// calc tree: number | {pct} | {op,a,b} | {fn,args}   ->  nodes of 4 doubles: [kind, x, y, z]; kind 0 const(x), 1 pct(x), 2 op(x=char code, y=a node, z=b node), 3 fn(x=0 min/1 max/2 clamp, y=first arg index in the arg table node chain, z=count) ; args stored as consecutive nodes of kind 4 (ref, x=node)
function packCalc(pk, t) {
	if (typeof t === 'number') { return pk.calcNode(0, t, 0, 0); } if (t.pct !== undefined) { return pk.calcNode(1, t.pct, 0, 0); }
	if (t.op) { const a = packCalc(pk, t.a), b = packCalc(pk, t.b); return pk.calcNode(2, t.op.charCodeAt(0), a, b); }
	if (t.fn) { const refs = t.args.map(x => packCalc(pk, x)); let first = -1; for (const r of refs) { const i = pk.calcNode(4, r, 0, 0); if (first < 0) { first = i; } } return pk.calcNode(3, t.fn === 'min' ? 0 : t.fn === 'max' ? 1 : 2, first, refs.length); }
	return pk.calcNode(0, 0, 0, 0);
}
const hasPct = (t) => typeof t === 'number' ? false : t.pct !== undefined ? true : t.op ? hasPct(t.a) || hasPct(t.b) : t.fn ? t.args.some(hasPct) : false;
function putLen(pk, a, o, x, autoVal = 0) {
	if (typeof x === 'number') { a[o] = 1; a[o + 1] = x; }
	else if (x !== null && typeof x === 'object') { if (x.pct !== undefined) { a[o] = 2; a[o + 1] = x.pct; } else if (x.calc) { a[o] = hasPct(x.calc) ? 4 : 3; a[o + 1] = packCalc(pk, x.calc); } else if (x.num !== undefined) { a[o] = 1; a[o + 1] = x.num; } else { a[o] = 0; a[o + 1] = 0; } }
	else if (typeof x === 'string') { a[o] = 0; a[o + 1] = x === 'auto' && autoVal ? autoVal : (KW[x] ?? 0); }
	else { a[o] = 0; a[o + 1] = 0; }
}
const num = (x, d = 0) => (typeof x === 'number' ? x : d);

const recCache = new WeakMap();   // computed style values -> packed style record (see packTree)
// One pack for every pass: a new one allocated ~2.5 MB of zeroed buffers per layout pass, and in QuickJS allocations of that size set off the cycle collector over the whole
// heap while packTree ran (3.0 of its 6.4 s over the 90 actions of the control scenario, 10 % of all interaction time on the sandbox). The C layout only reads the arrays during its call.
const sharedPack = new Pack();
/** Packs `box` (a Layout.build result) and its descendants in pre-order. Returns the Pack; pk.list[i] is the Box at index i. */
export function packTree(lay, rootBox, pk = sharedPack) {
	pk.reset();
	const walk = (b, parentIdx) => {
		const i = pk.allocBox(); pk.list.push(b); const a = pk.boxes, o = i * F.STRIDE; a.fill(0, o, o + F.STRIDE);
		a[o + F.KIND] = KIND[b.kind]; a[o + F.PARENT] = parentIdx;
		if (b.kind === 'text') {
			// style comes from the parent record in the native engine
			const parentV = b.parent.v; const font = resolveFont(parentV['font-family'], parentV['font-weight'], parentV['font-style']); const fid = nativeFontId(font);
			a[o + F.FONT] = fid; a[o + F.TEXT] = pk.addText(b.text); a[o + F.TEXTLEN] = b.text.length;
			const tr = parentV['text-transform']; let t2 = b.text; if (tr === 'uppercase') { t2 = t2.toUpperCase(); } else if (tr === 'lowercase') { t2 = t2.toLowerCase(); } else if (tr === 'capitalize') { t2 = t2.replace(/(^|\s)(\S)/g, (_, x, y) => x + y.toUpperCase()); }
			if (t2 !== b.text) { a[o + F.TEXT2] = pk.addText(t2); a[o + F.TEXT2LEN] = t2.length; } else { a[o + F.TEXT2] = a[o + F.TEXT]; a[o + F.TEXT2LEN] = a[o + F.TEXTLEN]; }
			ensureAdvances(font, fid, b.text); if (t2 !== b.text) { ensureAdvances(font, fid, t2); }
			return i;
		}
		const v = b.v; const d = b.display;
		// the style part of a record only depends on the computed style object (unchanged for every element that was not restyled), the box kind and the box flags: reuse it (not for replaced
		// boxes, whose size comes from the element, nor for records that put calc() trees into the pool: their node indexes belong to this pack)
		const hit = recCache.get(v);
		const usable = hit !== undefined && hit.kind === b.kind && hit.display === d && hit.flags === ((b.oof ? 1 : 0) | (b.replaced ? 2 : 0) | (b.pseudo ? 4 : 0));
		if (usable && !globalThis.__packVerify) { a.set(hit.data, o); a[o + F.PARENT] = parentIdx; for (const c of b.children) { walk(c, i); } return i; }
		const nc0 = pk.nc;
		a[o + F.DISPLAY] = d === 'flex' ? 1 : d === 'inline-flex' ? 2 : d === 'flow-root' ? 3 : 0;
		a[o + F.FLAGS] = (b.oof ? 1 : 0) | (b.replaced ? 2 : 0) | (b.pseudo ? 4 : 0) | (v.transform && v.transform !== 'none' ? 8 : 0);
		a[o + F.POS] = POS[v.position] ?? 4; a[o + F.BORDERBOX] = v['box-sizing'] === 'border-box' ? 1 : 0;
		putLen(pk, a, o + F.MARGIN, v['margin-top'], 4); putLen(pk, a, o + F.MARGIN + 2, v['margin-right'], 4); putLen(pk, a, o + F.MARGIN + 4, v['margin-bottom'], 4); putLen(pk, a, o + F.MARGIN + 6, v['margin-left'], 4);
		putLen(pk, a, o + F.PADDING, v['padding-top']); putLen(pk, a, o + F.PADDING + 2, v['padding-right']); putLen(pk, a, o + F.PADDING + 4, v['padding-bottom']); putLen(pk, a, o + F.PADDING + 6, v['padding-left']);
		a[o + F.BORDER] = num(v['border-top-width']); a[o + F.BORDER + 1] = num(v['border-right-width']); a[o + F.BORDER + 2] = num(v['border-bottom-width']); a[o + F.BORDER + 3] = num(v['border-left-width']);
		putLen(pk, a, o + F.WIDTH, v.width); putLen(pk, a, o + F.HEIGHT, v.height); putLen(pk, a, o + F.MINW, v['min-width']); putLen(pk, a, o + F.MINH, v['min-height']); putLen(pk, a, o + F.MAXW, v['max-width']); putLen(pk, a, o + F.MAXH, v['max-height']);
		a[o + F.OVX] = v['overflow-x'] !== 'visible' ? 1 : 0; a[o + F.OVY] = v['overflow-y'] !== 'visible' ? 1 : 0;
		a[o + F.FDIR] = FDIR[v['flex-direction']] ?? 0; a[o + F.FWRAP] = v['flex-wrap'] !== 'nowrap' ? 1 : 0; a[o + F.FGROW] = num(v['flex-grow']); a[o + F.FSHRINK] = v['flex-shrink'] === undefined ? 1 : num(v['flex-shrink'], 1);
		const fb = v['flex-basis']; if (fb === 'auto') { a[o + F.FBASIS] = 0; a[o + F.FBASIS + 1] = 0; } else if (fb === 'content') { a[o + F.FBASIS] = 0; a[o + F.FBASIS + 1] = 1; } else { putLen(pk, a, o + F.FBASIS, fb); if (a[o + F.FBASIS] === 0) { a[o + F.FBASIS + 1] = 2; } }
		a[o + F.ORDER] = num(v.order); a[o + F.AITEMS] = ALIGN[v['align-items']] ?? 5; a[o + F.ASELF] = ALIGN[v['align-self']] ?? 5; a[o + F.ACONTENT] = ACONTENT[v['align-content']] ?? 0; a[o + F.JUSTIFY] = JUSTIFY[v['justify-content']] ?? 0;
		putLen(pk, a, o + F.ROWGAP, v['row-gap']); putLen(pk, a, o + F.COLGAP, v['column-gap']);
		putLen(pk, a, o + F.TOP, v.top); putLen(pk, a, o + F.LEFT, v.left); putLen(pk, a, o + F.RIGHT, v.right); putLen(pk, a, o + F.BOTTOM, v.bottom);
		a[o + F.TALIGN] = TALIGN[v['text-align']] ?? 0; a[o + F.WS] = WS[v['white-space']] ?? 0; a[o + F.BREAKALL] = (v['word-break'] === 'break-all' || v['word-break'] === 'break-word') ? 1 : 0;
		a[o + F.OWRAP] = (v['overflow-wrap'] === 'break-word' || v['overflow-wrap'] === 'anywhere' || v['word-wrap'] === 'break-word') ? 1 : 0; a[o + F.TAB] = parseFloat(v['tab-size']) || 8;
		a[o + F.LS] = typeof v['letter-spacing'] === 'number' ? v['letter-spacing'] : 0; a[o + F.WSP] = typeof v['word-spacing'] === 'number' ? v['word-spacing'] : 0; a[o + F.TTRANSFORM] = TTR[v['text-transform']] ?? 0;
		const fs = v['font-size']; a[o + F.FSIZE] = fs; const l = v['line-height']; let lh = NaN; if (l !== 'normal' && l !== undefined) { if (l && l.num !== undefined) { lh = l.num * fs; } else { const r = putLhResolve(l, fs); lh = r === null ? NaN : r; } } a[o + F.LH] = lh;
		const font = resolveFont(v['font-family'], v['font-weight'], v['font-style']); a[o + F.FONT] = nativeFontId(font);
		if (b.replaced) { const rs = lay.replacedSize(b); a[o + F.REPLW] = rs.w; a[o + F.REPLH] = rs.h; if (b.__ratio) { a[o + F.FLAGS] += 16; } }
		if (usable && globalThis.__packVerify) { const g = globalThis.__packStats ??= { checked: 0, bad: 0 }; g.checked++; for (let k = 0; k < F.STRIDE; k++) { if (k !== F.PARENT && !Object.is(a[o + k], hit.data[k])) { g.bad++; break; } } }
		else if (pk.nc === nc0 && !b.anon && !b.replaced) { recCache.set(v, { kind: b.kind, display: d, flags: (b.oof ? 1 : 0) | (b.replaced ? 2 : 0) | (b.pseudo ? 4 : 0), data: a.slice(o, o + F.STRIDE) }); }
		for (const c of b.children) { walk(c, i); }
		return i;
	};
	walk(rootBox, -1); return pk;
}
import { resolveLen } from '../../06-rendering/host/dom/css.js';
function putLhResolve(l, fs) { return resolveLen(l, fs); }
