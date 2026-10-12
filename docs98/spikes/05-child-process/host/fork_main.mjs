// The "node" of this spike: runs a script on QuickJS with the Node shims, as a forked child would run under real Node.
//   qjs-spike5 --stack-size 0 fork_main.mjs <shimsOutDir> <script.js|.mjs> [args...]
// Provides: process.argv/execPath/execArgv, process.stdin/stdout/stderr as real fd streams, the IPC channel (process.send / 'message' / 'disconnect') when
// NODE_CHANNEL_FD is set, a real process.kill, and CommonJS execution of the script through the shim's Module loader. Forked grandchildren re-enter here.
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import '../../02-node-shim/host/globals.js';

// NOTE: no top-level await (see spike 2: with TLA `qjs` only runs one job per poll and microtasks stall until the next timer fires).
async function boot() {
const [outDirArg, script, ...rest] = scriptArgs.slice(1);
const outDir = (os.platform === 'win32' ? outDirArg.replace(/\\/g, '/') : outDirArg);   // canonical module-name spelling (see esm_loader.mjs)
const here = scriptArgs[0];
std.setenv('VSCODE_WILL_SEND_MESSAGE_PORT', '1');
if (std.getenv('NLS_MESSAGES')) { globalThis._VSCODE_NLS_MESSAGES = JSON.parse(std.loadFile(std.getenv('NLS_MESSAGES'))); globalThis._VSCODE_NLS_LANGUAGE = 'en'; }

// ---- preload every Node builtin shim into the table the CommonJS loader reads
globalThis.__builtins ??= {};
for (const f of os.readdir(outDir + '/shims')[0].filter(f => f.endsWith('.js'))) {
	const name = f.slice(0, -3).replace(/__/g, '/');
	try { const ns = await import(`${outDir}/shims/${f}`); globalThis.__builtins[name] = ns.default ?? ns; } catch (e) { std.err.puts(`preload failed ${name}: ${e.message}\n`); }
}
const { setupProcess } = await import('./proc_setup.mjs');
await setupProcess(outDir, globalThis.__builtins.path.resolve(here).replace(/\\/g, '/')   /* QuickJS's own relative-import resolution only knows '/' */, script, rest);
const P = globalThis.process;

// ---- run the script
const Module = globalThis.__builtins.module;
async function main() {
	try {
		if (script.endsWith('.mjs')) { await import(P.argv[1]); } else { Module._load(P.argv[1], null, true); }
	} catch (e) { std.err.puts(`fork_main: uncaught ${e && e.message ? e.message + "\n" : ""}${e && e.stack || e}\n`); std.err.flush(); P.exit(1); }
}
main();
}
boot();
