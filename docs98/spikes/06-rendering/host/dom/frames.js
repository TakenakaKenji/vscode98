// <iframe>: every frame is a window of its own (installEnvironment on a fresh global object) with its own Document, layout and event loop hooks, painted into the box of the
// iframe element (paint.js), hit-tested through it (env.js) and fed by the input driver. Scripts of a frame run with `with (window)` scoping so that `document`, `location`,
// `parent` ... resolve to the frame's window and everything else falls through to the shared realm. This is what VS Code's webviews are built from (an iframe whose page
// creates another iframe and document.write()s the extension's HTML into it), see docs98/FEATURES.md.
import * as D from './dom.js';
import { installEnvironment } from './env.js';
import { MessageChannel, MessagePort, postMessageToWindow } from './messaging.js';

const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
const BLANK = '<!DOCTYPE html><html><head></head><body></body></html>';

const logError = (m) => { if (globalThis.__log98) { globalThis.__log98(m); return; } const c = globalThis.console; (c && (c.error || c.log) || (() => { })).call(c, m); };
const resolveUrl = (href, base) => { try { return new URL(href, base).href; } catch { return String(href); } };
const decode = (buf) => (typeof buf === 'string' ? buf : new TextDecoder().decode(buf));

/** a location object for a frame at `href` (non-special schemes such as vscode-webview: have the origin scheme://host here, not "null") */
function makeLocation(frame, href) {
	let u; try { u = new URL(href); } catch { u = null; }
	const protocol = u ? u.protocol : 'about:', host = u ? u.host : '', loc = {
		href, protocol, host, hostname: u ? u.hostname : '', port: u ? u.port : '', pathname: u ? u.pathname : 'blank', search: u ? u.search : '', hash: u ? u.hash : '',
		origin: u && host ? `${protocol}//${host}` : (protocol === 'about:' ? 'null' : `${protocol}//`),
		assign: (h) => navigate(frame, resolveUrl(h, loc.href)), replace: (h) => navigate(frame, resolveUrl(h, loc.href)), reload: () => navigate(frame, loc.href), toString: () => loc.href,
		get searchParams() { return new URLSearchParams(loc.search); },
	};
	return loc;
}

/** the window of a frame: a null-prototype object that installEnvironment fills with the browser globals */
function createWindow(el) {
	const embedderDoc = el.ownerDocument, embedderEnv = embedderDoc.__env, parentG = embedderEnv.window;
	const g = Object.create(null);
	const env = installEnvironment({ global: g, width: 300, height: 150, readUrl: (u) => embedderEnv.fetchResource(u), opentype: embedderEnv.opentype });
	env.fetchResource = embedderEnv.fetchResource; env.fetchDocument = embedderEnv.fetchDocument; env.parentEnv = embedderEnv; env.frameElement = el;
	const frame = { el, g, env, doc: env.document, loadId: 0, loaded: false };
	(embedderEnv.children ??= new Set()).add(env); env.document.__parentDoc = embedderDoc; env.document.__isFrame = true;
	const define = (k, v) => Object.defineProperty(g, k, { value: v, writable: true, configurable: true, enumerable: false });
	// window.parent is the embedder, but a message posted through it comes from this frame
	const parentProxy = new Proxy(parentG, { get(t, k) { if (k === 'postMessage') { return (data, origin, transfer) => postMessageToWindow(parentG, g, data, origin, transfer); } return t[k]; }, has(t, k) { return k in t; } });
	define('parent', parentProxy); let top = embedderEnv; while (top.parentEnv) { top = top.parentEnv; } define('top', top.window); define('frameElement', el);
	define('postMessage', (data, origin, transfer) => postMessageToWindow(g, parentG, data, origin, transfer));
	// an exception in a timer callback of the page is reported and ignored, as in a browser (the host's own timers would end the process)
	const guarded = (fn, args) => () => { try { if (typeof fn === 'function') { fn(...args); } else { (0, eval)(String(fn)); } } catch (e) { logError('[frame timer] ' + (e && (e + '\n' + (e.stack || '')))); } };
	define('setTimeout', (fn, ms, ...args) => setTimeout(guarded(fn, args), ms)); define('setInterval', (fn, ms, ...args) => setInterval(guarded(fn, args), ms)); define('clearTimeout', (id) => clearTimeout(id)); define('clearInterval', (id) => clearInterval(id));
	define('queueMicrotask', (fn) => queueMicrotask(guarded(fn, [])));
	define('MessageChannel', MessageChannel); define('MessagePort', MessagePort);
	define('open', () => null); define('close', () => { });
	define('focus', () => { frame.doc.__hasFocus = true; }); define('blur', () => { });
	// a service worker is not needed: resources are read directly (see fetchResource); pages that register one are told it is ready
	const sw = Object.assign(new D.EventTarget(), { controller: { postMessage() { }, state: 'activated', scriptURL: '' }, register: () => Promise.resolve(Object.assign(new D.EventTarget(), { installing: null, waiting: null, active: { state: 'activated' }, update() { return Promise.resolve(this); }, unregister: () => Promise.resolve(true) })), getRegistration: () => Promise.resolve(undefined), getRegistrations: () => Promise.resolve([]), ready: Promise.resolve({ active: {} }), startMessages() { } });
	Object.defineProperty(g.navigator, 'serviceWorker', { value: sw, configurable: true });
	env.runScript = (code, name, isModule) => runScript(g, code, name, isModule);
	env.document.open = function () { openDocument(frame); return this; };
	env.document.write = function (...s) { writeDocument(frame, s.join('')); }; env.document.writeln = function (...s) { writeDocument(frame, s.join('') + '\n'); };
	env.document.close = function () { closeDocument(frame); };
	frame.location = null; setFrameLocation(frame, 'about:blank');
	return frame;
}

