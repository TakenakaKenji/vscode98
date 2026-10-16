// Style engine plug-in for 06-rendering/host/dom (env.styleEngine): selector matching in C (spike:style, style.c), the cascade and computed values stay in JavaScript.
// - The element tree is mirrored in C. dom.js reports every node it invalidates to a sink (setNativeStyleSink); before each style pass the changed nodes are sent as
//   node records (tag, id, classes, attributes, hover/active/checked/empty flags, element children), new subtrees in full. Removed subtrees are freed by C.
// - css.js buildRuleIndex creates a native index next to each JavaScript one (newIndex) and replays its entry/bucket operations on it.
// - matchAll(el, index) returns what css.js matchedDeclarationsAll returns: [element, ::before, ::after] entry lists in cascade order.
// verify: also run the JavaScript matcher (without the ancestor filter) on every element and record the differences in `mismatches`.
import * as S from 'spike:style';
import { setNativeStyleSink } from '../../06-rendering/host/dom/dom.js';
import { setNativeSheetParser, matchedDeclarationsAll, PROPS, INIT, INH, INIT_VALUES, parseValue, parseLength, parseColor, expandShorthand, expandDecls, finishComputed, computeStyleJS, substituteVars, EMPTY_VARS } from '../../06-rendering/host/dom/css.js';
import { deepEqual } from '../../06-rendering/host/dom/style_invalidation.js';

const NF_ELEM = 1, NF_DOC = 2, NF_HOVER = 4, NF_ACTIVE = 8, NF_CHECKED = 16, NF_EMPTY = 32;
const COMB = { ' ': 0, '>': 1, '+': 2, '~': 3 };
const OPS = { '=': 1, '~=': 2, '|=': 3, '^=': 4, '$=': 5, '*=': 6 };
const PSEUDO = {
	root: 2, 'first-child': 3, 'last-child': 4, 'only-child': 5, 'first-of-type': 6, 'last-of-type': 7, 'only-of-type': 8, 'nth-child': 9, 'nth-last-child': 10, 'nth-of-type': 11, 'nth-last-of-type': 12,
	empty: 13, not: 14, is: 15, where: 15, matches: 15, '-webkit-any': 15, any: 15, has: 16, hover: 17, active: 18, focus: 19, 'focus-visible': 20, 'focus-within': 21, checked: 22, disabled: 23, enabled: 24,
	link: 25, 'any-link': 25, 'read-only': 26, 'read-write': 27, required: 28, optional: 29, dir: 1, lang: 1, host: 1, 'host-context': 1, defined: 1,
};
const P_FALSE = 0, P_NOT = 14, P_IS = 15, P_HAS = 16, P_NTH_CHILD = 9, P_NTH_LAST_CHILD = 10, P_NTH_OF_TYPE = 11, P_NTH_LAST_OF_TYPE = 12;

// ---- atoms
const atomMap = new Map(); const lowerMap = new Map();
function atom(s) { let a = atomMap.get(s); if (a === undefined) { a = S.atom(s); atomMap.set(s, a); } return a; }
function lowerAtom(s) { let a = lowerMap.get(s); if (a === undefined) { a = atom(s.toLowerCase()); lowerMap.set(s, a); } return a; }

// ---- selectors: the parsed form of selectors.js as a flat Int32Array (read by style.c read_sel), cached on the parsed object
const clampInt = (n) => n > 1e9 ? 1e9 : n < -1e9 ? -1e9 : n;
function serList(list, out) { if (!Array.isArray(list)) { out.push(0); return; } out.push(list.length); for (const c of list) { serComplex(c, out); } }
function serComplex(c, out) {
	out.push(c.parts.length);
	for (const p of c.parts) {
		const k = p.compound; out.push(COMB[p.comb] ?? 0, k.tag ? atom(k.tag) : -1, k.id !== null ? atom(k.id) : -1, k.classes.length); for (const cl of k.classes) { out.push(atom(cl)); }
		out.push(k.attrs.length); for (const a of k.attrs) { out.push(atom(a.name), a.op ? (OPS[a.op] ?? 7) : 0, atom(a.value), a.flag === 'i' ? 1 : 0); }
		out.push(k.pseudos.length);
		for (const ps of k.pseudos) {
			let code = PSEUDO[ps.name] ?? P_FALSE; const arg = ps.arg;
			if ((code === P_NTH_CHILD || code === P_NTH_LAST_CHILD || code === P_NTH_OF_TYPE || code === P_NTH_LAST_OF_TYPE) && !(arg && Number.isFinite(arg.a) && Number.isFinite(arg.b))) { code = P_FALSE; }   // NaN: never matches
			out.push(code);
			if (code === P_NOT || code === P_IS || code === P_HAS) { serList(arg, out); }
			else if (code === P_NTH_CHILD || code === P_NTH_LAST_CHILD) { out.push(clampInt(arg.a), clampInt(arg.b)); if (arg.of) { serList(arg.of, out); } else { out.push(-1); } }
			else if (code === P_NTH_OF_TYPE || code === P_NTH_LAST_OF_TYPE) { out.push(clampInt(arg.a), clampInt(arg.b)); }
		}
	}
}
function serialized(complex) { let s = complex.__nser; if (s === undefined) { const out = []; serComplex(complex, out); s = complex.__nser = Int32Array.from(out); } return s; }

