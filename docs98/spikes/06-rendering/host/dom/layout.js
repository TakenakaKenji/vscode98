// Style resolution + layout for the rendering spike: block flow with margin collapsing, inline formatting (line breaking, white-space modes, baseline alignment),
// inline-block and replaced elements, absolute/fixed/relative positioning, flexbox (single and multi-line), overflow/scroll geometry, translate/scale transforms.
// Not implemented (recorded in `unsupported`): floats, tables (laid out as blocks), grid, multi-column, writing modes, bidi, ::first-line/letter.
import { buildRuleIndex, computeStyle, matchedDeclarations, matchedDeclarationsAll, resolveLen, PROPS, ancestorFilter, INH, varsEqual } from './css.js';
import { analyzeIndex, diffIndex, deltaOfUpdate, mergeInv, planRestyle, logTouchesSheets, inheritedChanged, deepEqual } from './style_invalidation.js';
import { resolveFont, fontMetrics, advance, kern } from './fonts.js';
import { noteMissing } from './dom.js';
import { optionList } from './selectmodel.js';
import { setMatchMemo } from './selectors.js';

export const unsupported = new Map();
const box_oof = (v) => v.position === 'absolute' || v.position === 'fixed';
const unsup = (k) => { unsupported.set(k, (unsupported.get(k) || 0) + 1); };

// ---- style pass -------------------------------------------------------------------------------------------------------------------------------
const countElements = (el) => { let n = 1; for (const c of el.__children) { if (c.nodeType === 1) { n += countElements(c); } } return n; };
/**
 * Computes the style of every element that needs it. The first pass, and any pass whose rule set, environment or mutation log cannot be analysed, restyles the whole tree;
 * all other passes restyle only what style_invalidation.js plans (see there for the levels). Cached per element: el.__cs (computed style), el.__cands (matched rules),
 * el.__pcands (matched rules of ::before/::after), el.__anc (ancestor Bloom filter). Statistics of the pass go to doc.__styleInfo.
 */
// ---- style-only passes: when a pass only restyled elements and none of the properties that layout (or a box's kind) reads changed, the previous layout is still right.
// PAINT_ONLY lists the properties that only painting reads (colors, backgrounds, shadows, outlines, radii, opacity, cursor, z-index, ...); every other property counts as layout-relevant.
const PAINT_ONLY = new Set(['color', 'background-color', 'background-image', 'background-position', 'background-position-x', 'background-position-y', 'background-size', 'background-repeat', 'background-clip', 'background-origin', 'background-attachment',
	'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
	'outline-color', 'outline-style', 'outline-width', 'outline-offset', 'box-shadow', 'text-shadow', 'opacity', 'cursor', 'pointer-events', 'z-index', 'text-decoration-line', 'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness',
	'caret-color', 'accent-color', 'fill', 'stroke', 'stroke-width', 'mix-blend-mode', 'user-select', 'transition', 'transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay', 'animation', 'will-change', 'scroll-behavior']);
// attributes that no layout code reads (the style system still sees them as attribute selectors)
const NO_LAYOUT_ATTR = new Set(['role', 'title', 'custom-hover', 'placeholder', 'tabindex', 'draggable', 'spellcheck', 'autocomplete', 'aria-label']);
/** do two computed-style value maps differ in a property layout reads? */
export function layoutPropsDiffer(a, b) {
	for (let i = 0; i < LAYOUT_KEYS.length; i++) { const k = LAYOUT_KEYS[i]; const x = a[k], y = b[k]; if (x !== y && (typeof x !== 'object' || typeof y !== 'object' || !deepEqual(x, y))) { return true; } }   // computed values always carry every property of PROPS
	return false;
}
const LAYOUT_KEYS = Object.keys(PROPS).filter((k) => !PAINT_ONLY.has(k));
const pseudoDiffers = (a, b) => (a === null || a === undefined) !== (b === null || b === undefined) || (a && b && deepEqual(a.values, b.values) === false);   // a pseudo-element's whole style: its box is rebuilt (not patched) when it changes
export function resolveStyles(doc, env, log) {
	const t0 = performance.now(); const root = doc.documentElement; const passId = (doc.__stylePass = (doc.__stylePass || 0) + 1);
	const envKey = `${env.vw}x${env.vh}|${env.dark}|${env.dpr}`; let index = doc.__ruleIndex; let delta = null; let full = null;
	if (!doc.__styleReady) { full = 'first pass'; } else if (log === undefined) { full = 'no mutation log'; } else if (doc.__incremental === false) { full = 'incremental style disabled'; }
	let planInv = null;
	if (!index || doc.__indexRulesVersion !== doc.__rulesVersion || envKey !== doc.__indexEnvKey || (log && logTouchesSheets(log))) {
		const old = index; index = buildRuleIndex(doc, env, old); const upd = index === old ? index.update : null; index.update = null; const extended = upd !== null; const added = extended ? upd.added : null;
		index.inv = analyzeIndex(index, old && old.inv, added); planInv = old && old.inv && old.inv !== index.inv ? mergeInv(old.inv, index.inv) : index.inv; doc.__ruleIndex = index; doc.__indexRulesVersion = doc.__rulesVersion;
		if (!full) { if (envKey !== doc.__indexEnvKey) { full = 'environment changed'; } else { delta = !old ? null : extended ? deltaOfUpdate(upd) : diffIndex(old, index); if (!delta) { full = 'rule set changed too much'; } } }
		doc.__indexEnvKey = envKey;
	}
	const indexMs = performance.now() - t0; let total = root ? countElements(root) : 0; let plan = null;
	if (!full && root) { plan = planRestyle(doc, log, planInv || index.inv, delta, total); if (plan.full) { full = plan.full; plan = null; } }
	const info = { mode: full ? 'full' : 'incremental', reason: full || '', total, recomputed: 0, rematched: 0, marked: plan ? plan.marks.size : 0, planMs: 0, indexMs, sheets: !!delta || undefined };
	if (plan) { for (const el of plan.marks.keys()) { for (let a = el; a && a.nodeType === 1 && a.__dd !== passId; a = a.parentNode) { a.__dd = passId; } } }
	info.planMs = performance.now() - t0 - indexMs;
	if (plan && globalThis.__styleDebug) { globalThis.__styleDebug(plan, log, planInv || index.inv); }
	const NS = env.styleEngine || null;   // native selector matching (07-native-render/host/native_style.js); its matcher needs no ancestor filter from here
	let layoutChanged = false; const changed = [];   // restyled elements, and whether any of them changed in a way layout reads
	const walk = (el, parentCS, parentAnc, forced, prev) => {
		let lvl = forced; if (plan) { const m = plan.marks.get(el); if (m !== undefined && m > lvl) { lvl = m; } } if (full) { lvl = 3; }
		let cs = el.__cs, anc = el.__anc, childForced = 0; el.__prev = prev;
		if (lvl > 0 || !cs) {
			const rematch = lvl >= 2 || !cs || !el.__cands; anc = NS !== null ? null : ancestorFilter(el, parentAnc); el.__anc = anc;
			const oldCs = cs, ob = el.__before, oa = el.__after;
			let cands, pc; if (rematch) { const all = NS !== null ? NS.matchAll(el, index) : matchedDeclarationsAll(el, index); cands = all[0]; pc = el.__pcands = [all[1], all[2]]; } else { cands = el.__cands; pc = el.__pcands ??= NS !== null ? NS.matchAll(el, index).slice(1) : [matchedDeclarations(el, index, null, 'before'), matchedDeclarations(el, index, null, 'after')]; }
			const ncs = computeStyle(el, parentCS, index, env, null, cands); info.recomputed++; if (rematch) { info.rematched++; }
			['before', 'after'].forEach((pe, i) => { const pcs = pc[i].length ? computeStyle(el, ncs, index, env, pe, pc[i]) : null; const c = pcs && pcs.values.content; el['__' + pe] = (c && c !== 'none' && c !== 'normal') ? pcs : null; });
			el.__cands = cands; childForced = lvl === 3 ? 3 : (inheritedChanged(cs, ncs, INH) ? 1 : 0); el.__cs = cs = ncs; changed.push(el);
			if (!layoutChanged && (!oldCs || layoutPropsDiffer(oldCs.values, ncs.values) || pseudoDiffers(ob, el.__before) || pseudoDiffers(oa, el.__after))) { layoutChanged = true; }
		} else if (el.__dd !== passId) { return; } else { anc = NS !== null ? null : ancestorFilter(el, parentAnc); el.__anc = anc; }   // ancestors on the way to a marked element: their filter is rebuilt too, a cached one may predate a class change that no rule cared about then
		let pe = null; for (const c of el.__children) { if (c.nodeType === 1) { walk(c, cs, anc, childForced, pe); pe = c; } }
	};
	if (root) { if (NS !== null) { NS.beginPass(doc); } setMatchMemo(passId); try { walk(root, null, null, 0); } finally { setMatchMemo(0); } } doc.__styleCount = total; doc.__styleReady = true; { const ae = doc.__activeElement && doc.__activeElement.isConnected ? doc.__activeElement : null; doc.__styledActive = ae; doc.__styledChain = []; for (let a = ae; a && a.nodeType === 1; a = a.parentNode) { doc.__styledChain.push(a); } } doc.__logOverflow = false; info.ms = performance.now() - t0; doc.__styleInfo = info;
	doc.__styleResult = { layoutChanged: layoutChanged || !!root === false, changed };
	if (doc.__verifyStyles) { verifyStyles(doc, env, index); }
}
/** Test oracle: restyle everything from scratch (without the ancestor filter) and record every difference to the cached styles in doc.__styleMismatches. */
export function verifyStyles(doc, env, index) {
	const out = (doc.__styleMismatches ??= []); const root = doc.documentElement; if (!root) { return; }
	const same = (a, b) => (a === null || a === undefined) ? (b === null || b === undefined) : (b !== null && b !== undefined && deepEqual(a.values, b.values) && varsEqual(a.vars, b.vars));
	const describe = (el) => el.localName + (el.getAttribute('id') ? '#' + el.getAttribute('id') : '') + (el.classes().length ? '.' + el.classes().join('.') : '');
	const diffProps = (a, b) => { if (!a || !b) { return String(!!a) + '/' + String(!!b); } for (const k of Object.keys(b.values)) { if (!deepEqual(a.values[k], b.values[k])) { return `${k}: ${JSON.stringify(a.values[k])} (cached) vs ${JSON.stringify(b.values[k])} (full)`; } } return 'custom properties'; };
	const walk = (el, parentCS) => {
		const saved = el.__anc; el.__anc = undefined;
		const fresh = matchedDeclarations(el, index, null, null); const cs = computeStyle(el, parentCS, index, env, null, fresh); const pseudo = {};
		for (const pe of ['before', 'after']) { const pcs = computeStyle(el, cs, index, env, pe); const c = pcs && pcs.values.content; pseudo[pe] = (c && c !== 'none' && c !== 'normal') ? pcs : null; }
		el.__anc = saved;
		if (!same(el.__cs, cs) && out.length < 200) { const had = new Set((el.__cands || []).map(e => e.sel)), want = new Set(fresh.map(e => e.sel)); out.push(`${describe(el)}: ${diffProps(el.__cs, cs)}   [rules only cached: ${[...had].filter(x => !want.has(x)).join(' ; ') || '-'}; only fresh: ${[...want].filter(x => !had.has(x)).join(' ; ') || '-'}]`); }
		for (const pe of ['before', 'after']) { if (!same(el['__' + pe], pseudo[pe]) && out.length < 200) { out.push(`${describe(el)}::${pe}: ${diffProps(el['__' + pe], pseudo[pe])}`); } }
		for (const c of el.__children) { if (c.nodeType === 1) { walk(c, cs); } }
	};
	walk(root, null);
}
export function parseContent(v) { if (!v) { return ''; } let out = ''; const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g; let m; while ((m = re.exec(v))) { out += (m[1] ?? m[2]).replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi, (_, h, c) => h ? String.fromCodePoint(parseInt(h, 16)) : c); } return out; }

