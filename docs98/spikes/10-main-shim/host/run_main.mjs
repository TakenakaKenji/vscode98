// The main process: VS Code's own electron-main bundle with `electron` replaced by electron_stub.mjs. Runs on Node and on QuickJS (via fork_main.mjs of spike 5).
//   node run_main.mjs <appRoot> [args...]        |        qjs-spike7 fork_main.mjs <shimsDir> run_main.mjs <appRoot> [args...]
import Module from 'node:module';
import './node_globals98.js';
import { installAddons } from './native_addons98.js';
installAddons();
const appRoot = process.argv[2];
const here = import.meta.url.replace(/\/[^/]*$/, '/');
Module.registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'electron') { return { url: here + 'electron_stub.mjs', shortCircuit: true }; }
		if (specifier === 'original-fs') { return nextResolve('node:fs', context); }
		return nextResolve(specifier, context);
	},
});
if (process.env.DEBUG_REJECT) { const prev = globalThis.__rejection; globalThis.__rejection = (p, reason, handled) => { if (!handled) { process.stderr.write('REJECTION ' + String(reason && reason.stack || reason).split('\n').slice(0, Number(process.env.DEBUG_REJECT)).join('\n') + '\n'); } prev?.(p, reason, handled); }; }
process.argv.splice(1, 2);   // a packaged Electron app sees argv = [exe, ...userArgs]
process.type = 'browser'; process.resourcesPath = appRoot;
await import(appRoot + '/out/main.js');
