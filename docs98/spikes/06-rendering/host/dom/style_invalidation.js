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
import { baseEntriesOf, varsEqual } from './css.js';

const STATE_ATTR = { disabled: ['[disabled]'], enabled: ['[disabled]'], checked: ['[checked]'], 'read-only': ['[readonly]'], 'read-write': ['[readonly]'], required: ['[required]'], optional: ['[required]'], link: ['[href]'], 'any-link': ['[href]'] };
const STATE = new Set(['hover', 'active', 'focus', 'focus-visible', 'focus-within', 'checked', 'disabled', 'enabled', 'target', 'read-only', 'read-write', 'placeholder-shown', 'required', 'optional', 'visited', 'link', 'any-link', 'indeterminate', 'default', 'valid', 'invalid', 'modal', 'popover-open', 'fullscreen', 'user-invalid', 'in-range', 'out-of-range']);
const STRUCT_CAT = { 'first-child': ['first'], 'only-child': ['first', 'last'], 'first-of-type': ['first'], 'only-of-type': ['first', 'last'], 'last-child': ['last'], 'last-of-type': ['last'], 'nth-child': ['nth'], 'nth-of-type': ['nth'], 'nth-last-child': ['nthLast'], 'nth-last-of-type': ['nthLast'], empty: ['empty'] };
const LOGICAL = new Set(['not', 'is', 'where', 'matches', '-webkit-any', 'any']);

export function elementKeys(el) {
	const keys = new Set(); keys.add('T:' + el.localName); const id = el.getAttribute('id'); if (id) { keys.add('#' + id); } for (const c of el.classes()) { keys.add('.' + c); } for (const n of el.__attrs.keys()) { keys.add('[' + n + ']'); } return keys;
}
const intersects = (a, b) => { const [s, l] = a.size < b.size ? [a, b] : [b, a]; for (const k of s) { if (l.has(k)) { return true; } } return false; };
const keysOfCompound = (c) => { const k = []; for (const cl of c.classes) { k.push('.' + cl); } if (c.id) { k.push('#' + c.id); } for (const a of c.attrs) { k.push('[' + a.name + ']'); } for (const p of c.pseudos) { if (STATE.has(p.name)) { k.push(':' + p.name); for (const a of STATE_ATTR[p.name] || []) { k.push(a); } } } return k; };

/** The part of a compound that does not depend on state or position (tag, id, classes, attribute names): an element lacking any of them cannot match the compound whatever its state. null = matches anything. */
const IS_LIKE = new Set(['is', 'where', 'matches', '-webkit-any', 'any']);
const shapeOf = (c, outer, parent, anc) => {
	const par = parent || (outer && outer.parent) || null; const an = anc || (outer && outer.anc) || null;
	const sh = { parent: par, anc: an, tag: c.tag || (outer && outer.tag) || null, id: c.id || (outer && outer.id) || null, classes: c.classes.concat(outer ? outer.classes : []), attrs: c.attrs.map(a => a.name).concat(outer ? outer.attrs : []), anyOf: outer ? outer.anyOf.slice() : [] };
	for (const p of c.pseudos) { if (IS_LIKE.has(p.name) && Array.isArray(p.arg)) { const alt = p.arg.map(cx => shapeOf(cx.parts[cx.parts.length - 1].compound, null)); if (!alt.includes(null)) { sh.anyOf.push(alt); } } }
	return (par || an || sh.tag || sh.id || sh.classes.length || sh.attrs.length || sh.anyOf.length) ? sh : null;
};
/** Can `el` match a compound of shape `sh` (not null)? */
function shapeMatch(sh, el) {
	if (sh.anc) { let a = el.parentNode; while (a && a.nodeType === 1 && !shapeMatch(sh.anc, a)) { a = a.parentNode; } if (!a || a.nodeType !== 1) { return false; } }
	if (sh.parent) { const p = el.parentNode; if (!p || p.nodeType !== 1 || !shapeMatch(sh.parent, p)) { return false; } }
	if (sh.tag && el.localName !== sh.tag && el.localName.toLowerCase() !== sh.tag) { return false; } if (sh.id && el.getAttribute('id') !== sh.id) { return false; }
	if (sh.classes.length) { const cl = el.classes(); if (!sh.classes.every(c => cl.includes(c))) { return false; } } if (sh.attrs.length && !sh.attrs.every(n => el.__attrs.has(n))) { return false; }
	return sh.anyOf.every(alt => alt.some(a => shapeMatch(a, el)));
}
/**
 * Can `el` match a compound of one of `shapes` (a list of shapeOf() results; undefined or containing null = anything)? The lists get long (hundreds of shapes), so they are indexed once by the
 * most selective thing a shape requires (id, first class, tag; the others stay in a "rest" list); an element can only match a shape whose key it has. The index is kept on the array
 * and extended when shapes were appended.
 */