function setFrameLocation(frame, href) {
	const loc = makeLocation(frame, href); frame.location = loc; Object.defineProperty(frame.g, 'location', { value: loc, writable: true, configurable: true, enumerable: false });
	Object.defineProperty(frame.g, 'origin', { value: loc.origin, writable: true, configurable: true, enumerable: false });
}

/** runs script text with the frame's window as the scope (classic scripts; module scripts as async function bodies) */
export function runScript(g, code, name, isModule) {
	let fn; try { const body = `with (__w) {\n${code}\n}\n//# sourceURL=${name}`; fn = isModule ? new AsyncFunction('__w', body) : new Function('__w', body); } catch (e) { logError('[frame script ' + name + '] ' + (e && (e + '\n' + (e.stack || '')))); return; }
	try { const r = fn.call(g, g); if (r && typeof r.catch === 'function') { r.catch((e) => logError('[frame module ' + name + '] ' + (e && (e + '\n' + (e.stack || ''))))); } } catch (e) { logError('[frame script ' + name + '] ' + (e && (e + '\n' + (e.stack || '')))); }
}

// ---- documents ----------------------------------------------------------------------------------------------------------------------------------
function resetDocument(doc) {
	for (const c of [...doc.__children]) { doc.__removeChild(c, false); }
	doc.__sheets = new Map(); doc.__adopted = []; doc.__rulesVersion = (doc.__rulesVersion || 0) + 1; doc.__styleReady = false; doc.__layout = null; doc.__ruleIndex = null; doc.__activeElement = null; doc.__customs = undefined; doc.__hasCustom = false;
	const html = doc.createElement('html'), head = doc.createElement('head'), body = doc.createElement('body'); html.appendChild(head); html.appendChild(body); doc.appendChild(html); doc.__dirty = doc.__styleDirty = true; doc.__selection.removeAllRanges();
}
function openDocument(frame) { resetDocument(frame.doc); frame.g.__l = new Map(); frame.doc.__l = new Map();   // document.open() erases the event listeners of the document and its window
	 frame.doc.readyState = 'loading'; frame.buf = ''; }
function writeDocument(frame, s) { if (frame.buf === undefined) { openDocument(frame); } frame.buf += s; }
function closeDocument(frame) { if (frame.buf === undefined) { return; } const html = frame.buf; frame.buf = undefined; loadHtml(frame, html); }

