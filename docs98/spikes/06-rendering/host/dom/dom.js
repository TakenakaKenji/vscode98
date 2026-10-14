// A small DOM for the rendering spike: Node / Element / Text / Document / events / attributes / classList / inline style / innerHTML / Range / Selection stubs.
// Pure JavaScript (ES2020, no Node or browser APIs) so it runs on QuickJS-ng and, for development, on Node. Layout, style resolution and painting live in other files and
// hook in through `Document.prototype.__layout` (a function installed by env.js). Anything the editor touches that is missing is recorded in `globalThis.__missing`.
import { notifyRemoval } from './dom_extra.js';
import { selectProps, optionProps } from './selectmodel.js';
import { textProps, setEventCtors, controlFocused, controlBlurred } from './textmodel.js';
import { parseSelector, matches, closestMatch } from './selectors.js';

export const missing = (globalThis.__missing ??= new Map());
export function noteMissing(what) { missing.set(what, (missing.get(what) || 0) + 1); }

// ---- events -----------------------------------------------------------------------------------------------------------------------------------
export class Event {
	constructor(type, init = {}) { this.type = type; this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable; this.composed = !!init.composed; this.defaultPrevented = false; this.target = null; this.currentTarget = null; this.eventPhase = 0; this.timeStamp = Date.now(); this.isTrusted = false; this._stop = false; this._stopImm = false; }
	preventDefault() { if (this.cancelable) { this.defaultPrevented = true; } }
	stopPropagation() { this._stop = true; } stopImmediatePropagation() { this._stop = true; this._stopImm = true; }
	composedPath() { const p = []; for (let n = this.target; n; n = n.parentNode ?? (n.nodeType === 9 ? n.defaultView : null)) { p.push(n); } return p; }
	static NONE = 0; static CAPTURING_PHASE = 1; static AT_TARGET = 2; static BUBBLING_PHASE = 3;
}
export class UIEvent extends Event { constructor(t, i = {}) { super(t, i); this.detail = i.detail ?? 0; this.view = i.view ?? null; } }
export class MouseEvent extends UIEvent { constructor(t, i = {}) { super(t, i); Object.assign(this, { screenX: 0, screenY: 0, clientX: 0, clientY: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, button: 0, buttons: 0, relatedTarget: null, pageX: i.clientX ?? 0, pageY: i.clientY ?? 0, offsetX: 0, offsetY: 0 }, i); } }
export class PointerEvent extends MouseEvent { constructor(t, i = {}) { super(t, i); this.pointerId = i.pointerId ?? 1; this.pointerType = i.pointerType ?? 'mouse'; } }
export class WheelEvent extends MouseEvent { constructor(t, i = {}) { super(t, i); Object.assign(this, { deltaX: 0, deltaY: 0, deltaZ: 0, deltaMode: 0, wheelDelta: 0, wheelDeltaX: 0, wheelDeltaY: 0 }, i); } }
export class KeyboardEvent extends UIEvent { constructor(t, i = {}) { super(t, i); Object.assign(this, { key: '', code: '', keyCode: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, location: 0, isComposing: false }, i); } getModifierState() { return false; } }
export class FocusEvent extends UIEvent { constructor(t, i = {}) { super(t, i); this.relatedTarget = i.relatedTarget ?? null; } }
export class CustomEvent extends Event { constructor(t, i = {}) { super(t, i); this.detail = i.detail ?? null; } }
export class InputEvent extends UIEvent { constructor(t, i = {}) { super(t, i); this.data = i.data ?? null; this.inputType = i.inputType ?? ''; this.isComposing = false; } }
export class CompositionEvent extends UIEvent { constructor(t, i = {}) { super(t, i); this.data = i.data ?? ''; } }
export class ClipboardEvent extends Event { constructor(t, i = {}) { super(t, i); this.clipboardData = i.clipboardData ?? null; } }
export class DragEvent extends MouseEvent { constructor(t, i = {}) { super(t, i); this.dataTransfer = i.dataTransfer ?? null; } }
export class TouchEvent extends UIEvent { }
export class ErrorEvent extends Event { constructor(t, i = {}) { super(t, i); this.message = i.message ?? ''; this.error = i.error; } }
export class MessageEvent extends Event { constructor(t, i = {}) { super(t, i); this.data = i.data; this.origin = i.origin ?? ''; this.source = i.source ?? null; this.ports = i.ports ?? []; } }

// HTMLCollection / NodeList .item() on the plain arrays this DOM returns
for (const [name, fn] of [['item', function (i) { return this[i] ?? null; }], ['namedItem', function (n) { return this.find(e => e && (e.id === n || (e.getAttribute && e.getAttribute('name') === n))) ?? null; }]]) { if (!Array.prototype[name]) { Object.defineProperty(Array.prototype, name, { value: fn, writable: true, configurable: true, enumerable: false }); } }

export class EventTarget {
	addEventListener(type, fn, opts) { if (!fn) { return; } const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture); const once = !!(opts && opts.once); const m = (this.__l ??= new Map()); let l = m.get(type); if (!l) { l = []; m.set(type, l); } if (l.some(e => e.fn === fn && e.capture === capture)) { return; } const e = { fn, capture, once, passive: !!(opts && opts.passive) }; l.push(e); if (opts && opts.signal) { opts.signal.addEventListener('abort', () => this.removeEventListener(type, fn, opts)); } }
	removeEventListener(type, fn, opts) { const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture); const l = this.__l && this.__l.get(type); if (!l) { return; } const i = l.findIndex(e => e.fn === fn && e.capture === capture); if (i >= 0) { l.splice(i, 1); } }
	dispatchEvent(ev) {
		ev.target = ev.target || this; const path = []; for (let n = this; n; n = n.__parentForEvents()) { path.push(n); }
		const run = (node, phase) => {
			const l = node.__l && node.__l.get(ev.type); if (!l) { return; } ev.currentTarget = node; ev.eventPhase = node === ev.target ? 2 : phase;
			for (const e of l.slice()) { if (ev._stopImm) { break; } if (node !== ev.target && e.capture !== (phase === 1)) { continue; } if (e.once) { node.removeEventListener(ev.type, e.fn, e.capture); } try { typeof e.fn === 'function' ? e.fn.call(node, ev) : e.fn.handleEvent(ev); } catch (err) { reportError(err); } }
		};
		for (let i = path.length - 1; i > 0 && !ev._stop; i--) { run(path[i], 1); }
		if (!ev._stop) { run(path[0], 2); }
		if (ev.bubbles) { for (let i = 1; i < path.length && !ev._stop; i++) { run(path[i], 3); } }
		ev.currentTarget = null; ev.eventPhase = 0; return !ev.defaultPrevented;
	}
	__parentForEvents() { return null; }
}
function reportError(e) { if (globalThis.console) { console.error('[event listener error]', e && (e.stack || e.message || e)); } }