function shapesMatch(shapes, el) {
	if (!shapes) { return true; }
	let ix = shapes.__six; if (ix === undefined || ix.n !== shapes.length) { ix = indexShapes(shapes, ix); }
	if (ix.any) { return true; }
	for (const sh of ix.rest) { if (shapeMatch(sh, el)) { return true; } }
	const id = el.getAttribute('id'); if (id) { const l = ix.byId.get(id); if (l) { for (const sh of l) { if (shapeMatch(sh, el)) { return true; } } } }
	const cl = el.classes(); for (let i = 0; i < cl.length; i++) { const l = ix.byClass.get(cl[i]); if (l) { for (const sh of l) { if (shapeMatch(sh, el)) { return true; } } } }
	const l = ix.byTag.get(el.localName); if (l) { for (const sh of l) { if (shapeMatch(sh, el)) { return true; } } }
	return false;
}
function indexShapes(shapes, prev) {
	const ix = prev || { n: 0, any: false, rest: [], byId: new Map(), byClass: new Map(), byTag: new Map() };
	const put = (m, k, sh) => { const l = m.get(k); if (l) { l.push(sh); } else { m.set(k, [sh]); } };
	for (let i = ix.n; i < shapes.length; i++) { const sh = shapes[i]; if (!sh) { ix.any = true; } else if (sh.id) { put(ix.byId, sh.id, sh); } else if (sh.classes.length) { put(ix.byClass, sh.classes[0], sh); } else if (sh.tag) { put(ix.byTag, sh.tag, sh); } else { ix.rest.push(sh); } }
	ix.n = shapes.length; Object.defineProperty(shapes, '__six', { value: ix, writable: true, configurable: true, enumerable: false }); return ix;
}
/** Whether a change of state/structure `key` of `el` can change how its descendants match (the key is context somewhere, in a compound `el` can satisfy). */
const ctxHit = (inv, key, el) => inv.ctxKeys.has(key) && shapesMatch(inv.ctxShapes.get(key), el);

