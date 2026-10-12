// Spike 4 end-to-end workload: tokenize real source files with vscode-textmate + the real TypeScript grammar, through a chosen Oniguruma implementation.
//   node tokenize_bench.mjs --impl wasm [--record trace.json] [--lines N] [--files a.ts,b.ts]      (V8's WebAssembly)
//   qjs-spike4 tokenize_bench.mjs --impl wasm|native|wasm2c ...                                     (wasm3 / native libonig / wasm2c-translated onig.wasm)
// Prints one JSON line: timings, token counts and an order-sensitive hash of every token (compare hashes across implementations).
const isQjs = typeof scriptArgs !== 'undefined';
const args = isQjs ? scriptArgs.slice(1) : process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const impl = opt('impl', 'wasm'), maxLines = Number(opt('lines', '1000000')), recordPath = opt('record', ''), root = opt('root', '/home/user/vscode98');
const files = opt('files', 'src/vs/editor/common/model/textModel.ts,src/vs/base/common/strings.ts,src/vs/workbench/api/common/extHostTypes.ts').split(',').map(f => f.startsWith('/') ? f : root + '/' + f);

let readText, readBytes, now, print, selfDir;
if (isQjs) {
	const std = await import('qjs:std'); await import('../../02-node-shim/host/globals.js');
	readText = (p) => std.loadFile(p);
	readBytes = (p) => { const f = std.open(p, 'rb'); f.seek(0, std.SEEK_END); const n = f.tell(); f.seek(0, std.SEEK_SET); const ab = new ArrayBuffer(n); f.read(ab, 0, n); f.close(); return ab; };
	now = () => performance.now(); print = (s) => console.log(s);
} else {
	const fs = await import('node:fs');
	readText = (p) => fs.readFileSync(p, 'utf8');
	readBytes = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
	now = () => performance.now(); print = (s) => console.log(s);
}
const evalCjs = (path, req) => { const m = { exports: {} }; new Function('module', 'exports', 'require', readText(path))(m, m.exports, req); return m.exports; };
const t0 = now();

// ---- Oniguruma implementation under test ----
const oniguruma = '/home/user/vscode98/node_modules/vscode-oniguruma/release/';
let onigLib, onigCalls = 0;
const trace = recordPath ? { scanners: [], strings: [], calls: [] } : null;
if (impl === 'wasm') {
	const onig = evalCjs(oniguruma + 'main.js');
	await onig.loadWASM(readBytes(oniguruma + 'onig.wasm'));
	let sid = 0;
	onigLib = {
		createOnigScanner(patterns) {
			const s = new onig.OnigScanner(patterns); const id = trace ? trace.scanners.push(patterns) - 1 : 0;
			return trace ? { findNextMatchSync(str, pos, opts) { const r = s.findNextMatchSync(str, pos, opts); onigCalls++; trace.calls.push([id, trace.strings.length - 1, pos, opts | 0, r ? r.index : -1, r ? r.captureIndices.map(c => c.start + ':' + c.end).join(',') : '']); return r; }, dispose() { s.dispose(); } }
				: { findNextMatchSync(str, pos, opts) { onigCalls++; return s.findNextMatchSync(str, pos, opts); }, dispose() { s.dispose(); } };
		},
		createOnigString(str) { if (trace) { trace.strings.push(str); } return new onig.OnigString(str); },
	};
} else {
	const lib = await import(impl === 'native' ? 'spike:onig-native' : 'spike:onig-wasm2c');
	onigLib = { createOnigScanner: (p) => { const s = lib.createOnigScanner(p); return { findNextMatchSync(str, pos, opts) { onigCalls++; return s.findNextMatchSync(str, pos, opts); }, dispose() { s.dispose && s.dispose(); } }; }, createOnigString: (s) => lib.createOnigString(s) };
}
const tSetup = now();

// ---- TextMate ----
const tm = evalCjs('/home/user/vscode98/node_modules/vscode-textmate/release/main.js');
const scopeMap = JSON.parse(readText(selfDirPath('scope-map.json')));
function selfDirPath(name) { return '/home/user/vscode98/docs98/spikes/04-webassembly/tests/' + name; }
const registry = new tm.Registry({
	onigLib: Promise.resolve(onigLib),
	loadGrammar: async (scope) => { const p = scopeMap[scope]; return p ? tm.parseRawGrammar(readText(p), p) : null; },
	getInjections: (scope) => scope === 'source.ts' || scope === 'source.tsx' ? ['documentation.injection.ts'] : undefined,
});
const grammar = await registry.loadGrammar('source.ts');
const tGrammar = now();

// ---- tokenize ----
function fnv(h, s) { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
let hash = 2166136261, tokens = 0, lines = 0, bytes = 0; const perFile = [];
for (const f of files) {
	let rules = tm.INITIAL; const fl0 = lines; const text = readText(f).split('\n');
	for (const line of text) {
		if (lines >= maxLines) { break; }
		const r = grammar.tokenizeLine(line, rules); rules = r.ruleStack; lines++; bytes += line.length;
		for (const t of r.tokens) { tokens++; hash = fnv(hash, t.startIndex + ',' + t.endIndex + ',' + t.scopes.join(' ') + ';'); }
		hash = fnv(hash, '\n');
	}
	perFile.push([f.replace(root + '/', ''), lines - fl0]);
}
const tDone = now();
const res = { impl, engine: isQjs ? 'quickjs' : 'node', files: perFile, lines, chars: bytes, tokens, hash: (hash >>> 0).toString(16), onigCalls,
	ms: { loadOnig: Math.round(tSetup - t0), loadGrammar: Math.round(tGrammar - tSetup), tokenize: Math.round(tDone - tGrammar), total: Math.round(tDone - t0) } };
print(JSON.stringify(res));
if (trace && !isQjs) { (await import('node:fs')).writeFileSync(recordPath, JSON.stringify(trace)); print('trace: ' + trace.calls.length + ' calls, ' + trace.scanners.length + ' scanners, ' + trace.strings.length + ' strings'); }
