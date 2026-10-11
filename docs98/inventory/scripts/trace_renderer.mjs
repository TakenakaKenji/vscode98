// Runtime trace of the VS Code renderer (workbench window) over the Chrome DevTools Protocol.
//
// What it does:
//   1. Attaches to the running workbench page (Electron started with --remote-debugging-port=PORT).
//   2. Registers an init script that wraps DOM / Web API prototypes and constructors with call counters,
//      then reloads the window so the counters see the whole startup.
//   3. Waits SETTLE seconds, then collects: API call counts, a census of CSS declarations in loaded
//      stylesheets, and a census of computed styles over every element currently in the DOM.
//
// Usage (repo root):
//   node docs98/inventory/scripts/trace_renderer.mjs <port> <settleSeconds> <outFile.json>
//
// Needs `chrome-remote-interface` (already a root devDependency of the repo).

import CDP from 'chrome-remote-interface';
import { writeFileSync } from 'node:fs';

const [port = '9333', settle = '30', out = 'renderer-trace.json'] = process.argv.slice(2);

const INSTRUMENT = `(() => {
	if (globalThis.__trace) { return; }
	const counts = Object.create(null);
	const inc = k => { counts[k] = (counts[k] | 0) + 1; };
	globalThis.__trace = { counts };

	const interfaces = [
		'EventTarget', 'Node', 'Element', 'HTMLElement', 'Document', 'DocumentFragment', 'ShadowRoot', 'Window',
		'CSSStyleDeclaration', 'CSSStyleSheet', 'DOMTokenList', 'NamedNodeMap', 'Attr', 'Text', 'Range', 'Selection',
		'HTMLCanvasElement', 'CanvasRenderingContext2D', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLIFrameElement',
		'HTMLImageElement', 'HTMLAnchorElement', 'HTMLStyleElement', 'HTMLLinkElement', 'HTMLSlotElement',
		'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'MessagePort', 'MessageChannel', 'Worker',
		'Storage', 'Performance', 'Clipboard', 'DataTransfer', 'DataTransferItemList', 'History', 'Location',
		'Navigator', 'Screen', 'TextMetrics', 'IDBFactory', 'WebSocket', 'XMLHttpRequest', 'Blob', 'URL'
	];
	const skip = new Set(['constructor']);

	const wrapProto = (name) => {
		const C = globalThis[name];
		const proto = C && C.prototype;
		if (!proto) { return; }
		for (const key of Reflect.ownKeys(proto)) {
			if (typeof key !== 'string' || skip.has(key)) { continue; }
			const d = Object.getOwnPropertyDescriptor(proto, key);
			if (!d || !d.configurable) { continue; }
			try {
				if (typeof d.value === 'function') {
					const orig = d.value, id = name + '.' + key + '()';
					Object.defineProperty(proto, key, { ...d, value: function () { inc(id); return Reflect.apply(orig, this, arguments); } });
				} else if (d.get || d.set) {
					const nd = { ...d };
					if (d.get) { const g = d.get, id = name + '.' + key + ' (get)'; nd.get = function () { inc(id); return Reflect.apply(g, this, []); }; }
					if (d.set) { const s = d.set, id = name + '.' + key + ' (set)'; nd.set = function (v) { inc(id); return Reflect.apply(s, this, [v]); }; }
					Object.defineProperty(proto, key, nd);
				}
			} catch { /* some properties cannot be redefined */ }
		}
	};
	interfaces.forEach(wrapProto);

	// Constructors: count "new X".
	const ctorPaths = [
		'Worker', 'SharedWorker', 'MessageChannel', 'ResizeObserver', 'MutationObserver', 'IntersectionObserver',
		'WebSocket', 'XMLHttpRequest', 'Blob', 'TextDecoder', 'TextEncoder', 'AbortController', 'OffscreenCanvas',
		'FontFace', 'BroadcastChannel', 'EventSource', 'WeakRef', 'FinalizationRegistry', 'Proxy',
		'Intl.Segmenter', 'Intl.Collator', 'Intl.DateTimeFormat', 'Intl.NumberFormat', 'Intl.RelativeTimeFormat',
		'Intl.PluralRules', 'Intl.ListFormat', 'Intl.DisplayNames', 'WebAssembly.Module', 'WebAssembly.Instance',
		'WebAssembly.Memory', 'WebAssembly.Table', 'SharedArrayBuffer', 'DOMParser', 'Image', 'Audio', 'Notification'
	];
	for (const p of ctorPaths) {
		const parts = p.split('.'); const prop = parts.pop();
		const holder = parts.reduce((o, k) => o && o[k], globalThis);
		const C = holder && holder[prop];
		if (typeof C !== 'function') { continue; }
		try {
			holder[prop] = new Proxy(C, { construct(t, a, nt) { inc('new ' + p); return Reflect.construct(t, a, nt); }, apply(t, th, a) { inc(p + '()'); return Reflect.apply(t, th, a); } });
		} catch { /* ignore */ }
	}

	// Namespace functions.
	const fnPaths = [
		'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'setTimeout', 'setInterval', 'queueMicrotask',
		'getComputedStyle', 'matchMedia', 'fetch', 'structuredClone', 'postMessage', 'open', 'getSelection', 'createImageBitmap',
		'WebAssembly.instantiate', 'WebAssembly.compile', 'WebAssembly.instantiateStreaming', 'WebAssembly.compileStreaming',
		'CSS.supports', 'CSS.escape', 'navigator.clipboard.readText', 'navigator.clipboard.writeText',
		'crypto.getRandomValues', 'crypto.randomUUID', 'crypto.subtle.digest', 'performance.now', 'performance.mark', 'performance.measure'
	];
	for (const p of fnPaths) {
		const parts = p.split('.'); const prop = parts.pop();
		const holder = parts.reduce((o, k) => o && o[k], globalThis);
		if (!holder || typeof holder[prop] !== 'function') { continue; }
		const orig = holder[prop];
		try { holder[prop] = function () { inc(p + '()'); return Reflect.apply(orig, this, arguments); }; } catch { /* ignore */ }
	}
})();`;