// ---- nodes ------------------------------------------------------------------------------------------------------------------------------------
let nextId = 1;
export class Node extends EventTarget {
	constructor() { super(); this.parentNode = null; this.__children = []; this.ownerDocument = null; this.__id = nextId++; }
	// `parentNode` is a plain own data property (fast: selector matching and layout read it constantly); the accessor on the prototype only exists so that code which looks it up there first (DOMPurify's lookupGetter on Element.prototype) finds a getter
	get parentNode() { const own = Object.getOwnPropertyDescriptor(this, 'parentNode'); return own ? own.value : null; } set parentNode(v) { Object.defineProperty(this, 'parentNode', { value: v, writable: true, configurable: true, enumerable: true }); }
	get nodeName() { return ({ 1: this.tagName, 3: '#text', 8: '#comment', 9: '#document', 11: '#document-fragment' })[this.nodeType] ?? ''; }
	static ELEMENT_NODE = 1; static TEXT_NODE = 3; static COMMENT_NODE = 8; static DOCUMENT_NODE = 9; static DOCUMENT_FRAGMENT_NODE = 11;
	static DOCUMENT_POSITION_DISCONNECTED = 1; static DOCUMENT_POSITION_PRECEDING = 2; static DOCUMENT_POSITION_FOLLOWING = 4; static DOCUMENT_POSITION_CONTAINS = 8; static DOCUMENT_POSITION_CONTAINED_BY = 16;
	get childNodes() { return this.__children; }
	get firstChild() { return this.__children[0] ?? null; } get lastChild() { return this.__children[this.__children.length - 1] ?? null; }
	get nextSibling() { const p = this.parentNode; if (!p) { return null; } const i = p.__children.indexOf(this); return p.__children[i + 1] ?? null; }
	get previousSibling() { const p = this.parentNode; if (!p) { return null; } const i = p.__children.indexOf(this); return i > 0 ? p.__children[i - 1] : null; }
	get parentElement() { const p = this.parentNode; return p && p.nodeType === 1 ? p : null; }
	get isConnected() { for (let n = this; n; n = n.parentNode) { if (n.nodeType === 9) { return true; } } return false; }
	get nodeValue() { return null; } set nodeValue(v) { }
	hasChildNodes() { return this.__children.length > 0; }
	contains(o) { for (let n = o; n; n = n.parentNode) { if (n === this) { return true; } } return false; }
	getRootNode() { let n = this; while (n.parentNode) { n = n.parentNode; } return n; }
	__parentForEvents() { return this.parentNode ?? (this.nodeType === 9 ? this.defaultView : null); }
	__invalidate(kind, what, arg, extra) { const d = this.nodeType === 9 ? this : this.ownerDocument; if (d) { d.__dirty = true; d.__styleDirty = d.__styleDirty || kind === 'style'; const log = (d.__dirtyLog ??= []); if (log.length < 200000) { log.push([kind, what, this, arg, extra]); } else { d.__logOverflow = true; } } }   // the log (cleared by every layout pass) says what made the pass necessary
	insertBefore(node, ref) {
		if (node.nodeType === 11) { for (const c of [...node.__children]) { this.insertBefore(c, ref); } return node; }
		if (ref && ref.parentNode !== this) { throw new DOMException('The node before which the new node is to be inserted is not a child of this node.', 'NotFoundError'); }
		if (node.contains && node.contains(this)) { throw new DOMException('The new child element contains the parent.', 'HierarchyRequestError'); }
		if (node.parentNode) { node.parentNode.__removeChild(node, true); }
		const i = ref ? this.__children.indexOf(ref) : this.__children.length; this.__children.splice(i, 0, node); node.parentNode = this;
		this.__invalidate('style', 'ins', node, i); this.__queueMutation({ type: 'childList', target: this, addedNodes: [node], removedNodes: [] }); node.__connectedChanged && node.__connectedChanged(this.isConnected); if (node.nodeType === 1 || node.nodeType === 11) { const dd = this.nodeType === 9 ? this : this.ownerDocument; if (dd && dd.__scanScripts && this.isConnected) { dd.__scanScripts(node); } } return node;
	}
	appendChild(node) { return this.insertBefore(node, null); }
	__removeChild(node, moving) { const i = this.__children.indexOf(node); if (i < 0) { throw new DOMException('The node to be removed is not a child of this node.', 'NotFoundError'); } notifyRemoval(this.nodeType === 9 ? this : this.ownerDocument, node); this.__children.splice(i, 1); node.parentNode = null; this.__invalidate('style', 'rem', node, i); { const d = this.nodeType === 9 ? this : this.ownerDocument; const ae = d && d.__activeElement; if (ae && node.contains && node.contains(ae)) { d.__activeElement = null; this.__invalidate('style', 'state', 'focus'); } } /* removing the focused element moves focus to the body: :focus and :focus-within change */ if (!moving) { this.__queueMutation({ type: 'childList', target: this, addedNodes: [], removedNodes: [node] }); } node.__connectedChanged && node.__connectedChanged(false); return node; }
	removeChild(node) { return this.__removeChild(node, false); }
	replaceChild(n, old) { this.insertBefore(n, old); return this.removeChild(old); }
	remove() { if (this.parentNode) { this.parentNode.removeChild(this); } }
	__queueMutation(rec) { const d = this.nodeType === 9 ? this : this.ownerDocument; if (d && d.__observers && d.__observers.size) { for (const o of d.__observers) { o.__maybeQueue(rec); } } }
	compareDocumentPosition(o) { if (o === this) { return 0; } if (this.contains(o)) { return 20; } if (o.contains(this)) { return 10; } const a = [], b = []; for (let n = this; n; n = n.parentNode) { a.unshift(n); } for (let n = o; n; n = n.parentNode) { b.unshift(n); } if (a[0] !== b[0]) { return 1; } let i = 0; while (a[i] === b[i]) { i++; } return a[i].parentNode.__children.indexOf(a[i]) < b[i].parentNode.__children.indexOf(b[i]) ? 4 : 2; }
	isEqualNode(o) { return this.outerHTML === o.outerHTML; } isSameNode(o) { return this === o; }
	normalize() { }
}
// the node-type constants are also readable on instances (`node.nodeType === node.ELEMENT_NODE`, as Monaco's mouse hit testing writes it)
for (const k of ['ELEMENT_NODE', 'TEXT_NODE', 'COMMENT_NODE', 'DOCUMENT_NODE', 'DOCUMENT_FRAGMENT_NODE', 'DOCUMENT_POSITION_DISCONNECTED', 'DOCUMENT_POSITION_PRECEDING', 'DOCUMENT_POSITION_FOLLOWING', 'DOCUMENT_POSITION_CONTAINS', 'DOCUMENT_POSITION_CONTAINED_BY']) { Object.defineProperty(Node.prototype, k, { value: Node[k], enumerable: false }); }
export class DOMException extends Error { constructor(msg, name = 'Error') { super(msg); this.name = name; this.code = 0; } }

