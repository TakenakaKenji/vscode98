// Fonts for the rendering spike: family matching onto installed TTF/OTF files, glyph advance widths and vertical metrics (opentype.js), and glyph outlines for the painter.
// Platform hook: globalThis.__readFileBytes(path) -> ArrayBuffer.
let opentype = null;
export function setOpentype(o) { opentype = o; }
const FILES = {   // family (lowercase) -> [regular, bold, italic, bold italic]
	'dejavu sans mono': ['/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Oblique.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-BoldOblique.ttf'],
	'dejavu sans': ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf'],
	'dejavu serif': ['/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif-BoldItalic.ttf'],
	'liberation sans': ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf'],
	'liberation mono': ['/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationMono-Italic.ttf', '/usr/share/fonts/truetype/liberation/LiberationMono-BoldItalic.ttf'],
	'liberation serif': ['/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf', '/usr/share/fonts/truetype/liberation/LiberationSerif-BoldItalic.ttf'],
	'inter': ['/usr/share/fonts/opentype/inter/Inter-Regular.otf', '/usr/share/fonts/opentype/inter/Inter-Bold.otf', '/usr/share/fonts/opentype/inter/Inter-Italic.otf', '/usr/share/fonts/opentype/inter/Inter-BoldItalic.otf'],
};
const ALIASES = { arial: 'liberation sans', helvetica: 'liberation sans', 'courier new': 'liberation mono', courier: 'liberation mono', 'times new roman': 'liberation serif', times: 'liberation serif', monospace: 'dejavu sans mono', 'sans-serif': 'inter', serif: 'dejavu serif', 'system-ui': 'inter', '-apple-system': 'inter', 'ui-monospace': 'dejavu sans mono', 'ui-sans-serif': 'inter', 'segoe ui': 'inter', 'ubuntu': 'inter', 'cantarell': 'inter' };
const custom = new Map();   // @font-face: family(lowercase) -> [{ weight, style, font }]
const loaded = new Map();
export function registerFontFace(family, font, weight = 400, style = 'normal') { const k = family.toLowerCase().replace(/^["']|["']$/g, ''); if (!custom.has(k)) { custom.set(k, []); } custom.get(k).push({ weight, style, font }); loadedKeyCache.clear(); }
const loadedKeyCache = new Map();
function loadFile(path) {
	if (loaded.has(path)) { return loaded.get(path); }
	let f = null; try { f = opentype.parse(globalThis.__readFileBytes(path)); } catch (e) { f = null; }
	if (f) { f.__path = path; f.__adv = new Map(); } loaded.set(path, f); return f;
}
/** Resolve a CSS font-family list + weight/style to a parsed font (first family available; falls back to the generic serif). */
export function resolveFont(familyList, weight, style) {
	const key = familyList + '|' + (weight >= 600 ? 'b' : 'r') + '|' + (style === 'italic' || style === 'oblique' ? 'i' : 'n'); let f = loadedKeyCache.get(key); if (f !== undefined) { return f; }
	const bold = weight >= 600, ital = style === 'italic' || style === 'oblique';
	for (let fam of familyList.split(',')) {
		fam = fam.trim().replace(/^["']|["']$/g, '').toLowerCase(); if (!fam) { continue; }
		const c = custom.get(fam); if (c) { const m = c.find(e => (e.weight >= 600) === bold) ?? c[0]; f = m.font; break; }
		const real = FILES[fam] ? fam : ALIASES[fam]; if (real && FILES[real]) { const files = FILES[real]; const idx = (bold ? 1 : 0) + (ital ? 2 : 0); f = loadFile(files[idx]) ?? loadFile(files[0]); if (f) { break; } }
	}
	if (!f) { f = loadFile(FILES['dejavu serif'][bold ? 1 : 0]); }
	loadedKeyCache.set(key, f); return f;
}
const metricsCache = new WeakMap();
export function fontMetrics(font, size) {
	let m = metricsCache.get(font); if (!m) { const upm = font.unitsPerEm; const h = font.tables.hhea, os2 = font.tables.os2; m = { upm, asc: h.ascender / upm, desc: -h.descender / upm, gap: (h.lineGap || 0) / upm, xHeight: (os2 && os2.sxHeight) ? os2.sxHeight / upm : 0.5 }; metricsCache.set(font, m); }
	const asc = Math.round(m.asc * size), desc = Math.round(m.desc * size), gap = m.gap * size;
	return { ascent: asc, descent: desc, lineGap: gap, lineHeightNormal: asc + desc + Math.round(gap), xHeight: m.xHeight * size };
}
/** advance width of one code point in px at `size` */
export function advance(font, cp, size) {
	let a = font.__adv.get(cp); if (a === undefined) { const g = font.charToGlyph(String.fromCodePoint(cp)); a = (g.advanceWidth ?? 0) / font.unitsPerEm; font.__adv.set(cp, a); }
	return a * size;
}
export function textWidth(font, text, size, letterSpacing = 0) { let w = 0; for (const ch of text) { w += advance(font, ch.codePointAt(0), size) + letterSpacing; } return w; }
export function glyphPath(font, cp, size) { return font.charToGlyph(String.fromCodePoint(cp)).getPath(0, 0, size); }
