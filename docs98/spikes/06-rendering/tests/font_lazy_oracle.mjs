// Oracle for lazy font parsing (opentype.parse(buf, { lowMemory: true }) in 06-rendering/host/dom/fonts.js): for every font file the renderer can load,
// the lazy parse must give the same metrics, glyph indices, advance widths, outlines (path commands at 13 px) and GPOS/kern values as the full parse,
// for every code point in the ranges below; prints both parse times. Usage: qjs-spike7 font_lazy_oracle.mjs [font dir, default /usr/share/fonts] [more font files...]
// (pass the workbench's codicon.ttf, loaded through @font-face, as one of the extra files)
import * as std from 'qjs:std';
import * as opentype from '../../../../node_modules/opentype.js/dist/opentype.mjs';
const dir = scriptArgs[1] || '/usr/share/fonts';
const FONTS = ['opentype/inter/Inter-Regular.otf', 'opentype/inter/Inter-Bold.otf', 'opentype/inter/Inter-Italic.otf', 'opentype/inter/Inter-SemiBold.otf', 'opentype/inter/Inter-Medium.otf',
	'truetype/dejavu/DejaVuSansMono.ttf', 'truetype/dejavu/DejaVuSansMono-Bold.ttf', 'truetype/dejavu/DejaVuSans.ttf', 'truetype/dejavu/DejaVuSerif.ttf',
	'truetype/liberation/LiberationSans-Regular.ttf', 'truetype/liberation/LiberationMono-Regular.ttf', 'truetype/liberation/LiberationSerif-Regular.ttf'];
const RANGES = [[0x20, 0x7f], [0xa0, 0x24f], [0x370, 0x3ff], [0x400, 0x4ff], [0x2000, 0x22ff], [0x2500, 0x25ff], [0xe000, 0xe010], [0xea60, 0xec40], [0xfb00, 0xfb06]];
let bad = 0, checked = 0; const fail = (m) => { if (bad++ < 15) { print('FAIL ' + m); } };
const load = (p) => { const u = std.loadFile(p, { binary: true }); return u ? u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) : null; };
const pathKey = (g) => JSON.stringify(g.getPath(1.5, 2, 13).commands);
let tFull = 0, tLazy = 0;
for (const f of [...FONTS, ...scriptArgs.slice(2)]) {
	const buf = load(f.startsWith('/') ? f : dir + '/' + f); if (!buf) { print('skip (missing) ' + f); continue; }
	let t = Date.now(); const a = opentype.parse(buf.slice(0)); tFull += Date.now() - t;
	t = Date.now(); const b = opentype.parse(buf.slice(0), { lowMemory: true }); const dt = Date.now() - t; tLazy += dt;
	const meta = (x) => JSON.stringify([x.unitsPerEm, x.tables.hhea.ascender, x.tables.hhea.descender, x.tables.hhea.lineGap, x.tables.os2 && x.tables.os2.sxHeight, x.numGlyphs]);
	if (meta(a) !== meta(b)) { fail(`${f}: metrics ${meta(a)} vs ${meta(b)}`); }
	const kt = (x) => { try { const k = x.position && x.position.getKerningTables ? x.position.getKerningTables('latn') : null; return k && k.length ? k : null; } catch { return null; } };
	const ka = kt(a), kb = kt(b);
	for (const [lo, hi] of RANGES) {
		for (let cp = lo; cp <= hi; cp++) {
			const s = String.fromCodePoint(cp), ga = a.charToGlyph(s), gb = b.charToGlyph(s); checked++;
			if (ga.index !== gb.index || ga.advanceWidth !== gb.advanceWidth) { fail(`${f} U+${cp.toString(16)}: index/advance ${ga.index}/${ga.advanceWidth} vs ${gb.index}/${gb.advanceWidth}`); continue; }
			if (pathKey(ga) !== pathKey(gb)) { fail(`${f} U+${cp.toString(16)}: outline differs`); }
		}
	}
	if (!!ka !== !!kb) { fail(`${f}: kerning tables ${!!ka} vs ${!!kb}`); }
	else if (ka) { for (let x = 0x41; x <= 0x7a; x++) { for (const y of [0x41, 0x56, 0x57, 0x59, 0x61, 0x6f, 0x76, 0x2e, 0x2c]) { const ia = a.charToGlyph(String.fromCharCode(x)).index, ib = a.charToGlyph(String.fromCharCode(y)).index; if (a.position.getKerningValue(ka, ia, ib) !== b.position.getKerningValue(kb, ia, ib)) { fail(`${f}: kern ${x},${y}`); } } } }
	print(`${f}: lazy parse ${dt} ms`);
}
print(`parse of ${FONTS.length + scriptArgs.length - 2} fonts: full ${tFull} ms, lazy ${tLazy} ms; ${checked} code points compared`);
print(bad ? `SUMMARY ${bad} failed` : 'SUMMARY all passed');
