// Incremental style invalidation: from the mutation log of one layout pass and an analysis of the active rule set, decide which elements must have their style
// re-matched (and how far), instead of restyling the whole tree.
//
// Levels, in the order a restyle walk applies them:
//   3  SUBTREE  re-match this element and every descendant (the element is context for descendant selectors, or it is new)
//   2  SELF     re-match this element; descendants are only restyled when an inherited value (or a custom property) of this element changed
//   1  INHERIT  recompute from the cached matched rules (a parent's inherited value changed); done by the walk, never by this planner
//
// Soundness comes from three things: (a) an element's matched rules depend only on its own attributes/state, on ancestors, on preceding siblings (+ ~), on its
// descendants (:has) and on its position among siblings (structural pseudo-classes); (b) analyzeIndex() records which *keys* (classes, ids, attribute names, state
// pseudo-classes) appear in each of those roles in the active rules; (c) a mutation is planned only for the roles whose keys it touches. Anything unforeseen falls back to a
// full restyle (see layout.js). The fuzz test (tests/style_fuzz.mjs) and the verify mode of the workbench harness compare against a full restyle.
import { matchesComplex } from './selectors.js';

const STATE_ATTR = { disabled: ['[disabled]'], enabled: ['[disabled]'], checked: ['[checked]'], 'read-only': ['[readonly]'], 'read-write': ['[readonly]'], required: ['[required]'], optional: ['[required]'], link: ['[href]'], 'any-link': ['[href]'] };
const STATE = new Set(['hover', 'active', 'focus', 'focus-visible', 'focus-within', 'checked', 'disabled', 'enabled', 'target', 'read-only', 'read-write', 'placeholder-shown', 'required', 'optional', 'visited', 'link', 'any-link', 'indeterminate', 'default', 'valid', 'invalid', 'modal', 'popover-open', 'fullscreen', 'user-invalid', 'in-range', 'out-of-range']);
const STRUCT_CAT = { 'first-child': ['first'], 'only-child': ['first', 'last'], 'first-of-type': ['first'], 'only-of-type': ['first', 'last'], 'last-child': ['last'], 'last-of-type': ['last'], 'nth-child': ['nth'], 'nth-of-type': ['nth'], 'nth-last-child': ['nthLast'], 'nth-last-of-type': ['nthLast'], empty: ['empty'] };
const LOGICAL = new Set(['not', 'is', 'where', 'matches', '-webkit-any', 'any']);

export function elementKeys(el) {
	const keys = new Set(); keys.add('T:' + el.localName); const id = el.getAttribute('id'); if (id) { keys.add('#' + id); } for (const c of el.classes()) { keys.add('.' + c); } for (const n of el.__attrs.keys()) { keys.add('[' + n + ']'); } return keys;
}
const intersects = (a, b) => { const [s, l] = a.size < b.size ? [a, b] : [b, a]; for (const k of s) { if (l.has(k)) { return true; } } return false; };
const keysOfCompound = (c) => { const k = []; for (const cl of c.classes) { k.push('.' + cl); } if (c.id) { k.push('#' + c.id); } for (const a of c.attrs) { k.push('[' + a.name + ']'); } for (const p of c.pseudos) { if (STATE.has(p.name)) { k.push(':' + p.name); for (const a of STATE_ATTR[p.name] || []) { k.push(a); } } } return k; };