const CENSUS = `(() => {
	const out = { stylesheets: {}, computed: {}, dom: {} };

	// 1. Declarations in loaded stylesheets
	const props = Object.create(null), atRules = Object.create(null), selectors = Object.create(null);
	const bump = (o, k, n = 1) => { o[k] = (o[k] | 0) + n; };
	const selFeatures = [[':has(', /:has\\(/], [':is()/:where()', /:(is|where)\\(/], [':not()', /:not\\(/], ['::before/::after', /::?(before|after)/],
		['::-webkit-scrollbar', /::-webkit-scrollbar/], [':hover', /:hover/], [':focus-visible/focus-within', /:focus-(visible|within)/],
		['attribute selector', /\\[[^\\]]+\\]/], [':nth-*', /:nth-/], [':first/last-child', /:(first|last)-(child|of-type)/],
		['sibling combinators + ~', /[+~]/], ['child combinator >', />/], ['::selection/::placeholder', /::(selection|placeholder)/], ['nesting &', /&/]];
	let rules = 0, sheets = 0;
	const walk = (list) => {
		for (const r of list) {
			rules++;
			bump(atRules, r.constructor.name);
			if (r.selectorText) { for (const [n, re] of selFeatures) { if (re.test(r.selectorText)) { bump(selectors, n); } } }
			if (r.style) { for (let i = 0; i < r.style.length; i++) { bump(props, r.style[i]); } }
			if (r.cssRules) { walk(r.cssRules); }
		}
	};
	const all = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
	for (const s of all) { try { sheets++; walk(s.cssRules); } catch { /* cross-origin */ } }
	out.stylesheets = { sheets, rules, properties: props, ruleTypes: atRules, selectorFeatures: selectors };

	// 2. Computed style census over live DOM
	const cs = Object.create(null);
	const keys = ['display', 'position', 'float', 'overflow-x', 'overflow-y', 'visibility', 'white-space', 'text-overflow', 'cursor', 'pointer-events',
		'user-select', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'box-sizing', 'text-align', 'text-decoration-line', 'font-style', 'font-weight'];
	const flags = {
		'transform != none': e => e.transform !== 'none', 'filter != none': e => e.filter !== 'none', 'backdrop-filter != none': e => e.backdropFilter && e.backdropFilter !== 'none',
		'box-shadow != none': e => e.boxShadow !== 'none', 'border-radius != 0': e => e.borderTopLeftRadius !== '0px', 'opacity < 1': e => parseFloat(e.opacity) < 1,
		'z-index set': e => e.zIndex !== 'auto', 'background-image set': e => e.backgroundImage !== 'none', 'mask/clip-path': e => (e.maskImage && e.maskImage !== 'none') || (e.clipPath && e.clipPath !== 'none'),
		'transition set': e => e.transitionDuration !== '0s', 'animation set': e => e.animationName !== 'none', 'outline set': e => e.outlineStyle !== 'none',
		'::before content': null, 'will-change set': e => e.willChange !== 'auto', 'contain set': e => e.contain !== 'none', 'position: sticky': e => e.position === 'sticky'
	};
	let n = 0, maxDepth = 0, shadowRoots = 0, iframes = 0, canvases = 0, inputs = 0, contentEditable = 0, svg = 0, texts = 0;
	const tags = Object.create(null);
	const visit = (root, depth) => {
		for (const el of root.querySelectorAll('*')) {
			n++; bump(tags, el.tagName.toLowerCase());
			const st = getComputedStyle(el);
			for (const k of keys) { bump(cs, k + ': ' + st.getPropertyValue(k)); }
			for (const [name, fn] of Object.entries(flags)) { if (fn && fn(st)) { bump(cs, 'FLAG ' + name); } }
			const b = getComputedStyle(el, '::before').content; if (b && b !== 'none' && b !== 'normal') { bump(cs, 'FLAG ::before content'); }
			const a = getComputedStyle(el, '::after').content; if (a && a !== 'none' && a !== 'normal') { bump(cs, 'FLAG ::after content'); }
			let d = 0; for (let p = el; p; p = p.parentElement) { d++; } if (d + depth > maxDepth) { maxDepth = d + depth; }
			if (el.shadowRoot) { shadowRoots++; visit(el.shadowRoot, d); }
			if (el.tagName === 'IFRAME' || el.tagName === 'WEBVIEW') { iframes++; }
			if (el.tagName === 'CANVAS') { canvases++; }
			if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { inputs++; }
			if (el.isContentEditable && el.getAttribute('contenteditable') !== null) { contentEditable++; }
			if (el instanceof SVGElement) { svg++; }
		}
	};
	visit(document, 0);
	out.computed = cs;
	out.dom = { elements: n, maxDepth, shadowRoots, iframes, canvases, inputsAndTextareas: inputs, contentEditable, svgElements: svg, tags };
	out.viewport = { w: innerWidth, h: innerHeight, dpr: devicePixelRatio };
	out.fonts = [...new Set([...document.fonts].map(f => f.family))];
	return out;
})()`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Find the workbench page target.
let target;
for (let i = 0; i < 60 && !target; i++) {
	try {
		const list = await CDP.List({ port: Number(port) });
		target = list.find(t => t.type === 'page' && /workbench/.test(t.url));
	} catch { /* not up yet */ }
	if (!target) { await sleep(1000); }
}
if (!target) { console.error('No workbench page target found on port ' + port); process.exit(2); }
console.error('attached to', target.url);

