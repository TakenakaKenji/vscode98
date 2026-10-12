// QuickJS-ng adapter for ts_bench_core.mjs.   qjs --stack-size 0 run_qjs.mjs <repoRoot> <dirRelativeToRoot> [queries]
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import { runBench } from './ts_bench_core.mjs';
// Host-provided shim: QuickJS has no Intl, but the TypeScript compiler (like VS Code itself) calls `new Intl.Collator(...)` when sorting completions.
// This minimal stand-in compares with String.prototype.localeCompare; it is NOT a faithful Collator (no locale data, options ignored).
if (typeof globalThis.Intl === 'undefined') {
	globalThis.Intl = { Collator: class { constructor(l, o) { this._o = o; } compare(a, b) { return a.localeCompare(b); } resolvedOptions() { return { locale: 'en' }; } } };
}
const [root = os.getcwd()[0], dir = 'src/vs/base/common', queries = '15'] = scriptArgs.slice(1);
const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000;
const st = (p) => { const [o, e] = os.stat(p); return e === 0 ? o : null; };
const env = {
	engine: 'quickjs-ng ' + (typeof std.getenv === 'function' ? '0.17.0' : ''),
	now: () => performance.now(),
	log: (m) => console.log(m),
	readFile: (p) => { const s = std.loadFile(p); return s === null ? undefined : s.replace(/^﻿/, ''); },
	isFile: (p) => { const o = st(p); return !!o && (o.mode & S_IFMT) === S_IFREG; },
	isDir: (p) => { const o = st(p); return !!o && (o.mode & S_IFMT) === S_IFDIR; },
	listDirs: (d) => { const [names, e] = os.readdir(d); return e === 0 ? names.filter(n => n !== '.' && n !== '..' && env.isDir(d + '/' + n)) : []; },
	listFiles: (d) => os.readdir(d)[0].filter(n => n !== '.' && n !== '..'),
	realpath: (p) => { const [r, e] = os.realpath(p); return e === 0 ? r : p; },
};
const r = runBench(env, { root, dir, tsDir: root + '/extensions/node_modules/typescript/lib', queries: Number(queries), queryFile: 'lifecycle.ts' });
console.log(JSON.stringify(r));
