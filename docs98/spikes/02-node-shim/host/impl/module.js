// `module` shim: a small CommonJS loader on QuickJS, shaped like Node's so that VS Code's extension host can patch it.
// The extension host replaces Module._load / _resolveFilename / _resolveLookupPaths (to intercept require('vscode')) and calls
// module.createRequire(import.meta.url) and module.registerHooks(...). Everything below goes through `Module._load` on purpose.
import * as os from 'qjs:os';
import * as std from 'qjs:std';
import * as nodePath from './path.js';

const { dirname, join, resolve, extname, isAbsolute } = nodePath;
const kind = (p) => { const [o, e] = os.stat(p); return e ? 0 : (o.mode & 0o170000) === 0o040000 ? 2 : 1; };   // 0 = missing, 1 = file, 2 = directory
const readText = (p) => { const s = std.loadFile(p); if (s === null) { throw Object.assign(new Error(`ENOENT: cannot read '${p}'`), { code: 'ENOENT' }); } return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; };
const toPath = (f) => String(f).startsWith('file://') ? decodeURIComponent(String(f).slice(7)) : String(f);
const NODE_CONDITIONS = ['node', 'require', 'module-sync', 'default'];
globalThis.__builtins ??= {};
const hooks = [];
const traceRequire = !!std.getenv('TRACE_REQUIRE');

function moduleNotFound(request, parent) { const e = new Error(`Cannot find module '${request}'\nRequire stack:\n- ${parent && parent.filename || '<repl>'}`); e.code = 'MODULE_NOT_FOUND'; return e; }

function pickExport(target, conditions) {            // package.json "exports" target resolution (strings, condition objects, arrays)
	if (typeof target === 'string') { return target; }
	if (Array.isArray(target)) { for (const t of target) { const r = pickExport(t, conditions); if (r) { return r; } } return undefined; }
	if (target && typeof target === 'object') { for (const k of Object.keys(target)) { if (conditions.includes(k)) { const r = pickExport(target[k], conditions); if (r) { return r; } } } }
	return undefined;
}
function tryFile(p) { if (kind(p) === 1) { return p; } for (const ext of ['.js', '.json', '.cjs']) { if (kind(p + ext) === 1) { return p + ext; } } return undefined; }
function tryDirectory(p) {
	if (kind(p) !== 2) { return undefined; }
	const pj = join(p, 'package.json');
	if (kind(pj) === 1) { try { const main = JSON.parse(readText(pj)).main; if (main) { const r = tryFile(resolve(p, main)) || tryIndex(resolve(p, main)); if (r) { return r; } } } catch { /* fall through to index */ } }
	return tryIndex(p);
}
function tryIndex(p) { for (const f of ['index.js', 'index.json', 'index.cjs']) { if (kind(join(p, f)) === 1) { return join(p, f); } } return undefined; }
function resolveInPackage(dir, name, sub) {            // dir/node_modules entry `name` with subpath `sub` ('' or '/x/y')
	const pkgDir = join(dir, name); if (kind(pkgDir) !== 2) { return undefined; }
	const pj = join(pkgDir, 'package.json');
	if (kind(pj) === 1) {
		let ex; try { ex = JSON.parse(readText(pj)).exports; } catch { ex = undefined; }
		if (ex !== undefined) {
			let target;
			if (typeof ex === 'string' || Array.isArray(ex) || (ex && !Object.keys(ex).some(k => k.startsWith('.')))) { target = sub === '' ? pickExport(ex, NODE_CONDITIONS) : undefined; }
			else { const key = sub === '' ? '.' : '.' + sub; target = ex[key] !== undefined ? pickExport(ex[key], NODE_CONDITIONS) : undefined; if (target === undefined) { for (const k of Object.keys(ex)) { if (k.endsWith('/*') && key.startsWith(k.slice(0, -1))) { const t = pickExport(ex[k], NODE_CONDITIONS); if (t) { target = t.replace('*', key.slice(k.length - 1)); break; } } } } }
			if (target) { const f = resolve(pkgDir, target); return kind(f) === 1 ? f : tryFile(f); }
			return undefined;
		}
	}
	return sub === '' ? tryDirectory(pkgDir) : (tryFile(join(pkgDir, sub)) || tryDirectory(join(pkgDir, sub)));
}

// require(esm): Node 24 loads ES modules synchronously from require(); QuickJS can only import() them asynchronously from JS. Until the host has a native
// sync module loader, ESM-only dependencies must be pre-bundled to CommonJS ahead of time (what VS Code's own extension build does). Pre-bundled copies are
// looked up in OVERLAY_DIR as <path with / replaced by __>.cjs.
const overlayDir = std.getenv('ESM_OVERLAY_DIR') || '';
function nearestPackageType(file) { for (let d = dirname(file); d && d !== '/'; d = dirname(d)) { const pj = join(d, 'package.json'); if (kind(pj) === 1) { try { return JSON.parse(readText(pj)).type || 'commonjs'; } catch { return 'commonjs'; } } } return 'commonjs'; }
function isEsmFile(file) { const e = extname(file); return e === '.mjs' || (e === '.js' && nearestPackageType(file) === 'module'); }
function esmError(file) { const e = new Error(`require() of ES Module ${file} is not supported by this host (no synchronous module loader); pre-bundle it to CommonJS`); e.code = 'ERR_REQUIRE_ESM'; return e; }