const client = await CDP({ port: Number(port), target });
const { Page, Runtime, Emulation } = client;
await Page.enable(); await Runtime.enable();
// Headless windows default to a tiny viewport, which hides most of the UI; emulate a normal desktop size.
await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await Page.addScriptToEvaluateOnNewDocument({ source: INSTRUMENT });
const t0 = Date.now();
await Page.reload({ ignoreCache: false });
console.error('reloaded; settling for ' + settle + 's');
await sleep(Number(settle) * 1000);

const ev = async (expression) => {
	const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) { throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); }
	return r.result.value;
};

const counts = await ev('globalThis.__trace ? globalThis.__trace.counts : null');
const census = await ev(CENSUS);
const timing = await ev(`(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { domContentLoaded: n.domContentLoadedEventEnd, loadEvent: n.loadEventEnd } : null; })()`);
const heap = await client.send('Runtime.getHeapUsage').catch(() => null);

const sorted = o => Object.fromEntries(Object.entries(o || {}).sort((a, b) => b[1] - a[1]));
writeFileSync(out, JSON.stringify({
	takenAt: new Date().toISOString(), settleSeconds: Number(settle), msSinceReload: Date.now() - t0, timing, heapUsage: heap,
	apiCounts: sorted(counts), census: { ...census, computed: sorted(census.computed), stylesheets: { ...census.stylesheets, properties: sorted(census.stylesheets.properties) } }
}, null, 1));
console.error('wrote ' + out);
await client.close();
process.exit(0);
