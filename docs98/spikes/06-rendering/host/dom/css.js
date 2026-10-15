// CSS for the rendering spike: parser (rules, @media, @supports, @layer flattening, @font-face), CSSOM subset (CSSStyleSheet, insertRule/deleteRule), value parsing
// (lengths incl. calc/min/max/clamp, colors incl. color-mix), shorthand expansion, var() substitution, cascade and computed style.
import { parseSelector, matchesComplex, cmpSpec } from './selectors.js';
import { splitDecls, CSSStyleDeclaration, noteMissing } from './dom.js';

// ---- parsing ----------------------------------------------------------------------------------------------------------------------------------
export function stripComments(t) { return t.indexOf('/*') < 0 ? t : t.replace(/\/\*[\s\S]*?\*\//g, ''); }
function readBlock(t, i) { /* t[i] === '{' → index after matching '}' */ let d = 0, q = 0; const n = t.length; for (; i < n; i++) { const c = t.charCodeAt(i); if (q !== 0) { if (c === 92) { i++; } else if (c === q) { q = 0; } continue; } if (c === 34 || c === 39) { q = c; } else if (c === 123) { d++; } else if (c === 125) { d--; if (d === 0) { return i + 1; } } } return n; }
function readPrelude(t, i) { let d = 0, q = 0; const n = t.length; for (; i < n; i++) { const c = t.charCodeAt(i); if (q !== 0) { if (c === 92) { i++; } else if (c === q) { q = 0; } continue; } if (c === 34 || c === 39) { q = c; } else if (c === 40) { d++; } else if (c === 41) { d--; } else if (d === 0 && (c === 123 || c === 59)) { return i; } } return n; }
export function parseDeclarations(text) { const __t0 = performance.now(); try { return parseDeclarations0(text); } finally {  } }
function parseDeclarations0(text) {
	const out = [];
	for (const d of splitDecls(stripComments(text))) { const colon = d.indexOf(':'); if (colon <= 0) { continue; } let n = d.slice(0, colon).trim(), v = d.slice(colon + 1).trim(), imp = false; if (/!\s*important\s*$/i.test(v)) { v = v.replace(/!\s*important\s*$/i, '').trim(); imp = true; } if (!n.startsWith('--')) { n = n.toLowerCase(); } if (v !== '') { out.push({ name: n, value: v, important: imp }); } }
	return out;
}
export class CSSStyleRule {
	constructor(selectorText, decls, sheet) { this.type = 1; this.selectorText = selectorText; this.__decls = decls; this.parentStyleSheet = sheet; this.__sel = null; }
	get selectors() { return this.__sel ??= parseSelector(this.selectorText); }
	get style() { const r = this; const st = new CSSStyleDeclaration(null); for (const d of this.__decls) { st.__map.set(d.name, { v: d.value, important: d.important }); } Object.defineProperty(st, '__changed', { value() { r.__decls = [...st.__map].map(([name, e]) => ({ name, value: e.v, important: e.important })); r.parentStyleSheet && r.parentStyleSheet.__touch(); } }); return st; }
	get cssText() { return `${this.selectorText} { ${this.__decls.map(d => `${d.name}: ${d.value}${d.important ? ' !important' : ''};`).join(' ')} }`; }
}
export class CSSGroupRule { constructor(type, cond, rules, sheet) { this.type = type; this.conditionText = cond; this.cssRules = rules; this.parentStyleSheet = sheet; } get media() { return { mediaText: this.conditionText }; } }
export function parseRules(text, sheet, depth = 0) {
	text = stripComments(text); const rules = []; let i = 0; const n = text.length;
	while (i < n) {
		while (i < n) { const c = text.charCodeAt(i); if (c === 32 || c === 10 || c === 9 || c === 13 || c === 12 || (c > 127 || c === 11) && /\s/.test(text[i])) { i++; } else { break; } } if (i >= n) { break; }
		if (text[i] === '@') {
			const end = readPrelude(text, i); const head = text.slice(i, end).trim(); const name = /^@([\w-]+)/.exec(head)[1].toLowerCase(); const prelude = head.slice(name.length + 1).trim();
			if (text[end] === '{') {
				const bend = readBlock(text, end); const body = text.slice(end + 1, bend - 1); i = bend;
				if (name === 'media' || name === 'supports' || name === 'layer' || name === 'container' || name === 'scope' || name === 'document') { rules.push(new CSSGroupRule(name === 'media' ? 4 : name === 'supports' ? 12 : 0, prelude, parseRules(body, sheet, depth + 1), sheet)); }
				else if (name === 'font-face') { const g = new CSSGroupRule(5, prelude, [], sheet); g.__decls = parseDeclarations(body); g.type = 5; rules.push(g); }
				else { /* @keyframes, @property, @page ...: ignored */ }
			} else { i = end + 1; }   // @import, @charset, @layer a, b;
			continue;
		}
		const end = readPrelude(text, i); if (text[end] !== '{') { break; }
		const sel = text.slice(i, end).trim(); const bend = readBlock(text, end); const body = text.slice(end + 1, bend - 1); i = bend;
		parseStyleRule(sel, body, sheet, rules, null);
	}
	return rules;
}
/** A style rule body may contain declarations and nested rules (CSS Nesting): flatten nested rules after the parent, resolving `&` and implicit descendant selectors. */
function parseStyleRule(sel, body, sheet, out, parentSel) {
	const fullSel = parentSel ? sel.split(',').map(x => x.trim()).map(x => /&/.test(x) ? x.replace(/&/g, `:is(${parentSel})`) : /^[>+~]/.test(x) ? `:is(${parentSel}) ${x}` : `:is(${parentSel}) ${x}`).join(', ') : sel;
	if (body.indexOf('{') < 0) { out.push(new CSSStyleRule(fullSel, parseDeclarations(body), sheet)); return; }
	let decl = '', i = 0; const nested = [];
	while (i < body.length) {
		const end = readPrelude(body, i); const chunk = body.slice(i, end);
		if (end >= body.length || body[end] === ';') { decl += chunk + ';'; i = end + 1; continue; }
		const bend = readBlock(body, end); const inner = body.slice(end + 1, bend - 1); const head = chunk.trim(); i = bend;
		if (head.startsWith('@')) { const name = /^@([\w-]+)/.exec(head)[1].toLowerCase(); const prelude = head.slice(name.length + 1).trim(); const sub = []; parseStyleRule('&', inner, sheet, sub, fullSel); nested.push(new CSSGroupRule(name === 'media' ? 4 : name === 'supports' ? 12 : 0, prelude, sub, sheet)); }
		else { parseStyleRule(head, inner, sheet, nested, fullSel); }
	}
	out.push(new CSSStyleRule(fullSel, parseDeclarations(decl), sheet)); for (const n of nested) { out.push(n); }
}
export class CSSStyleSheet {
	constructor(text = '', ownerNode = null) { this.ownerNode = ownerNode; this.disabled = false; this.cssRules = parseRules(text, this); this.__version = 0; this.media = { mediaText: '' }; this.href = null; this.type = 'text/css'; }
	get rules() { return this.cssRules; }
	insertRule(text, index = 0) { const r = parseRules(text, this); if (!r.length) { throw new SyntaxError('Failed to parse the rule: ' + text); } this.cssRules.splice(index, 0, r[0]); this.__touch(); return index; }
	deleteRule(i) { this.cssRules.splice(i, 1); this.__touch(); } addRule(sel, st, i) { this.insertRule(`${sel}{${st}}`, i ?? this.cssRules.length); return -1; } removeRule(i) { this.deleteRule(i); }
	replaceSync(t) { this.cssRules = parseRules(t, this); this.__touch(); } replace(t) { this.replaceSync(t); return Promise.resolve(this); }
	__touch() { this.__version++; const d = this.ownerNode && this.ownerNode.ownerDocument; if (d) { d.__styleDirty = true; d.__dirty = true; d.__rulesVersion = (d.__rulesVersion || 0) + 1; } if (this.__doc) { this.__doc.__styleDirty = true; this.__doc.__dirty = true; this.__doc.__rulesVersion = (this.__doc.__rulesVersion || 0) + 1; } }
}

// ---- values -----------------------------------------------------------------------------------------------------------------------------------
const NAMED = { transparent: [0, 0, 0, 0], black: [0, 0, 0, 1], white: [255, 255, 255, 1], red: [255, 0, 0, 1], green: [0, 128, 0, 1], blue: [0, 0, 255, 1], yellow: [255, 255, 0, 1], gray: [128, 128, 128, 1], grey: [128, 128, 128, 1], orange: [255, 165, 0, 1], purple: [128, 0, 128, 1], cyan: [0, 255, 255, 1], magenta: [255, 0, 255, 1], silver: [192, 192, 192, 1], maroon: [128, 0, 0, 1], navy: [0, 0, 128, 1], teal: [0, 128, 128, 1], lime: [0, 255, 0, 1], olive: [128, 128, 0, 1], aqua: [0, 255, 255, 1], fuchsia: [255, 0, 255, 1], pink: [255, 192, 203, 1], brown: [165, 42, 42, 1], gold: [255, 215, 0, 1], dodgerblue: [30, 144, 255, 1], lightgray: [211, 211, 211, 1], lightgrey: [211, 211, 211, 1], darkgray: [169, 169, 169, 1], whitesmoke: [245, 245, 245, 1], rebeccapurple: [102, 51, 153, 1], canvas: [255, 255, 255, 1], canvastext: [0, 0, 0, 1], highlight: [0, 120, 215, 1], highlighttext: [255, 255, 255, 1], buttonface: [240, 240, 240, 1] };
const clamp01 = (x) => Math.max(0, Math.min(1, x));
function splitArgs(s) { const out = []; let d = 0, cur = ''; for (const c of s) { if (c === '(') { d++; } else if (c === ')') { d--; } if (c === ',' && d === 0) { out.push(cur.trim()); cur = ''; } else { cur += c; } } out.push(cur.trim()); return out; }
function hsl2rgb(h, s, l) { h = ((h % 360) + 360) % 360 / 360; const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }; return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)]; }
export function parseColor(v, currentColor) {
	v = v.trim(); const low = v.toLowerCase();
	if (low === 'currentcolor') { return currentColor ?? [0, 0, 0, 1]; }
	if (NAMED[low]) { return NAMED[low].slice(); }
	let m;
	if ((m = /^#([0-9a-f]{3,8})$/i.exec(v))) { let h = m[1]; if (h.length === 3 || h.length === 4) { h = [...h].map(c => c + c).join(''); } if (h.length === 6) { h += 'ff'; } if (h.length !== 8) { return null; } return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16) / 255]; }
	if ((m = /^(rgba?|hsla?)\((.*)\)$/i.exec(v))) {
		const parts = m[2].split(/[\s,/]+/).filter(Boolean); if (parts.length < 3) { return null; } const pc = (s, base) => s.endsWith('%') ? parseFloat(s) / 100 * base : parseFloat(s); const a = parts[3] !== undefined ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
		if (m[1][0].toLowerCase() === 'r') { return [Math.round(pc(parts[0], 255)), Math.round(pc(parts[1], 255)), Math.round(pc(parts[2], 255)), a]; }
		const [r, g, b] = hsl2rgb(parseFloat(parts[0]), parseFloat(parts[1]) / 100, parseFloat(parts[2]) / 100); return [r, g, b, a];
	}
	if ((m = /^color-mix\(\s*in\s+[\w-]+\s*,(.*)\)$/i.exec(v))) {
		const [a, b] = splitArgs(m[1]).map(s => { const mm = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(s.trim()); return { c: parseColor(mm[1], currentColor), p: mm[2] !== undefined ? parseFloat(mm[2]) : undefined }; }); if (!a.c || !b.c) { return null; }
		let pa = a.p, pb = b.p; if (pa === undefined && pb === undefined) { pa = pb = 50; } else if (pa === undefined) { pa = 100 - pb; } else if (pb === undefined) { pb = 100 - pa; }
		const sum = pa + pb, wa = pa / sum, wb = pb / sum, al = a.c[3] * wa + b.c[3] * wb; if (al === 0) { return [0, 0, 0, 0]; }
		const ch = (i) => Math.round((a.c[i] * a.c[3] * wa + b.c[i] * b.c[3] * wb) / al); return [ch(0), ch(1), ch(2), al * (sum < 100 ? sum / 100 : 1)];
	}
	if ((m = /^light-dark\((.*)\)$/i.exec(v))) { return parseColor(splitArgs(m[1])[0], currentColor); }
	return null;
}
export function colorToString(c) { if (!c) { return ''; } return c[3] >= 1 ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${+c[3].toFixed(3)})`; }

// lengths: number (px) | { pct } | { calc: tree } | keyword string
const UNIT_PX = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };
export function parseLength(v, ctx) {
	v = String(v).trim(); const low = v.toLowerCase(); let m;
	if ((m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i.exec(v))) { const n = parseFloat(m[1]); const u = m[2].toLowerCase(); if (u === '') { return n === 0 ? 0 : { num: n }; } if (u === '%') { return { pct: n }; } return unitToPx(n, u, ctx); }
	if (/^(calc|min|max|clamp|-webkit-calc)\(/i.test(v)) { const t = parseCalc(v, ctx); return t === null ? null : (typeof t === 'number' ? t : { calc: t }); }
	if (/^[a-z-]+$/.test(low)) { return low; }
	return null;
}
function unitToPx(n, u, ctx) {
	if (u in UNIT_PX) { return n * UNIT_PX[u]; }
	if (u === 'em') { return n * (ctx?.fontSize ?? 16); } if (u === 'rem') { return n * (ctx?.rootFontSize ?? 16); } if (u === 'ex') { return n * (ctx?.fontSize ?? 16) * 0.5; } if (u === 'ch') { return n * (ctx?.fontSize ?? 16) * 0.6; }
	if (u === 'vw') { return n * (ctx?.vw ?? 800) / 100; } if (u === 'vh') { return n * (ctx?.vh ?? 600) / 100; } if (u === 'vmin') { return n * Math.min(ctx?.vw ?? 800, ctx?.vh ?? 600) / 100; } if (u === 'vmax') { return n * Math.max(ctx?.vw ?? 800, ctx?.vh ?? 600) / 100; }
	if (u === 'deg') { return n; } if (u === 's') { return n * 1000; } if (u === 'ms') { return n; }
	return null;
}
// calc tree: number (px) | { pct } | { op, a, b } | { fn: 'min'|'max'|'clamp', args }
function parseCalc(v, ctx) {
	const body = v.slice(v.indexOf('(') + 1, v.lastIndexOf(')')); const fn = v.slice(0, v.indexOf('(')).toLowerCase();
	if (fn === 'min' || fn === 'max' || fn === 'clamp') { const args = splitArgs(body).map(a => parseCalcExpr(a, ctx)); if (args.some(a => a === null)) { return null; } const t = { fn, args }; return constant(t) ? evalCalc(t, 0) : t; }
	const t = parseCalcExpr(body, ctx); return t === null ? null : (constant(t) ? evalCalc(t, 0) : t);
}
const constant = (t) => typeof t === 'number' ? true : t.pct !== undefined ? false : t.op ? constant(t.a) && constant(t.b) : t.fn ? t.args.every(constant) : false;
function parseCalcExpr(s, ctx) {
	const toks = []; const re = /\s*([+\-*/()]|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[a-z%]*|(?:calc|min|max|clamp)\()/gi; let m, last = 0;
	while ((m = re.exec(s))) { if (m.index !== last) { return null; } last = re.lastIndex; toks.push(m[1]); } if (last !== s.length && s.slice(last).trim()) { return null; }
	let i = 0; const peek = () => toks[i];
	const atom = () => { const t = toks[i++]; if (t === undefined) { return null; } if (t === '(' || /\($/.test(t)) { if (/^(min|max|clamp)\($/i.test(t)) { const fn = t.slice(0, -1).toLowerCase(); const args = []; for (;;) { args.push(expr()); if (peek() === ',') { i++; continue; } break; } i++; return { fn, args }; } const e = expr(); i++; return e; } if (t === '-' || t === '+') { const a = atom(); return t === '-' ? { op: '*', a: -1, b: a } : a; } const mm = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i.exec(t); if (!mm) { return null; } const n = parseFloat(mm[1]), u = mm[2].toLowerCase(); if (u === '') { return { raw: n }; } if (u === '%') { return { pct: n }; } return unitToPx(n, u, ctx); };
	const term = () => { let a = atom(); while (peek() === '*' || peek() === '/') { const op = toks[i++]; const b = atom(); if (a === null || b === null) { return null; } a = { op, a, b }; } return a; };
	const expr = () => { let a = term(); while (peek() === '+' || peek() === '-') { const op = toks[i++]; const b = term(); if (a === null || b === null) { return null; } a = { op, a, b }; } return a; };
	// split commas for min/max handled via splitArgs on the outside; inside nested calls commas appear as tokens we did not tokenise → handle by pre-splitting
	try { const r = expr(); return r === null || i < toks.length ? null : simplifyRaw(r); } catch { return null; }
}
const simplifyRaw = (t) => (t && t.raw !== undefined) ? t.raw : (t && t.op) ? { op: t.op, a: simplifyRaw(t.a), b: simplifyRaw(t.b) } : (t && t.fn) ? { fn: t.fn, args: t.args.map(simplifyRaw) } : t;
export function evalCalc(t, base) {
	if (typeof t === 'number') { return t; } if (t.pct !== undefined) { return t.pct / 100 * base; }
	if (t.op) { const a = evalCalc(t.a, base), b = evalCalc(t.b, base); return t.op === '+' ? a + b : t.op === '-' ? a - b : t.op === '*' ? a * b : a / b; }
	if (t.fn) { const v = t.args.map(a => evalCalc(a, base)); return t.fn === 'min' ? Math.min(...v) : t.fn === 'max' ? Math.max(...v) : Math.max(v[0], Math.min(v[1], v[2])); }
	return 0;
}
/** resolve a computed length-ish value to px against `base` (percentage basis); 'auto'/'none'/keywords yield null */
export function resolveLen(v, base) { if (typeof v === 'number') { return v; } if (v && typeof v === 'object') { if (v.pct !== undefined) { return v.pct / 100 * base; } if (v.calc) { return evalCalc(v.calc, base); } if (v.num !== undefined) { return v.num; } } return null; }
export function lengthToString(v) { if (typeof v === 'number') { return +v.toFixed(4) + 'px'; } if (v && v.pct !== undefined) { return v.pct + '%'; } if (v && v.calc) { return 'calc(...)'; } if (v && v.num !== undefined) { return String(v.num); } return String(v); }

// ---- shorthands ------------------------------------------------------------------------------------------------------------------------------
const SIDES = ['top', 'right', 'bottom', 'left'];
const box4 = (parts) => parts.length === 1 ? [parts[0], parts[0], parts[0], parts[0]] : parts.length === 2 ? [parts[0], parts[1], parts[0], parts[1]] : parts.length === 3 ? [parts[0], parts[1], parts[2], parts[1]] : parts.slice(0, 4);
export function splitValues(s) { const out = []; let d = 0, cur = '', q = ''; for (const c of s.trim()) { if (q) { cur += c; if (c === q) { q = ''; } continue; } if (c === '"' || c === "'") { q = c; cur += c; continue; } if (c === '(') { d++; } else if (c === ')') { d--; } if (/\s/.test(c) && d === 0) { if (cur) { out.push(cur); cur = ''; } } else { cur += c; } } if (cur) { out.push(cur); } return out; }
const isWidth = (s) => /^(thin|medium|thick)$/i.test(s) || /^[+-]?[\d.]/.test(s) || /^calc\(/i.test(s);
const BSTYLES = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset']);
export const LONGHANDS_OF = {
	margin: SIDES.map(s => 'margin-' + s), padding: SIDES.map(s => 'padding-' + s), inset: SIDES, 'border-width': SIDES.map(s => `border-${s}-width`), 'border-style': SIDES.map(s => `border-${s}-style`), 'border-color': SIDES.map(s => `border-${s}-color`),
	border: SIDES.flatMap(s => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]), 'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
	overflow: ['overflow-x', 'overflow-y'], flex: ['flex-grow', 'flex-shrink', 'flex-basis'], 'flex-flow': ['flex-direction', 'flex-wrap'], gap: ['row-gap', 'column-gap'], 'grid-gap': ['row-gap', 'column-gap'], background: ['background-color', 'background-image', 'background-repeat', 'background-position', 'background-size'],
	font: ['font-style', 'font-weight', 'font-size', 'line-height', 'font-family'], 'text-decoration': ['text-decoration-line', 'text-decoration-style', 'text-decoration-color'], outline: ['outline-width', 'outline-style', 'outline-color'], 'place-items': ['align-items', 'justify-items'], 'place-content': ['align-content', 'justify-content'],
	'list-style': ['list-style-type'], transition: ['transition-property'], animation: ['animation-name'], 'border-top': ['border-top-width', 'border-top-style', 'border-top-color'], 'border-right': ['border-right-width', 'border-right-style', 'border-right-color'], 'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'], 'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
	'border-inline': ['border-left-width', 'border-left-style', 'border-left-color', 'border-right-width', 'border-right-style', 'border-right-color'], 'margin-inline': ['margin-left', 'margin-right'], 'margin-block': ['margin-top', 'margin-bottom'], 'padding-inline': ['padding-left', 'padding-right'], 'padding-block': ['padding-top', 'padding-bottom'], 'inset-inline': ['left', 'right'], 'inset-block': ['top', 'bottom'],
	'text-wrap': ['text-wrap-mode'], mask: ['mask-image'], 'mask-image': ['mask-image'], 'column-rule': ['column-rule-width'], 'grid-template': ['grid-template-columns'], 'overscroll-behavior': ['overscroll-behavior-x', 'overscroll-behavior-y'],
};
/** expand one declaration into longhand [name, value] pairs. Unknown shorthands pass through unchanged. */
export function expandShorthand(name, value) {
	if (name === 'font') { value = value.replace(/\s*\/\s*/g, '/'); }
	const parts = splitValues(value);
	switch (name) {
		case 'margin': case 'padding': { const v = box4(parts); return SIDES.map((s, i) => [`${name}-${s}`, v[i]]); }
		case 'inset': { const v = box4(parts); return SIDES.map((s, i) => [s, v[i]]); }
		case 'margin-inline': case 'padding-inline': case 'inset-inline': { const p = name.split('-')[0]; const v = parts.length === 1 ? [parts[0], parts[0]] : parts; return p === 'inset' ? [['left', v[0]], ['right', v[1]]] : [[`${p}-left`, v[0]], [`${p}-right`, v[1]]]; }
		case 'margin-block': case 'padding-block': case 'inset-block': { const p = name.split('-')[0]; const v = parts.length === 1 ? [parts[0], parts[0]] : parts; return p === 'inset' ? [['top', v[0]], ['bottom', v[1]]] : [[`${p}-top`, v[0]], [`${p}-bottom`, v[1]]]; }
		case 'border-width': case 'border-style': case 'border-color': { const k = name.slice(7); const v = box4(parts); return SIDES.map((s, i) => [`border-${s}-${k}`, v[i]]); }
		case 'border': case 'border-top': case 'border-right': case 'border-bottom': case 'border-left': case 'border-inline': case 'border-block': {
			let w = 'medium', st = 'none', c = 'currentcolor'; for (const p of parts) { if (BSTYLES.has(p.toLowerCase())) { st = p; } else if (isWidth(p)) { w = p; } else { c = p; } }
			const sides = name === 'border' ? SIDES : name === 'border-inline' ? ['left', 'right'] : name === 'border-block' ? ['top', 'bottom'] : [name.slice(7)];
			if (/^(none|0)$/i.test(value.trim())) { w = '0'; st = 'none'; } return sides.flatMap(s => [[`border-${s}-width`, w], [`border-${s}-style`, st], [`border-${s}-color`, c]]);
		}
		case 'border-radius': { const [h, vv] = value.split('/').map(s => splitValues(s)); const hh = box4(h), v2 = vv ? box4(vv) : hh; return ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((c, i) => [`border-${c}-radius`, hh[i] + (vv ? ' ' + v2[i] : '')]); }
		case 'overflow': return [['overflow-x', parts[0]], ['overflow-y', parts[1] ?? parts[0]]];
		case 'flex': {
			const v = value.trim().toLowerCase(); if (v === 'none') { return [['flex-grow', '0'], ['flex-shrink', '0'], ['flex-basis', 'auto']]; } if (v === 'auto') { return [['flex-grow', '1'], ['flex-shrink', '1'], ['flex-basis', 'auto']]; } if (v === 'initial') { return [['flex-grow', '0'], ['flex-shrink', '1'], ['flex-basis', 'auto']]; }
			let g = '1', s = '1', b = '0%'; const nums = []; for (const p of parts) { if (/^[\d.]+$/.test(p)) { nums.push(p); } else { b = p; } } if (nums.length) { g = nums[0]; } if (nums.length > 1) { s = nums[1]; } return [['flex-grow', g], ['flex-shrink', s], ['flex-basis', b]];
		}
		case 'flex-flow': { const o = []; for (const p of parts) { if (/^(row|column)/.test(p)) { o.push(['flex-direction', p]); } else { o.push(['flex-wrap', p]); } } return o; }
		case 'gap': case 'grid-gap': return [['row-gap', parts[0]], ['column-gap', parts[1] ?? parts[0]]];
		case 'place-items': return [['align-items', parts[0]], ['justify-items', parts[1] ?? parts[0]]]; case 'place-content': return [['align-content', parts[0]], ['justify-content', parts[1] ?? parts[0]]];
		case 'background': {
			let color = 'transparent', image = 'none', repeat = 'repeat', pos = '0% 0%', size = 'auto'; const posT = [], sizeT = []; let inSize = false;
			for (let p of parts) {
				if (/^(url|(repeating-)?(linear|radial|conic)-gradient)\(/i.test(p)) { image = p; continue; } if (p === 'none') { image = 'none'; continue; }
				if (!/^(url|[a-z-]*gradient)\(/i.test(p) && p.includes('/')) { const [a, b] = p.split('/'); inSize = true; if (a) { if (/^(left|right|top|bottom|center|-?[\d.]+(px|%|em|rem)?)$/i.test(a)) { posT.push(a); } } if (b) { sizeT.push(b); } continue; }
				if (p === '/') { inSize = true; continue; } if (/^(repeat|no-repeat|repeat-x|repeat-y|space|round)$/i.test(p)) { repeat = p.toLowerCase(); continue; }
				if (parseColor(p) || /^currentcolor$/i.test(p)) { color = p; continue; } if (inSize) { if (/^(auto|cover|contain|-?[\d.]+(px|%|em|rem)?)$/i.test(p)) { sizeT.push(p); } continue; } if (/^(left|right|top|bottom|center|-?[\d.]+(px|%|em|rem)?)$/i.test(p)) { posT.push(p); }
			}
			if (posT.length) { pos = posT.join(' '); } if (sizeT.length) { size = sizeT.join(' '); } return [['background-color', color], ['background-image', image], ['background-repeat', repeat], ['background-position', pos], ['background-size', size]];
		}
		case 'font': {
			const sys = /^(caption|icon|menu|message-box|small-caption|status-bar)$/.test(value.trim()); if (sys) { return [['font-size', '13px']]; }
			let style = 'normal', weight = 'normal', i = 0; for (; i < parts.length; i++) { const p = parts[i]; if (/^(italic|oblique)$/.test(p)) { style = p; } else if (/^(normal|bold|bolder|lighter|\d{3,4})$/.test(p)) { weight = p === 'normal' ? weight : p; } else if (p === 'small-caps') { /* ignore */ } else { break; } }
			const [size, lh] = (parts[i] || '').split('/'); return [['font-style', style], ['font-weight', weight], ['font-size', size || 'medium'], ['line-height', lh || 'normal'], ['font-family', parts.slice(i + 1).join(' ')]];
		}
		case 'text-decoration': { const o = [['text-decoration-line', 'none'], ['text-decoration-style', 'solid'], ['text-decoration-color', 'currentcolor']]; const lines = []; for (const p of parts) { if (/^(underline|overline|line-through|blink)$/.test(p)) { lines.push(p); } else if (/^(solid|double|dotted|dashed|wavy)$/.test(p)) { o[1][1] = p; } else if (p !== 'none') { o[2][1] = p; } } if (lines.length) { o[0][1] = lines.join(' '); } return o; }
		case 'outline': { let w = 'medium', st = 'none', c = 'currentcolor'; for (const p of parts) { if (BSTYLES.has(p.toLowerCase())) { st = p; } else if (isWidth(p)) { w = p; } else { c = p; } } return [['outline-width', w], ['outline-style', st], ['outline-color', c]]; }
		case 'list-style': return [['list-style-type', parts[0] ?? 'disc']];
		case 'transition': case 'animation': case 'mask': case 'column-rule': case 'grid-template': case 'text-wrap': return [[name === 'text-wrap' ? 'text-wrap-mode' : name + '-x', value]];
		case 'overscroll-behavior': return [['overscroll-behavior-x', parts[0]], ['overscroll-behavior-y', parts[1] ?? parts[0]]];
		default: return [[name, value]];
	}
}

// ---- property table ---------------------------------------------------------------------------------------------------------------------------
// [inherited, initial, kind]  kinds: kw, len, color, num, str, int
const T = {};
const def = (names, inh, init, kind) => { for (const n of names.split(' ')) { T[n] = { inh, init, kind }; } };
def('display position visibility float clear box-sizing text-align white-space word-break overflow-wrap word-wrap text-transform vertical-align list-style-type font-style font-variant-ligatures table-layout overflow-x overflow-y pointer-events user-select -webkit-user-select cursor text-overflow resize flex-direction flex-wrap align-items align-self align-content justify-content justify-items justify-self direction unicode-bidi text-rendering tab-size text-wrap-mode appearance -webkit-appearance contain content-visibility isolation mix-blend-mode text-decoration-line text-decoration-style background-repeat outline-style border-top-style border-right-style border-bottom-style border-left-style border-collapse caret-color transform will-change transition-x animation-x font-feature-settings font-variation-settings font-kerning line-break hyphens writing-mode object-fit scroll-behavior scrollbar-width overscroll-behavior-x overscroll-behavior-y touch-action -webkit-text-size-adjust text-size-adjust -webkit-font-smoothing -moz-osx-font-smoothing forced-color-adjust color-scheme quotes background-position background-size filter backdrop-filter box-shadow text-shadow text-decoration-thickness text-underline-offset font-synthesis font-stretch font-optical-sizing', 0, 'initial', 'kw'); def('background-image mask-image', 0, 'none', 'str');
for (const n of ['visibility', 'cursor', 'white-space', 'text-align', 'word-break', 'overflow-wrap', 'word-wrap', 'text-transform', 'list-style-type', 'font-style', 'font-variant-ligatures', 'pointer-events', 'user-select', '-webkit-user-select', 'direction', 'text-rendering', 'tab-size', 'text-wrap-mode', 'caret-color', 'font-feature-settings', 'font-variation-settings', 'font-kerning', 'line-break', 'hyphens', 'writing-mode', 'border-collapse', 'quotes', 'text-shadow', '-webkit-text-size-adjust', 'text-size-adjust', '-webkit-font-smoothing', '-moz-osx-font-smoothing', 'forced-color-adjust', 'color-scheme', 'font-synthesis', 'font-stretch', 'font-optical-sizing', 'text-underline-offset', 'scroll-behavior']) { T[n].inh = 1; }
const init = (names, v) => { for (const n of names.split(' ')) { T[n].init = v; } };
init('display', 'inline'); init('position', 'static'); init('visibility', 'visible'); init('float clear text-transform pointer-events', 'none'); T.clear.init = 'none'; T['pointer-events'].init = 'auto'; T['box-sizing'].init = 'content-box'; init('text-align', 'start'); init('white-space word-break overflow-wrap word-wrap', 'normal'); T['overflow-wrap'].init = 'normal'; init('vertical-align', 'baseline'); init('list-style-type', 'disc'); init('font-style', 'normal');
init('overflow-x overflow-y', 'visible'); init('user-select -webkit-user-select', 'auto'); init('cursor', 'auto'); init('text-overflow', 'clip'); init('resize', 'none'); init('flex-direction', 'row'); init('flex-wrap', 'nowrap'); init('align-items align-self align-content', 'normal'); T['align-self'].init = 'auto'; init('justify-content', 'normal'); init('direction', 'ltr'); init('tab-size', '8'); init('contain', 'none'); init('text-decoration-line', 'none'); init('text-decoration-style', 'solid'); init('background-repeat', 'repeat'); init('background-image', 'none'); init('border-top-style border-right-style border-bottom-style border-left-style outline-style', 'none'); init('transform filter backdrop-filter mask-image box-shadow text-shadow', 'none'); init('font-feature-settings font-variation-settings', 'normal'); init('caret-color', 'auto'); init('text-rendering', 'auto'); init('background-position', '0% 0%'); init('background-size', 'auto'); init('object-fit', 'fill'); init('content-visibility', 'visible'); init('table-layout', 'auto'); init('isolation', 'auto'); init('mix-blend-mode', 'normal');
def('top right bottom left width height margin-top margin-right margin-bottom margin-left flex-basis row-gap column-gap', 0, 'auto', 'len'); for (const n of ['row-gap', 'column-gap']) { T[n].init = 'normal'; } for (const n of ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']) { T[n].init = 0; } T['flex-basis'].init = 'auto';
def('min-width min-height padding-top padding-right padding-bottom padding-left border-top-width border-right-width border-bottom-width border-left-width outline-width border-top-left-radius border-top-right-radius border-bottom-right-radius border-bottom-left-radius outline-offset', 0, 0, 'len');
for (const n of ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'outline-width']) { T[n].init = 3; }
def('anchor-name position-anchor', 0, 'none', 'str'); def('max-width max-height', 0, 'none', 'len'); def('letter-spacing word-spacing', 1, 'normal', 'len'); def('text-indent', 1, 0, 'len'); def('line-height', 1, 'normal', 'len'); def('font-size', 1, 16, 'len'); def('font-weight', 1, 400, 'num'); def('font-family', 1, 'serif', 'str');
def('opacity flex-grow', 0, 1, 'num'); T['flex-grow'].init = 0; def('flex-shrink', 0, 1, 'num'); def('z-index', 0, 'auto', 'int'); def('order', 0, 0, 'int');
def('color', 1, [0, 0, 0, 1], 'color'); def('background-color border-top-color border-right-color border-bottom-color border-left-color outline-color text-decoration-color', 0, 'currentcolor', 'color'); T['background-color'].init = [0, 0, 0, 0];
def('content', 0, 'normal', 'str');
export const PROPS = T;
const keywordFontSizes = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };

// ---- cascade ----------------------------------------------------------------------------------------------------------------------------------
const UA_CSS = `
html,body,div,section,article,nav,aside,header,footer,main,ul,ol,li,p,pre,form,fieldset,table,h1,h2,h3,h4,h5,h6,dl,dd,dt,blockquote,hr,figure,figcaption,address,details,summary,menu,dialog,canvas-wrapper,template-wrapper { display:block }
head,script,style,link,meta,title,base,template,noscript,area,datalist,param,source,track { display:none }
li { display:list-item } table { display:table } tr { display:table-row } td,th { display:table-cell } thead { display:table-header-group } tbody { display:table-row-group }
img,canvas,video,svg,input,button,select,textarea,iframe { display:inline-block } input,textarea,button,select { font: 13.333px Arial; } textarea { white-space: pre-wrap; }
html { color:#000; background-color: transparent } body { margin:8px } pre { white-space:pre; font-family: monospace } b,strong { font-weight:bold } i,em { font-style:italic } a:link { color:#0000ee; text-decoration: underline; cursor: pointer }
h1 { font-size:2em; margin:0.67em 0; font-weight:bold } h2 { font-size:1.5em; margin:0.83em 0; font-weight:bold } h3 { font-size:1.17em; margin:1em 0; font-weight:bold } p,ul,ol { margin:1em 0 } ul,ol { padding-left:40px } li { list-style-type: disc }
code,kbd,samp,tt { font-family: monospace } small { font-size: 0.83em } sub { vertical-align: sub; font-size: .83em } sup { vertical-align: super; font-size: .83em } [hidden] { display:none }
`;
let uaSheet = null;
function sheetsOf(doc) { const out = []; if (!uaSheet) { uaSheet = new CSSStyleSheet(UA_CSS); } out.push({ sheet: uaSheet, ua: true }); for (const s of doc.__allSheets()) { if (!s.disabled) { out.push({ sheet: s, ua: false }); } } return out; }
function mediaMatches(q, env) {
	q = q.trim().toLowerCase(); if (q === '' || q === 'all' || q === 'screen') { return true; } if (q === 'print') { return false; }
	return q.split(',').some(part => { part = part.trim(); let neg = false; if (part.startsWith('not ')) { neg = true; part = part.slice(4); } part = part.replace(/^(only\s+)?(screen|all)\s*(and\s*)?/, ''); const conds = [...part.matchAll(/\(\s*([\w-]+)\s*(?::\s*([^)]+))?\)/g)]; const ok = conds.every(([, f, v]) => { v = (v || '').trim(); const px = parseFloat(v); switch (f) { case 'min-width': return env.vw >= px; case 'max-width': return env.vw <= px; case 'min-height': return env.vh >= px; case 'max-height': return env.vh <= px; case 'prefers-color-scheme': return v === (env.dark ? 'dark' : 'light'); case 'prefers-reduced-motion': return v === 'no-preference'; case 'hover': return v === 'hover'; case 'pointer': return v === 'fine'; case 'any-hover': return v === 'hover'; case 'min-resolution': case '-webkit-min-device-pixel-ratio': return env.dpr >= px; case 'forced-colors': return v === 'none'; case 'display-mode': return v === 'browser'; case 'orientation': return v === (env.vw >= env.vh ? 'landscape' : 'portrait'); case 'prefers-contrast': return v === 'no-preference'; default: return false; } }); return neg ? !ok : ok; });
}
function flattenRules(rules, env, out, ua, state) {
	for (const r of rules) {
		if (r instanceof CSSStyleRule) { out.push({ rule: r, ua, order: state.order++ }); }
		else if (r.type === 4) { if (mediaMatches(r.conditionText, env)) { flattenRules(r.cssRules, env, out, ua, state); } }
		else if (r.type === 12 || r.type === 0) { if (r.type === 0 || !/^\s*not\b/i.test(r.conditionText)) { flattenRules(r.cssRules, env, out, ua, state); } }
	}
}
/**
 * The index buckets a rule is filed under, as a flat [kind, key, kind, key, ...] list (kind 0 id, 1 class, 2 tag), or null when it must be tried on every element: an element can only match a rule
 * whose subject compound has an id, a class or a tag if it has it, and a compound made of `:is(...)`/`:where(...)` of such selectors (most of the rules without a tag or class) only if it has the key
 * of one of the alternatives (an alternative without a key sends the rule to the universal bucket); `:root` can only be the <html> element.
 */
function bucketKeys(c) {
	if (c.id) { return [0, c.id]; } if (c.classes.length === 1) { return [1, c.classes[0]]; } if (c.classes.length) { return [3, c.classes]; } if (c.tag) { return [2, c.tag]; }
	for (const p of c.pseudos) {
		if (p.name === 'root') { return [2, 'html']; }
		if ((p.name === 'is' || p.name === 'where' || p.name === 'matches' || p.name === '-webkit-any' || p.name === 'any') && Array.isArray(p.arg) && p.arg.length) {
			const out = []; for (const alt of p.arg) { const k = bucketKeys(alt.parts[alt.parts.length - 1].compound); if (k === null) { out.length = 0; break; } for (let i = 0; i < k.length; i += 2) { out.push(k[i], k[i + 1]); } }
			if (out.length) { return out; }
		}
	}
	return null;
}
function rarest(classes, freq) { let best = classes[0], n = freq.get(best) || 0; for (let i = 1; i < classes.length; i++) { const m = freq.get(classes[i]) || 0; if (m < n) { n = m; best = classes[i]; } } return best; }
/** the index entries of a rule (without cascade data), as the delta between two rule sets needs them */
export function baseEntriesOf(rule) { const c = baseEntries.get(rule); return c && c.base ? c.base : []; }
let matchToken = 0;   // an entry filed under several buckets is considered once per matching walk (entry.mk)
const baseEntries = new WeakMap();   // CSSStyleRule -> the cascade-independent parts of its index entries (null: unparsable)
/** The cascade-independent index entries of a rule (parsed selectors, expanded declarations, ancestor-filter bits, bucket keys), cached until the rule is edited; null when unparsable. */
function baseOf(rule) {
	const cached = baseEntries.get(rule);   // the parsed selectors, expanded declarations and ancestor-filter bits of a rule only change when the rule is edited (declarations replaced, selector text set): the rebuilds after a stylesheet change reuse them
	if (cached !== undefined && cached.src === rule.__decls && cached.sel === rule.selectorText) { return cached.base; }
	let base, list; try { list = rule.selectors; } catch { noteMissing('css: unparsable selector'); base = null; }
	if (list) { const decls = expandRuleDecls(rule), sel = rule.selectorText; base = list.map((complex) => ({ complex, decls, spec: complex.spec, pseudoElement: complex.parts[complex.parts.length - 1].compound.pseudoElement, need: needOf(complex), needAny: needAnyOf(complex), sel, keys: bucketKeys(complex.parts[complex.parts.length - 1].compound) })); }
	baseEntries.set(rule, { src: rule.__decls, sel: rule.selectorText, base }); return base;
}
function countKeys(base, freq, d = 1) { for (const b of base) { const k = b.keys; if (k !== null) { for (let i = 0; i < k.length; i += 2) { if (k[i] === 3) { for (const cl of k[i + 1]) { freq.set(cl, (freq.get(cl) || 0) + d); } } else if (k[i] === 1) { freq.set(k[i + 1], (freq.get(k[i + 1]) || 0) + d); } } } } }   // how many rules use each class
/** files an entry under a bucket and logs where, so that the entries of the last rules can be taken out again (they are the last element of each of their buckets) */
function put(index, list, e) { list.push(e); index.logB.push(list); index.logE.push(e); }
function putKey(index, map, key, e) { let l = map.get(key); if (l === undefined) { l = []; map.set(key, l); } put(index, l, e); }
function placeEntries(index, base, f, freq, added) {
	for (const b of base) {
		const e = { complex: b.complex, decls: b.decls, ua: f.ua, order: f.order, spec: b.spec, pseudoElement: b.pseudoElement, need: b.need, needAny: b.needAny, sel: b.sel, mk: 0, w0: b.need.length ? b.need[0] : -1, m0: b.need.length ? b.need[1] : 0, multi: b.keys !== null && b.keys.length > 2 }; index.count++; if (added) { added.push(e); }
		const keys = b.keys; if (keys === null) { put(index, index.universal, e); } else { for (let i = 0; i < keys.length; i += 2) { const k = keys[i]; if (k === 3) { putKey(index, index.byClass, rarest(keys[i + 1], freq), e); } else { putKey(index, k === 0 ? index.byId : k === 1 ? index.byClass : index.byTag, keys[i + 1], e); } } }
	}
}
/** adds rule `f` (a flatten result) to `index`, remembering where its entries start in the log */
function addRule(index, f, base, added) {
	index.rules.push(f.rule); index.decls.push(f.rule.__decls); index.sels.push(f.rule.selectorText); index.markLog.push(index.logB.length); index.markCount.push(index.count);
	if (base) { countKeys(base, index.freq); placeEntries(index, base, f, index.freq, added); }
}
/**
 * Builds an index of all active style rules for a document: entries { complex selector, decls, ua, order }, bucketed by the rightmost compound's id/class/tag (see bucketKeys).
 * When `prev` (the index of the previous build) is given and the rules are the same as before up to some point (a stylesheet was appended, or the last ones were replaced), `prev` is updated
 * in place (its entries from that point on are taken out and the new ones put in) instead of rebuilt: `prev.update` then says which rules were added and removed and lists the new entries.
 * A change that moves rules or edits selectors returns a new index.
 */
export function buildRuleIndex(doc, env, prev) {
	const flat = []; const state = { order: 0 };
	for (const { sheet, ua } of sheetsOf(doc)) { flattenRules(sheet.cssRules, env, flat, ua, state); }
	if (prev) {
		const n0 = prev.rules.length; let p = 0; const nm = Math.min(n0, flat.length);
		while (p < nm) { const r = flat[p].rule; if (r !== prev.rules[p] || r.__decls !== prev.decls[p] || r.selectorText !== prev.sels[p]) { break; } p++; }
		if (p > 0 && updateInPlace(prev, flat, p)) { return prev; }
	}
	const index = { byId: new Map(), byClass: new Map(), byTag: new Map(), universal: [], count: 0, rules: [], decls: [], sels: [], freq: new Map(), logB: [], logE: [], markLog: [], markCount: [], update: null };
	for (const f of flat) { addRule(index, f, baseOf(f.rule), null); }
	return index;
}
function updateInPlace(prev, flat, p) {
	const n0 = prev.rules.length; const oldPos = new Map(); for (let i = p; i < n0; i++) { oldPos.set(prev.rules[i], i); }
	const addedRules = [], removedRules = []; const kept = new Set(); let last = -1;
	for (let i = p; i < flat.length; i++) {
		const r = flat[i].rule; const j = oldPos.get(r);
		if (j === undefined) { addedRules.push(r); continue; }
		if (j < last || prev.sels[j] !== r.selectorText) { return false; }   // rules moved relative to each other, or a selector was edited: rebuild
		last = j; kept.add(j); if (prev.decls[j] !== r.__decls) { addedRules.push(r); }
	}
	for (let j = p; j < n0; j++) { if (!kept.has(j)) { removedRules.push(prev.rules[j]); } }
	// take out the entries of rules p.. (the last ones logged), then put the new tail in
	const lp = prev.markLog[p] ?? prev.logB.length;
	for (let k = prev.logB.length - 1; k >= lp; k--) { if (prev.logB[k].pop() !== prev.logE[k]) { return false; } }   // (the index is damaged only if this fires halfway: callers rebuild from `flat` then, nothing else holds it)
	for (let i = n0 - 1; i >= p; i--) { const c = baseEntries.get(prev.rules[i]); if (c && c.base) { countKeys(c.base, prev.freq, -1); } }
	prev.count = prev.markCount[p] ?? prev.count; prev.logB.length = lp; prev.logE.length = lp; prev.rules.length = p; prev.decls.length = p; prev.sels.length = p; prev.markLog.length = p; prev.markCount.length = p;
	const added = []; for (let i = p; i < flat.length; i++) { addRule(prev, flat[i], baseOf(flat[i].rule), added); }
	prev.update = { added, addedRules, removedRules }; return true;
}
// ---- ancestor Bloom filter (as in WebKit/Blink): rejects descendant/child selectors whose required ancestor tag/id/class is not on the element's ancestor chain
const BLOOM_WORDS = 32;   // 1024 bits
const hashStr = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 16777619); } return h >>> 0; };
const bloomBits = (h) => [(h & 1023), ((h >>> 10) ^ (h >>> 20)) & 1023];
function needOf(complex) {
	const need = []; const parts = complex.parts;
	for (let k = parts.length - 1; k >= 1; k--) {
		const comb = parts[k].comb; if (comb !== ' ' && comb !== '>') { break; }
		const c = parts[k - 1].compound; const hs = []; if (c.id) { hs.push(hashStr('#' + c.id)); } for (const cl of c.classes) { hs.push(hashStr('.' + cl)); } if (c.tag) { hs.push(hashStr('T' + c.tag)); }
		for (const h of hs) { for (const b of bloomBits(h)) { need.push(b >> 5, 1 << (b & 31)); } }
	}
	return need;
}
/**
 * Ancestor requirements that are "one of": a `:is(.a, .b)` compound on the way up the selector needs an ancestor with the bits of at least one alternative (the alternative's own tag/id/classes;
 * an alternative without any sends the group away). Returns null, or a list of groups, each a list of flat [word, mask, ...] alternatives.
 */
function needAnyOf(complex) {
	let out = null; const parts = complex.parts;
	for (let k = parts.length - 1; k >= 1; k--) {
		const comb = parts[k].comb; if (comb !== ' ' && comb !== '>') { break; }
		for (const p of parts[k - 1].compound.pseudos) {
			if (!((p.name === 'is' || p.name === 'where' || p.name === 'matches' || p.name === '-webkit-any' || p.name === 'any') && Array.isArray(p.arg) && p.arg.length)) { continue; }
			const group = []; let ok = true;
			for (const alt of p.arg) { const c = alt.parts[alt.parts.length - 1].compound; const hs = []; if (c.id) { hs.push(hashStr('#' + c.id)); } for (const cl of c.classes) { hs.push(hashStr('.' + cl)); } if (c.tag) { hs.push(hashStr('T' + c.tag)); } if (!hs.length) { ok = false; break; } const flat = []; for (const h of hs) { for (const b of bloomBits(h)) { flat.push(b >> 5, 1 << (b & 31)); } } group.push(flat); }
			if (ok) { (out ??= []).push(group); }
		}
	}
	return out;
}
/** whether the ancestor filter rules out an entry's "one of" groups */
function anyRejects(filter, groups) {
	for (const group of groups) { let any = false; for (const alt of group) { let ok = true; for (let i = 0; i < alt.length; i += 2) { if ((filter[alt[i]] & alt[i + 1]) === 0) { ok = false; break; } } if (ok) { any = true; break; } } if (!any) { return true; } }
	return false;
}
/** adds an element's own tag/id/class bits to a copy of its parent's ancestor filter */
export function ancestorFilter(el, parentFilter) {
	const f = parentFilter ? parentFilter.slice() : new Int32Array(BLOOM_WORDS); const add = (h) => { for (const b of bloomBits(h)) { f[b >> 5] |= 1 << (b & 31); } };
	add(hashStr('T' + el.localName)); const id = el.getAttribute('id'); if (id) { add(hashStr('#' + id)); } const cls = el.classes(); for (let i = 0; i < cls.length; i++) { add(hashStr('.' + cls[i])); }
	return f;
}
const push = (m, k, e) => { const l = m.get(k); if (l) { l.push(e); } else { m.set(k, [e]); } };
const declCache = new WeakMap();
function expandRuleDecls(rule) { const key = rule.__decls; let c = declCache.get(key); if (c) { return c; } c = expandDecls(rule.__decls); declCache.set(key, c); return c; }
/** declarations → list of { name (longhand), value, important, pending? } (pending: the shorthand value contains var() and is expanded at computed-value time) */
export function expandDecls(decls) {
	const out = [];
	for (const d of decls) {
		const n = d.name; const sh = LONGHANDS_OF[n];
		if (n.startsWith('--')) { out.push({ name: n, value: d.value, important: d.important }); continue; }
		if (sh && n !== 'mask-image') { if (d.value.includes('var(') ) { for (const l of sh) { out.push({ name: l, value: d.value, important: d.important, pendingShorthand: n }); } } else { for (const [ln, lv] of expandShorthand(n, d.value)) { out.push({ name: ln, value: lv, important: d.important }); } } }
		else { out.push({ name: n, value: d.value, important: d.important }); }
	}
	return out;
}
export function matchedDeclarations(el, index, inlineDecls, pseudo) {
	const cands = []; const filter = el.__anc;   // ancestor Bloom filter, set by resolveStyles
	const tok = ++matchToken; const consider = (list) => { if (list) { outer: for (const e of list) { if (e.multi) { if (e.mk === tok) { continue; } e.mk = tok; } if ((e.pseudoElement || null) !== (pseudo || null)) { continue; } if (filter) { const w = e.w0; if (w >= 0) { if ((filter[w] & e.m0) === 0) { continue; } const need = e.need; for (let i = 2; i < need.length; i += 2) { if ((filter[need[i]] & need[i + 1]) === 0) { continue outer; } } } } if (matchesComplex(el, e.complex)) { cands.push(e); } } } };
	const id = el.getAttribute('id'); if (id) { consider(index.byId.get(id)); }
	const cls = el.classes(); for (let i = 0; i < cls.length; i++) { consider(index.byClass.get(cls[i])); }
	consider(index.byTag.get(el.localName)); consider(index.universal);
	cands.sort((a, b) => (a.ua === b.ua ? 0 : a.ua ? -1 : 1) || cmpSpec(a.spec, b.spec) || a.order - b.order);
	return cands;
}
/** The matched rules of an element, of the element itself and of its ::before and ::after, in one walk over the candidate lists: [main, before, after], each in cascade order. */
export function matchedDeclarationsAll(el, index) {
	const out = [[], [], []]; const filter = el.__anc;
	const tok = ++matchToken; const consider = (list) => { if (list) { outer: for (const e of list) { if (e.multi) { if (e.mk === tok) { continue; } e.mk = tok; } if (filter) { const w = e.w0; if (w >= 0) { if ((filter[w] & e.m0) === 0) { continue; } const need = e.need; for (let i = 2; i < need.length; i += 2) { if ((filter[need[i]] & need[i + 1]) === 0) { continue outer; } } } if (e.needAny !== null && anyRejects(filter, e.needAny)) { continue; } } const pe = e.pseudoElement; const dst = !pe ? out[0] : pe === 'before' ? out[1] : pe === 'after' ? out[2] : null; if (dst && matchesComplex(el, e.complex)) { dst.push(e); } } } };
	const id = el.getAttribute('id'); if (id) { consider(index.byId.get(id)); }
	const cls = el.classes(); for (let i = 0; i < cls.length; i++) { consider(index.byClass.get(cls[i])); }
	consider(index.byTag.get(el.localName)); consider(index.universal);
	for (const cands of out) { if (cands.length > 1) { cands.sort((a, b) => (a.ua === b.ua ? 0 : a.ua ? -1 : 1) || cmpSpec(a.spec, b.spec) || a.order - b.order); } }
	return out;
}
const VAR_RE = /var\(\s*(--[\w-]+)\s*(?:,((?:[^()]|\([^()]*\))*))?\)/;
export function substituteVars(value, vars, depth = 0) {
	if (!value.includes('var(')) { return value; } if (depth > 10) { return null; }
	let out = value, guard = 0;
	for (let m = VAR_RE.exec(out); m && guard++ < 50; m = VAR_RE.exec(out)) {
		let rep = vars.get(m[1]); if (rep === undefined) { rep = m[2] !== undefined ? m[2].trim() : null; } if (rep === null) { return null; }
		if (rep.includes('var(')) { rep = substituteVars(rep, vars, depth + 1); if (rep === null) { return null; } }
		out = out.slice(0, m.index) + rep + out.slice(m.index + m[0].length);
	}
	return out;
}
/** Compute the style of one element (or pseudo-element) given its parent's computed style. Returns { values (camel-free dashed keys → computed), vars (Map) } */
export function computeStyle(el, parentCS, index, env, pseudo, candsIn) {
	const cands = candsIn ?? matchedDeclarations(el, index, null, pseudo);   // candsIn: the cached result of matchedDeclarations when only inherited values changed
	if (pseudo && cands.length === 0) { return null; }
	let vars = parentCS ? parentCS.vars : new Map(); let varsOwned = !parentCS;      // copy-on-write: the workbench has ~1500 custom properties on one ancestor
	const winners = new Map();    // longhand → { value, important, pendingShorthand }
	const apply = (decls, rank) => { for (const d of decls) { const prev = winners.get(d.name); if (!prev || (d.important && !prev.important) || (d.important === prev.important && rank >= prev.rank)) { winners.set(d.name, { name: d.name, value: d.value, important: d.important, pendingShorthand: d.pendingShorthand, rank }); } } };
	let rank = 0; for (const c of cands) { apply(c.decls, rank++); }
	if (!pseudo && el.__style && el.__style.__map.size) { const inl = []; for (const [k, e] of el.__style.__map) { inl.push({ name: k, value: e.v, important: e.important }); } apply(expandDecls(inl), 1e9); }
	// custom properties first
	for (const [k, d] of winners) { if (k.startsWith('--')) { const v = d.value.includes('var(') ? substituteVars(d.value, vars) : d.value; if (!varsOwned) { vars = new Map(vars); varsOwned = true; } if (v !== null) { vars.set(k, v.trim()); } else { vars.delete(k); } } }
	const out = {}; const parentVals = parentCS ? parentCS.values : null;
	const ctx = { fontSize: parentVals ? parentVals['font-size'] : 16, rootFontSize: env.rootFontSize ?? 16, vw: env.vw, vh: env.vh };
	// resolve declared values
	const declared = new Map();
	for (const [k, d] of winners) {
		if (k.startsWith('--')) { continue; } let val = d.value;
		if (val.includes('var(')) { val = substituteVars(val, vars); if (val === null) { continue; } if (d.pendingShorthand) { const ex = expandShorthand(d.pendingShorthand, val).find(([n]) => n === k); if (!ex) { continue; } val = ex[1]; } }
		declared.set(k, val.trim());
	}
	// font-size first (em units of the other properties depend on it)
	const fs = declared.get('font-size'); let fontSize = parentVals ? parentVals['font-size'] : 16;
	if (fs !== undefined && !/^(inherit|unset)$/i.test(fs)) { if (/^initial$/i.test(fs)) { fontSize = 16; } else if (keywordFontSizes[fs.toLowerCase()] !== undefined) { fontSize = keywordFontSizes[fs.toLowerCase()]; } else if (fs === 'smaller') { fontSize = fontSize / 1.2; } else if (fs === 'larger') { fontSize = fontSize * 1.2; } else { const l = parseLength(fs, { ...ctx, fontSize: parentVals ? parentVals['font-size'] : 16 }); const px = l !== null && typeof l === 'object' && l.pct !== undefined ? l.pct / 100 * (parentVals ? parentVals['font-size'] : 16) : (typeof l === 'number' ? l : null); if (px !== null) { fontSize = px; } } }
	ctx.fontSize = fontSize;
	const color0 = declared.get('color'); let color = parentVals ? parentVals.color : T.color.init; if (color0 !== undefined && !/^(inherit|unset)$/i.test(color0)) { const c = /^initial$/i.test(color0) ? T.color.init : parseColor(color0, color); if (c) { color = c; } }
	for (const k of NONINH) { out[k] = INIT[k]; }
	for (const k of INH) { out[k] = parentVals ? parentVals[k] : INIT[k]; }
	let anchored;
	for (const [k, d] of declared) {
		const p = T[k]; if (!p || k === 'font-size' || k === 'color') { continue; }
		if (d.charCodeAt(0) === 97 && /^anchor(-size)?\(/.test(d)) { (anchored ??= {})[k] = d; const px = el.__anchorPx && el.__anchorPx[k]; out[k] = px !== undefined ? px : INIT[k]; continue; }   // CSS anchor positioning: anchor() / anchor-size() are resolved after layout from the anchor's box (env.js resolveAnchors) and arrive here as pixels
		if (/^initial$/i.test(d)) { out[k] = INIT[k]; continue; }
		if (/^inherit$/i.test(d) || (p.inh && /^unset$/i.test(d))) { out[k] = parentVals ? parentVals[k] : INIT[k]; continue; }
		if (/^(unset|revert|revert-layer)$/i.test(d)) { out[k] = INIT[k]; continue; }
		out[k] = parseValueCached(p, k, d, ctx, color) ?? (p.inh && parentVals ? parentVals[k] : INIT[k]);
	}
	out['font-size'] = fontSize; out.color = color;
	if (anchored || (out['anchor-name'] && out['anchor-name'] !== 'none')) { const ad = el.ownerDocument; if (ad) { if (anchored) { Object.defineProperty(out, '__anchored', { value: anchored, enumerable: false }); (ad.__anchoredEls ??= new Set()).add(el); } if (out['anchor-name'] !== 'none') { (ad.__anchorEls ??= new Set()).add(el); } ad.__hasAnchors = true; } }
	// border widths are 0 when the style is none/hidden
	for (const s of SIDES) { const st = out[`border-${s}-style`]; if (st === 'none' || st === 'hidden') { out[`border-${s}-width`] = 0; } else if (out[`border-${s}-width`] && typeof out[`border-${s}-width`] === 'string') { out[`border-${s}-width`] = { thin: 1, medium: 3, thick: 5 }[out[`border-${s}-width`]] ?? 3; } if (out[`border-${s}-color`] === 'currentcolor') { out[`border-${s}-color`] = color; } }
	if (out['outline-color'] === 'currentcolor') { out['outline-color'] = color; } if (out['text-decoration-color'] === 'currentcolor') { out['text-decoration-color'] = color; }
	if (out['font-weight'] === 'bold') { out['font-weight'] = 700; } if (typeof out['font-weight'] === 'string') { out['font-weight'] = out['font-weight'] === 'bolder' ? 700 : out['font-weight'] === 'lighter' ? 300 : 400; }
	for (const k of ['overflow-x', 'overflow-y']) { if (!['visible', 'hidden', 'scroll', 'auto', 'clip'].includes(out[k])) { out[k] = 'visible'; } }
	if (out.position === 'absolute' || out.position === 'fixed' || out.float !== 'none') { if (out.display === 'inline') { out.display = 'block'; } else if (out.display === 'inline-block' || out.display === 'inline-flex' || out.display === 'inline-table') { out.display = out.display === 'inline-flex' ? 'flex' : out.display === 'inline-table' ? 'table' : 'block'; } }
	return { values: out, vars, cands };
}
const initialOf = (p) => Array.isArray(p.init) ? p.init.slice() : p.init;
export const INIT = {}, INH = [], NONINH = []; for (const k in T) { INIT[k] = initialOf(T[k]); (T[k].inh ? INH : NONINH).push(k); }
const parseCache = new Map();
function parseValueCached(p, k, d, ctx, color) {
	const ctxDep = p.kind === 'len' || /em|ex|ch|vw|vh|vmin|vmax|calc|min\(|max\(|clamp|currentcolor|color-mix/i.test(d);
	const key = ctxDep ? k + '|' + d + '|' + ctx.fontSize + '|' + (color ? color.join(',') : '') : k + '|' + d;
	let v = parseCache.get(key); if (v !== undefined) { return v; }
	v = parseValue(p, d, ctx, color); if (v === null || v === undefined) { v = null; } if (parseCache.size > 50000) { parseCache.clear(); } parseCache.set(key, v); return v;
}
function parseValue(p, d, ctx, color) {
	switch (p.kind) {
		case 'kw': return d.toLowerCase();
		case 'color': { const lc = d.toLowerCase(); if (lc === 'currentcolor') { return p === T.color ? null : (T['border-top-color'] === p || p.init === 'currentcolor' ? 'currentcolor' : color); } return parseColor(d, color); }
		case 'num': { if (d === 'bold') { return 700; } if (d === 'normal') { return 400; } const n = parseFloat(d); return Number.isNaN(n) ? (/^(bolder|lighter)$/.test(d) ? d : null) : n; }
		case 'int': { if (d === 'auto') { return 'auto'; } const n = parseInt(d, 10); return Number.isNaN(n) ? null : n; }
		case 'str': return d;
		case 'len': { const l = parseLength(d, ctx); if (l === null) { return null; } if (l && l.num !== undefined) { return p.init === 'normal' ? l.num * ctx.fontSize : l.num; } return l; }
	}
	return d;
}
export function serializeValue(k, v) {
	const p = T[k]; if (v === undefined || v === null) { return ''; } if (p && p.kind === 'color') { return v === 'currentcolor' ? v : colorToString(v); }
	if (typeof v === 'number') { return p && p.kind === 'len' ? lengthToString(v) : String(v); } if (typeof v === 'object') { return v.pct !== undefined || v.calc || v.num !== undefined ? lengthToString(v) : String(v); } return String(v);
}