// ---- rule indexes
const reg = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry((h) => S.idxFree(h)) : null;
const pkOf = (pe) => !pe ? 0 : pe === 'before' ? 1 : pe === 'after' ? 2 : 3;
class NativeIndex {
	constructor() { this.h = S.idxNew(); this.ents = []; this.broken = false; if (reg) { reg.register(this, this.h); } }
	bucket(kind, key) { if (this.broken) { return -1; } try { return S.bucket(this.h, kind, kind === 3 ? 0 : atom(key)); } catch (e) { this.fail(e); return -1; } }
	entry(e) {
		if (this.broken) { return -1; }
		try { const id = S.entry(this.h, serialized(e.complex), pkOf(e.pseudoElement), e.ua ? 1 : 0, e.order, e.spec[0], e.spec[1], e.spec[2], e.multi ? 1 : 0); this.ents[id] = e; return id; } catch (err) { this.fail(err); return -1; }
	}
	push(b, id) { if (!this.broken) { S.push(this.h, b, id); } }
	pop(b) { if (!this.broken) { S.pop(this.h, b); } }
	truncate(n) { if (!this.broken) { S.truncate(this.h, n); this.ents.length = n; } }
	fail(e) { this.broken = true; stats.brokenIndexes++; if (globalThis.__log98) { globalThis.__log98('[native style] index disabled, JavaScript matching instead: ' + (e && e.message || e)); } }
}

// ---- element tree mirror
const dirty = new Set();
const natNodes = [undefined]; const freeNids = []; let maxNid = 0; let syncSeq = 0;
let buf = new Int32Array(1 << 16); let blen = 0; const vals = [];
function assign(n) { const nid = freeNids.length ? freeNids.pop() : ++maxNid; n.__nid = nid; natNodes[nid] = n; return nid; }
function reserve(k) { if (blen + k > buf.length) { let c = buf.length * 2; while (blen + k > c) { c *= 2; } const nb = new Int32Array(c); nb.set(buf.subarray(0, blen)); buf = nb; } }
function emit(n, mark) {
	const kids = n.__children; let tag = -1, tagl = -1, id = -1, flags, cls = null, attrs = null;
	if (n.nodeType === 9) { flags = NF_DOC; }
	else {
		flags = NF_ELEM; if (n.__hover) { flags |= NF_HOVER; } if (n.__active) { flags |= NF_ACTIVE; }
		attrs = n.__attrs; if (attrs.has('checked') || n.checked) { flags |= NF_CHECKED; }
		tag = atom(n.localName); tagl = lowerAtom(n.localName); const idv = attrs.get('id'); if (idv !== undefined) { id = atom(idv); } cls = n.classes();
	}
	reserve(8 + (cls ? cls.length : 0) + (attrs ? attrs.size : 0) + kids.length);
	const b = buf; let i = blen; b[i++] = n.__nid; const fi = i++; b[i++] = tag; b[i++] = tagl; b[i++] = id;
	if (cls) { b[i++] = cls.length; for (let k = 0; k < cls.length; k++) { b[i++] = atom(cls[k]); } } else { b[i++] = 0; }
	if (attrs) { b[i++] = attrs.size; for (const [k, v] of attrs) { b[i++] = atom(k); vals.push(v); } } else { b[i++] = 0; }
	const ki = i++; let nk = 0, empty = true;
	for (let k = 0; k < kids.length; k++) {
		const c = kids[k]; const t = c.nodeType;
		if (t === 1) { empty = false; let cn = c.__nid; if (cn === undefined) { cn = assign(c); mark(c); } b[i++] = cn; nk++; } else if (t === 3 ? c.__data !== '' : t !== 8) { empty = false; }
	}
	b[ki] = nk; b[fi] = flags | (empty && n.nodeType === 1 ? NF_EMPTY : 0); blen = i; stats.records++;
}
/** sends the changed nodes (and new subtrees) of all documents to C; `doc` is sent in full the first time */
function sync(doc) {
	const seq = ++syncSeq; const todo = []; const mark = (n) => { if (n.__nsy !== seq) { n.__nsy = seq; todo.push(n); } };
	if (doc.__nid === undefined) { assign(doc); mark(doc); }
	for (const n of dirty) { const t = n.nodeType; if (t === 1 || t === 9) { if (n.__nid !== undefined) { mark(n); } } else { const p = n.parentNode; if (p && p.__nid !== undefined) { mark(p); } } }
	dirty.clear();
	for (let i = 0; i < todo.length; i++) { emit(todo[i], mark); }
	if (blen > 0) {
		const freed = S.sync(buf, blen, vals, maxNid); blen = 0; vals.length = 0;
		for (let i = 0; i < freed.length; i++) { const nid = freed[i]; const n = natNodes[nid]; if (n !== undefined && n.__nid === nid) { n.__nid = undefined; } natNodes[nid] = undefined; freeNids.push(nid); }
		stats.freed += freed.length;
	}
}

