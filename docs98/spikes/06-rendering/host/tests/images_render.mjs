// Renders a page with <img> elements (PNG data URL, max-width scaling, alt-less broken image) through the native rasterizer: docs98/spikes/06-rendering/host/tests/images_render.mjs
import * as std from 'qjs:std';
import '../../../02-node-shim/host/globals.js';
import * as opentype from '/home/user/vscode98/node_modules/opentype.js/dist/opentype.mjs';
import '../dom/intl_shim.js';
import { installEnvironment } from '../dom/env.js';
import { paintDocument, toPPM } from '../dom/paint.js';
import { NativeBackend } from '../../../07-native-render/host/native_backend.js';
const readBytes = (f) => { const h = std.open(f, 'rb'); if (!h) { throw new Error('ENOENT ' + f); } h.seek(0, std.SEEK_END); const n = h.tell(); h.seek(0, std.SEEK_SET); const ab = new ArrayBuffer(n); h.read(ab, 0, n); h.close(); return ab; };
globalThis.__readFileBytes = readBytes;
globalThis.__log98 = (m) => console.log(m);
const env = installEnvironment({ width: 600, height: 400, opentype, readUrl: (u) => readBytes(decodeURIComponent(new URL(u).pathname)) }); const doc = env.document;
env.window.location.href = 'file:///tmp/claude-0/imgt/page.html';
doc.body.setAttribute('style', 'margin:10px;background:#fff');
doc.body.innerHTML = '<div style="width:300px;border:1px solid #888"><img id="a" src="file:///tmp/claude-0/imgt/rgba.png"><img id="b" src="file:///tmp/claude-0/imgt/base.jpg" style="max-width:100%"><br><img id="c" src="file:///tmp/claude-0/imgt/p.gif" width="140"><img id="d" src="file:///tmp/claude-0/imgt/icon.svg"><img id="e" src="file:///tmp/claude-0/imgt/nothere.png"></div>';
doc.__ensureLayout(); for (const id of ['a', 'b', 'c', 'd']) { const el = doc.getElementById(id); const r = el.getBoundingClientRect(); console.log(id + ' rect ' + [r.left, r.top, r.width, r.height].map(Math.round) + ' natural ' + el.naturalWidth + 'x' + el.naturalHeight); }
const be = new NativeBackend(600, 400, {}); const r = paintDocument(doc, 600, 400, be); const ppm = toPPM(r.px, 600, 400); const fh = std.open('/tmp/claude-0/imgt/render.ppm', 'wb'); fh.write(ppm.buffer, 0, ppm.length); fh.close();
{ const d2 = doc.createElement('div'); d2.setAttribute('style', 'position:absolute;left:340px;top:10px;width:200px;height:120px;border:2px solid #04a;background:url(file:///tmp/claude-0/imgt/rgba.png) no-repeat center / 60px #eef'); doc.body.appendChild(d2);
const d3 = doc.createElement('div'); d3.setAttribute('style', 'position:absolute;left:340px;top:150px;width:200px;height:100px;background-image:url(file:///tmp/claude-0/imgt/rgba.png);background-size:35px 26px'); doc.body.appendChild(d3);
doc.__ensureLayout(); be.reset(); const r2 = paintDocument(doc, 600, 400, be); const ppm2 = toPPM(r2.px, 600, 400); const f2 = std.open('/tmp/claude-0/imgt/render2.ppm', 'wb'); f2.write(ppm2.buffer, 0, ppm2.length); f2.close(); }
