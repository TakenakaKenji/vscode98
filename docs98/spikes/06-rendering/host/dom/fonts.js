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
const INTER_NAMES = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
const interFile = (weight, ital) => { const w = Math.max(100, Math.min(900, Math.round((weight || 400) / 100) * 100)); const n = INTER_NAMES[w]; return `/usr/share/fonts/opentype/inter/Inter-${ital ? (n === 'Regular' ? '' : n) + 'Italic' : n}.otf`; };
const ALIASES = { arial: 'liberation sans', helvetica: 'liberation sans', 'courier new': 'liberation mono', courier: 'liberation mono', 'times new roman': 'liberation serif', times: 'liberation serif', monospace: 'dejavu sans mono', 'sans-serif': 'inter', serif: 'dejavu serif', 'system-ui': 'inter', '-apple-system': 'inter', 'ui-monospace': 'dejavu sans mono', 'ui-sans-serif': 'inter', 'segoe ui': 'inter', 'ubuntu': 'inter', 'cantarell': 'inter' };
const custom = new Map();   // @font-face: family(lowercase) -> [{ weight, style, font }]
const loaded = new Map();
export function registerFontFace(family, font, weight = 400, style = 'normal') { const k = family.toLowerCase().replace(/^["']|["']$/g, ''); if (!custom.has(k)) { custom.set(k, []); } custom.get(k).push({ weight, style, font }); loadedKeyCache.clear(); }
const loadedKeyCache = new Map();
// The font table names Linux system paths; `globalThis.__fontRoot` (set by a harness with --font-dir) relocates /usr/share/fonts to a directory shipped with the application (Windows has none of these files).
const fontFile = (path) => globalThis.__fontRoot && path.startsWith('/usr/share/fonts/') ? globalThis.__fontRoot + path.slice('/usr/share/fonts'.length) : path;
function loadFile(path) {
	if (loaded.has(path)) { return loaded.get(path); }
	// lowMemory: glyphs are parsed when first used, not all at load (the full parse was 1.0 s of the laptop's launch; same results: tests/font_lazy_oracle.mjs)
	let f = null; try { f = opentype.parse(globalThis.__readFileBytes(fontFile(path)), { lowMemory: true }); } catch (e) { f = null; }
	if (f) { f.__path = path; f.__adv = new Map(); } loaded.set(path, f); return f;
}
/** Resolve a CSS font-family list + weight/style to a parsed font (first family available; falls back to the generic serif). */
export function resolveFont(familyList, weight, style) {
	const key = familyList + '|' + (/inter|sans|system|ui|apple|segoe|ubuntu/i.test(familyList) ? Math.round((weight || 400) / 100) : (weight >= 600 ? 'b' : 'r')) + '|' + (style === 'italic' || style === 'oblique' ? 'i' : 'n'); let f = loadedKeyCache.get(key); if (f !== undefined) { return f; }
	const bold = weight >= 600, ital = style === 'italic' || style === 'oblique';
	for (let fam of familyList.split(',')) {
		fam = fam.trim().replace(/^["']|["']$/g, '').toLowerCase(); if (!fam) { continue; }
		const c = custom.get(fam); if (c) { const m = c.find(e => (e.weight >= 600) === bold) ?? c[0]; f = m.font; break; }
		const real = FILES[fam] ? fam : ALIASES[fam]; if (real === 'inter') { f = loadFile(interFile(weight, ital)) ?? loadFile(interFile(400, false)); if (f) { break; } } else if (real && FILES[real]) { const files = FILES[real]; const idx = (bold ? 1 : 0) + (ital ? 2 : 0); f = loadFile(files[idx]) ?? loadFile(files[0]); if (f) { break; } }
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
/** GPOS/kern pair adjustment in px between two code points (opentype.js: pair lookups only; class-based and contextual kerning, e.g. Inter's, is not covered). */
export function kern(font, a, b, size) {
	if (a === 32 || b === 32) { return 0; }
	if (font.__kt === undefined) { try { font.__kt = font.position && font.position.getKerningTables ? font.position.getKerningTables('latn') : null; } catch { font.__kt = null; } if (font.__kt && !font.__kt.length) { font.__kt = null; } font.__kc = new Map(); }
	if (!font.__kt) { return 0; }
	const key = a * 0x110000 + b; let v = font.__kc.get(key);
	if (v === undefined) { v = font.position.getKerningValue(font.__kt, font.charToGlyph(String.fromCodePoint(a)).index, font.charToGlyph(String.fromCodePoint(b)).index) / font.unitsPerEm; font.__kc.set(key, v); }
	return v * size;
}
export function textWidth(font, text, size, letterSpacing = 0) { let w = 0; for (const ch of text) { w += advance(font, ch.codePointAt(0), size) + letterSpacing; } return w; }
export function glyphPath(font, cp, size) { return font.charToGlyph(String.fromCodePoint(cp)).getPath(0, 0, size); }
