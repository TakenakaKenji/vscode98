// Oracle for the SVG rasterizer's C loops (07-native-render/host/svg98.h): every SVG under the given directories (the app's out/ has the workbench's
// icons, logos and welcome-page artwork) decoded at scale 1 and 2, with and without a currentColor, must give the same RGBA bytes with the C loops
// as with svg.js's JS loops; prints the time of both. Usage: qjs-spike7 svg_native_oracle.mjs <dir>...
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import { decodeSvg, useNativeSvg } from '../host/dom/svg.js';
if (typeof globalThis.__svgFill !== 'function') { print('FAIL the host has no __svgFill'); std.exit(1); }
const files = [];
const walk = (d) => { const [names] = os.readdir(d); for (const n of names || []) { if (n === '.' || n === '..') { continue; } const p = d + '/' + n; const [st] = os.stat(p); if (st && (st.mode & 0o170000) === 0o040000) { walk(p); } else if (n.endsWith('.svg')) { files.push(p); } } };
for (const d of scriptArgs.slice(1)) { walk(d); }
let bad = 0, cases = 0, tJs = 0, tC = 0; const fail = (m) => { if (bad++ < 10) { print('FAIL ' + m); } };
const run = (text, scale, cc) => { try { return decodeSvg(text, scale, cc); } catch (e) { return 'throws: ' + e.message; } };
for (const p of files) {
	const text = std.loadFile(p); if (text === null) { continue; }
	for (const [scale, cc] of [[1, null], [2, null], [2, [200, 100, 50, 1]]]) {
		useNativeSvg(false); let t = Date.now(); const a = run(text, scale, cc); tJs += Date.now() - t;
		useNativeSvg(true); t = Date.now(); const b = run(text, scale, cc); tC += Date.now() - t; cases++;
		if (typeof a === 'string' || typeof b === 'string') { if (String(a) !== String(b)) { fail(`${p} x${scale}: ${a} vs ${b}`); } continue; }
		if (a.w !== b.w || a.h !== b.h || a.data.length !== b.data.length) { fail(`${p} x${scale}: size`); continue; }
		let diff = -1; for (let i = 0; i < a.data.length; i++) { if (a.data[i] !== b.data[i]) { diff = i; break; } }
		if (diff >= 0) { fail(`${p} x${scale}${cc ? ' currentColor' : ''}: byte ${diff}: ${a.data[diff]} vs ${b.data[diff]}`); }
	}
}
print(`${files.length} files, ${cases} decodes: JS loops ${tJs} ms, C loops ${tC} ms`);
print(bad ? `SUMMARY ${bad} failed` : 'SUMMARY all passed');
