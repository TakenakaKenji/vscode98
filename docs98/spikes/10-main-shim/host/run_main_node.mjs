// node run_main_node.mjs <appRoot> [args...]   runs the real electron-main bundle (out/main.js) under Node with `electron` replaced by electron_stub.mjs
import { register } from 'node:module';
import path from 'node:path';
register('./hooks.mjs', import.meta.url);
const appRoot = path.resolve(process.argv[2]);
process.argv.splice(1, 2);   // a packaged Electron app sees argv = [exe, ...userArgs]
Object.defineProperty(process, 'type', { value: 'browser' }); process.resourcesPath = appRoot;
await import(path.join(appRoot, 'out/main.js'));
