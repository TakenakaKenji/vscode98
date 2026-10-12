// JS half of the native module loader (esm.c): Node-style resolution (+ module.registerHooks resolve hooks) and CommonJS/data-URL loading for ES modules.
//   globalThis.__esmResolve(specifier, importerName) -> module name (absolute path, data: URL, or a qjs:/spike: builtin)
//   globalThis.__esmLoad(moduleName)                  -> undefined (stock file loader) | { format: 'module', source, url } | { format: 'commonjs', exports }
import * as std from 'qjs:std';
import * as os from 'qjs:os';

export function installEsm(outDir) {
	const Module = globalThis.__builtins.module; const P = globalThis.__builtins.path;   // `path` is win32 flavoured on Windows
	const shimDirs = [P.join(outDir, 'shims') + P.sep, P.join(outDir + '.impl') + P.sep];
	const dirname = (p) => P.dirname(p);
	const kind = (p) => { const [o, e] = os.stat(p); return e ? 0 : (o.mode & 0o170000) === 0o040000 ? 2 : 1; };
	const toUrl = (name) => P.isAbsolute(name) ? P.toFileUrl(name) : name;
	const fromUrl = (url) => url.startsWith('file://') ? P.fromFileUrl(url) : url;
	const notFound = (spec, base) => Object.assign(new Error(`Cannot find module '${spec}' imported from ${base || '<entry>'}`), { code: 'ERR_MODULE_NOT_FOUND' });

	function defaultResolve(spec, ctx) {
		if (/^(qjs|spike):/.test(spec) || spec.startsWith('data:')) { return { url: spec }; }
		if (Module.isBuiltin(spec)) { return { url: toUrl(`${outDir}/shims/${spec.replace(/^node:/, '').replace(/\//g, '__')}.js`) }; }
		if (spec.startsWith('file://')) { return { url: spec }; }
		const parent = ctx.parentURL && !ctx.parentURL.startsWith('data:') ? fromUrl(ctx.parentURL) : P.join(P.resolve('.'), 'x');
		let path;
		if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') { path = P.resolve(dirname(parent), spec); }
		else if (P.isAbsolute(spec)) { path = P.normalize(spec); }
		else { path = Module._resolveBareEsm(spec, dirname(parent)); if (!path) { throw notFound(spec, parent); } }
		if (kind(path) === 2) { const idx = ['index.mjs', 'index.js', 'index.cjs'].map(f => P.join(path, f)).find(f => kind(f) === 1); if (idx) { path = idx; } }
		if (kind(path) !== 1) { throw notFound(spec, parent); }
		return { url: toUrl(path) };
	}
	function normalise(p) { const out = []; for (const seg of p.split('/')) { if (seg === '..') { out.pop(); } else if (seg !== '.' && seg !== '') { out.push(seg); } } return '/' + out.join('/'); }

	globalThis.__esmResolve = (spec, base) => {
		const ctx = { conditions: ['node', 'import', 'module-sync'], importAttributes: {}, parentURL: base ? toUrl(base) : undefined };
		let next = defaultResolve;
		for (const h of Module.__hooks) { if (h && typeof h.resolve === 'function') { const prev = next; next = (s, c) => h.resolve(s, c ?? ctx, prev); } }
		const r = next(spec, ctx);
		return fromUrl(r.url);
	};

	const pkgType = (file) => { for (let d = dirname(file); d && d !== dirname(d); d = dirname(d)) { const pj = P.join(d, 'package.json'); if (kind(pj) === 1) { try { return JSON.parse(std.loadFile(pj)).type || null; } catch { return null; } } } return null; };
	// Node 24 detects ES-module syntax in .js files that have no "type" by parsing them. Spike shortcut: scan the head (hoisted imports) and tail (export lists) with a regex.
	const esmSyntax = /(^|[;}\n])\s*(import\s*(\{|\*|[\w$]+\s*(,|from\b)|["'])|export\s*(\{|\*|default\b|(const|let|var|function|class|async)\b))|\bimport\.meta\b/;
	const looksLikeEsm = (src) => esmSyntax.test(src.slice(0, 65536)) || (src.length > 65536 && esmSyntax.test(src.slice(-8192)));
	globalThis.__esmLoad = (name) => {
		if (name.startsWith('data:')) {
			const m = /^data:([^,;]*)((?:;[^,;]*)*),(.*)$/s.exec(name); if (!m) { throw new TypeError('Invalid data: URL'); }
			const source = m[2].includes(';base64') ? new TextDecoder().decode(Uint8Array.from(atob(m[3]), c => c.charCodeAt(0))) : decodeURIComponent(m[3]);
			return { format: 'module', source, url: name };
		}
		if (!P.isAbsolute(name) || shimDirs.some(d => name.startsWith(d))) { return undefined; }
		if (name.endsWith('.mjs')) { return { format: 'module', source: std.loadFile(name), url: toUrl(name), filename: name, dirname: dirname(name) }; }
		if (name.endsWith('.json')) { return { format: 'commonjs', exports: JSON.parse(std.loadFile(name)) }; }
		let esm = false;
		if (name.endsWith('.js')) { const t = pkgType(name); esm = t === 'module' || (t === null && looksLikeEsm(std.loadFile(name))); }
		if (esm) { return { format: 'module', source: std.loadFile(name), url: toUrl(name), filename: name, dirname: dirname(name) }; }   // read here so import.meta.dirname/filename can be set
		return { format: 'commonjs', exports: Module._load(name, null, false) };
	};
}