export class CharacterData extends Node {
	constructor(data) { super(); this.__data = String(data); }
	get data() { return this.__data; } set data(v) { this.__data = String(v); this.__invalidate('layout', 'text'); this.__queueMutation({ type: 'characterData', target: this }); }
	get nodeValue() { return this.__data; } set nodeValue(v) { this.data = v; }
	get textContent() { return this.__data; } set textContent(v) { this.data = v; }
	get length() { return this.__data.length; }
	substringData(o, n) { return this.__data.substr(o, n); } appendData(s) { this.data = this.__data + s; }
	insertData(o, s) { this.data = this.__data.slice(0, o) + s + this.__data.slice(o); } deleteData(o, n) { this.data = this.__data.slice(0, o) + this.__data.slice(o + n); } replaceData(o, n, s) { this.data = this.__data.slice(0, o) + s + this.__data.slice(o + n); }
}
export class Text extends CharacterData {
	constructor(data = '') { super(data); } get nodeType() { return 3; } get nodeName() { return '#text'; }
	get wholeText() { return this.__data; }
	splitText(o) { const t = new Text(this.__data.slice(o)); t.ownerDocument = this.ownerDocument; this.data = this.__data.slice(0, o); if (this.parentNode) { this.parentNode.insertBefore(t, this.nextSibling); } return t; }
	cloneNode() { const t = new Text(this.__data); t.ownerDocument = this.ownerDocument; return t; }
}
/** Element.prototype.cloneNode applied to another kind of node (DOMPurify does that through its prototype lookups) */
function cloneNonElement(n, deep) { if (n.nodeType === 3) { const t = new Text(n.__data); t.ownerDocument = n.ownerDocument; return t; } if (n.nodeType === 8) { const t = new Comment(n.__data); t.ownerDocument = n.ownerDocument; return t; } if (n.nodeType === 11) { const f = new DocumentFragment(); f.ownerDocument = n.ownerDocument; if (deep) { for (const c of n.__children) { f.appendChild(c.cloneNode(true)); } } return f; } throw new Error('cloneNode: unsupported node type ' + n.nodeType); }
export class Comment extends CharacterData { constructor(d = '') { super(d); } get nodeType() { return 8; } get nodeName() { return '#comment'; } cloneNode() { const t = new Comment(this.__data); t.ownerDocument = this.ownerDocument; return t; } }

// ---- parent-node mixin helpers ----------------------------------------------------------------------------------------------------------------
const toNode = (doc, x) => (x instanceof Node ? x : (() => { const t = new Text(String(x)); t.ownerDocument = doc; return t; })());
const ParentNodeMixin = {
	get children() { return this.__children.filter(c => c.nodeType === 1); },
	get childElementCount() { return this.__children.reduce((n, c) => n + (c.nodeType === 1 ? 1 : 0), 0); },
	get firstElementChild() { return this.__children.find(c => c.nodeType === 1) ?? null; },
	get lastElementChild() { for (let i = this.__children.length - 1; i >= 0; i--) { if (this.__children[i].nodeType === 1) { return this.__children[i]; } } return null; },
	append(...a) { for (const x of a) { this.appendChild(toNode(this.ownerDocument || this, x)); } },
	prepend(...a) { const f = this.firstChild; for (const x of a) { this.insertBefore(toNode(this.ownerDocument || this, x), f); } },
	replaceChildren(...a) { for (const c of [...this.__children]) { this.removeChild(c); } this.append(...a); },
	querySelector(sel) { const s = parseSelector(sel); const walk = (n) => { for (const c of n.__children) { if (c.nodeType !== 1) { continue; } if (matches(c, s)) { return c; } const r = walk(c); if (r) { return r; } } return null; }; return walk(this); },
	querySelectorAll(sel) { const s = parseSelector(sel); const out = []; const walk = (n) => { for (const c of n.__children) { if (c.nodeType !== 1) { continue; } if (matches(c, s)) { out.push(c); } walk(c); } }; walk(this); return out; },
	getElementById(id) { const walk = (n) => { for (const c of n.__children) { if (c.nodeType !== 1) { continue; } if (c.id === id) { return c; } const r = walk(c); if (r) { return r; } } return null; }; return walk(this); },
	getElementsByClassName(cn) { const names = cn.split(/\s+/).filter(Boolean); const out = []; const walk = (n) => { for (const c of n.__children) { if (c.nodeType !== 1) { continue; } if (names.every(x => c.classList.contains(x))) { out.push(c); } walk(c); } }; walk(this); return out; },
	getElementsByTagName(t) { t = t.toLowerCase(); const out = []; const walk = (n) => { for (const c of n.__children) { if (c.nodeType !== 1) { continue; } if (t === '*' || c.localName === t) { out.push(c); } walk(c); } }; walk(this); return out; },
};
function mixin(cls, src) { for (const k of Object.getOwnPropertyNames(src)) { Object.defineProperty(cls.prototype, k, Object.getOwnPropertyDescriptor(src, k)); } }