/** Analyses the active rules once per rule-set change: which keys occur as ancestor context, as sibling context, inside :has(), and which structural pseudo-classes are used. */
export function analyzeIndex(index) {
	const inv = { ctxKeys: new Set(), sibKeys: new Set(), sibKeysDeep: new Set(), sibUniversal: false, selfStateKeys: new Set(), hasRules: [], struct: { first: { any: false, left: false }, last: { any: false, left: false }, nth: { any: false, left: false }, nthLast: { any: false, left: false }, empty: { any: false, left: false } }, entries: 0 };
	const all = [...index.byId.values(), ...index.byClass.values(), ...index.byTag.values(), index.universal].flat(); inv.entries = all.length; const seen = new Set();
	const scanCompoundPseudos = (c, left, followedBySibling, tailHasDesc, forced) => {
		for (const p of c.pseudos) {
			const cats = STRUCT_CAT[p.name]; if (cats) { for (const cat of cats) { inv.struct[cat].any = true; if (left || forced) { inv.struct[cat].left = true; } } }
			if (p.name === 'has' && Array.isArray(p.arg)) {
				for (const a of p.arg) { const argKeys = new Set(); let universal = false; scanArg(a, argKeys, () => { universal = true; }); inv.hasRules.push({ hostClasses: c.classes.slice(), hostId: c.id, hostAttrs: c.attrs.map(x => x.name), hostTag: c.tag, argKeys, argUniversal: universal, left: left || forced }); scanComplex(a, true); }
			} else if ((LOGICAL.has(p.name) || p.name.startsWith('nth-')) && p.arg) {
				const list = Array.isArray(p.arg) ? p.arg : p.arg.of; if (list) { for (const a of list) { scanComplex(a, left || forced, true); } } if (p.arg && p.arg.of) { inv.sibUniversal = true; }
			}
		}
	};
	const scanArg = (complex, keys, onUniversal) => { for (const part of complex.parts) { const c = part.compound; const ks = keysOfCompound(c); for (const k of ks) { keys.add(k); } if (c.tag) { keys.add('T:' + c.tag); } if (!ks.length && !c.tag) { onUniversal(); } for (const p of c.pseudos) { if (Array.isArray(p.arg)) { for (const a of p.arg) { scanArg(a, keys, onUniversal); } } else if (p.arg && p.arg.of) { for (const a of p.arg.of) { scanArg(a, keys, onUniversal); } } } } };
	const scanComplex = (complex, forced, nested) => {
		const parts = complex.parts, n = parts.length;
		for (let i = 0; i < n; i++) {
			const c = parts[i].compound; const left = i < n - 1 || forced; const nextComb = i < n - 1 ? parts[i + 1].comb : null; const followedBySibling = nextComb === '+' || nextComb === '~'; const keys = keysOfCompound(c);
			const tailHasDesc = followedBySibling && parts.slice(i + 2).some(p => p.comb === ' ' || p.comb === '>');
			if (left) { if (followedBySibling) { const target = tailHasDesc || forced ? inv.sibKeysDeep : inv.sibKeys; for (const k of keys) { target.add(k); } if (!keys.length) { inv.sibUniversal = true; } } if (!followedBySibling || forced) { for (const k of keys) { inv.ctxKeys.add(k); } } }
			else { for (const k of keys) { if (k[0] === ':') { inv.selfStateKeys.add(k); } } }
			if (forced && nested) { for (const k of keys) { inv.ctxKeys.add(k); } }
			scanCompoundPseudos(c, left, followedBySibling, tailHasDesc, forced);
		}
	};
	for (const e of all) { if (seen.has(e.complex)) { continue; } seen.add(e.complex); scanComplex(e.complex, false, false); }
	return inv;
}

/** The analyses of two rule sets combined: cached styles were computed with the old rules, new styles will be computed with the new ones, so an invalidation must consider both. */
export function mergeInv(a, b) {
	const u = (x, y) => new Set([...x, ...y]); const struct = {}; for (const k of Object.keys(a.struct)) { struct[k] = { any: a.struct[k].any || b.struct[k].any, left: a.struct[k].left || b.struct[k].left }; }
	return { ctxKeys: u(a.ctxKeys, b.ctxKeys), sibKeys: u(a.sibKeys, b.sibKeys), sibKeysDeep: u(a.sibKeysDeep, b.sibKeysDeep), sibUniversal: a.sibUniversal || b.sibUniversal, selfStateKeys: u(a.selfStateKeys, b.selfStateKeys), hasRules: a.hasRules.concat(b.hasRules), struct, entries: a.entries + b.entries };
}

