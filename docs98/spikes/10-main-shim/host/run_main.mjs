// The main process: VS Code's own electron-main bundle with `electron` replaced by electron_stub.mjs. Runs on Node and on QuickJS (via fork_main.mjs of spike 5).
//   node run_main.mjs <appRoot> [args...]        |        qjs-spike7 fork_main.mjs <shimsDir> run_main.mjs <appRoot> [args...]
import { installResolveHooks } from './hooks98.mjs';
import './error_stack98.js';
import './node_globals98.js';
import { installAddons } from './native_addons98.js';
installAddons();
import { pathToFileURL } from 'node:url';
import nodePath from 'node:path';
const appRoot = process.argv[2];
const here = import.meta.url.replace(/\/[^/]*$/, '/');
installResolveHooks(import.meta.url);
if (process.env.DEBUG_REJECT) { const prev = globalThis.__rejection; globalThis.__rejection = (p, reason, handled) => { if (!handled) { process.stderr.write('REJECTION ' + String(reason && reason.stack || reason).split('\n').slice(0, Number(process.env.DEBUG_REJECT)).join('\n') + '\n'); } prev?.(p, reason, handled); }; }
if (process.env.DEBUG_FS) { globalThis.__fsDebug = true; }
process.argv.splice(1, 2);   // a packaged Electron app sees argv = [exe, ...userArgs]
process.type = 'browser'; process.resourcesPath = appRoot;
await import(pathToFileURL(nodePath.join(appRoot, 'out', 'main.js')).href);
