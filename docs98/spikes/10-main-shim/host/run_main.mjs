// The main process: VS Code's own electron-main bundle with `electron` replaced by electron_stub.mjs. Runs on Node and on QuickJS (via fork_main.mjs of spike 5).
//   node run_main.mjs <appRoot> [args...]        |        qjs-spike7 fork_main.mjs <shimsDir> run_main.mjs <appRoot> [args...]
import Module from 'node:module';
const appRoot = process.argv[2];
const here = import.meta.url.replace(/\/[^/]*$/, '/');
Module.registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'electron') { return { url: here + 'electron_stub.mjs', shortCircuit: true }; }
		if (specifier === 'original-fs') { return nextResolve('node:fs', context); }
		return nextResolve(specifier, context);
	},
});
process.argv.splice(1, 2);   // a packaged Electron app sees argv = [exe, ...userArgs]
process.type = 'browser'; process.resourcesPath = appRoot;
await import(appRoot + '/out/main.js');