const attrsOf = (s) => { const out = {}; const re = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g; let m; while ((m = re.exec(s))) { out[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''; } return out; };

/** splits page text into the markup of its head and body and the attributes of the html and body tags: html/head/body tags (a page may contain several, the Markdown preview nests a whole document in another) are dropped from the text between scripts, scripts stay where they are */
export function splitHtml(html) {
	const parts = String(html).replace(/<!doctype[^>]*>/gi, '').split(/(<script\b[\s\S]*?<\/script>)/i); let headMarkup = '', bodyMarkup = '', inHead = false; const htmlAttrs = {}, bodyAttrs = {};
	for (let i = 0; i < parts.length; i++) {
		if (i % 2 === 1) { if (inHead) { headMarkup += parts[i]; } else { bodyMarkup += parts[i]; } continue; }
		const re = /<(\/?)(html|head|body)\b([^>]*)>/gi; let last = 0, m; const seg = parts[i];
		while ((m = re.exec(seg))) { const text = seg.slice(last, m.index); if (inHead) { headMarkup += text; } else { bodyMarkup += text; } last = re.lastIndex; const tag = m[2].toLowerCase(); if (tag === 'head') { inHead = !m[1]; } else if (!m[1]) { Object.assign(tag === 'html' ? htmlAttrs : bodyAttrs, attrsOf(m[3])); } }
		const rest = seg.slice(last); if (inHead) { headMarkup += rest; } else { bodyMarkup += rest; }
	}
	return { headMarkup, bodyMarkup, htmlAttrs, bodyAttrs };
}
export function mountMarkup(doc, el, markup) { const frag = D.parseFragment(doc, markup, el); for (const c of [...frag.__children]) { el.appendChild(c); } }

/** parses a page into the (reset) document of the frame, loads its stylesheets, runs its scripts in order, then fires DOMContentLoaded and (as a later task) load */
function loadHtml(frame, html) {
	const { doc, env } = frame; const baseUrl = frame.location.href;
	const { headMarkup, bodyMarkup, htmlAttrs, bodyAttrs } = splitHtml(html);
	for (const [k, v] of Object.entries(htmlAttrs)) { doc.documentElement.setAttribute(k, v); } for (const [k, v] of Object.entries(bodyAttrs)) { doc.body.setAttribute(k, v); }
	const saved = doc.__scanScripts; doc.__scanScripts = () => { };   // the scripts of the page run below, in document order, not on insertion
	mountMarkup(doc, doc.head, headMarkup); mountMarkup(doc, doc.body, bodyMarkup);
	const scripts = [];
	const walk = (n) => { for (const c of n.__children) { if (c.nodeType !== 1) { continue; } if (c.localName === 'link' && /stylesheet/i.test(c.getAttribute('rel') || '') && c.getAttribute('href')) { try { c.__linkText = decode(env.fetchResource(resolveUrl(c.getAttribute('href'), baseUrl))); } catch (e) { setTimeout(() => c.dispatchEvent(new D.ErrorEvent('error', {})), 0); } } if (c.localName === 'script') { scripts.push(c); } walk(c); } };
	walk(doc.documentElement); doc.__scanScripts = saved;
	for (const s of scripts) { s.__ran = true; }
	doc.__dirty = doc.__styleDirty = true;
	for (const s of scripts) {
		const type = (s.getAttribute('type') || 'text/javascript').toLowerCase(); const isModule = type === 'module'; if (!isModule && !/^(text|application)\/(javascript|ecmascript)$/.test(type)) { continue; }
		const src = s.getAttribute('src'); let code, name;
		if (src) { name = resolveUrl(src, baseUrl); try { code = decode(env.fetchResource(name)); } catch (e) { s.dispatchEvent(new D.ErrorEvent('error', { message: String(e && e.message || e) })); continue; } } else { code = s.textContent; name = baseUrl + '#inline'; }
		if (code) { runScript(frame.g, code, name, isModule); }
		if (src) { s.dispatchEvent(new D.Event('load')); }
	}
	doc.readyState = 'interactive'; doc.dispatchEvent(new D.Event('DOMContentLoaded', { bubbles: true }));
	setTimeout(() => { doc.readyState = 'complete'; doc.dispatchEvent(new D.Event('load', { bubbles: true })); frame.loaded = true; frame.el.dispatchEvent(new D.Event('load')); }, 0);
}

// ---- navigation -----------------------------------------------------------------------------------------------------------------------------------
function navigate(frame, href) {
	const id = ++frame.loadId; frame.loaded = false;
	setTimeout(() => {
		if (id !== frame.loadId) { return; } let html;
		try { html = /^(about:blank|about:srcdoc)?$/.test(href) ? BLANK : decode(frame.env.fetchDocument(href)); } catch (e) { html = '<!DOCTYPE html><html><body>' + String(e && e.message || e).replace(/</g, '&lt;') + '</body></html>'; setTimeout(() => frame.el.dispatchEvent(new D.ErrorEvent('error', {})), 0); }
		setFrameLocation(frame, href || 'about:blank'); resetDocument(frame.doc); loadHtml(frame, html);
	}, 0);
}

/** the frame of an iframe element, created when first needed while the element is in a document */
export function frameOf(el, create = true) {
	if (el.__frame) { return el.__frame; } if (!create || !el.isConnected) { return null; }
	const frame = el.__frame = createWindow(el); const src = el.getAttribute('src'); const srcdoc = el.getAttribute('srcdoc');
	if (srcdoc !== null) { navigate(frame, 'about:srcdoc'); frame.srcdoc = srcdoc; } else if (src) { navigate(frame, resolveUrl(src, el.ownerDocument.baseURI)); } else { navigate(frame, 'about:blank'); }
	return frame;
}

export const iframeProps = {
	get contentWindow() { const f = frameOf(this); return f ? f.g : null; },
	get contentDocument() { const f = frameOf(this); return f ? f.doc : null; },
	get sandbox() { return this.__sandbox ??= new D.DOMTokenList(this, 'sandbox'); },
	get allow() { return this.getAttribute('allow') ?? ''; }, set allow(v) { this.setAttribute('allow', v); },
	get srcdoc() { return this.getAttribute('srcdoc') ?? ''; }, set srcdoc(v) { this.setAttribute('srcdoc', v); },
	get frameBorder() { return this.getAttribute('frameborder') ?? ''; }, set frameBorder(v) { this.setAttribute('frameborder', v); },
	/** attribute changes that navigate the frame */
	__attrHook(name, value) { const f = this.__frame; if (!f) { return; } if (name === 'src') { navigate(f, resolveUrl(value, this.ownerDocument.baseURI)); } else if (name === 'srcdoc') { f.srcdoc = value; navigate(f, 'about:srcdoc'); } },
};

/** after a layout pass of the embedding document: make sure every iframe box has a frame and tell each frame the size of its viewport */
export function syncFrames(doc) {
	const lay = doc.__layout; if (!lay) { return 0; } let n = 0;
	for (const [el, box] of lay.boxOf) {
		if (el.localName !== 'iframe') { continue; } const f = frameOf(el); if (!f) { continue; }
		const w = Math.max(0, Math.round(box.w - box.hx)), h = Math.max(0, Math.round(box.h - box.vy)); if (w > 0 && h > 0) { f.env.resize(w, h); } n++;
	}
	return n;
}

/** the origin (in the coordinates of the outermost document) of the viewport of a frame's document */
export function originOf(d) {
	let ox = 0, oy = 0;
	for (let cur = d; cur.__parentDoc; cur = cur.__parentDoc) { const pd = cur.__parentDoc, fe = cur.__env.frameElement; const box = pd.__layout && pd.__layout.boxOf.get(fe); if (!box) { continue; } const r = pd.__rect(fe); ox += r.left + box.bl + (box.pl || 0); oy += r.top + box.bt + (box.pt || 0); }
	return [ox, oy];
}
/** the innermost element at a point of `doc`, looking through iframes: { el, doc, x, y } with the point in the coordinates of the returned document */
export function deepHit(doc, x, y) {
	let d = doc;
	for (;;) {
		const el = d.__hitTest(x, y, 1)[0] ?? null; if (!el) { return { el: d.body, doc: d, x, y }; }
		const f = el.localName === 'iframe' && el.__frame; if (!f) { return { el, doc: d, x, y }; }
		const box = d.__layout.boxOf.get(el), r = d.__rect(el); const lx = x - (r.left + box.bl + (box.pl || 0)), ly = y - (r.top + box.bt + (box.pt || 0));
		if (lx < 0 || ly < 0 || lx >= f.env.vw || ly >= f.env.vh) { return { el, doc: d, x, y }; }
		d = f.doc; x = lx; y = ly; d.__ensureLayout();
	}
}