// ---- attributes, classList, style ------------------------------------------------------------------------------------------------------------
class DOMTokenList {
	constructor(el) { this.__el = el; }
	__list() { return (this.__el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
	__set(l) { this.__el.setAttribute('class', l.join(' ')); }
	get length() { return this.__list().length; } get value() { return this.__el.getAttribute('class') || ''; } set value(v) { this.__el.setAttribute('class', v); }
	item(i) { return this.__list()[i] ?? null; } contains(t) { return this.__list().includes(t); }
	add(...ts) { const l = this.__list(); let ch = false; for (const t of ts) { if (!l.includes(t)) { l.push(t); ch = true; } } if (ch) { this.__set(l); } }
	remove(...ts) { const l = this.__list(); const n = l.filter(x => !ts.includes(x)); if (n.length !== l.length) { this.__set(n); } }
	toggle(t, force) { const has = this.contains(t); const want = force === undefined ? !has : !!force; if (want && !has) { this.add(t); } else if (!want && has) { this.remove(t); } return want; }
	replace(a, b) { const l = this.__list(); const i = l.indexOf(a); if (i < 0) { return false; } l[i] = b; this.__set(l); return true; }
	forEach(f) { this.__list().forEach(f); } [Symbol.iterator]() { return this.__list()[Symbol.iterator](); } toString() { return this.value; }
}
const dash = (n) => n.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
const camel = (n) => n.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const styleMethods = new Set(['getPropertyValue', 'setProperty', 'removeProperty', 'getPropertyPriority', 'item']);
export class CSSStyleDeclaration {
	constructor(owner) { Object.defineProperty(this, '__map', { value: new Map(), enumerable: false }); Object.defineProperty(this, '__owner', { value: owner, enumerable: false }); return new Proxy(this, STYLE_PROXY); }
	getPropertyValue(n) { return this.__map.get(n.startsWith('--') ? n : dash(n))?.v ?? ''; }
	getPropertyPriority(n) { return this.__map.get(n.startsWith('--') ? n : dash(n))?.important ? 'important' : ''; }
	setProperty(n, v, prio = '') { n = n.startsWith('--') ? n : dash(n); v = v == null ? '' : String(v); if (v === '') { this.removeProperty(n); return; } this.__map.set(n, { v: v.trim(), important: prio === 'important' }); this.__changed(); }
	removeProperty(n) { n = n.startsWith('--') ? n : dash(n); const o = this.getPropertyValue(n); if (this.__map.delete(n)) { this.__changed(); } return o; }
	get cssText() { return [...this.__map].map(([k, e]) => `${k}: ${k.startsWith('--') ? e.v : (k === 'font-feature-settings' ? normalizeValue(e.v).replace(/"\s+off\b/g, '" 0').replace(/"\s+on\b/g, '" 1') : normalizeValue(e.v))}${e.important ? ' !important' : ''};`).join(' '); }
	set cssText(t) { this.__map.clear(); for (const d of splitDecls(String(t))) { const m = /^([^:]+):([\s\S]*)$/.exec(d); if (m) { let v = m[2].trim(), imp = false; if (/!\s*important$/i.test(v)) { v = v.replace(/!\s*important$/i, '').trim(); imp = true; } const n = m[1].trim(); this.__map.set(n.startsWith('--') ? n : n.toLowerCase(), { v, important: imp }); } } this.__changed(); }
	get length() { return this.__map.size; } item(i) { return [...this.__map.keys()][i] ?? ''; }
	[Symbol.iterator]() { return this.__map.keys(); }
	__changed() { const o = this.__owner; if (o) { if (!o.__syncingStyleAttr) { o.__syncingStyleAttr = true; try { o.__attrs.set('style', this.cssText); } finally { o.__syncingStyleAttr = false; } } o.__invalidate('style', 'attr', 'style'); } }
}
export function splitDecls(t) {   // splits at the top-level ';' (not inside parentheses or quotes); pieces are trimmed, empty ones dropped
	const out = []; const n = t.length; let depth = 0, q = 0, start = 0;
	for (let i = 0; i < n; i++) {
		const c = t.charCodeAt(i);
		if (q !== 0) { if (c === 92) { i++; } else if (c === q) { q = 0; } continue; }
		if (c === 34 || c === 39) { q = c; } else if (c === 40) { depth++; } else if (c === 41) { depth--; } else if (c === 59 && depth === 0) { const piece = t.slice(start, i).trim(); if (piece) { out.push(piece); } start = i + 1; }
	}
	const last = t.slice(start).trim(); if (last) { out.push(last); } return out;
}
/** Chromium re-serialises values it parsed: numbers keep 6 significant digits (%g style), strings use double quotes. Needed so inline style attributes compare equal. */
function fmtNum(x) { if (!Number.isFinite(x) || x === 0) { return String(x); } const exp = Math.floor(Math.log10(Math.abs(x))); if (exp < -4 || exp >= 6) { let m = x.toExponential(5); m = m.replace(/\.?0+e/, 'e'); return m.replace(/e([+-])(\d)$/, 'e$10$2'); } return String(Number(x.toPrecision(6))); }
export function normalizeValue(v) { return v.replace(/'((?:[^'\\]|\\.)*)'/g, (m, s) => s.includes('"') ? m : '"' + s + '"').replace(/(^|[^\w.#-])(-?\d*\.?\d+(?:e[+-]?\d+)?)(?=[a-z%]*\b|$)/gi, (m, pre, num) => { const x = parseFloat(num); return pre + (num.replace(/^[-+]?0*\.?0*$/, '') === '' ? num : (String(x).length > 6 || /e/i.test(num) ? fmtNum(x) : num)); }); }
const STYLE_PROXY = {
	get(t, k) { if (typeof k === 'symbol' || k in t) { const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; } return t.getPropertyValue(k.startsWith('--') ? k : (k === 'cssFloat' ? 'float' : k)); },
	set(t, k, v) { if (typeof k === 'symbol' || k in t) { t[k] = v; return true; } t.setProperty(k === 'cssFloat' ? 'float' : k, v); return true; },
	has(t, k) { return k in t || typeof k === 'string'; },
};

// ---- Element ----------------------------------------------------------------------------------------------------------------------------------
export class Element extends Node {
	constructor(localName = Element.__pending, ns = 'http://www.w3.org/1999/xhtml') { super(); this.localName = localName; this.namespaceURI = ns; this.__attrs = new Map(); this.__style = null; this.__classList = null; }
	get nodeType() { return 1; } get nodeName() { return this.nodeType === 1 ? this.tagName : ({ 3: '#text', 8: '#comment', 9: '#document', 11: '#document-fragment' })[this.nodeType] ?? ''; }
	__connectedChanged(connected) { const d = this.ownerDocument; if (!d || !d.__hasCustom) { return; } const walk = (n) => { if (n.nodeType !== 1) { return; } const was = n.__wasConnected === true; if (connected !== was) { n.__wasConnected = connected; const cb = connected ? n.connectedCallback : n.disconnectedCallback; if (typeof cb === 'function') { try { cb.call(n); } catch (e) { reportError(e); } } } for (const c of n.__children) { walk(c); } }; walk(this); }
	get tagName() { return this.namespaceURI === 'http://www.w3.org/1999/xhtml' ? this.localName.toUpperCase() : this.localName; }
	get id() { return this.getAttribute('id') || ''; } set id(v) { this.setAttribute('id', v); }
	get className() { return this.getAttribute('class') || ''; } set className(v) { this.setAttribute('class', v); }
	get classList() { return this.__classList ??= new DOMTokenList(this); }
	get style() { return this.__style ??= new CSSStyleDeclaration(this); }
	set style(v) { this.style.cssText = String(v); }
	get attributes() { const el = this; const list = NamedNodeMap.from([...this.__attrs].map(([name, value]) => ({ name, value, localName: name, ownerElement: el }))); return list; }
	classes() { return this.__cls ??= (this.__attrs.get('class') || '').split(/\s+/).filter(Boolean); }
	getAttribute(n) { n = n.toLowerCase(); return this.__attrs.has(n) ? this.__attrs.get(n) : null; }
	getAttributeNS(ns, n) { return this.getAttribute(n); }
	setAttribute(n, v) {
		n = String(n).toLowerCase(); v = String(v); const old = this.__attrs.get(n); this.__attrs.set(n, v); if (n === 'class') { this.__cls = null; }
		if (n === 'style' && !this.__syncingStyleAttr) { this.__syncingStyleAttr = true; try { this.style.cssText = v; } finally { this.__syncingStyleAttr = false; } }
		this.__invalidate(n === 'class' || n === 'id' || n === 'style' || n.startsWith('data-') || n.startsWith('aria-') || n === 'type' || n === 'disabled' || n === 'hidden' ? 'style' : 'layout', 'attr', n, old);
		this.__queueMutation({ type: 'attributes', target: this, attributeName: n, oldValue: old ?? null });
	}
	setAttributeNS(ns, n, v) { this.setAttribute(n, v); }
	removeAttribute(n) { n = n.toLowerCase(); if (n === 'class') { this.__cls = null; } const oldV = this.__attrs.get(n); if (this.__attrs.delete(n)) { if (n === 'style' && !this.__syncingStyleAttr) { this.style.cssText = ''; } this.__invalidate('style', 'attr', n, oldV); this.__queueMutation({ type: 'attributes', target: this, attributeName: n, oldValue: null }); } }
	removeAttributeNS(ns, n) { this.removeAttribute(n); }
	hasAttribute(n) { return this.__attrs.has(n.toLowerCase()); } hasAttributes() { return this.__attrs.size > 0; }
	toggleAttribute(n, force) { const has = this.hasAttribute(n); const want = force === undefined ? !has : !!force; if (want && !has) { this.setAttribute(n, ''); } else if (!want && has) { this.removeAttribute(n); } return want; }
	getAttributeNames() { return [...this.__attrs.keys()]; }
	get dataset() { const el = this; return new Proxy({}, { get: (_, k) => typeof k === 'string' ? (el.getAttribute('data-' + dash(k)) ?? undefined) : undefined, set: (_, k, v) => { el.setAttribute('data-' + dash(k), v); return true; }, deleteProperty: (_, k) => { el.removeAttribute('data-' + dash(k)); return true; }, has: (_, k) => el.hasAttribute('data-' + dash(String(k))), ownKeys: () => [...el.__attrs.keys()].filter(k => k.startsWith('data-')).map(k => camel(k.slice(5))), getOwnPropertyDescriptor: (_, k) => el.hasAttribute('data-' + dash(String(k))) ? { enumerable: true, configurable: true, value: el.getAttribute('data-' + dash(String(k))) } : undefined }); }
	get textContent() { let s = ''; for (const c of this.__children) { if (c.nodeType === 3 || c.nodeType === 1) { s += c.textContent; } } return s; }
	set textContent(v) { for (const c of [...this.__children]) { this.__removeChild(c, false); } v = v == null ? '' : String(v); if (v !== '') { const t = new Text(v); t.ownerDocument = this.ownerDocument; this.appendChild(t); } }
	get innerText() { return this.textContent; } set innerText(v) { this.textContent = v; }
	get innerHTML() { return this.__children.map(serialize).join(''); }
	set innerHTML(html) { for (const c of [...this.__children]) { this.__removeChild(c, false); } const frag = parseFragment(this.ownerDocument, String(html), this); for (const c of [...frag.__children]) { this.appendChild(c); } }
	get outerHTML() { return serialize(this); }
	insertAdjacentHTML(pos, html) { const frag = parseFragment(this.ownerDocument, html, this); if (pos === 'beforeend') { this.appendChild(frag); } else if (pos === 'afterbegin') { this.insertBefore(frag, this.firstChild); } else if (pos === 'beforebegin') { this.parentNode.insertBefore(frag, this); } else if (pos === 'afterend') { this.parentNode.insertBefore(frag, this.nextSibling); } }
	insertAdjacentElement(pos, el) { if (pos === 'beforeend') { this.appendChild(el); } else if (pos === 'afterbegin') { this.insertBefore(el, this.firstChild); } else if (pos === 'beforebegin') { this.parentNode.insertBefore(el, this); } else { this.parentNode.insertBefore(el, this.nextSibling); } return el; }
	get nextElementSibling() { for (let n = this.nextSibling; n; n = n.nextSibling) { if (n.nodeType === 1) { return n; } } return null; }
	get previousElementSibling() { for (let n = this.previousSibling; n; n = n.previousSibling) { if (n.nodeType === 1) { return n; } } return null; }
	after(...a) { const p = this.parentNode, r = this.nextSibling; for (const x of a) { p.insertBefore(toNode(this.ownerDocument, x), r); } }
	before(...a) { const p = this.parentNode; for (const x of a) { p.insertBefore(toNode(this.ownerDocument, x), this); } }
	replaceWith(...a) { this.before(...a); this.remove(); }
	matches(sel) { return matches(this, parseSelector(sel)); } webkitMatchesSelector(s) { return this.matches(s); }
	closest(sel) { return closestMatch(this, parseSelector(sel)); }
	cloneNode(deep) { if (this.nodeType !== 1) { return cloneNonElement(this, deep); } const e = this.ownerDocument.__createElementNS(this.namespaceURI, this.localName); for (const [k, v] of this.__attrs) { e.setAttribute(k, v); } if (deep) { for (const c of this.__children) { e.appendChild(c.cloneNode(true)); } } return e; }
	get shadowRoot() { return null; } attachShadow() { noteMissing('Element.attachShadow'); throw new DOMException('Shadow DOM not supported', 'NotSupportedError'); }
	// focus
	focus() { const d = this.ownerDocument; if (!d || d.__activeElement === this) { return; } const prev = d.__activeElement; d.__activeElement = this; if (prev) { prev.__invalidate('style', 'state', 'focus'); if (prev.__tc) { controlBlurred(prev); } } this.__invalidate('style', 'state', 'focus'); if (this.__tc) { controlFocused(this); } if (prev) { prev.dispatchEvent(new FocusEvent('blur', { relatedTarget: this })); prev.dispatchEvent(new FocusEvent('focusout', { relatedTarget: this, bubbles: true })); } this.dispatchEvent(new FocusEvent('focus', { relatedTarget: prev })); this.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: prev })); }
	blur() { const d = this.ownerDocument; if (d && d.__activeElement === this) { d.__activeElement = null; this.__invalidate('style', 'state', 'focus'); if (this.__tc) { controlBlurred(this); } this.dispatchEvent(new FocusEvent('blur')); this.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); } }
	click() { this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }
	scrollIntoView() { } setPointerCapture() { } releasePointerCapture() { } hasPointerCapture() { return false; } requestPointerLock() { }
	animate() { return { cancel() { }, finished: Promise.resolve(), onfinish: null }; } getAnimations() { return []; }
	// geometry: provided by layout (Document.__layout)
	getBoundingClientRect() { return this.ownerDocument.__rect(this); }
	getClientRects() { const r = this.getBoundingClientRect(); return r.width || r.height ? [r] : []; }
	get offsetWidth() { return Math.round(this.ownerDocument.__box(this, 'offsetWidth')); } get offsetHeight() { return Math.round(this.ownerDocument.__box(this, 'offsetHeight')); }
	get offsetTop() { return Math.round(this.ownerDocument.__box(this, 'offsetTop')); } get offsetLeft() { return Math.round(this.ownerDocument.__box(this, 'offsetLeft')); }
	get offsetParent() { return this.ownerDocument.__offsetParent(this); }
	get clientWidth() { return Math.round(this.ownerDocument.__box(this, 'clientWidth')); } get clientHeight() { return Math.round(this.ownerDocument.__box(this, 'clientHeight')); }
	get clientTop() { return this.ownerDocument.__box(this, 'clientTop'); } get clientLeft() { return this.ownerDocument.__box(this, 'clientLeft'); }
	get scrollWidth() { return Math.round(this.ownerDocument.__box(this, 'scrollWidth')); } get scrollHeight() { return Math.round(this.ownerDocument.__box(this, 'scrollHeight')); }
	get scrollTop() { return this.__scrollTop || 0; } set scrollTop(v) { this.ownerDocument.__setScroll(this, 'top', +v || 0); }
	get scrollLeft() { return this.__scrollLeft || 0; } set scrollLeft(v) { this.ownerDocument.__setScroll(this, 'left', +v || 0); }
	scrollTo(x, y) { if (typeof x === 'object') { y = x.top; x = x.left; } if (x !== undefined) { this.scrollLeft = x; } if (y !== undefined) { this.scrollTop = y; } } scroll(x, y) { this.scrollTo(x, y); } scrollBy(x, y) { this.scrollTo(this.scrollLeft + (x || 0), this.scrollTop + (y || 0)); }
}
mixin(Element, ParentNodeMixin);
// reflected attributes
for (const [prop, attr, bool] of [['title', 'title'], ['lang', 'lang'], ['dir', 'dir'], ['hidden', 'hidden', true], ['draggable', 'draggable', true], ['tabIndex', 'tabindex'], ['role', 'role'], ['href', 'href'], ['src', 'src'], ['alt', 'alt'], ['type', 'type'], ['name', 'name'], ['placeholder', 'placeholder'], ['spellcheck', 'spellcheck'], ['contentEditable', 'contenteditable'], ['htmlFor', 'for'], ['rel', 'rel'], ['target', 'target'], ['slot', 'slot'], ['autocomplete', 'autocomplete'], ['autocapitalize', 'autocapitalize'], ['wrap', 'wrap'], ['ariaLabel', 'aria-label'], ['ariaHidden', 'aria-hidden'], ['ariaLive', 'aria-live'], ['ariaDisabled', 'aria-disabled'], ['ariaExpanded', 'aria-expanded'], ['ariaSelected', 'aria-selected'], ['ariaChecked', 'aria-checked'], ['ariaPressed', 'aria-pressed'], ['ariaLevel', 'aria-level'], ['ariaSetSize', 'aria-setsize'], ['ariaPosInSet', 'aria-posinset'], ['ariaHasPopup', 'aria-haspopup'], ['ariaMultiLine', 'aria-multiline'], ['ariaActiveDescendant', 'aria-activedescendant'], ['ariaRoleDescription', 'aria-roledescription'], ['ariaAtomic', 'aria-atomic'], ['ariaRelevant', 'aria-relevant'], ['ariaOrientation', 'aria-orientation']]) {
	Object.defineProperty(Element.prototype, prop, bool ? { get() { return this.hasAttribute(attr); }, set(v) { v ? this.setAttribute(attr, prop === 'draggable' ? 'true' : '') : this.removeAttribute(attr); }, configurable: true } : prop === 'tabIndex' ? { get() { const v = this.getAttribute(attr); return v === null ? -1 : parseInt(v, 10); }, set(v) { this.setAttribute(attr, v); }, configurable: true } : { get() { return this.getAttribute(attr) ?? ''; }, set(v) { if (v === null || v === undefined) { this.removeAttribute(attr); } else { this.setAttribute(attr, v); } }, configurable: true });
}
export class HTMLElement extends Element { }
export class SVGElement extends Element { get className() { return { baseVal: this.getAttribute('class') || '' }; } set className(v) { this.setAttribute('class', v); } getBBox() { return { x: 0, y: 0, width: 0, height: 0 }; } }
const tagClasses = {};
const mk = (name, tags, extra) => { const C = ({ [name]: class extends HTMLElement { } })[name]; if (extra) { Object.defineProperties(C.prototype, Object.getOwnPropertyDescriptors(extra)); } for (const t of tags) { tagClasses[t] = C; } return C; };
export const HTMLDivElement = mk('HTMLDivElement', ['div']), HTMLSpanElement = mk('HTMLSpanElement', ['span']), HTMLBodyElement = mk('HTMLBodyElement', ['body']), HTMLHeadElement = mk('HTMLHeadElement', ['head']), HTMLHtmlElement = mk('HTMLHtmlElement', ['html']),
	HTMLAnchorElement = mk('HTMLAnchorElement', ['a']), HTMLButtonElement = mk('HTMLButtonElement', ['button']), HTMLLabelElement = mk('HTMLLabelElement', ['label']), HTMLImageElement = mk('HTMLImageElement', ['img']), HTMLLinkElement = mk('HTMLLinkElement', ['link']),
	HTMLScriptElement = mk('HTMLScriptElement', ['script']), HTMLTableElement = mk('HTMLTableElement', ['table']), HTMLIFrameElement = mk('HTMLIFrameElement', ['iframe']), HTMLUListElement = mk('HTMLUListElement', ['ul']), HTMLLIElement = mk('HTMLLIElement', ['li']),
	HTMLParagraphElement = mk('HTMLParagraphElement', ['p']), HTMLPreElement = mk('HTMLPreElement', ['pre']), HTMLBRElement = mk('HTMLBRElement', ['br']), HTMLSelectElement = mk('HTMLSelectElement', ['select'], selectProps), HTMLOptionElement = mk('HTMLOptionElement', ['option'], optionProps), HTMLOptGroupElement = mk('HTMLOptGroupElement', ['optgroup']);
