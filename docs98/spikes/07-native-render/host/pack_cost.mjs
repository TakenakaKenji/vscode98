// qjs-spike7 --stack-size 0 pack_cost.mjs <workbench.json> : cost of packing the styled box tree for the native layout (marshalling), next to the JS layout it replaces
import * as std from 'qjs:std';
import '../../02-node-shim/host/globals.js';
import '../../06-rendering/host/dom/intl_shim.js';
import * as opentype from '/home/user/vscode98/node_modules/opentype.js/dist/opentype.mjs';
import { installEnvironment } from '../../06-rendering/host/dom/env.js';
import { replayPage, applyScrolls } from '../../06-rendering/host/dom/replay_core.js';
import { packTree } from './layout_pack.js';
import { stats } from './native_fonts.js';
console.error ??= (...a) => { std.err.puts(a.map(String).join(' ') + '\n'); };
const data = JSON.parse(std.loadFile(scriptArgs[1]));
globalThis.__readFileBytes = (p) => { const f = std.open(p, 'rb'); f.seek(0, std.SEEK_END); const n = f.tell(); f.seek(0, std.SEEK_SET); const ab = new ArrayBuffer(n); f.read(ab, 0, n); f.close(); return ab; };
const env = installEnvironment({ width: data.w, height: data.h, opentype }); const doc = replayPage(env, data); applyScrolls(doc, data.elements); doc.__ensureLayout();
const lay = doc.__layout; std.out.puts(`style ${lay.styleMs.toFixed(0)} ms, layout ${lay.layoutMs.toFixed(0)} ms\n`);
for (let k = 0; k < 3; k++) { const t = performance.now(); const pk = packTree(lay, lay.rootBox); std.out.puts(`pack #${k}: ${(performance.now() - t).toFixed(0)} ms, ${pk.n} boxes, ${pk.nt} text units, ${pk.nc / 4} calc nodes; fonts: ${JSON.stringify(stats)}\n`); }
std.exit(0);