// ---- boxes ------------------------------------------------------------------------------------------------------------------------------------
export class Box {
	constructor(el, cs, kind) { this.el = el; this.cs = cs; this.v = cs ? cs.values : null; this.kind = kind; this.children = []; this.parent = null; this.ox = 0; this.oy = 0; this.w = 0; this.h = 0; this.ax = 0; this.ay = 0; this.lines = null; this.pos = this.v ? this.v.position : 'static'; this.mt = this.mr = this.mb = this.ml = 0; this.pt = this.pr = this.pb = this.pl = 0; this.bt = this.br = this.bb = this.bl = 0; this.text = null; this.oof = false; this.relDx = 0; this.relDy = 0; this.scrollW = 0; this.scrollH = 0; }
}
/** style of the anonymous block box wrapped around text that is a direct child of a flex container */
export function anonStyle(v) { return Object.assign({}, v, { display: 'block', 'margin-top': 0, 'margin-bottom': 0, 'margin-left': 0, 'margin-right': 0, 'padding-top': 0, 'padding-bottom': 0, 'padding-left': 0, 'padding-right': 0, 'border-top-width': 0, 'border-bottom-width': 0, 'border-left-width': 0, 'border-right-width': 0, width: 'auto', height: 'auto', 'min-width': 0, 'min-height': 0, 'max-width': 'none', 'max-height': 'none', position: 'static', 'flex-grow': 0, 'flex-shrink': 1, 'flex-basis': 'auto', order: 0, 'align-self': 'auto' }); }
const isBlockLevel = (d) => d === 'block' || d === 'list-item' || d === 'flex' || d === 'table' || d === 'flow-root' || d === 'grid' || d === 'table-row' || d === 'table-row-group' || d === 'table-header-group' || d === 'table-cell';
const REPLACED = new Set(['img', 'canvas', 'video', 'svg', 'iframe', 'input', 'select', 'textarea', 'button']);

