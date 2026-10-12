// Boots the real web workbench (bundled with build/next, target server-web) on the spike 6 DOM/CSS/layout engine under Node, headless.
// Usage: node boot_node.mjs <outWebDir> [--ppm out.ppm] [--seconds 60] [--layout native is QuickJS-only]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, } from 'node:module';
import { pathToFileURL } from 'node:url';
import { installEnvironment } from '../../06-rendering/host/dom/env.js';
import { parseFragment, missing } from '../../06-rendering/host/dom/dom.js';
import { unsupported } from '../../06-rendering/host/dom/layout.js';
import { paintDocument, toPPM, unpainted } from '../../06-rendering/host/dom/paint.js';
import { installWebShims, preparePage } from './web_shims.js';
import { summarizeRun, runScenario } from './boot_common.js';

const args = process.argv.slice(2); const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const webDir = path.resolve(args[0]); const seconds = Number(opt('seconds', 60)); const W = 1280, H = 800;
const require = createRequire(import.meta.url); const opentype = require('/home/user/vscode98/node_modules/opentype.js/dist/opentype.js');
globalThis.__readFileBytes = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const nodeProcess = process; const t00 = performance.now();
const readUrl = (u) => { const f = path.join(webDir, u.replace(/^https?:\/\/[^/]+\/out\//, '').replace(/[?#].*$/, '')); const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const env = installEnvironment({ width: W, height: H, opentype, readUrl }); const doc = env.document;
installWebShims(env, { baseUrl: 'http://localhost:8080', readFile: (p) => { const b = fs.readFileSync(path.join(webDir, p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });
const BASE = 'http://localhost:8080';
preparePage(doc, parseFragment, { html: fs.readFileSync(path.join(webDir, 'vs/code/browser/workbench/workbench.html'), 'utf8'), base: BASE, readText: (p) => fs.readFileSync(p, 'utf8'), webDir });
globalThis._VSCODE_FILE_ROOT = BASE + '/out/';
const errors = []; const note = (k, e) => { errors.push([k, (e && (e.stack || e.message)) || String(e)]); };
nodeProcess.on('unhandledRejection', (e) => note('unhandledRejection', e)); nodeProcess.on('uncaughtException', (e) => note('uncaughtException', e));
globalThis.addEventListener('error', (ev) => note('window.onerror', ev.error || ev.message));
Object.defineProperty(globalThis, 'process', { value: undefined, configurable: true, writable: true });   // the page must not think it runs in Node
const consoleLog = []; for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace']) { console[k] = (...a) => { consoleLog.push([k, a.map(x => (x && x.stack) || String(x)).join(' ')]); }; }
const tImport = performance.now();
try { await import(pathToFileURL(path.join(webDir, 'vs/code/browser/workbench/workbench.js')).href); } catch (e) { note('import', e); }
const tLoaded = performance.now();
doc.__passStats = [];
const ctx = { env, doc, note, rss: () => ({ rss: Math.round(nodeProcess.memoryUsage().rss / 1048576), peak: 0 }), layoutTiming: null, opt, log: (m) => nodeProcess.stdout.write(m + '\n'), W, H };
await runScenario(ctx, { seconds });
const done = performance.now();
summarizeRun(ctx, { tImport, tLoaded, done, t00, errors, consoleLog, rssAfterImport: { rss: 0 }, missing, unsupported });
if (opt('scenario')) { const sc = await import(pathToFileURL(path.resolve(opt('scenario'))).href); await sc.run(ctx); }
if (opt('ppm')) { const r = paintDocument(doc, W, H); fs.writeFileSync(opt('ppm'), toPPM(r.px, r.w, r.h)); log('painted ' + JSON.stringify(r.stats) + ' unpainted: ' + JSON.stringify([...unpainted])); }
nodeProcess.exit(0);