const withText = (extra) => Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(textProps), ...Object.getOwnPropertyDescriptors(extra) });
export const HTMLInputElement = mk('HTMLInputElement', ['input'], withText({ get checked() { return this.__checked !== undefined ? this.__checked : this.hasAttribute('checked'); }, set checked(v) { this.__checked = !!v; this.ownerDocument && (this.ownerDocument.__paintGen = (this.ownerDocument.__paintGen | 0) + 1); } }));
export const HTMLTextAreaElement = mk('HTMLTextAreaElement', ['textarea'], withText({}));
export const HTMLFormElement = mk('HTMLFormElement', ['form'], { submit() { }, reset() { }, requestSubmit() { }, checkValidity() { return true; }, reportValidity() { return true; }, get elements() { return [...this.querySelectorAll('input, select, textarea, button')]; } });
export class NamedNodeMap extends Array { getNamedItem(n) { return this.find(a => a.name === n) ?? null; } item(i) { return this[i] ?? null; } }
export const HTMLStyleElement = mk('HTMLStyleElement', ['style'], { get sheet() { return this.__sheet ?? (this.isConnected ? (this.ownerDocument.__ensureSheet(this)) : null); } });
export const HTMLCanvasElement = mk('HTMLCanvasElement', ['canvas'], {
	get width() { return +(this.getAttribute('width') ?? 300); }, set width(v) { this.setAttribute('width', v); this.__ctx = null; }, get height() { return +(this.getAttribute('height') ?? 150); }, set height(v) { this.setAttribute('height', v); this.__ctx = null; },
	getContext(kind) { return this.ownerDocument.__canvasContext(this, kind); }, toDataURL() { return 'data:,'; }, toBlob(cb) { cb(null); },
});
export const HTMLTemplateElement = mk('HTMLTemplateElement', ['template'], { get content() { return this.__content ??= (() => { const f = new DocumentFragment(); f.ownerDocument = this.ownerDocument; return f; })(); } });
export const HTMLUnknownElement = class HTMLUnknownElement extends HTMLElement { };
export { tagClasses };
export const SVG_NS = 'http://www.w3.org/2000/svg';