export class Layout {
	constructor(doc, env) { this.doc = doc; this.env = env; this.boxOf = new Map(); this.oofList = []; }
	run() {
		const ts = performance.now(); this.vw = this.env.vw; this.vh = this.env.vh; if (!this.skipStyle) { resolveStyles(this.doc, this.env, this.dirtyLog); } this.styleMs = this.skipStyle ? (this.preStyleMs || 0) : performance.now() - ts; this.styleInfo = this.doc.__styleInfo; const tl = performance.now();
		const root = this.doc.documentElement; this.rootBox = null; this.boxOf.clear(); this.fragsByText = new Map();
		if (!root) { return; }
		const rootBox = this.build(root, null); this.rootBox = rootBox; if (!rootBox) { return; }
		if (this.env.layoutEngine) { this.env.layoutEngine.run(this, rootBox, this.env.vw, this.env.vh); this.layoutMs = performance.now() - tl; return; }   // e.g. the native engine of spike 7
		const vw = this.env.vw, vh = this.env.vh;
		this.oofList = []; this.collectOof(rootBox);
		this.layoutBlock(rootBox, vw, vh, { forceW: vw, forceH: null });
		rootBox.ox = 0; rootBox.oy = 0;
		this.absolutize(rootBox, 0, 0);
		// body background propagates to the canvas; absolutely positioned boxes are laid out after the flow is known
		for (const b of this.oofList) { this.layoutOof(b); }
		this.computeScroll(rootBox); this.layoutMs = performance.now() - tl;
	}
	/**
	 * A pass that only changed attributes the style system reads (no inserted/removed nodes, no text, no layout attributes), at the same viewport size, and whose restyled elements differ from before
	 * only in paint-only properties, keeps the previous layout: the boxes of the restyled elements get their new style and nothing is laid out. Returns false when a real layout is needed
	 * (the styles are resolved by then only if `false` came after the style step: run() resolves them again, which is cheap because nothing is left dirty).
	 */
	static styleOnly(doc, env, prev, log) {
		const W = (doc.__styleOnlyWhy ??= {}); const why = (k) => { W[k] = (W[k] || 0) + 1; };
		if (!prev.rootBox || prev.vw !== env.vw || prev.vh !== env.vh || doc.__logOverflow || !log || !log.length) { why('setup'); return false; }
		for (const [kind, what, , arg] of log) { if ((kind !== 'style' && !(what === 'attr' && NO_LAYOUT_ATTR.has(arg))) || what === 'ins' || what === 'rem' || (what === 'attr' && arg === 'type')) { why(kind !== 'style' ? 'layout-attr/text:' + what + ':' + arg : what === 'ins' || what === 'rem' ? 'ins/rem' : 'type'); return false; } }
		resolveStyles(doc, env, log); const r = doc.__styleResult; prev.dirtyLog = log;
		if (r && r.layoutChanged) { why('style:layout-prop'); }
		if (!r || r.layoutChanged || doc.__styleInfo.mode === 'full' && doc.__styleInfo.reason === 'environment changed') { return null; }   // null: styles are resolved already, only the layout is missing
		for (const el of r.changed) {
			const box = prev.boxOf.get(el); if (!box) { continue; }
			box.cs = el.__cs; box.v = el.__cs.values;
			for (const c of box.children) {
				if (c.kind === 'text') { if (c.pseudo === undefined) { prev.patchText(c, box); } }
				else if (c.anon) { c.v = anonStyle(box.v); for (const t of c.children) { if (t.kind === 'text') { prev.patchText(t, c); } } }
			}
		}
		return true;
	}
	patchText(t, owner) {
		t.v = owner.v; t.cs = owner.cs;
		if (t.el) { const fr = this.fragsByText.get(t.el); if (fr) { for (const f of fr) { f.v = owner.v; } } }
	}
	// ---- tree building
	build(el, parent) {
		const cs = el.__cs; if (!cs) { return null; } const v = cs.values; let d = v.display; if (d === 'none') { return null; }
		if (d === 'contents') { for (const c of el.__children) { this.buildChild(c, parent); } return null; }
		if (parent && (parent.display === 'flex' || parent.display === 'inline-flex') && !(box_oof(v))) { d = ({ inline: 'block', 'inline-block': 'block', 'inline-flex': 'flex', 'inline-table': 'table' })[d] ?? d; }
		let kind = isBlockLevel(d) ? (d === 'flex' ? 'flex' : 'block') : d === 'inline-block' || d === 'inline-flex' || d === 'inline-table' || d === 'inline-grid' ? 'inline-block' : 'inline';
		if (d === 'inline-flex') { kind = 'inline-block'; }
		if (d === 'grid' || d === 'inline-grid') { unsup('display:grid'); } if (d === 'table' || d.startsWith('table-')) { unsup('display:table'); }
		if (REPLACED.has(el.localName) && kind === 'inline') { kind = 'inline-block'; }
		const box = new Box(el, cs, kind); box.display = d; box.parent = parent; this.boxOf.set(el, box);
		if (v.float !== 'none') { unsup('float'); }
		box.oof = box.pos === 'absolute' || box.pos === 'fixed';
		if (el.localName === 'br') { box.kind = 'br'; return box; }
		if (REPLACED.has(el.localName) && el.localName !== 'button') { box.replaced = true; return box; }
		if (el.__before) { this.pseudoBox(box, el.__before, 'before'); }
		for (const c of el.__children) { this.buildChild(c, box); }
		if (el.__after) { this.pseudoBox(box, el.__after, 'after'); }
		return box;
	}
	buildChild(c, parent) {
		if (c.nodeType === 3) { if (c.__data !== '') { const t = new Box(c, null, 'text'); t.text = c.__data; t.parent = parent; t.v = parent.v; t.cs = parent.cs; parent.children.push(t); } }
		else if (c.nodeType === 1) { const b = this.build(c, parent); if (b) { parent.children.push(b); } }
	}
	pseudoBox(parent, pcs, which) {
		const v = pcs.values; if (v.display === 'none') { return; } const content = parseContent(v.content); const inFlex = parent.display === 'flex' || parent.display === 'inline-flex'; const isOof = v.position === 'absolute' || v.position === 'fixed'; const isBlock = isBlockLevel(v.display) || isOof || inFlex;
		const pb = new Box(null, pcs, isBlock ? 'block' : (v.display === 'inline-block' ? 'inline-block' : 'inline')); pb.display = (inFlex && !isOof && v.display !== 'flex') ? 'block' : v.display; pb.parent = parent; pb.pseudo = which; pb.oof = pb.pos === 'absolute' || pb.pos === 'fixed';
		if (content) { const t = new Box(null, null, 'text'); t.text = content; t.parent = pb; t.v = v; t.cs = pcs; pb.children.push(t); }
		parent.children.push(pb);
	}
	collectOof(box) { for (const c of box.children) { if (c.oof) { this.oofList.push(c); } this.collectOof(c); } }

	// ---- box metrics
	metrics(box, cbw) {
		const v = box.v, r = (x) => { const l = resolveLen(x, cbw); return l === null ? 0 : l; };
		box.mt = r(v['margin-top']); box.mr = r(v['margin-right']); box.mb = r(v['margin-bottom']); box.ml = r(v['margin-left']);
		box.autoML = v['margin-left'] === 'auto'; box.autoMR = v['margin-right'] === 'auto'; box.autoMT = v['margin-top'] === 'auto'; box.autoMB = v['margin-bottom'] === 'auto';
		box.pt = Math.max(0, r(v['padding-top'])); box.pr = Math.max(0, r(v['padding-right'])); box.pb = Math.max(0, r(v['padding-bottom'])); box.pl = Math.max(0, r(v['padding-left']));
		box.bt = v['border-top-width']; box.br = v['border-right-width']; box.bb = v['border-bottom-width']; box.bl = v['border-left-width']; for (const k of ['bt', 'br', 'bb', 'bl']) { if (typeof box[k] !== 'number') { box[k] = 0; } }
		box.hx = box.pl + box.pr + box.bl + box.br; box.vy = box.pt + box.pb + box.bt + box.bb;
	}
	specSize(box, prop, cbSize) {   // content-box size from width/height/min/max (null = auto/none)
		const v = box.v, bb = v['box-sizing'] === 'border-box', extra = prop === 'width' ? box.hx : box.vy; const conv = (x) => { if (x === 'auto' || x === 'none' || x === undefined || x === 'min-content' || x === 'max-content' || x === 'fit-content') { return null; } if (cbSize === null && x && (x.pct !== undefined || (x.calc && JSON.stringify(x.calc).includes('"pct"')))) { return null; } const l = resolveLen(x, cbSize ?? 0); return l === null ? null : Math.max(0, bb ? l - extra : l); };
		let max = conv(v['max-' + prop]); const mk = v['max-' + prop]; if (prop === 'width' && typeof mk === 'string' && (mk === 'fit-content' || mk === 'max-content' || mk === 'min-content') && box.kind !== 'text') { max = mk === 'min-content' ? this.minContent(box) : this.maxContent(box); }
		return { size: conv(v[prop]), min: conv(v['min-' + prop]) ?? 0, max, kw: typeof v[prop] === 'string' ? v[prop] : null };
	}
	clampSize(s, x) { let r = x; if (s.max !== null) { r = Math.min(r, s.max); } return Math.max(r, s.min); }