// ---- matching
let out = new Int32Array(4096); S.setOut(out);
export const stats = { passes: 0, matches: 0, fallbacks: 0, records: 0, freed: 0, brokenIndexes: 0, syncMs: 0, matchMs: 0, verified: 0, computes: 0, computeFallbacks: 0, computeMs: 0, computeVerified: 0, sheets: 0, sheetFallbacks: 0, sheetMs: 0 };
export const mismatches = [];
const describe = (el) => el.localName + (el.getAttribute('id') ? '#' + el.getAttribute('id') : '') + (el.classes().length ? '.' + el.classes().join('.') : '');
function verifyOne(el, index, got) {
	const saved = el.__anc; el.__anc = undefined; let want; try { want = matchedDeclarationsAll(el, index); } finally { el.__anc = saved; } stats.verified++;
	for (let q = 0; q < 3; q++) {
		const a = got[q], b = want[q]; let same = a.length === b.length; for (let i = 0; same && i < a.length; i++) { if (a[i] !== b[i]) { same = false; } }
		if (!same && mismatches.length < 200) { const ga = new Set(a), wb = new Set(b); mismatches.push(`${describe(el)}${q ? (q === 1 ? '::before' : '::after') : ''}: only native: ${a.filter(e => !wb.has(e)).map(e => e.sel).join(' ; ') || '-'}; only js: ${b.filter(e => !ga.has(e)).map(e => e.sel).join(' ; ') || '-'}${ga.size === wb.size && a.every(e => wb.has(e)) ? ' (order differs)' : ''}`); if (mismatches.length <= 20 && globalThis.__log98) { globalThis.__log98('[native style] mismatch ' + mismatches[mismatches.length - 1]); } }
	}
}