// ---- fragments, document ----------------------------------------------------------------------------------------------------------------------
export class DocumentFragment extends Node { get nodeType() { return 11; } get nodeName() { return '#document-fragment'; } get textContent() { return this.__children.map(c => c.textContent).join(''); } cloneNode(deep) { const f = new DocumentFragment(); f.ownerDocument = this.ownerDocument; if (deep) { for (const c of this.__children) { f.appendChild(c.cloneNode(true)); } } return f; } }
mixin(DocumentFragment, ParentNodeMixin);

// ---- serialize / parse -----------------------------------------------------------------------------------------------------------------------
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');
export function serialize(n) {
	if (n.nodeType === 3) { const p = n.parentNode; return p && (p.localName === 'style' || p.localName === 'script') ? n.__data : esc(n.__data); }
	if (n.nodeType === 8) { return `<!--${n.__data}-->`; }
	let s = '<' + n.localName; for (const [k, v] of n.__attrs) { s += ` ${k}="${escAttr(v)}"`; } s += '>';
	if (VOID.has(n.localName)) { return s; }
	for (const c of n.__children) { s += serialize(c); } return s + '</' + n.localName + '>';
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×', zwj: '‍', zwnj: '‌' };
const decode = (s) => s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e] ?? m));
export function parseFragment(doc, html, context) {
	const frag = new DocumentFragment(); frag.ownerDocument = doc; const stack = [frag]; const re = /<!--([\s\S]*?)-->|<\/([a-zA-Z][^\s>]*)\s*>|<([a-zA-Z][^\s/>]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/g;
	let m; const inSvg = () => stack.some(n => n.namespaceURI === SVG_NS) || (context && context.namespaceURI === SVG_NS);
	while ((m = re.exec(html))) {
		const top = stack[stack.length - 1];
		if (m[1] !== undefined) { const c = new Comment(m[1]); c.ownerDocument = doc; top.appendChild(c); }
		else if (m[2] !== undefined) { const t = m[2].toLowerCase(); for (let i = stack.length - 1; i > 0; i--) { if (stack[i].localName === t) { stack.length = i; break; } } }
		else if (m[3] !== undefined) {
			const t = m[3].toLowerCase(); const el = doc.__createElementNS(t === 'svg' || inSvg() ? SVG_NS : 'http://www.w3.org/1999/xhtml', t === 'svg' || inSvg() ? m[3] : t);
			const ar = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g; let a; while ((a = ar.exec(m[4]))) { el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? '')); }
			top.appendChild(el);
			if (t === 'style' || t === 'script' || t === 'textarea') { const end = html.indexOf('</' + t, re.lastIndex); const raw = html.slice(re.lastIndex, end < 0 ? html.length : end); if (raw) { const tx = new Text(t === 'textarea' ? decode(raw) : raw); tx.ownerDocument = doc; el.appendChild(tx); } re.lastIndex = end < 0 ? html.length : html.indexOf('>', end) + 1; }
			else if (!m[5] && !VOID.has(t)) { stack.push(el); }
		} else if (m[6] !== undefined) { const tx = new Text(decode(m[6])); tx.ownerDocument = doc; top.appendChild(tx); }
	}
	return frag;
}