/** Entries of `index` as a Map(decls -> Set(complex)) used to find the rules that differ between two rule sets. */
function signature(index) { const m = new Map(); for (const e of [...index.byId.values(), ...index.byClass.values(), ...index.byTag.values(), index.universal].flat()) { let s = m.get(e.decls); if (!s) { s = new Set(); m.set(e.decls, s); } s.add(e.complex); } return m; }
const bucketize = (entries) => { const byId = new Map(), byClass = new Map(), byTag = new Map(), universal = []; const push = (m, k, e) => { const l = m.get(k); if (l) { l.push(e); } else { m.set(k, [e]); } }; for (const e of entries) { const c = e.complex.parts[e.complex.parts.length - 1].compound; if (c.id) { push(byId, c.id, e); } else if (c.classes.length) { push(byClass, c.classes[0], e); } else if (c.tag) { push(byTag, c.tag, e); } else { universal.push(e); } } return { byId, byClass, byTag, universal }; };
/** The rules that were added to or removed from the active set between two indexes (null when the difference is too large to be worth analysing). */
export function diffIndex(oldIndex, newIndex, limit = 3000) {
	const a = signature(oldIndex), b = signature(newIndex); const changed = []; const all = (idx) => [...idx.byId.values(), ...idx.byClass.values(), ...idx.byTag.values(), idx.universal].flat();
	for (const e of all(newIndex)) { const s = a.get(e.decls); if (!s || !s.has(e.complex)) { changed.push(e); } } for (const e of all(oldIndex)) { const s = b.get(e.decls); if (!s || !s.has(e.complex)) { changed.push(e); } }
	if (changed.length > limit) { return null; }
	// the cascade also depends on the order of the rules: if rules present in both sets changed their relative order (a stylesheet was moved), everything may differ
	const ordered = (idx, other) => { const seq = []; let last = null; for (const e of all(idx).sort((x, y) => x.order - y.order)) { if (other.has(e.decls) && e.decls !== last) { seq.push(e.decls); last = e.decls; } } return seq; };
	const so = ordered(oldIndex, b), sn = ordered(newIndex, a); if (so.length !== sn.length) { return null; } for (let i = 0; i < so.length; i++) { if (so[i] !== sn[i]) { return null; } }
	return bucketize(changed);
}
/** Whether any entry of a changed-rules bucket set can match `el` (the subject compound only: pseudo-element rules act on their host element). */
export function matchesDelta(el, delta) {
	const test = (list) => { if (list) { for (const e of list) { if (matchesComplex(el, e.complex)) { return true; } } } return false; };
	const id = el.getAttribute('id'); if (id && test(delta.byId.get(id))) { return true; } for (const c of el.classes()) { if (test(delta.byClass.get(c))) { return true; } } return test(delta.byTag.get(el.localName)) || test(delta.universal);
}

const isSheetEl = (n) => n.nodeType === 1 && (n.localName === 'style' || n.localName === 'link');
const containsSheet = (n) => { if (n.nodeType !== 1) { return false; } if (isSheetEl(n)) { return true; } for (const c of n.__children) { if (containsSheet(c)) { return true; } } return false; };
/** True when the log contains a change to a stylesheet-bearing element (a <style>/<link> inserted, removed, re-texted or with changed attributes). */
export function logTouchesSheets(log) {
	for (const [, what, node, arg] of log) {
		if (what === 'ins' || what === 'rem') { if (containsSheet(arg)) { return true; } }
		else if (what === 'text') { const p = node.parentNode; if (p && isSheetEl(p)) { return true; } }
		else if (what === 'attr' && isSheetEl(node)) { return true; }
	}
	return false;
}

const elementChildren = (p) => p.__children.filter(c => c.nodeType === 1);
function connected(n) { return n.isConnected; }
/**
 * Plans an incremental restyle. Returns { marks: Map(element -> level) } or { full: reason } when an incremental pass is not possible or not worthwhile.
 * `delta` (optional) holds the rules added to/removed from the active set, which are matched against every connected element.
 */
