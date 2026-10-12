// Shared by the spike-4 benchmarks: environment detection (Node vs the qjs-spike4 host) and loading of the Oniguruma implementation under test.
export const isQjs = typeof scriptArgs !== 'undefined';
export const args = isQjs ? scriptArgs.slice(1) : process.argv.slice(2);
export const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
export const now = () => performance.now();
export const print = (s) => console.log(s);
export let readText, readBytes;
if (isQjs) {
	const std = await import('qjs:std'); await import('../../02-node-shim/host/globals.js');
	readText = (p) => { const s = std.loadFile(p); if (s === null) { throw new Error('cannot read ' + p); } return s; };
	readBytes = (p) => { const f = std.open(p, 'rb'); f.seek(0, std.SEEK_END); const n = f.tell(); f.seek(0, std.SEEK_SET); const ab = new ArrayBuffer(n); f.read(ab, 0, n); f.close(); return ab; };
} else {
	const fs = await import('node:fs');
	readText = (p) => fs.readFileSync(p, 'utf8');
	readBytes = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
}
export const evalCjs = (path, req) => { const m = { exports: {} }; new Function('module', 'exports', 'require', readText(path))(m, m.exports, req); return m.exports; };

const oniguruma = '/home/user/vscode98/node_modules/vscode-oniguruma/release/';
/** Returns { createOnigScanner(patterns), createOnigString(str) } for: 'wasm' (vscode-oniguruma on the host's WebAssembly), 'native' (libonig 6.9.8 via C), 'wasm2c' (onig.wasm translated to C). */
export async function loadOnig(impl) {
	if (impl === 'wasm') {
		const onig = evalCjs(oniguruma + 'main.js');
		await onig.loadWASM(readBytes(oniguruma + 'onig.wasm'));
		return { createOnigScanner: (p) => new onig.OnigScanner(p), createOnigString: (s) => new onig.OnigString(s) };
	}
	const lib = await import(impl === 'native' ? 'spike:onig-native' : 'spike:onig-wasm2c');
	return { createOnigScanner: (p) => lib.createOnigScanner(p), createOnigString: (s) => lib.createOnigString(s) };
}