/** Analyses the active rules once per rule-set change: which keys occur as ancestor context, as sibling context, inside :has(), and which structural pseudo-classes are used. */
export function analyzeIndex(index, prev, only) {
	const fresh = { ctxKeys: new Set(), ctxShapes: new Map(), sibKeys: new Set(), sibKeysDeep: new Set(), sibUniversal: false, sibUniShapes: [], sibAllKeys: new Set(), adj: 0, adjChain: false, selfStateKeys: new Set(), hasRules: [], struct: { first: { any: false, left: false, shapes: [], sib: 0, sibShapes: [] }, last: { any: false, left: false, shapes: [], sib: 0, sibShapes: [] }, nth: { any: false, left: false, shapes: [], sib: 0, sibShapes: [] }, nthLast: { any: false, left: false, shapes: [], sib: 0, sibShapes: [] }, empty: { any: false, left: false, shapes: [], sib: 0, sibShapes: [] } }, entries: 0 };
	const all = only || [...index.byId.values(), ...index.byClass.values(), ...index.byTag.values(), index.universal].flat();   // `only`: just the entries that were added to `prev`'s index
	// the analysis only ever grows (a key or shape that was context once stays context), so a rule-set change scans just the rules not seen before; it starts over when most of what it remembers is gone
	const inv = prev && prev.__seen && (only || prev.__seen.size <= 2 * all.length + 2000) ? prev : Object.defineProperty(fresh, '__seen', { value: new Set() }); inv.entries = only ? index.count : all.length; const seen = inv.__seen;
	const scanCompoundPseudos = (c, left, eff, forced, shape) => {
		for (const p of c.pseudos) {
			const cats = STRUCT_CAT[p.name]; if (cats) { for (const cat of cats) { inv.struct[cat].any = true; if (left || forced) { inv.struct[cat].left = true; inv.struct[cat].shapes.push(shape); } if (eff) { inv.struct[cat].sib = Math.max(inv.struct[cat].sib, eff); inv.struct[cat].sibShapes.push(shape); } } }
			if (p.name === 'has' && Array.isArray(p.arg)) {
				for (const a of p.arg) { const argKeys = new Set(); let universal = false; scanArg(a, argKeys, () => { universal = true; }); inv.hasRules.push({ hostClasses: c.classes.slice(), hostId: c.id, hostAttrs: c.attrs.map(x => x.name), hostTag: c.tag, argKeys, argUniversal: universal, left: left || forced, sib: eff }); scanComplex(a, true, false, eff); }
			} else if ((LOGICAL.has(p.name) || p.name.startsWith('nth-')) && p.arg) {
				const list = Array.isArray(p.arg) ? p.arg : p.arg.of; if (list) { for (const a of list) { scanComplex(a, left || forced, true, eff, shape); } } if (p.arg && p.arg.of) { inv.sibUniversal = true; inv.sibUniShapes.push(shape); for (const a of p.arg.of) { scanArg(a, inv.sibAllKeys, () => { }); } }
			}
		}
	};
	const scanArg = (complex, keys, onUniversal) => { for (const part of complex.parts) { const c = part.compound; const ks = keysOfCompound(c); for (const k of ks) { keys.add(k); } if (c.tag) { keys.add('T:' + c.tag); } if (!ks.length && !c.tag) { onUniversal(); } for (const p of c.pseudos) { if (Array.isArray(p.arg)) { for (const a of p.arg) { scanArg(a, keys, onUniversal); } } else if (p.arg && p.arg.of) { for (const a of p.arg.of) { scanArg(a, keys, onUniversal); } } } } };
	const scanComplex = (complex, forced, nested, sibMode = 0, outer = null) => {
		const parts = complex.parts, n = parts.length;
		for (let i = 0; i < n; i++) {
			if (i > 0 && parts[i].comb === '+') { inv.adj = Math.max(inv.adj, forced || parts.slice(i + 1).some(q => q.comb === ' ' || q.comb === '>') ? 3 : 2); if (parts.slice(i + 1).some(q => q.comb === '+' || q.comb === '~')) { inv.adjChain = true; } }
			const c = parts[i].compound; const left = i < n - 1 || forced; const nextComb = i < n - 1 ? parts[i + 1].comb : null; const followedBySibling = nextComb === '+' || nextComb === '~'; const keys = keysOfCompound(c);
			// the compound's shape is only needed for state keys in context and for its pseudo-classes: built on first use (building it for every compound of every rule was most of the analysis)
			let shape, hasShape = false; const shapeNow = () => { if (!hasShape) { shape = shapeOf(c, i === n - 1 ? outer : null, i > 0 && parts[i].comb === '>' ? shapeOf(parts[i - 1].compound, null) : null, i > 0 && parts[i].comb === ' ' ? shapeOf(parts[i - 1].compound, null) : null); hasShape = true; } return shape; };
			const addCtx = (k) => { inv.ctxKeys.add(k); if (k[0] === ':') { const l = inv.ctxShapes.get(k); if (l) { l.push(shapeNow()); } else { inv.ctxShapes.set(k, [shapeNow()]); } } };
			const tailHasDesc = followedBySibling && parts.slice(i + 2).some(p => p.comb === ' ' || p.comb === '>'); let inRun = i === n - 1; for (let j = i; !inRun && j + 1 < n && (parts[j + 1].comb === '+' || parts[j + 1].comb === '~'); j++) { inRun = j + 1 === n - 1; }
			const own = followedBySibling ? (tailHasDesc || forced ? 3 : 2) : 0; const eff = Math.max(own, inRun ? sibMode : 0);
			if (left) { if (eff) { const target = eff === 3 ? inv.sibKeysDeep : inv.sibKeys; for (const k of keys) { target.add(k); } if (!keys.length && own) { inv.sibUniversal = true; { const rp = i > 0 && parts[i].comb === '>' ? shapeOf(parts[i - 1].compound, null) : null, ra = i > 0 && parts[i].comb === ' ' ? shapeOf(parts[i - 1].compound, null) : null; for (let j = i + 1; j < n; j++) { inv.sibUniShapes.push(shapeOf(parts[j].compound, j === n - 1 ? outer : null, rp, ra)); if (parts[j + 1] === undefined || (parts[j + 1].comb !== '+' && parts[j + 1].comb !== '~')) { break; } } } } } if (!eff || forced) { for (const k of keys) { addCtx(k); } } }
			else { for (const k of keys) { if (k[0] === ':') { inv.selfStateKeys.add(k); } } }
			if (forced && nested) { for (const k of keys) { addCtx(k); } }
			if (c.pseudos.length) { scanCompoundPseudos(c, left, eff, forced, shapeNow()); }
		}
	};
	for (const e of all) { if (seen.has(e.complex)) { continue; } seen.add(e.complex); scanComplex(e.complex, false, false); }
	return inv;
}

