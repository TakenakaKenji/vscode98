// Development harness (Node): loads tests/page.html (+ monaco.js/css) into the spike DOM, runs it, prints a summary and optional dumps.
//   node run_node.mjs <monacoDir> [--dump out.json] [--page page.html]
import fs from 'node:fs';
import path from 'node:path';
import { boot } from './node_boot.mjs';
import { missing } from './dom/dom.js';
import { unsupported } from './dom/layout.js';
const args = process.argv.slice(2); const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const monacoDir = args[0]; const pageFile = opt('page', path.join(import.meta.dirname, '../tests/pages/basic.html'));
const { env, doc, ms, nodeProcess, error } = await boot(monacoDir, pageFile);
if (error) { console.log('LOAD FAILED:', error && (error.stack || error)); }
const out = (m) => nodeProcess.stdout.write(m + '\n');
const container = doc.getElementById('container');
out(`loaded in ${ms} ms; layouts ${doc.__layoutCount} (${Math.round(doc.__layoutMs)} ms); container descendants: ${container ? container.getElementsByTagName('*').length : 'n/a'}`);
out('missing: ' + JSON.stringify([...missing].sort((a, b) => b[1] - a[1]).slice(0, 40)));
out('unsupported: ' + JSON.stringify([...unsupported]));
const ppmPath = opt('ppm', null);
if (ppmPath) { const { paintDocument, toPPM, unpainted } = await import('./dom/paint.js'); const t = performance.now(); const r = paintDocument(doc, 800, 520); fs.writeFileSync(ppmPath, toPPM(r.px, r.w, r.h)); out(`painted in ${Math.round(performance.now() - t)} ms ${JSON.stringify(r.stats)} unpainted: ${JSON.stringify([...unpainted])}`); }
const dumpPath = opt('dump', null);
if (dumpPath && container) {
	const props = ['display', 'position'];
	const rows = []; const walk = (el, depth, p) => { const r = el.getBoundingClientRect(); rows.push({ path: p, tag: el.localName, cls: el.getAttribute('class') || '', id: el.id, x: r.x, y: r.y, w: r.width, h: r.height, depth, text: el.children.length === 0 ? el.textContent.slice(0, 80) : undefined, inlineStyle: el.getAttribute('style') || '', offsetW: el.offsetWidth, offsetH: el.offsetHeight, scrollW: el.scrollWidth, scrollH: el.scrollHeight }); let i = 0; for (const c of el.children) { walk(c, depth + 1, p + '/' + c.localName + '[' + (i++) + ']'); } };
	walk(container, 0, 'container'); fs.writeFileSync(dumpPath, JSON.stringify({ elements: rows, html: container.outerHTML }, null, 1));
}
nodeProcess.exit(0);