	// ---- intrinsic widths (content box)
	fontOf(box) { const v = box.v; return resolveFont(v['font-family'], v['font-weight'], v['font-style']); }
	textSegments(text, v) { return text; }
	maxContent(box) {
		if (box.__max !== undefined) { return box.__max; }
		let w = 0;
		if (box.replaced) { w = this.replacedSize(box).w; }
		else if (this.isInlineContainer(box)) { w = this.inlineIntrinsic(box, false); }
		else if (box.kind === 'flex') { const col = (box.v['flex-direction'] || '').startsWith('column'); let s = 0, mx = 0; const gap = this.gapOf(box, 'column-gap', 0); let n = 0; for (const c of box.children) { if (c.oof || c.kind === 'text' && !c.text.trim()) { continue; } const ow = this.outerIntrinsic(c, false); s += ow; mx = Math.max(mx, ow); n++; } w = col ? mx : s + gap * Math.max(0, n - 1); }
		else { for (const c of box.children) { if (c.oof) { continue; } w = Math.max(w, this.outerIntrinsic(c, false)); } }
		box.__max = w; return w;
	}
	minContent(box) {
		if (box.__min !== undefined) { return box.__min; }
		let w = 0;
		if (box.replaced) { w = this.replacedSize(box).w; }
		else if (this.isInlineContainer(box)) { w = this.inlineIntrinsic(box, true); }
		else if (box.kind === 'flex') { const col = (box.v['flex-direction'] || '').startsWith('column'); const wrap = box.v['flex-wrap'] !== 'nowrap'; let s = 0, mx = 0; for (const c of box.children) { if (c.oof) { continue; } const ow = this.outerIntrinsic(c, true); s += ow; mx = Math.max(mx, ow); } w = col || wrap ? mx : s; }
		else { for (const c of box.children) { if (c.oof) { continue; } w = Math.max(w, this.outerIntrinsic(c, true)); } }
		box.__min = w; return w;
	}
	outerIntrinsic(c, min) {   // margin-box width of a child for intrinsic sizing
		if (c.kind === 'text') { return min ? this.inlineIntrinsic({ children: [c], v: c.parent.v }, true) : this.inlineIntrinsic({ children: [c], v: c.parent.v }, false); }
		this.metrics(c, 0); const spec = this.specSize(c, 'width', null); let w;
		if (spec.size !== null) { w = spec.size; } else { w = min ? this.minContent(c) : this.maxContent(c); } w = this.clampSize(spec, w);
		return w + c.hx + c.ml + c.mr;
	}
	isInlineContainer(box) { if (box.kind === 'flex' || box.replaced) { return false; } return box.children.length > 0 && box.children.every(c => c.oof || c.kind === 'text' || c.kind === 'inline' || c.kind === 'inline-block' || c.kind === 'br') && box.children.some(c => !c.oof); }
	// ---- the generic inline walk: flatten inline-level descendants of a block container into an item list
	inlineItems(container, out) {
		for (const c of container.children) {
			if (c.oof) { out.push({ t: 'oof', box: c }); continue; }
			if (c.kind === 'text') { out.push({ t: 'text', box: c, text: c.text, v: c.parent.v }); }
			else if (c.kind === 'br') { out.push({ t: 'br', box: c }); }
			else if (c.kind === 'inline') { this.metrics(c, this.curCbw ?? 0); out.push({ t: 'open', box: c }); this.inlineItems(c, out); out.push({ t: 'close', box: c }); }
			else { out.push({ t: 'atomic', box: c }); }
		}
		return out;
	}
	ws(v) { const w = v['white-space']; return { collapse: w === 'normal' || w === 'nowrap' || w === 'pre-line', wrap: w === 'normal' || w === 'pre-wrap' || w === 'pre-line' || w === 'break-spaces', newlines: w === 'pre' || w === 'pre-wrap' || w === 'pre-line' || w === 'break-spaces' }; }
	inlineIntrinsic(container, min) {
		const items = this.inlineItems(container, []); let best = 0, cur = 0;
		for (const it of items) {
			if (it.t === 'text') {
				const v = it.v, w = this.ws(v), font = this.fontOf({ v }), size = v['font-size'], ls = typeof v['letter-spacing'] === 'number' ? v['letter-spacing'] : 0; let t = it.text; if (w.collapse) { t = t.replace(/[ \t\n\r\f]+/g, ' '); }
				const words = w.wrap ? t.split(/(?<=[ \n-])/) : [t];
				for (const word of words) { const ww = this.measure(font, word.replace(/\n$/, ''), size, ls, v); if (word.endsWith('\n') && w.newlines) { cur += ww; best = Math.max(best, cur); cur = 0; continue; } if (min) { best = Math.max(best, w.wrap ? ww - (word.endsWith(' ') ? this.measure(font, ' ', size, ls, v) : 0) : ww); } else { cur += ww; } }
			} else if (it.t === 'atomic') { const ow = this.outerIntrinsic(it.box, min); if (min) { best = Math.max(best, ow); } else { cur += ow; } }
			else if (it.t === 'open') { const b = it.box; const e = b.ml + b.pl + b.bl; if (!min) { cur += e; } }
			else if (it.t === 'close') { const b = it.box; const e = b.mr + b.pr + b.br; if (!min) { cur += e; } }
			else if (it.t === 'br') { best = Math.max(best, cur); cur = 0; }
		}
		return Math.max(best, cur);
	}
	measure(font, text, size, ls, v) { let w = 0, prev = 0; const ws = v ? v['word-spacing'] : 0; for (const ch of text) { const cp = ch.codePointAt(0); w += advance(font, cp, size) + ls + (cp === 32 && typeof ws === 'number' ? ws : 0); if (ls === 0 && prev) { w += kern(font, prev, cp, size); } prev = cp; } return w; }
	replacedSize(box) {
		const el = box.el, n = el.localName, v = box.v; if (box.__rs) { return box.__rs; } let w = 0, h = 0; const attr = (a) => { const x = el.getAttribute(a); return x === null ? null : parseFloat(x); };
		if (n === 'canvas') { w = attr('width') ?? 300; h = attr('height') ?? 150; } else if (n === 'img' || n === 'video' || n === 'svg' || n === 'iframe') { w = attr('width') ?? (n === 'iframe' ? 300 : 0); h = attr('height') ?? (n === 'iframe' ? 150 : 0); if (n === 'img') { const im = el.ownerDocument.__imageFor && el.ownerDocument.__imageFor(el); if (im) { const aw = attr('width'), ah = attr('height'); const nw = im.iw || im.w, nh = im.ih || im.h; w = aw ?? (ah !== null ? ah * nw / nh : nw); h = ah ?? (aw !== null ? aw * nh / nw : nh); box.__ratio = nh / nw; } } }
		else if (n === 'input') { const t = (el.getAttribute('type') || 'text').toLowerCase(); if (t === 'checkbox' || t === 'radio') { w = h = 13; } else { w = 153; h = Math.round(fontMetrics(this.fontOf(box), v['font-size']).lineHeightNormal) + 6; } }
		else if (n === 'textarea') { const cols = attr('cols') ?? 20, rows = attr('rows') ?? 2; const font = this.fontOf(box); w = cols * advance(font, 48, v['font-size']) + 8; h = rows * fontMetrics(font, v['font-size']).lineHeightNormal + 6; }
		else if (n === 'select') { const font = this.fontOf(box), fs = v['font-size']; const opts = optionList(el); let mw = 0; for (const o of opts) { mw = Math.max(mw, this.measure(font, o.text, fs, 0, v)); } const lh = Math.round(fontMetrics(font, fs).lineHeightNormal); const rows = el.hasAttribute('multiple') ? Math.max(1, parseInt(el.getAttribute('size') ?? '4', 10) || 4) : parseInt(el.getAttribute('size') ?? '1', 10) || 1; w = Math.round(mw) + 28; h = rows > 1 ? rows * lh + 4 : lh + 6; }
		box.__rs = { w, h }; return box.__rs;
	}
	gapOf(box, prop, base) { const g = box.v[prop]; const l = resolveLen(g, base); return l === null ? 0 : l; }