/** The analyses of two rule sets combined: cached styles were computed with the old rules, new styles will be computed with the new ones, so an invalidation must consider both. */
export function mergeInv(a, b) {
	const u = (x, y) => new Set([...x, ...y]); const struct = {}; for (const k of Object.keys(a.struct)) { struct[k] = { any: a.struct[k].any || b.struct[k].any, left: a.struct[k].left || b.struct[k].left, shapes: a.struct[k].shapes.concat(b.struct[k].shapes), sib: Math.max(a.struct[k].sib, b.struct[k].sib), sibShapes: a.struct[k].sibShapes.concat(b.struct[k].sibShapes) }; }
	const ctxShapes = new Map(a.ctxShapes); for (const [k, l] of b.ctxShapes) { ctxShapes.set(k, (ctxShapes.get(k) || []).concat(l)); }
	return { ctxKeys: u(a.ctxKeys, b.ctxKeys), ctxShapes, sibKeys: u(a.sibKeys, b.sibKeys), sibKeysDeep: u(a.sibKeysDeep, b.sibKeysDeep), sibUniversal: a.sibUniversal || b.sibUniversal, sibUniShapes: a.sibUniShapes.concat(b.sibUniShapes), sibAllKeys: u(a.sibAllKeys, b.sibAllKeys), adj: Math.max(a.adj, b.adj), adjChain: a.adjChain || b.adjChain, selfStateKeys: u(a.selfStateKeys, b.selfStateKeys), hasRules: a.hasRules.concat(b.hasRules), struct, entries: a.entries + b.entries };
}

/** Entries of `index` as a Map(decls -> Set(complex)) used to find the rules that differ between two rule sets. */
const bucketize = (entries) => { const byId = new Map(), byClass = new Map(), byTag = new Map(), universal = []; const push = (m, k, e) => { const l = m.get(k); if (l) { l.push(e); } else { m.set(k, [e]); } }; for (const e of entries) { const c = e.complex.parts[e.complex.parts.length - 1].compound; if (c.id) { push(byId, c.id, e); } else if (c.classes.length) { push(byClass, c.classes[0], e); } else if (c.tag) { push(byTag, c.tag, e); } else { universal.push(e); } } return { byId, byClass, byTag, universal }; };
/**
 * The rules that were added to or removed from the active set between two indexes (null when the difference is too large to be worth analysing). Rules are compared by identity: the rule
 * objects of an unchanged stylesheet are the same in both builds, a rule whose declarations were replaced counts as removed and added (its selectors are the same objects), a rule whose
 * selector text changed or moved relative to the others sends the whole restyle down the full path.
 */