// ---- Range / Selection (just enough for the editor's measuring and focus handling) -----------------------------------------------------------
export class Range {
	constructor(doc) { this.__doc = doc; this.startContainer = this.endContainer = doc; this.startOffset = this.endOffset = 0; this.collapsed = true; }
	setStart(n, o) { this.startContainer = n; this.startOffset = o; this.__upd(); } setEnd(n, o) { this.endContainer = n; this.endOffset = o; this.__upd(); }
	setStartBefore(n) { this.setStart(n.parentNode, n.parentNode.__children.indexOf(n)); } setEndAfter(n) { this.setEnd(n.parentNode, n.parentNode.__children.indexOf(n) + 1); }
	selectNode(n) { this.setStartBefore(n); this.setEndAfter(n); } selectNodeContents(n) { this.setStart(n, 0); this.setEnd(n, n.nodeType === 3 ? n.length : n.__children.length); }
	collapse(toStart) { if (toStart) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; } else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; } this.__upd(); }
	__upd() { this.collapsed = this.startContainer === this.endContainer && this.startOffset === this.endOffset; this.commonAncestorContainer = this.startContainer; }
	getBoundingClientRect() { return this.__doc.__rangeRects(this).total; } getClientRects() { return this.__doc.__rangeRects(this).rects; }
	cloneRange() { const r = new Range(this.__doc); r.startContainer = this.startContainer; r.startOffset = this.startOffset; r.endContainer = this.endContainer; r.endOffset = this.endOffset; r.__upd(); return r; }
	detach() { } toString() { return ''; } deleteContents() { } insertNode(n) { noteMissing('Range.insertNode'); } cloneContents() { return new DocumentFragment(); } createContextualFragment(h) { return parseFragment(this.__doc, h, null); }
	static START_TO_START = 0;
}
export class Selection {
	constructor(doc) { this.__doc = doc; this.rangeCount = 0; this.__ranges = []; this.anchorNode = this.focusNode = null; this.anchorOffset = this.focusOffset = 0; this.isCollapsed = true; this.type = 'None'; }
	getRangeAt(i) { return this.__ranges[i]; } addRange(r) { this.__ranges = [r]; this.rangeCount = 1; this.anchorNode = r.startContainer; this.focusNode = r.endContainer; this.anchorOffset = r.startOffset; this.focusOffset = r.endOffset; this.isCollapsed = r.collapsed; this.type = r.collapsed ? 'Caret' : 'Range'; }
	removeAllRanges() { this.__ranges = []; this.rangeCount = 0; this.anchorNode = this.focusNode = null; this.type = 'None'; } empty() { this.removeAllRanges(); } removeRange() { this.removeAllRanges(); }
	collapse(n, o = 0) { const r = new Range(this.__doc); r.setStart(n, o); r.setEnd(n, o); this.addRange(r); } setBaseAndExtent(an, ao, fn, fo) { const r = new Range(this.__doc); r.setStart(an, ao); r.setEnd(fn, fo); this.addRange(r); } selectAllChildren(n) { const r = new Range(this.__doc); r.selectNodeContents(n); this.addRange(r); } toString() { return ''; } containsNode() { return false; }
}