	// ---- block layout
	layoutBlock(box, cbw, cbh, opts = {}) {
		box.frags = null; box.inlineRects = null;      // a box can be laid out more than once (flex re-layout, shrink-to-fit): start from a clean fragment list
		this.metrics(box, cbw);
		const wSpec = this.specSize(box, 'width', cbw), hSpec = this.specSize(box, 'height', cbh);
		let cw;
		if (opts.forceW !== undefined) { cw = opts.forceW - box.hx; }
		else if (wSpec.size !== null) { cw = this.clampSize(wSpec, wSpec.size); const rem = cbw - cw - box.hx - box.ml - box.mr; if (box.kind === 'block' || box.kind === 'flex') { if (box.autoML && box.autoMR) { box.ml = box.mr = Math.max(0, rem / 2); } else if (box.autoML) { box.ml = Math.max(0, rem); } else if (box.autoMR) { box.mr = Math.max(0, rem); } } }
		else if (box.kind === 'inline-block' || box.kind === 'abs-shrink' || wSpec.kw === 'fit-content' || wSpec.kw === 'max-content' || wSpec.kw === 'min-content' || opts.shrink) {
			const avail = cbw - box.hx - box.ml - box.mr; const mx = this.maxContent(box), mn = this.minContent(box);
			cw = wSpec.kw === 'max-content' ? mx : wSpec.kw === 'min-content' ? mn : Math.min(Math.max(mn, avail), mx); cw = this.clampSize(wSpec, cw);
		} else { cw = this.clampSize(wSpec, cbw - box.hx - box.ml - box.mr); }
		cw = Math.max(0, cw);
		if (opts.forceW === undefined && (box.kind === 'block' || box.kind === 'flex') && (box.autoML || box.autoMR)) { const rem = cbw - cw - box.hx - (box.autoML ? 0 : box.ml) - (box.autoMR ? 0 : box.mr); if (box.autoML && box.autoMR) { box.ml = Math.max(0, rem / 2); box.mr = rem < 0 ? rem : box.ml; } else if (box.autoML) { box.ml = Math.max(0, rem); } else { box.mr = Math.max(0, rem); } }
		let ch = null; if (opts.forceH !== undefined && opts.forceH !== null) { ch = Math.max(0, opts.forceH - box.vy); } else if (hSpec.size !== null) { ch = this.clampSize(hSpec, hSpec.size); }
		const res = { mtOut: box.mt, mbOut: box.mb };
		let contentH;
		const savedCbw = this.curCbw; this.curCbw = cw;
		if (box.replaced) { const rs = this.replacedSize(box); if (wSpec.size === null && opts.forceW === undefined) { cw = this.clampSize(wSpec, rs.w); } contentH = ch ?? this.clampSize(hSpec, box.__ratio && cw > 0 ? cw * box.__ratio : rs.h); }
		else if (box.kind === 'flex' || (box.display === 'inline-flex')) { contentH = this.layoutFlex(box, cw, ch); }
		else { contentH = this.layoutFlow(box, cw, ch, res); }
		this.curCbw = savedCbw;
		if (ch !== null) { contentH = ch; } else { contentH = this.clampSize(hSpec, contentH); }
		box.cw = cw; box.chh = contentH; box.w = cw + box.hx; box.h = contentH + box.vy; res.mtOut = res.mtOut ?? box.mt; return res;
	}
	isBfcRoot(box) { const v = box.v; return !box.parent || box.oof || box.kind === 'inline-block' || v['overflow-x'] !== 'visible' || v['overflow-y'] !== 'visible' || box.kind === 'flex' || (box.parent && box.parent.kind === 'flex') || box.display === 'flow-root' || box.pos === 'fixed'; }
	layoutFlow(box, cw, ch, res) {
		const collapsible = !this.isBfcRoot(box); const topAdj = collapsible && box.pt === 0 && box.bt === 0, botAdj = collapsible && box.pb === 0 && box.bb === 0 && ch === null;
		let y = 0, pending = null, first = true; res.mtOut = box.mt; let lastBaseline = null;
		const kids = box.children; let i = 0;
		while (i < kids.length) {
			const c = kids[i];
			if (c.oof) { c.static = { x: 0, y: y + (pending ?? 0), parentBox: box }; c.ox = box.bl + box.pl; c.oy = box.bt + box.pt + y + (pending ?? 0); i++; continue; }
			if (c.kind === 'text' || c.kind === 'inline' || c.kind === 'inline-block' || c.kind === 'br') {
				let j = i; const run = []; while (j < kids.length && (kids[j].oof || kids[j].kind === 'text' || kids[j].kind === 'inline' || kids[j].kind === 'inline-block' || kids[j].kind === 'br')) { run.push(kids[j]); j++; }
				const out = this.layoutInline(box, run, cw, y + (pending ?? 0), ch);
				if (out.height > 0 || out.hasContent) { const adj = pending ?? 0; if (first && topAdj) { /* line boxes never collapse with the parent: parent's margin stays */ } y += adj; pending = null; for (const ln of out.lines) { ln.y += y; } this.shiftFrags(out, y); y += out.height; first = false; if (out.lastBaseline !== null) { lastBaseline = y - out.height + out.lastBaseline; } }
				else { this.shiftFrags(out, y + (pending ?? 0)); }
				i = j; continue;
			}
			// block-level child
			const r = this.layoutBlock(c, cw, ch); c.res = r;
			const mt = r.mtOut ?? c.mt; let gap;
			if (first && topAdj) { res.mtOut = this.collapse(box.mt, mt); gap = 0; } else if (pending === null) { gap = mt; } else { gap = this.collapse(pending, mt); }
			if (!(first && topAdj)) { y += gap; } else { y += 0; }
			c.ox = box.bl + box.pl + c.ml; c.oy = box.bt + box.pt + y; y += c.h; pending = r.mbOut ?? c.mb; first = false; if (c.lastBaseline !== undefined && c.lastBaseline !== null) { lastBaseline = c.oy - box.bt - box.pt + c.lastBaseline; }
			i++;
		}
		if (botAdj) { res.mbOut = this.collapse(box.mb, pending ?? 0); if (pending === null) { res.mbOut = box.mb; } }
		else { if (pending !== null) { y += pending; } res.mbOut = box.mb; }
		box.lastBaseline = lastBaseline !== null ? lastBaseline + box.bt + box.pt : null;
		box.contentExtentH = y; return y;
	}
	collapse(a, b) { if (a >= 0 && b >= 0) { return Math.max(a, b); } if (a < 0 && b < 0) { return Math.min(a, b); } return a + b; }
	shiftFrags(out, dy) { for (const f of out.frags) { f.y += dy; if (f.baseline !== undefined) { f.baseline += dy; } } for (const a of out.atomics) { a.box.oy += dy; } for (const o of out.oofs) { o.box.oy += dy; if (o.box.static) { o.box.static.y += dy; } } for (const r of out.inlineRects) { for (const q of r.rects) { q.y += dy; } } }