export function diffIndex(oldIndex, newIndex, limit = 3000) {
	const oldPos = new Map(); const orules = oldIndex.rules; for (let i = 0; i < orules.length; i++) { oldPos.set(orules[i], i); }
	const nrules = newIndex.rules; const changed = []; let last = -1; let kept = 0; const seen = new Set();
	const add = (rule) => { for (const b of baseEntriesOf(rule)) { changed.push({ complex: b.complex, decls: b.decls }); } };
	for (let i = 0; i < nrules.length; i++) {
		const r = nrules[i]; const p = oldPos.get(r);
		if (p === undefined) { add(r); }
		else {
			if (p < last) { return null; }   // the cascade also depends on the order of the rules: rules present in both sets changed their relative order (a stylesheet was moved)
			last = p; kept++; seen.add(p);
			if (oldIndex.sels[p] !== newIndex.sels[i]) { return null; } if (oldIndex.decls[p] !== newIndex.decls[i]) { add(r); }
		}
		if (changed.length > limit) { return null; }
	}
	if (kept !== orules.length) { for (let p = 0; p < orules.length; p++) { if (!seen.has(p)) { add(orules[p]); } } }
	if (changed.length > limit) { return null; }
	return bucketize(changed);
}
/** The delta (as diffIndex returns it) for an in-place update of an index (rules added and removed); null when there are too many. */
export function deltaOfUpdate(update, limit = 3000) {
	const changed = []; for (const list of [update.addedRules, update.removedRules]) { for (const rule of list) { for (const b of baseEntriesOf(rule)) { changed.push({ complex: b.complex, decls: b.decls }); } } }
	return changed.length > limit ? null : bucketize(changed);
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
	const marks = new Map(); const dbg = globalThis.__styleDebug ? new Map() : null; let why = ''; const mark = (el, lvl) => { if (el && el.nodeType === 1 && (marks.get(el) || 0) < lvl) { marks.set(el, lvl); if (dbg) { dbg.set(el, why); } } };
	const markFollowing = (el, lvl) => { const p = el.parentNode; if (!p) { return; } let after = false; for (const c of p.__children) { if (c === el) { after = true; } else if (after && c.nodeType === 1) { mark(c, lvl); } } };
	// `:nth-child(n of S)`: whether a sibling matches S changes the position of the others, before and after it
	const markSiblingsAll = (el) => { const p = el.parentNode; if (!p || p.nodeType !== 1) { return; } for (const k of p.__children) { if (k.nodeType === 1 && shapesMatch(inv.sibUniShapes, k)) { mark(k, 3); } } };
	const markAncestors = (el, lvl) => { for (let a = el; a && a.nodeType === 1; a = a.parentNode) { mark(a, lvl); } };
	// :has(): rules whose argument keys intersect `keys` may change the match of any ancestor that satisfies the rule's host compound
	const hostMatches = (h, a) => { if (h.hostTag && a.localName !== h.hostTag) { return false; } if (h.hostId && a.getAttribute('id') !== h.hostId) { return false; } if (h.hostClasses.length) { const cl = a.classes(); for (const c of h.hostClasses) { if (!cl.includes(c)) { return false; } } } for (const n of h.hostAttrs) { if (!a.hasAttribute(n)) { return false; } } return true; };
	const touchHas = (from, keys) => { for (const h of inv.hasRules) { if (h.argUniversal || intersects(h.argKeys, keys)) { for (let a = from; a && a.nodeType === 1; a = a.parentNode) { if (hostMatches(h, a)) { mark(a, h.left ? 3 : 2); if (h.sib) { markFollowing(a, h.sib); } } } } } };

	const at = (arr, cat) => { const S = inv.struct; why += ' [' + cat + ']'; for (const k of arr) { mark(k, S[cat].left && shapesMatch(S[cat].shapes, k) ? 3 : 2); if (S[cat].sib && shapesMatch(S[cat].sibShapes, k)) { markFollowing(k, S[cat].sib); } } };
	why = 'delta'; if (delta) { const walk = (el) => { if (matchesDelta(el, delta)) { mark(el, 2); } for (const c of el.__children) { if (c.nodeType === 1) { walk(c); } } }; if (doc.documentElement) { walk(doc.documentElement); } }

	// ---- attribute changes: compare the value before the first change in this window with the current one
	const firstOld = new Map(); const parents = new Map(); const removedFrom = new Map();
	for (const [, what, node, arg, extra] of log) {
		if (what === 'attr') { let m = firstOld.get(node); if (!m) { m = new Map(); firstOld.set(node, m); } if (!m.has(arg)) { m.set(arg, extra); } }
		else if (what === 'ins' || what === 'rem') { if (what === 'rem') { const l = removedFrom.get(node); if (l) { l.push(arg); } else { removedFrom.set(node, [arg]); } } let r = parents.get(node); if (!r) { r = { min: Infinity, max: -1, nodes: [] }; parents.set(node, r); } const i = extra ?? 0; r.min = Math.min(r.min, i); r.max = Math.max(r.max, i); r.nodes.push(arg); }
	}
	/** keys of an element now and, when its attributes changed in this window, before: a removed element mattered with its old attributes */
	const ekeys = (n) => { const ks = elementKeys(n); const fo = firstOld.get(n); if (fo) { for (const [name, old] of fo) { if (name === 'class') { for (const c of (old || '').split(/\s+/)) { if (c) { ks.add('.' + c); } } } else if (name === 'id') { if (old) { ks.add('#' + old); } } else { ks.add('[' + name + ']'); } } } return ks; };
	for (const [el, attrs] of firstOld) {
		if (!connected(el)) { continue; } mark(el, 2); const touched = new Set();
		for (const [name, old] of attrs) {
			if (name === 'class') { const o = (old || '').split(/\s+/).filter(Boolean), nw = el.classes(); for (const c of o) { if (!nw.includes(c)) { touched.add('.' + c); } } for (const c of nw) { if (!o.includes(c)) { touched.add('.' + c); } } }
			else if (name === 'id') { if (old) { touched.add('#' + old); } const nid = el.getAttribute('id'); if (nid) { touched.add('#' + nid); } if (old !== nid) { touched.add('[id]'); } }
			else { touched.add('[' + name + ']'); }
		}
		if (!touched.size) { continue; }
		why = 'attr ' + [...touched].join(' ');
		let ctx = false, sib = false, sibDeep = false; for (const k of touched) { if (inv.ctxKeys.has(k)) { ctx = true; } if (inv.sibKeys.has(k)) { sib = true; } if (inv.sibKeysDeep.has(k)) { sibDeep = true; } }
		if (inv.sibAllKeys.size && intersects(touched, inv.sibAllKeys)) { markSiblingsAll(el); }
		if (ctx) { mark(el, 3); } if (sibDeep) { markFollowing(el, 3); } else if (sib) { markFollowing(el, 2); }
		if (inv.hasRules.length) { touchHas(el.parentNode, touched); }
	}
	// ---- insertions and removals, per parent
	for (const [P, r] of parents) {
		if (!connected(P) && P.nodeType !== 9) { continue; }
		const kids = P.nodeType === 1 ? elementChildren(P) : []; const pos = new Map(); if (P.nodeType === 1 && kids.length > 2) { P.__children.forEach((c, i) => pos.set(c, i)); }
		const posOf = (k) => pos.has(k) ? pos.get(k) : P.__children.indexOf(k);
		why = 'inserted'; for (const X of r.nodes) { if (X.nodeType === 1 && connected(X)) { mark(X, 3); } }
		if (P.nodeType !== 1) { continue; }
		why = 'struct in ' + P.localName + '.' + P.getAttribute('class'); const S = inv.struct; 
		if (inv.adj) {   // `A + B`: whatever now precedes an element differs from what it preceded when it was styled
			let pe = null, changed = false; for (const k of kids) { if (changed && inv.adjChain) { mark(k, inv.adj); } else if (k.__prev !== pe) { mark(k, inv.adj); changed = true; } pe = k; }
		}
		if (S.empty.any) { at([P], 'empty'); }
		if (S.first.any || S.last.any) {
			// the elements whose first/last-child-ness can have changed: the new edge element, the inserted ones next to it, and the first untouched one behind them (the old edge)
			const ins = new Set(r.nodes); const edge = (list) => { const out = []; for (const k of list) { out.push(k); if (!ins.has(k)) { break; } } return out; };
			if (S.first.any) { const f = edge(kids); if (r.min <= posOf(f[f.length - 1])) { at(f, 'first'); } }
			if (S.last.any) { const l = edge(kids.slice().reverse()); if (r.max >= posOf(l[l.length - 1])) { at(l, 'last'); } }
		}
		if (S.nth.any) { at(kids.filter(k => posOf(k) >= r.min), 'nth'); }
		if (S.nthLast.any) { at(kids.filter(k => posOf(k) <= r.max), 'nthLast'); }
		if (inv.sibUniversal || inv.sibKeys.size || inv.sibKeysDeep.size) {
			let base = 0; for (const X of r.nodes) { if (X.nodeType !== 1) { continue; } const ks = ekeys(X); if (intersects(ks, inv.sibKeysDeep)) { base = 3; break; } if (base < 2 && intersects(ks, inv.sibKeys)) { base = 2; } }
			const uni = inv.sibUniversal && r.nodes.some(X => X.nodeType === 1);
			if (base || uni) { for (const k of kids) { if (posOf(k) >= r.min - 1) { const lvl = uni && shapesMatch(inv.sibUniShapes, k) ? 3 : base; if (lvl) { mark(k, lvl); } } } }
		}
		if (inv.hasRules.length) { const keys = new Set(); const seenN = new Set(); const collect = (n) => { if (n.nodeType !== 1 || seenN.has(n)) { return; } seenN.add(n); for (const k of ekeys(n)) { keys.add(k); } for (const c of n.__children) { collect(c); } const gone = removedFrom.get(n); /* a removed subtree also held what was removed from inside it earlier in the window */ if (gone) { for (const c of gone) { collect(c); } } }; for (const X of r.nodes) { collect(X); } if (keys.size) { touchHas(P, keys); } }
	}
	why = 'text/focus/state';
	// ---- text changes only matter for :empty
	for (const [, what, node] of log) { if (what === 'text' && inv.struct.empty.any) { const p = node.parentNode; if (p && p.nodeType === 1 && connected(p)) { at([p], 'empty'); } } }
	// ---- focus: compare the focus chain (active element and its ancestors) of the previous style pass with the current one; the log cannot say where a removed element used to be
	const activeNow = doc.__activeElement && doc.__activeElement.isConnected ? doc.__activeElement : null; const chainBefore = doc.__styledChain || [];
	const chainNow = []; for (let a = activeNow; a && a.nodeType === 1; a = a.parentNode) { chainNow.push(a); }
	if ((doc.__styledActive || null) !== activeNow || chainNow.length !== chainBefore.length || chainNow.some((e, i) => e !== chainBefore[i])) {   // also when the focused element was moved: its ancestors changed
		const setBefore = new Set(chainBefore), setNow = new Set(chainNow); const focusEls = new Set([doc.__styledActive, activeNow]);
		for (const el of [...chainBefore, ...chainNow]) {
			if (!connected(el) || (setBefore.has(el) && setNow.has(el) && !focusEls.has(el))) { continue; }
			const keys = focusEls.has(el) ? [':focus', ':focus-visible', ':focus-within'] : [':focus-within']; mark(el, 2);
			for (const k of keys) { if (ctxHit(inv, k, el)) { mark(el, 3); } if (inv.sibKeys.has(k) || inv.sibKeysDeep.has(k)) { markFollowing(el, inv.sibKeysDeep.has(k) ? 3 : 2); } }
			if (inv.sibAllKeys.size && intersects(new Set(keys), inv.sibAllKeys)) { markSiblingsAll(el); }
			if (inv.hasRules.length) { touchHas(el.parentNode, new Set(keys)); }
		}
	}
	// ---- other state changes
	for (const [, what, node, arg] of log) {
		if (what !== 'state' || arg === 'focus' || !connected(node)) { continue; }
		const k = ':' + arg; mark(node, 2); if (ctxHit(inv, k, node)) { mark(node, 3); } if (inv.sibKeys.has(k) || inv.sibKeysDeep.has(k)) { markFollowing(node, inv.sibKeysDeep.has(k) ? 3 : 2); } if (inv.sibAllKeys.has(k)) { markSiblingsAll(node); } if (inv.hasRules.length) { touchHas(node.parentNode, new Set([k])); }
	}
	if (marks.size > total * 0.4) { return { full: `too many dirty elements (${marks.size} of ${total})` }; }
	return { marks, why: dbg };
}

const eq = (a, b) => { if (a === b) { return true; } if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) { return false; } if (Array.isArray(a) !== Array.isArray(b)) { return false; } const ka = Object.keys(a), kb = Object.keys(b); if (ka.length !== kb.length) { return false; } for (const k of ka) { if (!eq(a[k], b[k])) { return false; } } return true; };
export const deepEqual = eq;
/** Did anything a child can inherit change? (inherited properties and custom properties) */
export function inheritedChanged(oldCS, newCS, INH) {
	if (!oldCS) { return true; } if (oldCS.vars !== newCS.vars && !varsEqual(newCS.vars, oldCS.vars)) { return true; }
	for (const k of INH) { if (!eq(oldCS.values[k], newCS.values[k])) { return true; } } return false;
}