// ---- computed values (phase 2, style_compute.c): the cascade, custom properties, var() and the values in C; css.js computeStyleJS is the reference
const PNAMES = Object.keys(PROPS); const PIDX = new Map(PNAMES.map((n, i) => [n, i]));
const SHORTHANDS = []; const SHIDX = new Map();
const cur = { rootFontSize: 16, vw: 0, vh: 0 };   // the environment of the element being computed, for the parse callback
/** C asks for the JavaScript value of a declaration it has not seen before (it caches the answer like css.js parseValueCached) */
function parseCb(mode, a, b, str, fs, color) {
	if (mode === 0) { const v = parseValue(PROPS[PNAMES[a]], str, { fontSize: fs, rootFontSize: cur.rootFontSize, vw: cur.vw, vh: cur.vh }, color); return v === undefined ? null : v; }
	if (mode === 1) { const l = parseLength(str, { fontSize: fs, rootFontSize: cur.rootFontSize, vw: cur.vw, vh: cur.vh }); return l !== null && typeof l === 'object' && l.pct !== undefined ? l.pct / 100 * fs : (typeof l === 'number' ? l : null); }   // font-size against the parent's
	if (mode === 2) { return parseColor(str, color) ?? null; }
	const ex = expandShorthand(SHORTHANDS[a], str).find(([n]) => n === PNAMES[b]); return ex ? String(ex[1]) : null;   // a longhand of a shorthand whose value had var()
}
S.computeInit(PNAMES, Int32Array.from(PNAMES, (n) => (PROPS[n].inh ? 1 : 0)), Int32Array.from(PNAMES, (n) => (PROPS[n].kind === 'len' ? 1 : 0)), PNAMES.map((n) => INIT[n]), PROPS.color.init, parseCb);
const blockReg = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry((b) => S.declFree(b)) : null;
const scopeReg = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry((h) => S.scopeUnref(h)) : null;
/** a declaration list (css.js expandDecls) as a native block; cached on the list (the rule lists are cached per rule by css.js) */
function makeBlock(decls) {
	const f = [], vals = [];
	for (let i = 0; i < decls.length; i++) {
		const d = decls[i], n = d.name; let p = -1, c = -1;
		if (n.charCodeAt(0) === 45 && n.charCodeAt(1) === 45) { c = atom(n); } else { p = PIDX.get(n); if (p === undefined) { continue; } }   // unknown properties never reach a computed value
		let sh = 0; if (d.pendingShorthand) { sh = SHIDX.get(d.pendingShorthand); if (sh === undefined) { sh = SHORTHANDS.length; SHORTHANDS.push(d.pendingShorthand); SHIDX.set(d.pendingShorthand, sh); } sh++; }
		f.push(p, c, d.important ? 1 : 0, sh); vals.push(d.value);
	}
	return S.declBlock(Int32Array.from(f), vals);
}
function blockOf(decls) { let b = decls.__nb; if (b === undefined) { b = decls.__nb = makeBlock(decls); if (blockReg) { blockReg.register(decls, b); } } return b; }
/** the inline style's block, rebuilt only when the declaration changed (dom.js CSSStyleDeclaration bumps __map.__ver) */
function inlineBlockOf(el) {
	const m = el.__style.__map; const ver = m.__ver | 0;
	if (m.__nb !== undefined) { if (m.__nbv === ver) { return m.__nb; } if (blockReg) { blockReg.unregister(m); } S.declFree(m.__nb); }
	const inl = []; for (const [k, e] of m) { inl.push({ name: k, value: e.v, important: e.important }); }
	const b = makeBlock(expandDecls(inl)); m.__nb = b; m.__nbv = ver; if (blockReg) { blockReg.register(m, b, m); } return b;
}
/** the custom properties of a computed style held by C (css.js VarScope's interface) */
class NativeVars {
	constructor(h, owned) { this.h = h; this.native = true; this.parent = null; this.depth = 0; this.flatMap = null; this.eqTo = null; this.map = null; if (owned && scopeReg) { scopeReg.register(this, h); } }
	get(k) { return S.varGet(this.h, k); }
	has(k) { return S.varGet(this.h, k) !== undefined; }
	toMap() { if (this.map === null) { const a = S.varEntries(this.h); const m = new Map(); for (let i = 0; i < a.length; i += 2) { m.set(a[i], a[i + 1]); } this.map = m; } return this.map; }
	substitute(value) { return substituteVars(value, this); }
	equals(o) { return S.varsEqual(this.h, o.h); }
	get size() { return this.toMap().size; }
	[Symbol.iterator]() { return this.toMap()[Symbol.iterator](); }
}
const EMPTY_NATIVE = new NativeVars(0, false);
/** the native scope of a parent's custom properties (a JavaScript VarScope, from an element JavaScript computed, gets a flat native copy) */
function scopeOf(vars) {
	if (vars.native) { return vars.h; } if (vars === EMPTY_VARS) { return 0; }
	if (vars.__nh === undefined) { const m = vars.toMap(); vars.__nh = S.scopeFrom(Int32Array.from([...m.keys()], (k) => atom(k)), [...m.values()]); if (scopeReg) { scopeReg.register(vars, vars.__nh); } }
	return vars.__nh;
}
let blk = new Int32Array(64);
export const computeMismatches = [];
function sameVars(a, b) { const ma = a.toMap(), mb = b.toMap(); if (ma.size !== mb.size) { return false; } for (const [k, v] of ma) { if (mb.get(k) !== v) { return false; } } return true; }
function verifyCompute(el, parentCS, env, pseudo, cands, got) {
	const want = computeStyleJS(el, parentCS, env, pseudo, cands); stats.computeVerified++;
	let diff = null; for (const k of Object.keys(want.values)) { if (!deepEqual(got.values[k], want.values[k])) { diff = `${k}: ${JSON.stringify(got.values[k])} (native) vs ${JSON.stringify(want.values[k])} (js)`; break; } }
	if (diff === null && !sameVars(got.vars, want.vars)) { diff = 'custom properties differ'; }
	if (diff !== null && computeMismatches.length < 200) { computeMismatches.push(`${describe(el)}${pseudo ? '::' + pseudo : ''}: ${diff}`); if (computeMismatches.length <= 20 && globalThis.__log98) { globalThis.__log98('[native style] compute mismatch ' + computeMismatches[computeMismatches.length - 1]); } }
}
function computeNative(el, parentCS, env, pseudo, cands) {
	const t0 = performance.now();
	const pv = parentCS ? parentCS.values : null, pvars = parentCS ? parentCS.vars : EMPTY_NATIVE; const ps = scopeOf(pvars);
	const n = cands.length; if (blk.length < n) { blk = new Int32Array(n * 2); } for (let i = 0; i < n; i++) { blk[i] = blockOf(cands[i].decls); }
	const ib = !pseudo && el.__style && el.__style.__map.size ? inlineBlockOf(el) : -1;
	const out = { ...INIT_VALUES }; if (pv) { for (let i = 0; i < INH.length; i++) { const k = INH[i]; out[k] = pv[k]; } }
	cur.rootFontSize = env.rootFontSize ?? 16; cur.vw = env.vw; cur.vh = env.vh;
	const sc = S.compute(blk, n, ib, ps, pv, out, cur.rootFontSize, cur.vw, cur.vh);
	if (sc === -2) { stats.computeFallbacks++; return undefined; }
	const vars = sc === ps ? (parentCS ? pvars : EMPTY_NATIVE) : new NativeVars(sc, true);
	finishComputed(el, out, out.color, undefined);
	const r = { values: out, vars, cands }; stats.computes++; stats.computeMs += performance.now() - t0;
	if (engine.verify) { verifyCompute(el, parentCS, env, pseudo, cands, r); }
	return r;
}