	// ---- inline layout --------------------------------------------------------------------------------------------------------------------
	layoutInline(container, run, cw, y0, chDefinite = null) {
		const items = []; const tmp = { children: run, v: container.v }; this.inlineItems(tmp, items);
		const v = container.v; const align = v['text-align']; const cvFont = this.fontOf(container); const cvSize = v['font-size']; const cvMet = fontMetrics(cvFont, cvSize);
		const lhOf = (vv, met) => { const l = vv['line-height']; if (l === 'normal' || l === undefined) { return met.lineHeightNormal; } if (l && l.num !== undefined) { return l.num * vv['font-size']; } const r = resolveLen(l, vv['font-size']); return r === null ? met.lineHeightNormal : r; };
		const frags = [], atomics = [], oofs = [], lines = [], inlineRects = [], stack = [];
		let line = null; const lines_ = lines; let x = 0; let hasContent = false; let prevSpace = true;
		const newLine = () => { line = { y: 0, h: 0, items: [], baseline: 0, strutAsc: 0, strutDesc: 0, x0: 0, width: 0 }; lines_.push(line); x = 0; prevSpace = true; const strutLh = lhOf(v, cvMet); const hl = strutLh - (cvMet.ascent + cvMet.descent), half = Math.floor(hl / 2); line.maxAsc = cvMet.ascent + half; line.maxDesc = cvMet.descent + (hl - half); line.hasStrutContent = false; };
		const startInlineBoxes = () => { for (const b of stack) { if (!b.__lineRect || b.__lineRect.line !== line) { const rect = { line, x: x, y: 0, w: 0, h: 0 }; b.__lineRect = rect; b.__rects.rects.push(rect); } } };
		const contribute = (asc, desc) => { line.maxAsc = Math.max(line.maxAsc, asc); line.maxDesc = Math.max(line.maxDesc, desc); };
		const placeFrag = (f) => { line.items.push(f); frags.push(f); };
		newLine();
		const finishLine = (forced) => {
			const L = line; L.h = L.maxAsc + L.maxDesc; L.baseline = L.maxAsc;
			// trailing collapsible space is dropped from the line width
			let end = 0; for (const it of L.items) { end = Math.max(end, it.x + it.w - (it.trailingSpaceW || 0)); } L.width = end;
			const free = cw - end; let shift = 0; if (align === 'center') { shift = Math.max(0, free / 2); } else if (align === 'right' || align === 'end') { shift = Math.max(0, free); }
			L.shift = shift; for (const it of L.items) { it.x += shift; if (it.box && it.t === 'atomic') { it.box.ox = it.x + container.bl + container.pl + (it.box.ml); } }
			const top = L.y; for (const it of L.items) { if (it.t === 'text') { it.y = top + L.baseline - it.asc; it.baseline = top + L.baseline; } else if (it.t === 'atomic') { it.box.oy = top + L.baseline - it.boxBaseline + it.box.mt + container.bt + container.pt; } }
			for (const r of inlineRects) { for (const q of r.rects) { if (q.line === L && !q.fin) { q.fin = true; q.x += shift; const m = r.m; q.y = top + L.baseline - m.asc - r.box.pt - r.box.bt; q.h = m.asc + m.desc + r.box.pt + r.box.pb + r.box.bt + r.box.bb; } } }
		};
		const nextLine = () => { finishLine(false); const prev = line; newLine(); line.y = prev.y + prev.h; };
		const spaceCache = new Map();
		for (let idx = 0; idx < items.length; idx++) {
			const it = items[idx];
			if (it.t === 'open') { const b = it.box; const font = this.fontOf(b), size = b.v['font-size']; const m = fontMetrics(font, size); b.__rects = { box: b, rects: [], m: { asc: m.ascent, desc: m.descent } }; inlineRects.push(b.__rects); b.__lineRect = null; stack.push(b); startInlineBoxes(); const e = b.ml + b.bl + b.pl; const q = b.__lineRect; x += e; hasContent = hasContent || e > 0; const lh = lhOf(b.v, m); const hl = lh - (m.ascent + m.descent), half = Math.floor(hl / 2); contribute(m.ascent + half, m.descent + (hl - half)); }
			else if (it.t === 'close') { const b = it.box; const e = b.mr + b.br + b.pr; x += e; stack.pop(); if (b.__lineRect) { b.__lineRect.endX = x; b.__lineRect.w = x - b.__lineRect.x; b.__lineRect.sx = b.__lineRect.x; } }
			else if (it.t === 'oof') { it.box.static = { x, y: 0, parentBox: container, line }; oofs.push(it); it.box.ox = container.bl + container.pl + x; it.box.oy = container.bt + container.pt + line.y; }
			else if (it.t === 'br') { hasContent = true; line.hasStrutContent = true; nextLine(); }
			else if (it.t === 'atomic') {
				const b = it.box; startInlineBoxes(); this.metrics(b, cw); this.layoutBlock(b, cw, chDefinite, {}); const ow = b.w + b.ml + b.mr;
				if (x + ow > cw + 1e-6 && line.items.length > 0 && this.ws(v).wrap) { nextLine(); startInlineBoxes(); }
				const vv = b.v; let baseline = b.h + b.mb; if (b.lastBaseline !== null && b.lastBaseline !== undefined && vv['overflow-x'] === 'visible' && vv['overflow-y'] === 'visible') { baseline = b.lastBaseline + b.mt; } else { baseline = b.h + b.mt; }
				const asc = baseline, desc = b.h + b.mt + b.mb - baseline; contribute(asc, desc);
				const f = { t: 'atomic', box: b, x, w: ow, boxBaseline: baseline }; b.ox = 0; placeFrag(f); atomics.push(f); x += ow; hasContent = true; prevSpace = false; line.hasStrutContent = true;
			}
			else if (it.t === 'text') {
				const v2 = it.v, wsm = this.ws(v2), font = this.fontOf({ v: v2 }), size = v2['font-size'], met = fontMetrics(font, size); const ls = typeof v2['letter-spacing'] === 'number' ? v2['letter-spacing'] : 0; const lh = lhOf(v2, met); const hl = lh - (met.ascent + met.descent), half = Math.floor(hl / 2), halfB = hl - half;
				const wsp = typeof v2['word-spacing'] === 'number' ? v2['word-spacing'] : 0; const tabSize = parseFloat(v2['tab-size']) || 8; const tr = v2['text-transform'];
				let text = it.text; if (tr === 'uppercase') { text = text.toUpperCase(); } else if (tr === 'lowercase') { text = text.toLowerCase(); } else if (tr === 'capitalize') { text = text.replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase()); }
				const breakAll = v2['word-break'] === 'break-all' || v2['word-break'] === 'break-word'; const overflowWrap = v2['overflow-wrap'] === 'break-word' || v2['overflow-wrap'] === 'anywhere' || v2['word-wrap'] === 'break-word';
				// tokenise into words / spaces / newlines
				const toks = []; { let i = 0; const n = text.length; while (i < n) { const c = text[i]; if (c === '\n' && wsm.newlines) { toks.push({ k: 'nl' }); i++; } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { let j = i; while (j < n && (text[j] === ' ' || text[j] === '\t' || ((text[j] === '\n' || text[j] === '\r' || text[j] === '\f') && !(text[j] === '\n' && wsm.newlines)))) { j++; } if (wsm.collapse) { toks.push({ k: 'sp', s: ' ', src: i, srcEnd: j }); } else { toks.push({ k: 'sp', s: text.slice(i, j), src: i, srcEnd: j }); } i = j === i ? i + 1 : j; } else { let j = i; while (j < n && !' \t\n\r\f'.includes(text[j])) { j++; } toks.push({ k: 'w', s: text.slice(i, j), src: i, srcEnd: j }); i = j; } } }
				let cur = null;   // fragment being extended on the current line
				const startFrag = (srcPos) => { startInlineBoxes(); cur = { t: 'text', box: it.box, node: it.box.el, v: v2, text: '', x, w: 0, y: 0, asc: met.ascent, desc: met.descent, src: srcPos, srcEnd: srcPos, font, size, ls, trailingSpaceW: 0, line }; placeFrag(cur); contribute(met.ascent + half, met.descent + halfB); };
				const addText = (s, srcStart, srcEnd, isSpace) => { if (!cur || cur.line !== line) { startFrag(srcStart); } const wdt = this.measure(font, s, size, ls, v2) + (isSpace ? wsp * (s.split(' ').length - 1) : 0); cur.text += s; cur.w += wdt; cur.srcEnd = srcEnd; x += wdt; hasContent = true; line.hasStrutContent = true; return wdt; };
				for (let ti = 0; ti < toks.length; ti++) {
					const tk = toks[ti];
					if (tk.k === 'nl') { hasContent = true; line.hasStrutContent = true; if (!cur || cur.line !== line) { startFrag(tk.src ?? 0); } nextLine(); cur = null; prevSpace = true; continue; }
					if (tk.k === 'sp') {
						if (wsm.collapse) { if (prevSpace) { continue; } }
						let s = tk.s; if (s.includes('\t') && !wsm.collapse) { /* tabs: advance to the next tab stop */ const spw = advance(font, 32, size) + ls; let out = ''; let xx = x; for (const ch of s) { if (ch === '\t') { const stop = tabSize * spw; const nx = Math.floor((xx - 0) / stop + 1e-9) * stop + stop; const n = Math.max(1, Math.round((nx - xx) / spw)); out += ' '.repeat(n); xx += n * spw; } else { out += ch; xx += spw; } } s = out; }
						const swd = this.measure(font, s, size, ls, v2) + wsp;
						if (wsm.wrap && !wsm.collapse && x + swd > cw + 1e-6 && line.items.length > 0 && v2['white-space'] !== 'pre-wrap') { nextLine(); cur = null; }
						addText(s, tk.src, tk.srcEnd, true); prevSpace = wsm.collapse; if (wsm.collapse && cur) { cur.trailingSpaceW = swd; }
						continue;
					}
					// word
					let word = tk.s; let ww = this.measure(font, word, size, ls, v2);
					if (cur && cur.trailingSpaceW) { cur.trailingSpaceW = 0; }
					if (wsm.wrap && x + ww > cw + 1e-6 && line.items.length > 0) {
						// drop the pending trailing space, break the line
						if (cur && cur.line === line && cur.text.endsWith(' ') && wsm.collapse) { const sw = this.measure(font, ' ', size, ls, v2) + wsp; cur.text = cur.text.slice(0, -1); cur.w -= sw; x -= sw; }
						nextLine(); cur = null; prevSpace = true;
					}
					if (wsm.wrap && ww > cw - x + 1e-6 && (breakAll || overflowWrap)) {
						// split the word at character boundaries
						let start = tk.src; let rest = word; while (rest.length) { let k = 0, acc = 0; const arr = [...rest]; while (k < arr.length) { const cw1 = this.measure(font, arr[k], size, ls, v2); if (x + acc + cw1 > cw + 1e-6 && (k > 0 || line.items.length > 0)) { break; } acc += cw1; k++; } if (k === 0) { nextLine(); cur = null; continue; } const part = arr.slice(0, k).join(''); addText(part, start, start + part.length, false); start += part.length; rest = arr.slice(k).join(''); if (rest.length) { nextLine(); cur = null; } }
						prevSpace = false; continue;
					}
					addText(word, tk.src, tk.srcEnd, false); prevSpace = false;
				}
			}
		}
		// drop a trailing empty line; finish
		const last = lines[lines.length - 1]; if (last.items.length === 0 && !last.hasStrutContent && lines.length > 1) { lines.pop(); line = lines[lines.length - 1]; }
		const emptyOnly = lines.length === 1 && lines[0].items.length === 0 && !lines[0].hasStrutContent && !hasContent;
		if (emptyOnly) { for (const o of oofs) { o.box.static.y = y0; } return { height: 0, lines: [], frags, atomics, oofs, inlineRects, hasContent: false, lastBaseline: null }; }
		finishLine(true);
		let h = 0; for (const L of lines) { h = Math.max(h, L.y + L.h); }
		// store fragments with positions relative to the container's border box origin
		const ox = container.bl + container.pl, oy = container.bt + container.pt;
		for (const f of frags) { if (f.t === 'text') { f.x += ox; f.y += oy; f.baseline += oy; } }
		for (const r of inlineRects) { for (const q of r.rects) { q.x += ox; q.y += oy; } }
		for (const o of oofs) { o.box.static.x = o.box.static.x + (lines[0] ? lines[0].shift : 0); o.box.static.y = (o.box.static.line ? o.box.static.line.y : 0); }
		container.frags = (container.frags || []).concat(frags); container.inlineRects = (container.inlineRects || []).concat(inlineRects);
		for (const f of frags) { if (f.t === 'text' && f.node) { let l = this.fragsByText.get(f.node); if (!l) { l = []; this.fragsByText.set(f.node, l); } l.push(f); } }
		const lastLine = lines[lines.length - 1];
		return { height: h, lines, frags, atomics, oofs, inlineRects, hasContent: true, lastBaseline: lastLine.y + lastLine.baseline, oy };
	}

	// ---- flex (single and multi line) -------------------------------------------------------------------------------------------------------
	layoutFlex(box, cw, ch) {
		const v = box.v; const dir = v['flex-direction']; const row = dir === 'row' || dir === 'row-reverse'; const rev = dir.endsWith('reverse'); const wrap = v['flex-wrap'] !== 'nowrap';
		const colGap = this.gapOf(box, 'column-gap', cw), rowGap = this.gapOf(box, 'row-gap', ch ?? 0); const mainGap = row ? colGap : rowGap, crossGap = row ? rowGap : colGap;
		const items = []; for (const c of box.children) { if (c.oof) { c.static = { x: 0, y: 0, parentBox: box }; c.ox = box.bl + box.pl; c.oy = box.bt + box.pt; continue; } if (c.kind === 'text') { if (!c.text.trim()) { continue; } const anon = new Box(null, box.cs, 'block'); anon.v = box.v; anon.display = 'block'; anon.anon = true; anon.children = [c]; c.parent = anon; anon.parent = box; anon.v = anonStyle(box.v); items.push(anon); continue; } items.push(c); }
		items.sort((a, b) => (a.v.order || 0) - (b.v.order || 0));
		const mainAvail = row ? cw : ch; const crossAvail = row ? ch : cw;
		for (const it of items) {
			this.metrics(it, cw); const iv = it.v;
			it.mMain = row ? [it.ml, it.mr] : [it.mt, it.mb]; it.mCross = row ? [it.mt, it.mb] : [it.ml, it.mr];
			const autoMain = row ? [it.autoML, it.autoMR] : [it.autoMT, it.autoMB]; it.autoMain = autoMain;
			const wSpec = this.specSize(it, 'width', cw), hSpec = this.specSize(it, 'height', ch);
			const mainSpec = row ? wSpec : hSpec, crossSpec = row ? hSpec : wSpec; it.mainSpec = mainSpec; it.crossSpec = crossSpec;
			const extraMain = row ? it.hx : it.vy; it.extraMain = extraMain; it.extraCross = row ? it.vy : it.hx;
			let basis = iv['flex-basis']; let bpx; if (basis === 'auto' || basis === 'content') { bpx = mainSpec.size; } else { const l = resolveLen(basis, mainAvail ?? 0); bpx = l === null ? null : (iv['box-sizing'] === 'border-box' ? Math.max(0, l - extraMain) : l); }
			if (bpx === null || bpx === undefined) {
				if (row) { bpx = this.maxContent(it); if (wSpec.kw === 'min-content') { bpx = this.minContent(it); } }
				else { this.layoutBlock(it, cw, null, { forceW: it.alignStretchW }); bpx = it.h - it.vy; }
			}
			it.basis = this.clampSize(mainSpec, bpx); it.grow = iv['flex-grow'] || 0; it.shrink = iv['flex-shrink'] ?? 1;
			it.minMain = mainSpec.min; it.maxMain = mainSpec.max;
			if (mainSpec.min === 0 && mainSpec.size === null && iv['overflow-x'] === 'visible') { it.minMain = Math.min(row ? this.minContent(it) : 0, it.basis); }   // automatic minimum size
		}
		// split into lines
		const lines = []; let cur = { items: [], main: 0 };
		for (const it of items) { const outer = it.basis + it.extraMain + it.mMain[0] + it.mMain[1]; if (wrap && cur.items.length && mainAvail !== null && cur.main + mainGap + outer > mainAvail + 1e-6) { lines.push(cur); cur = { items: [], main: 0 }; } cur.main += (cur.items.length ? mainGap : 0) + outer; cur.items.push(it); }
		if (cur.items.length || !lines.length) { lines.push(cur); }
		// resolve flexible lengths per line
		for (const ln of lines) {
			const avail = mainAvail === null ? ln.main : mainAvail; let free = avail - ln.main; const sumGrow = ln.items.reduce((s, i) => s + i.grow, 0), sumShrink = ln.items.reduce((s, i) => s + i.shrink * i.basis, 0);
			for (const it of ln.items) { it.main = it.basis; }
			if (free > 0 && sumGrow > 0) { const frozen = new Set(); let guard = 0; let remaining = free; while (guard++ < 10) { const grow = ln.items.filter(i => !frozen.has(i)).reduce((s, i) => s + i.grow, 0); if (grow <= 0) { break; } let violated = false; for (const it of ln.items) { if (frozen.has(it)) { continue; } const t = it.basis + remaining * (it.grow / (grow < 1 ? 1 : grow)) * (grow < 1 ? grow : 1); const c = Math.min(it.maxMain ?? Infinity, Math.max(it.minMain, t)); if (c !== t) { frozen.add(it); it.main = c; violated = true; remaining -= (c - it.basis); } else { it.target = t; } } if (!violated) { for (const it of ln.items) { if (!frozen.has(it)) { it.main = it.target; } } break; } } }
			else if (free < 0 && sumShrink > 0) { const frozen = new Set(); let guard = 0; let remaining = free; while (guard++ < 10) { const tot = ln.items.filter(i => !frozen.has(i)).reduce((s, i) => s + i.shrink * i.basis, 0); if (tot <= 0) { break; } let violated = false; for (const it of ln.items) { if (frozen.has(it)) { continue; } const t = it.basis + remaining * (it.shrink * it.basis / tot); const c = Math.min(it.maxMain ?? Infinity, Math.max(it.minMain, t)); if (c !== t) { frozen.add(it); it.main = c; violated = true; remaining -= (c - it.basis); } else { it.target = t; } } if (!violated) { for (const it of ln.items) { if (!frozen.has(it)) { it.main = it.target; } } break; } } }
			// auto margins on the main axis absorb free space
			const used = ln.items.reduce((s, i) => s + i.main + i.extraMain + i.mMain[0] + i.mMain[1], 0) + mainGap * Math.max(0, ln.items.length - 1); ln.free = avail - used; ln.avail = avail;
			const autos = ln.items.reduce((s, i) => s + (i.autoMain[0] ? 1 : 0) + (i.autoMain[1] ? 1 : 0), 0); if (autos && ln.free > 0) { const share = ln.free / autos; for (const it of ln.items) { if (it.autoMain[0]) { it.mMain[0] = share; } if (it.autoMain[1]) { it.mMain[1] = share; } } ln.free = 0; }
		}
		// lay out each item at its main size to find cross sizes
		for (const ln of lines) {
			let crossMax = 0;
			for (const it of ln.items) {
				const wMain = it.main + it.extraMain; const iv = it.v;
				if (row) { this.layoutBlock(it, cw, ch, { forceW: wMain, forceH: it.crossSpec.size !== null ? this.clampSize(it.crossSpec, it.crossSpec.size) + it.vy : null }); }
				else { this.layoutBlock(it, cw, ch, { forceW: it.crossSpec.size !== null ? this.clampSize(it.crossSpec, it.crossSpec.size) + it.hx : undefined, forceH: wMain }); if (it.crossSpec.size === null) { /* width stretch / shrink-to-fit decided in alignment below */ } }
				it.crossOuter = (row ? it.h : it.w) + it.mCross[0] + it.mCross[1]; crossMax = Math.max(crossMax, it.crossOuter);
			}
			ln.cross = crossMax;
		}
		const single = lines.length === 1; const containerCross = crossAvail;
		if (single && containerCross !== null) { lines[0].cross = containerCross; }
		const totalCross = lines.reduce((s, l) => s + l.cross, 0) + crossGap * (lines.length - 1);
		const alignContent = v['align-content']; let crossStart = 0, crossSpace = 0; if (!single && containerCross !== null) { const free = containerCross - totalCross; if (alignContent === 'center') { crossStart = free / 2; } else if (alignContent === 'flex-end' || alignContent === 'end') { crossStart = free; } else if (alignContent === 'space-between' && lines.length > 1) { crossSpace = free / (lines.length - 1); } else if (alignContent === 'stretch' || alignContent === 'normal') { const add = Math.max(0, free) / lines.length; for (const l of lines) { l.cross += add; } } }
		const jc = v['justify-content']; const ai = v['align-items'];
		let cursorCross = crossStart; const baseX = box.bl + box.pl, baseY = box.bt + box.pt;
		for (const ln of lines) {
			let startMain = 0, between = 0; if (ln.free > 0) { if (jc === 'center') { startMain = ln.free / 2; } else if (jc === 'flex-end' || jc === 'end' || jc === 'right') { startMain = ln.free; } else if (jc === 'space-between' && ln.items.length > 1) { between = ln.free / (ln.items.length - 1); } else if (jc === 'space-around') { between = ln.free / ln.items.length; startMain = between / 2; } else if (jc === 'space-evenly') { between = ln.free / (ln.items.length + 1); startMain = between; } }
			let pos = rev ? ln.avail - startMain : startMain; const list = rev ? [...ln.items].reverse() : ln.items;
			for (const it of ln.items) {
				const as = it.v['align-self'] === 'auto' ? ai : it.v['align-self']; const stretch = (as === 'normal' || as === 'stretch') && it.crossSpec.size === null && !(row ? it.autoMT || it.autoMB : it.autoML || it.autoMR);
				if (stretch) { const target = ln.cross - it.mCross[0] - it.mCross[1]; if (row) { this.layoutBlock(it, cw, ch, { forceW: it.main + it.extraMain, forceH: Math.max(this.clampSize(it.crossSpec, target - it.vy) + it.vy, 0) }); } else { this.layoutBlock(it, cw, ch, { forceW: this.clampSize(it.crossSpec, target - it.hx) + it.hx, forceH: it.main + it.extraMain }); } }
				else if (!row && it.crossSpec.size === null) { /* column item, cross = width: shrink-to-fit for non-stretch alignment */ const avail = ln.cross - it.mCross[0] - it.mCross[1]; const w = Math.min(Math.max(this.minContent(it), avail - it.hx), this.maxContent(it)) + it.hx; this.layoutBlock(it, cw, ch, { forceW: w, forceH: it.main + it.extraMain }); }
			}
			let p = startMain; const seq = ln.items; let pm = rev ? ln.avail - startMain : startMain;
			for (const it of seq) {
				const outerMain = it.main + it.extraMain + it.mMain[0] + it.mMain[1];
				let mainOff; if (rev) { pm -= outerMain; mainOff = pm + it.mMain[0]; pm -= between + mainGap; } else { mainOff = p + it.mMain[0]; p += outerMain + between + mainGap; }
				const as = it.v['align-self'] === 'auto' ? ai : it.v['align-self']; const crossOuterNow = (row ? it.h : it.w) + it.mCross[0] + it.mCross[1]; let crossOff = 0; const free = ln.cross - crossOuterNow;
				const autoCross = row ? [it.autoMT, it.autoMB] : [it.autoML, it.autoMR]; if (autoCross[0] && autoCross[1]) { crossOff = free / 2; } else if (autoCross[0]) { crossOff = free; } else if (as === 'center') { crossOff = free / 2; } else if (as === 'flex-end' || as === 'end' || as === 'self-end') { crossOff = free; } else if (as === 'baseline') { crossOff = 0; }
				const cx = cursorCross + crossOff + it.mCross[0];
				if (row) { it.ox = baseX + mainOff; it.oy = baseY + cx; } else { it.ox = baseX + cx; it.oy = baseY + mainOff; }
				if (it.anon) { it.parent = box; }
			}
			cursorCross += ln.cross + crossGap + crossSpace;
		}
		for (const it of items) { if (it.anon) { box.children = box.children.map(c => c === it.children[0] ? it : c); it.children[0].parent = it; it.v.display = 'block'; this.boxOf; } }
		const mainUsed = lines.reduce((m, l) => Math.max(m, l.avail - l.free), 0); const crossUsed = totalCross;
		const contentW = row ? (ch === null ? cw : cw) : cw; let contentH = row ? crossUsed : (ch ?? mainUsed);
		if (row && ch !== null) { contentH = ch; }
		return contentH;
	}

	// ---- positioning ------------------------------------------------------------------------------------------------------------------------
	absolutize(box, px, py) {
		// px,py = absolute border-box origin of the parent
		box.ax = px + box.ox; box.ay = py + box.oy;
		if (box.pos === 'relative') { const v = box.v, cb = box.parent; const l = resolveLen(v.left, cb ? cb.w : 0), r = resolveLen(v.right, cb ? cb.w : 0), t = resolveLen(v.top, cb ? cb.h : 0), b = resolveLen(v.bottom, cb ? cb.h : 0); box.relDx = l !== null ? l : (r !== null ? -r : 0); box.relDy = t !== null ? t : (b !== null ? -b : 0); box.ax += box.relDx; box.ay += box.relDy; }
		for (const f of box.frags || []) { f.ax = box.ax + f.x; f.ay = box.ay + f.y; f.abaseline = box.ay + f.baseline; }
		for (const r of box.inlineRects || []) { for (const q of r.rects) { q.ax = box.ax + q.x; q.ay = box.ay + q.y; } }
		for (const c of box.children) { if (c.oof) { continue; } if (c.kind === 'inline' || c.kind === 'text') { continue; } this.absolutize(c, box.ax, box.ay); }
	}
	containingBlockFor(b) {
		if (b.pos === 'fixed') { return { x: 0, y: 0, w: this.env.vw, h: this.env.vh, box: null }; }
		for (let p = b.parent; p; p = p.parent) { if (p.pos !== 'static' || (p.v.transform && p.v.transform !== 'none')) { if (p.kind === 'inline' && p.__rects && p.__rects.rects.length) { const r = p.__rects.rects[0]; return { x: r.ax, y: r.ay, w: r.w, h: r.h, box: p }; } return { x: p.ax + p.bl, y: p.ay + p.bt, w: p.w - p.bl - p.br, h: p.h - p.bt - p.bb, box: p }; } }
		return { x: 0, y: 0, w: this.env.vw, h: this.env.vh, box: null };
	}
	layoutOof(b) {
		const v = b.v; const cb = this.containingBlockFor(b); this.metrics(b, cb.w);
		const L = resolveLen(v.left, cb.w), R = resolveLen(v.right, cb.w), T = resolveLen(v.top, cb.h), B = resolveLen(v.bottom, cb.h);
		const wSpec = this.specSize(b, 'width', cb.w), hSpec = this.specSize(b, 'height', cb.h);
		let forceW, shrink = false;
		if (wSpec.size !== null) { forceW = this.clampSize(wSpec, wSpec.size) + b.hx; }
		else if (L !== null && R !== null) { forceW = this.clampSize(wSpec, cb.w - L - R - b.ml - b.mr - b.hx) + b.hx; }
		else { shrink = true; }
		let forceH; if (hSpec.size !== null) { forceH = this.clampSize(hSpec, hSpec.size) + b.vy; } else if (T !== null && B !== null) { forceH = this.clampSize(hSpec, cb.h - T - B - b.mt - b.mb - b.vy) + b.vy; }
		if (shrink) { const avail = Math.max(0, cb.w - (L ?? 0) - (R ?? 0) - b.ml - b.mr - b.hx); const mx = this.maxContent(b), mn = this.minContent(b); forceW = this.clampSize(wSpec, Math.min(Math.max(mn, avail), mx)) + b.hx; }
		b.__max = undefined; b.__min = undefined;
		this.layoutBlock(b, cb.w, cb.h, { forceW, forceH });
		let x, y;
		if (L !== null) { x = cb.x + L + b.ml; } else if (R !== null) { x = cb.x + cb.w - R - b.mr - b.w; } else { x = this.staticAbs(b).x + b.ml; }
		if (T !== null) { y = cb.y + T + b.mt; } else if (B !== null) { y = cb.y + cb.h - B - b.mb - b.h; } else { y = this.staticAbs(b).y + b.mt; }
		b.ax = x; b.ay = y; b.ox = 0; b.oy = 0;
		for (const f of b.frags || []) { f.ax = b.ax + f.x; f.ay = b.ay + f.y; f.abaseline = b.ay + f.baseline; } for (const r of b.inlineRects || []) { for (const q of r.rects) { q.ax = b.ax + q.x; q.ay = b.ay + q.y; } }
		for (const c of b.children) { if (c.oof || c.kind === 'inline' || c.kind === 'text') { continue; } this.absolutize(c, b.ax, b.ay); }
		b.oofPlaced = true;
	}
	staticAbs(b) { const s = b.static; if (!s || !s.parentBox) { return { x: 0, y: 0 }; } const p = s.parentBox; return { x: p.ax + p.bl + p.pl + (s.x || 0), y: p.ay + p.bt + p.pt + (s.y || 0) }; }
	computeScroll(root) {
		const visit = (b) => {
			let right = 0, bottom = 0;
			const add = (rx, ry, rw, rh) => { right = Math.max(right, rx + rw); bottom = Math.max(bottom, ry + rh); };
			const px = b.ax + b.bl, py = b.ay + b.bt;
			const gather = (c) => {
				if (c.kind === 'text') { return; }
				if (c.kind === 'inline') { for (const r of c.__rects ? c.__rects.rects : []) { if (r.ax !== undefined) { add(r.ax - px, r.ay - py, r.w, r.h); } } for (const cc of c.children) { gather(cc); } return; }
				visit(c); add(c.ax - px + (c.tx || 0), c.ay - py + (c.ty || 0), c.w, c.h);
				if (c.v['overflow-x'] === 'visible' && c.v['overflow-y'] === 'visible') { add(c.ax - px + (c.tx || 0), c.ay - py + (c.ty || 0), c.scrollW, c.scrollH); }
			};
			for (const c of b.children) { gather(c); }
			for (const f of b.frags || []) { if (f.t === 'text') { add(f.ax - px, f.ay - py, f.w, f.asc + f.desc); } }
			const cw = b.w - b.bl - b.br, ch = b.h - b.bt - b.bb; b.scrollW = Math.max(cw, right); b.scrollH = Math.max(ch, bottom);
		};
		// oof boxes are children in the box tree, so the generic walk already covers them
		const walk = (b) => { visit(b); };
		walk(root);
	}
}
