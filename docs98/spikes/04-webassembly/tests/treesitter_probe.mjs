// Probe: can wasm3 (via our WebAssembly API) instantiate the tree-sitter runtime / a grammar? These are Emscripten dylink modules that import
// env.memory and env.__indirect_function_table (shared with each other). Prints what the API does with each; `node` result is the reference.
import { readBytes, print } from './common.mjs';
const dir = '/home/user/vscode98/node_modules/@vscode/tree-sitter-wasm/wasm/';
for (const name of ['tree-sitter.wasm', 'tree-sitter-regex.wasm']) {
	const bytes = readBytes(dir + name);
	try {
		const m = new WebAssembly.Module(bytes);
		if (WebAssembly.Module.imports) { print(name + ' imports: ' + JSON.stringify(WebAssembly.Module.imports(m).map(i => i.module + '.' + i.name + ':' + i.kind)).slice(0, 200)); }
		print(name + ' typeof Global/Table/Memory: ' + typeof WebAssembly.Global + '/' + typeof WebAssembly.Table + '/' + typeof WebAssembly.Memory);
		const memory = new WebAssembly.Memory({ initial: 512, maximum: 32768 });
		const table = new WebAssembly.Table({ initial: 64, element: 'anyfunc' });
		const env = new Proxy({ memory, __indirect_function_table: table, __stack_pointer: (typeof WebAssembly.Global === 'function' ? new WebAssembly.Global({ value: 'i32', mutable: true }, 65536) : 65536), __memory_base: (typeof WebAssembly.Global === 'function' ? new WebAssembly.Global({ value: 'i32' }, 1024) : 1024), __table_base: (typeof WebAssembly.Global === 'function' ? new WebAssembly.Global({ value: 'i32' }, 1) : 1) }, { get: (t, k) => k in t ? t[k] : (() => 0) });
		const imports = { env, wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }), 'GOT.mem': new Proxy({}, { get: () => new WebAssembly.Global({ value: 'i32', mutable: true }, 0) }) };
		const inst = new WebAssembly.Instance(m, imports);
		print(name + ' instantiated; exports: ' + Object.keys(inst.exports).length);
	} catch (e) { print(name + ' FAILED: ' + (e && e.constructor && e.constructor.name) + ' ' + String(e && e.message).slice(0, 300)); }
}