// ---- stylesheet parsing in C (style_sheet.c); verify mode compares it with the JavaScript parser
export const sheetMismatches = [];
setNativeSheetParser((text) => { const t0 = performance.now(); const r = S.parseSheet(text); stats.sheetMs += performance.now() - t0; stats.sheets++; if (r === null) { stats.sheetFallbacks++; } return r; }, () => engine.verify ? sheetMismatches : null);

export const engine = {
	verify: false,
	/** computeStyle's computed-value step in C (css.js calls it; undefined: use computeStyleJS) */
	compute: computeNative,
	newIndex() { return new NativeIndex(); },
	/** called by resolveStyles before its walk */
	beginPass(doc) {
		const t0 = performance.now(); sync(doc); const ae = doc.__activeElement; S.pass(ae && ae.__nid !== undefined ? ae.__nid : 0, doc.__focusVisible ? 1 : 0); stats.passes++; stats.syncMs += performance.now() - t0;
	},
	matchAll(el, index) {
		const nat = index.nat; const nid = el.__nid;
		if (!nat || nat.broken || nid === undefined) { stats.fallbacks++; return matchedDeclarationsAll(el, index); }
		const t0 = performance.now(); let n = S.match(nat.h, nid); if (n < 0) { out = new Int32Array(-n * 2); S.setOut(out); n = S.match(nat.h, nid); }
		const ents = nat.ents, o = out; let k = 3; const r0 = [], r1 = [], r2 = [];
		for (let i = o[0]; i > 0; i--) { r0.push(ents[o[k++]]); } for (let i = o[1]; i > 0; i--) { r1.push(ents[o[k++]]); } for (let i = o[2]; i > 0; i--) { r2.push(ents[o[k++]]); }
		stats.matches++; stats.matchMs += performance.now() - t0; const r = [r0, r1, r2];
		if (this.verify) { verifyOne(el, index, r); }
		return r;
	},
	nativeStats() { return Object.assign(S.stats(), S.computeStats()); },
};
setNativeStyleSink(dirty);