export class Module {
	constructor(id = '', parent) { this.id = id; this.path = dirname(id); this.exports = {}; this.filename = null; this.loaded = false; this.children = []; this.paths = []; this.parent = parent; }
	require(id) { return Module._load(id, this, false); }
	load(filename) {
		this.filename = filename; this.paths = Module._nodeModulePaths(dirname(filename));
		if (extname(filename) === '.json') { this.exports = JSON.parse(readText(filename)); }
		else if (isEsmFile(filename)) {
			const overlay = overlayDir ? `${overlayDir}/${filename.replace(/\//g, '__')}.cjs` : '';
			if (overlay && kind(overlay) === 1) { this._compile(readText(overlay), filename); } else { throw esmError(filename); }
		} else { this._compile(readText(filename), filename); }
		this.loaded = true;
	}
	_compile(content, filename) {
		const src = content.startsWith('#!') ? '//' + content : content;
		let fn; try { fn = new Function('exports', 'require', 'module', '__filename', '__dirname', src + '\n//# sourceURL=' + filename); } catch (e) { e.message += ` (while compiling ${filename})`; throw e; }
		fn.call(this.exports, this.exports, makeRequire(this), this, filename, dirname(filename));
	}
}
Module._cache = Object.create(null);
Module._extensions = { '.js': null, '.json': null, '.node': null };
Module.builtinModules = ['assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'];
Module.isBuiltin = (name) => { const n = String(name).replace(/^node:/, ''); return String(name).startsWith('node:') || Module.builtinModules.includes(n.split('/')[0]) && (n.indexOf('/') < 0 || ['fs/promises', 'path/posix', 'path/win32', 'stream/promises', 'timers/promises', 'util/types', 'dns/promises', 'readline/promises', 'assert/strict'].includes(n)); };
Module.wrap = (s) => '(function (exports, require, module, __filename, __dirname) { ' + s + '\n});';
Module._nodeModulePaths = (from) => { const parts = resolve(from).split('/').filter(Boolean); const out = []; for (let i = parts.length; i >= 0; i--) { if (parts[i - 1] === 'node_modules') { continue; } out.push('/' + parts.slice(0, i).join('/') + (i ? '/' : '') + 'node_modules'); } return out; };
Module._resolveLookupPaths = (request, parent) => (request.startsWith('./') || request.startsWith('../') ? [parent && parent.filename ? dirname(parent.filename) : '.'] : (parent && parent.paths ? parent.paths.slice() : Module._nodeModulePaths(os.getcwd()[0])));
Module._resolveFilename = function (request, parent, isMain, options) {
	if (Module.isBuiltin(request)) { return request; }
	let found;
	if (request.startsWith('./') || request.startsWith('../') || request === '.' || request === '..' || isAbsolute(request)) {
		const base = isAbsolute(request) ? request : resolve(parent && parent.filename ? dirname(parent.filename) : os.getcwd()[0], request);
		found = tryFile(base) || tryDirectory(base);
	} else {
		const m = /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(request); const name = m[1], sub = m[2] || '';
		const dirs = options && Array.isArray(options.paths) ? options.paths.flatMap(p => [p, ...Module._nodeModulePaths(p)]) : Module._resolveLookupPaths(request, parent);
		for (const d of dirs) { found = resolveInPackage(d.endsWith('node_modules') ? d : join(d, 'node_modules'), name, sub) || (d.endsWith('node_modules') ? undefined : resolveInPackage(d, name, sub)); if (found) { break; } }
	}
	if (!found) { throw moduleNotFound(request, parent); }
	return found;
};
Module._load = function (request, parent, isMain) {
	if (Module.isBuiltin(request)) { const n = String(request).replace(/^node:/, ''); return globalThis.__builtins[n] ?? globalThis.__stub('builtin', n); }
	const filename = Module._resolveFilename(request, parent, isMain);
	const cached = Module._cache[filename]; if (cached) { return cached.exports; }
	if (traceRequire) { std.err.puts('[require] ' + filename + '\n'); std.err.flush(); }
	const m = new Module(filename, parent); Module._cache[filename] = m; if (parent && parent.children) { parent.children.push(m); }
	try { m.load(filename); } catch (e) { delete Module._cache[filename]; throw e; }
	return m.exports;
};
function makeRequire(mod) {
	const req = (id) => mod.require(id);                         // goes through Module._load, so patches (VS Code's vscode-API interceptor) apply
	req.resolve = (id, opts) => Module._resolveFilename(id, mod, false, opts);
	req.resolve.paths = (id) => Module._resolveLookupPaths(id, mod);
	req.cache = Module._cache; req.main = undefined; req.extensions = Module._extensions;
	return req;
}
export function createRequire(filename) { const f = toPath(filename); const m = new Module(f); m.filename = f; m.paths = Module._nodeModulePaths(dirname(f)); return makeRequire(m); }
export function registerHooks(h) { hooks.push(h); return { deregister() { const i = hooks.indexOf(h); if (i >= 0) { hooks.splice(i, 1); } } }; }
export const builtinModules = Module.builtinModules; export const isBuiltin = Module.isBuiltin; export const _cache = Module._cache;
export function enableCompileCache() { return { status: 0 }; }
export function syncBuiltinESMExports() { }
Module.createRequire = createRequire; Module.registerHooks = registerHooks; Module.enableCompileCache = enableCompileCache; Module.syncBuiltinESMExports = syncBuiltinESMExports; Module.Module = Module;
Module.__hooks = hooks;
globalThis.__builtins.module = Module;
export default Module;