export class MutationObserver {
	constructor(cb) { this.__cb = cb; this.__targets = []; this.__queue = []; this.__scheduled = false; }
	observe(target, opts = {}) { this.__targets.push({ target, opts }); const d = target.nodeType === 9 ? target : target.ownerDocument; (d.__observers ??= new Set()).add(this); }
	disconnect() { this.__targets = []; this.__queue = []; for (const d of [...(globalThis.document ? [globalThis.document] : [])]) { d.__observers && d.__observers.delete(this); } }
	takeRecords() { const q = this.__queue; this.__queue = []; return q; }
	__maybeQueue(rec) {
		for (const { target, opts } of this.__targets) {
			const inScope = rec.target === target || (opts.subtree && target.contains(rec.target)); if (!inScope) { continue; }
			if ((rec.type === 'childList' && !opts.childList) || (rec.type === 'attributes' && !opts.attributes && !opts.attributeFilter && !opts.attributeOldValue) || (rec.type === 'characterData' && !opts.characterData)) { continue; }
			if (rec.type === 'attributes' && opts.attributeFilter && !opts.attributeFilter.includes(rec.attributeName)) { continue; }
			this.__queue.push(rec); if (!this.__scheduled) { this.__scheduled = true; queueMicrotask(() => { this.__scheduled = false; const q = this.takeRecords(); if (q.length) { this.__cb(q, this); } }); } return;
		}
	}
}
export { mixin, camel, dash, toNode, ParentNodeMixin };
setEventCtors(Event, InputEvent);
