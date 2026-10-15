// Stand-in for node_modules/vscode-oniguruma/release/main.js: the workbench loads that file as an AMD module and then hands it onig.wasm. This host has no WebAssembly,
// so the module is replaced by one that forwards to the native Oniguruma of the host (module `spike:onig-native`, exposed as globalThis.__onig98; same API surface and
// behaviour as vscode-oniguruma 1.7.0). `loadWASM` only records that it was called; the bytes it receives are not needed.
export const ONIG_SHIM_SOURCE = `define([], function () {
	var n = globalThis.__onig98; var loaded = null;
	return {
		loadWASM: function () { return loaded || (loaded = Promise.resolve()); },
		createOnigScanner: function (patterns) { return n.createOnigScanner(patterns); },
		createOnigString: function (s) { return n.createOnigString(s); },
		OnigScanner: function OnigScanner(patterns) { return n.createOnigScanner(patterns); },
		OnigString: function OnigString(s) { return n.createOnigString(s); },
		setDefaultDebugCall: function () { }
	};
});
`;
