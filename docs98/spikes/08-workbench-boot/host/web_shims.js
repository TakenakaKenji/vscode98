// Browser APIs the web workbench needs that the spike 6 environment does not provide yet (grown iteratively while booting).
export function workbenchConfig(base) {
	return { callbackRoute: '/callback', settingsSyncOptions: { enabled: false }, additionalBuiltinExtensions: [], developmentOptions: {}, _wrapWebWorkerExtHostInWorkerBlob: false };
}
export function installWebShims(env, { baseUrl, readFile }) {
	const g = env.window; const def = (k, v) => { if (!(k in g) || g[k] === undefined) { Object.defineProperty(g, k, { value: v, writable: true, configurable: true, enumerable: false }); } };
	const force = (k, v) => Object.defineProperty(g, k, { value: v, writable: true, configurable: true, enumerable: false });
	const u = typeof URL !== 'undefined' ? new URL(baseUrl + '/') : { href: baseUrl + '/', origin: baseUrl, protocol: 'http:', host: baseUrl.replace(/^https?:\/\//, ''), hostname: 'localhost', port: '8080', pathname: '/' };
	Object.assign(g.location, { href: u.href, origin: u.origin, protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: '', hash: '' }); force('origin', u.origin);
	// ---- performance: user timing + navigation entries (QuickJS only has performance.now)
	const perf = g.performance; const entries = [];
	const addEntry = (e) => { entries.push(e); return e; };
	if (!perf.mark) { const methods = {
		timeOrigin: Date.now() - perf.now(), timing: { navigationStart: Date.now() - perf.now() },
		mark(name, o) { return addEntry({ name, entryType: 'mark', startTime: o && o.startTime !== undefined ? o.startTime : perf.now(), duration: 0, detail: o && o.detail || null }); },
		measure(name, a, b) { const find = (n) => { const e = [...entries].reverse().find(x => x.name === n && x.entryType === 'mark'); if (!e) { throw new SyntaxError(`The "${n}" performance mark has not been set`); } return e.startTime; }; const s0 = typeof a === 'string' ? find(a) : (a && a.start !== undefined ? a.start : 0); const e0 = typeof b === 'string' ? find(b) : perf.now(); return addEntry({ name, entryType: 'measure', startTime: s0, duration: e0 - s0 }); },
		getEntries() { return entries.slice(); }, getEntriesByName(n, t) { return entries.filter(e => e.name === n && (!t || e.entryType === t)); }, getEntriesByType(t) { return t === 'navigation' ? [{ name: 'document', entryType: 'navigation', type: 'navigate', startTime: 0, duration: 0 }] : entries.filter(e => e.entryType === t); },
		clearMarks(n) { for (let i = entries.length - 1; i >= 0; i--) { if (entries[i].entryType === 'mark' && (!n || entries[i].name === n)) { entries.splice(i, 1); } } }, clearMeasures() { }, toJSON() { return {}; },
	}; const np = { now: () => perf.now() }; for (const k of Object.keys(methods)) { np[k] = methods[k]; } force('performance', np); }
	def('PerformanceObserver', class { constructor() { } observe() { } disconnect() { } takeRecords() { return []; } static get supportedEntryTypes() { return []; } });
	// ---- abort
	if (typeof g.AbortSignal === 'undefined' && typeof g.AbortController !== 'undefined') { const S = new g.AbortController().signal.constructor; S.abort ??= (reason) => { const c = new g.AbortController(); c.abort(reason); return c.signal; }; S.timeout ??= (ms) => { const c = new g.AbortController(); setTimeout(() => c.abort(new Error('TimeoutError')), ms); return c.signal; }; S.any ??= (list) => { const c = new g.AbortController(); for (const s of list) { if (s.aborted) { c.abort(s.reason); break; } s.addEventListener('abort', () => c.abort(s.reason)); } return c.signal; }; force('AbortSignal', S); }
	// ---- fetch: files below <base>/out/ come from disk, everything else is "offline"
	class Headers { constructor(init) { this.m = new Map(); if (init) { for (const [k, v] of (init instanceof Headers ? init.m : Array.isArray(init) ? init : Object.entries(init))) { this.m.set(String(k).toLowerCase(), String(v)); } } } get(k) { return this.m.get(String(k).toLowerCase()) ?? null; } set(k, v) { this.m.set(String(k).toLowerCase(), String(v)); } has(k) { return this.m.has(String(k).toLowerCase()); } append(k, v) { this.set(k, v); } delete(k) { this.m.delete(String(k).toLowerCase()); } forEach(fn) { this.m.forEach((v, k) => fn(v, k, this)); } entries() { return this.m.entries(); } keys() { return this.m.keys(); } values() { return this.m.values(); } [Symbol.iterator]() { return this.m.entries(); } }
	class Response { constructor(body, init = {}) { this._body = body ?? null; this.status = init.status ?? 200; this.statusText = init.statusText ?? ''; this.ok = this.status >= 200 && this.status < 300; this.headers = new Headers(init.headers); this.url = init.url ?? ''; this.type = 'basic'; this.redirected = false; this.bodyUsed = false; }
		async arrayBuffer() { this.bodyUsed = true; const b = this._body; if (b instanceof ArrayBuffer) { return b; } if (ArrayBuffer.isView(b)) { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } return new TextEncoder().encode(String(b ?? '')).buffer; }
		async text() { const b = this._body; if (typeof b === 'string') { this.bodyUsed = true; return b; } return new TextDecoder().decode(await this.arrayBuffer()); } async json() { return JSON.parse(await this.text()); } async blob() { return new g.Blob([await this.arrayBuffer()]); } clone() { return new Response(this._body, this); } static error() { return new Response(null, { status: 0 }); } }
	class Request { constructor(input, init = {}) { this.url = typeof input === 'string' ? input : input.url; this.method = init.method || 'GET'; this.headers = new Headers(init.headers); this.signal = init.signal ?? null; this.body = init.body ?? null; } }
	force('Headers', Headers); force('Response', Response); force('Request', Request);
	force('fetch', async (input, init) => { const url = typeof input === 'string' ? input : input.url; const prefix = baseUrl + '/out/';
		if (readFile && url.startsWith(prefix)) { try { const p = url.slice(prefix.length).replace(/[?#].*$/, ''); return new Response(readFile(p), { url, headers: { 'content-type': p.endsWith('.json') ? 'application/json' : 'application/octet-stream' } }); } catch (e) { return new Response('not found', { status: 404, url }); } }
		throw new TypeError('Failed to fetch (offline): ' + url); });
	// ---- misc constructors a browser has
	def('Blob', class { constructor(parts = [], o = {}) { this.parts = parts; this.type = o.type || ''; this.size = parts.reduce((n, p) => n + (typeof p === 'string' ? p.length : p.byteLength ?? p.size ?? 0), 0); } async text() { return this.parts.map(p => typeof p === 'string' ? p : new TextDecoder().decode(p)).join(''); } async arrayBuffer() { return new TextEncoder().encode(await this.text()).buffer; } slice() { return this; } });
	def('File', class extends g.Blob { constructor(parts, name, o) { super(parts, o); this.name = name; this.lastModified = Date.now(); } });
	def('FormData', class { constructor() { this.m = []; } append(k, v) { this.m.push([k, v]); } get(k) { return (this.m.find(e => e[0] === k) || [])[1] ?? null; } });
	def('BroadcastChannel', class extends g.EventTarget { constructor(name) { super(); this.name = name; } postMessage() { } close() { } });
	def('MessagePort', g.MessageChannel ? new g.MessageChannel().port1.constructor : class { });
	def('Worker', class extends g.EventTarget { constructor(url) { super(); this.url = String(url); queueMicrotask(() => { const ev = new g.Event('error'); ev.message = 'Workers are not available in this host'; this.dispatchEvent(ev); }); } postMessage() { } terminate() { } });
	def('SharedWorker', g.Worker); def('XMLHttpRequest', class { open() { } send() { throw new Error('XMLHttpRequest is not available'); } setRequestHeader() { } });
	def('WebSocket', class extends g.EventTarget { constructor() { super(); throw new Error('WebSocket is not available'); } });
}

/** resolve a relative URL reference against a base URL string (no dependency on the URL class) */
export function resolveUrl(rel, base) {
	if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) { return rel; }
	const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)(\/[^?#]*)?/i.exec(base); const origin = m[1]; const dir = (m[2] || '/').replace(/[^/]*$/, '');
	const parts = (rel.startsWith('/') ? rel : dir + rel).split('/'); const out = [];
	for (const p of parts) { if (p === '..') { out.pop(); } else if (p !== '.') { out.push(p); } }
	return origin + out.join('/');
}
/** make the url(...) references of a stylesheet absolute, as the browser does when it fetches the stylesheet from `href` */
export function absolutizeCssUrls(css, href) {
	return css.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/g, (all, q, u) => (/^(data:|#)/.test(u) ? all : `url(${q}${resolveUrl(u, href)}${q})`));
}

/** Builds the page from the product's workbench.html: placeholders replaced, module scripts left to the caller, stylesheets inlined (with absolute url()s). */
export function preparePage(doc, parseFragment, { html, base, readText, webDir }) {
	html = html.replaceAll('{{WORKBENCH_WEB_CONFIGURATION}}', JSON.stringify(workbenchConfig(base)).replace(/"/g, '&quot;')).replaceAll('{{WORKBENCH_WEB_BASE_URL}}', base).replaceAll('{{WORKBENCH_AUTH_SESSION}}', '').replace(/<script[^>]*type="module"[^>]*><\/script>/g, '').replace(/<!doctype[^>]*>/i, '');
	const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html), body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
	const mount = (el, markup) => { const f = parseFragment(doc, markup, el); for (const c of [...f.__children]) { el.appendChild(c); } };
	mount(doc.head, head[1]); mount(doc.body, body[1]);
	for (const el of doc.head.__children) { if (el.localName === 'link' && el.getAttribute('rel') === 'stylesheet') { const href = el.getAttribute('href'); el.__linkText = absolutizeCssUrls(readText(webDir + '/' + href.replace(base + '/out/', '')), href); } }
}
