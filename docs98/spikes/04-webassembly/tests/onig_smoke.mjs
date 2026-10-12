// Run the UNMODIFIED vscode-oniguruma 1.7.0 package (its Emscripten glue + onig.wasm) and print a few matches as JSON.
// Works under Node (V8's WebAssembly) and under qjs-spike4 (wasm3 WebAssembly): compare the two outputs.
//   node onig_smoke.mjs   |   qjs-spike4 onig_smoke.mjs
const isQjs = typeof scriptArgs !== 'undefined';
let readBytes, loadModuleSrc, print;
if (isQjs) {
	const std = await import('qjs:std');
	await import('../../02-node-shim/host/globals.js');
	readBytes = (p) => { const f = std.open(p, 'rb'); f.seek(0, std.SEEK_END); const n = f.tell(); f.seek(0, std.SEEK_SET); const ab = new ArrayBuffer(n); f.read(ab, 0, n); f.close(); return ab; };
	loadModuleSrc = (p) => std.loadFile(p); print = (s) => console.log(s);
} else {
	const fs = await import('node:fs');
	readBytes = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
	loadModuleSrc = (p) => fs.readFileSync(p, 'utf8'); print = (s) => console.log(s);
}
const root = '/home/user/vscode98/node_modules/vscode-oniguruma/release/';
const mod = { exports: {} };
new Function('module', 'exports', 'require', loadModuleSrc(root + 'main.js'))(mod, mod.exports, undefined);
const onig = mod.exports;
await onig.loadWASM(readBytes(root + 'onig.wasm'));
const scanner = new onig.OnigScanner(['\\b(function)\\s+([A-Za-z_$][\\w$]*)', '(?<=\\()\\s*([a-z]+)\\s*:', '\\d+(\\.\\d+)?', 'é+']);
const out = [];
for (const [s, pos] of [['export function hello(a: number) { return 42.5 }', 0], ['export function hello(a: number) { return 42.5 }', 8], ['naïve é café ééé 😀 x1', 0], ['no match here', 0]]) {
	out.push({ s, pos, r: scanner.findNextMatchSync(s, pos) });
}
print(JSON.stringify(out));
for (const bad of ['(unclosed', '[abc', '(?<n', 'a{2,1}x(?<=a*)', '\\\\']) { try { new onig.OnigScanner([bad]); print(JSON.stringify(bad) + ' -> compiles'); } catch (e) { print(JSON.stringify(bad) + ' -> error: ' + e.message); } }
