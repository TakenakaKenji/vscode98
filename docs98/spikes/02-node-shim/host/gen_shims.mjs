// Spike 2b generator. Copies the Node-side bundle entry files into <outDir>/bundle/, rewrites their NON-relative import specifiers
// (fs, node:net, electron, @vscode/spdlog, ...) to generated shim modules in <outDir>/shims/, and writes one shim per module.
// A shim re-exports every name the bundles import from that module: the real implementation from ./impl/<module>.js when it provides it,
// otherwise a "lenient stub" (a callable Proxy that records the call and returns another stub) so evaluation can continue and we learn
// which APIs the code touches at startup. Usage: node gen_shims.mjs <bundleRoot> <outDir> <entry.js>...
import fs from 'node:fs';
import path from 'node:path';

const [bundleRoot, outDir, ...entries] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const implDir = path.join(here, 'impl');
// Extra implementation directories (colon-separated, searched first) let later spikes override or add shims without touching this directory.
const implDirs = [...(process.env.SHIM_IMPL_DIRS ? process.env.SHIM_IMPL_DIRS.split(':') : []), implDir];
const findImpl = (mod) => implDirs.map(d => path.join(d, fileFor(mod))).find(f => fs.existsSync(f));
const importRe = /import\s*(?:([\w$]+)\s*,?\s*)?(?:\*\s*as\s+([\w$]+)|\{([^}]*)\})?\s*from\s*(["'])([^"']+)\4|import\s*(["'])([^"']+)\6|import\(\s*(["'])([^"']+)\8\s*\)/g;
const isRel = (s) => s.startsWith('.') || s.startsWith('/');
const fileFor = (spec) => spec.replace(/^node:/, '').replace(/\//g, '__') + '.js';
const mods = new Map();   // module -> { named:Set, default:bool }
const rewritten = [];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'shims'), { recursive: true });
for (const entry of entries) {
	const src = path.join(bundleRoot, entry);
	let text = fs.readFileSync(src, 'utf8');
	text = text.replace(importRe, (all, def, ns, named, _q, fromSpec, _q2, bareSpec, _q3, dynSpec) => {
		const spec = fromSpec ?? bareSpec ?? dynSpec;
		if (isRel(spec) || !/^[@\w][\w@./:-]*$/.test(spec)) { return all; }   // not a plausible module name (e.g. matched inside a string): leave untouched
		const key = spec.replace(/^node:/, '');
		const e = mods.get(key) ?? { named: new Set(), default: false }; mods.set(key, e);
		if (def) { e.default = true; }
		if (named) { named.split(',').map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach(n => e.named.add(n)); }
		const target = path.join(outDir, 'shims', fileFor(spec)).replace(/\\/g, '/');
		const at = all.lastIndexOf(spec);   // the specifier is always the LAST occurrence in the match (earlier text may contain it, e.g. 'os' in 'hostname')
		return all.slice(0, at) + target + all.slice(at + spec.length);
	});
	text = text.replace(/\bimport\((?!\s*["'`])/g, '__dynImport(');   // runtime-computed specifiers (file:// URLs of ESM extensions) go through globals.js
	const dest = path.join(outDir, 'bundle', entry);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.writeFileSync(dest, text);
	rewritten.push(dest);
}
// Every Node builtin gets a shim (lenient stub by default) so CommonJS code can require() any of them, not only what the bundles import statically.
const NODE_BUILTINS = ['assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'readline/promises', 'repl', 'stream', 'stream/promises', 'string_decoder', 'sys', 'timers', 'timers/promises', 'tls', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib', 'original-fs'];
for (const b of NODE_BUILTINS) { if (!mods.has(b)) { mods.set(b, { named: new Set(), default: false }); } }
for (const [mod, e] of mods) {
	const implFile = findImpl(mod);
	const hasImpl = !!implFile;
	const lines = [`// generated for module '${mod}'`];
	if (hasImpl) { lines.push(`import * as impl from '${implFile}';`, `export * from '${implFile}';`); }   // also expose names that were only reached through dynamic import()
	for (const n of [...e.named].sort()) {
		if (!/^[\w$]+$/.test(n)) { continue; }
		lines.push(hasImpl ? `export const ${n} = impl.${n} ?? globalThis.__stub('${mod}', '${n}');` : `export const ${n} = globalThis.__stub('${mod}', '${n}');`);
	}
	lines.push(hasImpl ? `export default impl.default ?? globalThis.__stub('${mod}', 'default');` : `export default globalThis.__stub('${mod}', 'default');`);
	fs.writeFileSync(path.join(outDir, 'shims', fileFor(mod)), lines.join('\n') + '\n');
}
console.log(JSON.stringify({ entries: rewritten.length, modules: [...mods.keys()].sort(), withImpl: [...mods.keys()].filter(m => findImpl(m)) }));