export function planRestyle(doc, log, inv, delta, total) {
	if (doc.__logOverflow) { return { full: 'mutation log overflow' }; }
	const marks = new Map(); const mark = (el, lvl) => { if (el && el.nodeType === 1 && (marks.get(el) || 0) < lvl) { marks.set(el, lvl); } };
	const markFollowing = (el, lvl) => { const p = el.parentNode; if (!p) { return; } let after = false; for (const c of p.__children) { if (c === el) { after = true; } else if (after && c.nodeType === 1) { mark(c, lvl); } } };
	const markAncestors = (el, lvl) => { for (let a = el; a && a.nodeType === 1; a = a.parentNode) { mark(a, lvl); } };
	// :has(): rules whose argument keys intersect `keys` may change the match of any ancestor that satisfies the rule's host compound
	const hostMatches = (h, a) => { if (h.hostTag && a.localName !== h.hostTag) { return false; } if (h.hostId && a.getAttribute('id') !== h.hostId) { return false; } if (h.hostClasses.length) { const cl = a.classes(); for (const c of h.hostClasses) { if (!cl.includes(c)) { return false; } } } for (const n of h.hostAttrs) { if (!a.hasAttribute(n)) { return false; } } return true; };
	const touchHas = (from, keys) => { for (const h of inv.hasRules) { if (h.argUniversal || intersects(h.argKeys, keys)) { for (let a = from; a && a.nodeType === 1; a = a.parentNode) { if (hostMatches(h, a)) { mark(a, h.left ? 3 : 2); } } } } };

	if (delta) { const walk = (el) => { if (matchesDelta(el, delta)) { mark(el, 2); } for (const c of el.__children) { if (c.nodeType === 1) { walk(c); } } }; if (doc.documentElement) { walk(doc.documentElement); } }

	// ---- attribute changes: compare the value before the first change in this window with the current one
	const firstOld = new Map(); const parents = new Map();
	for (const [, what, node, arg, extra] of log) {
		if (what === 'attr') { let m = firstOld.get(node); if (!m) { m = new Map(); firstOld.set(node, m); } if (!m.has(arg)) { m.set(arg, extra); } }
		else if (what === 'ins' || what === 'rem') { let r = parents.get(node); if (!r) { r = { min: Infinity, max: -1, nodes: [] }; parents.set(node, r); } const i = extra ?? 0; r.min = Math.min(r.min, i); r.max = Math.max(r.max, i); r.nodes.push(arg); }
	}
	for (const [el, attrs] of firstOld) {
		if (!connected(el)) { continue; } mark(el, 2); const touched = new Set();
		for (const [name, old] of attrs) {
			if (name === 'class') { const o = (old || '').split(/\s+/).filter(Boolean), nw = el.classes(); for (const c of o) { if (!nw.includes(c)) { touched.add('.' + c); } } for (const c of nw) { if (!o.includes(c)) { touched.add('.' + c); } } }
			else if (name === 'id') { if (old) { touched.add('#' + old); } const nid = el.getAttribute('id'); if (nid) { touched.add('#' + nid); } if (old !== nid) { touched.add('[id]'); } }
			else { touched.add('[' + name + ']'); }
		}
		if (!touched.size) { continue; }
		let ctx = false, sib = false, sibDeep = false; for (const k of touched) { if (inv.ctxKeys.has(k)) { ctx = true; } if (inv.sibKeys.has(k)) { sib = true; } if (inv.sibKeysDeep.has(k)) { sibDeep = true; } }
		if (ctx) { mark(el, 3); } if (sibDeep) { markFollowing(el, 3); } else if (sib) { markFollowing(el, 2); }
		if (inv.hasRules.length) { touchHas(el.parentNode, touched); }
	}
	// ---- insertions and removals, per parent
	for (const [P, r] of parents) {
		if (!connected(P) && P.nodeType !== 9) { continue; }
		const kids = P.nodeType === 1 ? elementChildren(P) : []; const pos = new Map(); if (P.nodeType === 1 && kids.length > 2) { P.__children.forEach((c, i) => pos.set(c, i)); }
		const posOf = (k) => pos.has(k) ? pos.get(k) : P.__children.indexOf(k);
		for (const X of r.nodes) { if (X.nodeType === 1 && connected(X)) { mark(X, 3); } }
		if (P.nodeType !== 1) { continue; }
		const S = inv.struct; const at = (arr, lvl) => { for (const k of arr) { mark(k, lvl); } };
		if (S.empty.any) { mark(P, S.empty.left ? 3 : 2); }
		if (S.first.any) { at(kids.slice(0, 2), S.first.left ? 3 : 2); } if (S.last.any) { at(kids.slice(-2), S.last.left ? 3 : 2); }
		if (S.nth.any) { at(kids.filter(k => posOf(k) >= r.min - 1), S.nth.left ? 3 : 2); }
		if (S.nthLast.any) { at(kids.filter(k => posOf(k) <= r.max + 1), S.nthLast.left ? 3 : 2); }
		if (inv.sibUniversal || inv.sibKeys.size || inv.sibKeysDeep.size) {
			for (const X of r.nodes) { if (X.nodeType !== 1) { continue; } const ks = elementKeys(X); const deep = intersects(ks, inv.sibKeysDeep); if (inv.sibUniversal || deep || intersects(ks, inv.sibKeys)) { const lvl = deep || inv.sibUniversal ? 3 : 2; at(kids.filter(k => posOf(k) >= r.min - 1), lvl); break; } }
		}
		if (inv.hasRules.length) { const keys = new Set(); const collect = (n) => { if (n.nodeType !== 1) { return; } for (const k of elementKeys(n)) { keys.add(k); } for (const c of n.__children) { collect(c); } }; for (const X of r.nodes) { collect(X); } if (keys.size) { touchHas(P, keys); } }
	}
	// ---- text changes only matter for :empty
	for (const [, what, node] of log) { if (what === 'text' && inv.struct.empty.any) { const p = node.parentNode; if (p && p.nodeType === 1 && connected(p)) { mark(p, inv.struct.empty.left ? 3 : 2); } } }
	// ---- focus: compare the focus chain (active element and its ancestors) of the previous style pass with the current one; the log cannot say where a removed element used to be
	const activeNow = doc.__activeElement && doc.__activeElement.isConnected ? doc.__activeElement : null; const chainBefore = doc.__styledChain || [];
	if ((doc.__styledActive || null) !== activeNow) {
		const chainNow = []; for (let a = activeNow; a && a.nodeType === 1; a = a.parentNode) { chainNow.push(a); } const setBefore = new Set(chainBefore), setNow = new Set(chainNow); const focusEls = new Set([doc.__styledActive, activeNow]);
		for (const el of [...chainBefore, ...chainNow]) {
			if (!connected(el) || (setBefore.has(el) && setNow.has(el) && !focusEls.has(el))) { continue; }
			const keys = focusEls.has(el) ? [':focus', ':focus-visible', ':focus-within'] : [':focus-within']; mark(el, 2);
			for (const k of keys) { if (inv.ctxKeys.has(k)) { mark(el, 3); } if (inv.sibKeys.has(k) || inv.sibKeysDeep.has(k)) { markFollowing(el, inv.sibKeysDeep.has(k) ? 3 : 2); } }
			if (inv.hasRules.length) { touchHas(el.parentNode, new Set(keys)); }
		}
	}
	// ---- other state changes
	for (const [, what, node, arg] of log) {
		if (what !== 'state' || arg === 'focus' || !connected(node)) { continue; }
		const k = ':' + arg; mark(node, 2); if (inv.ctxKeys.has(k)) { mark(node, 3); } if (inv.sibKeys.has(k) || inv.sibKeysDeep.has(k)) { markFollowing(node, inv.sibKeysDeep.has(k) ? 3 : 2); } if (inv.hasRules.length) { touchHas(node.parentNode, new Set([k])); }
	}
	if (marks.size > total * 0.4) { return { full: `too many dirty elements (${marks.size} of ${total})` }; }
	return { marks };
}

const eq = (a, b) => { if (a === b) { return true; } if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) { return false; } if (Array.isArray(a) !== Array.isArray(b)) { return false; } const ka = Object.keys(a), kb = Object.keys(b); if (ka.length !== kb.length) { return false; } for (const k of ka) { if (!eq(a[k], b[k])) { return false; } } return true; };
export const deepEqual = eq;
/** Did anything a child can inherit change? (inherited properties and custom properties) */
export function inheritedChanged(oldCS, newCS, INH) {
	if (!oldCS) { return true; } if (oldCS.vars !== newCS.vars) { if (oldCS.vars.size !== newCS.vars.size) { return true; } for (const [k, v] of newCS.vars) { if (oldCS.vars.get(k) !== v) { return true; } } }
	for (const k of INH) { if (!eq(oldCS.values[k], newCS.values[k])) { return true; } } return false;
}
