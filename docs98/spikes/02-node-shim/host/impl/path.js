// Minimal POSIX `path` for the spike. (A production shim would reuse VS Code's own vs/base/common/path, a port of Node's, which also has win32.)
export const sep = '/'; export const delimiter = ':';
export function normalize(p) {
	if (p === '') { return '.'; }
	const abs = p.startsWith('/'); const trail = p.endsWith('/'); const out = [];
	for (const seg of p.split('/')) { if (!seg || seg === '.') { continue; } if (seg === '..') { if (out.length && out[out.length - 1] !== '..') { out.pop(); } else if (!abs) { out.push('..'); } } else { out.push(seg); } }
	let r = out.join('/'); if (!r && !abs) { r = '.'; } if (r && trail) { r += '/'; } return (abs ? '/' : '') + r;
}
export function join(...a) { const j = a.filter(Boolean).join('/'); return j ? normalize(j) : '.'; }
export function isAbsolute(p) { return p.startsWith('/'); }
export function resolve(...a) { let r = ''; for (let i = a.length - 1; i >= -1 && !r.startsWith('/'); i--) { const s = i >= 0 ? a[i] : process.cwd(); if (s) { r = s + (r ? '/' + r : ''); } } const n = normalize(r); return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n; }
export function dirname(p) { if (!p) { return '.'; } const i = p.replace(/\/+$/, '').lastIndexOf('/'); return i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i); }
export function basename(p, ext) { let b = p.replace(/\/+$/, ''); b = b.slice(b.lastIndexOf('/') + 1); return ext && b.endsWith(ext) && b !== ext ? b.slice(0, -ext.length) : b; }
export function extname(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); }
export function relative(from, to) { const f = resolve(from).split('/').filter(Boolean), t = resolve(to).split('/').filter(Boolean); let i = 0; while (i < f.length && i < t.length && f[i] === t[i]) { i++; } return [...f.slice(i).map(() => '..'), ...t.slice(i)].join('/'); }
export function parse(p) { const base = basename(p), ext = extname(p); return { root: p.startsWith('/') ? '/' : '', dir: dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base }; }
export function format(o) { return (o.dir ? o.dir + '/' : o.root || '') + (o.base || (o.name || '') + (o.ext || '')); }
export function toNamespacedPath(p) { return p; }
const api = { sep, delimiter, normalize, join, isAbsolute, resolve, dirname, basename, extname, relative, parse, format, toNamespacedPath };
export const posix = api; export const win32 = api;
export default Object.assign(api, { posix: api, win32: api });
