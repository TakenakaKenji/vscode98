// Font registry shared by the native layout and the native rasterizer: gives every opentype.js font a native id (with its vertical metrics) and hands advances,
// kerning values and outlines to C on first use. Font file parsing stays in JavaScript in this spike.
import * as nr from 'spike:render';
import { advance, kern } from '../../06-rendering/host/dom/fonts.js';

const CMD_TYPE = { M: 0, L: 1, Q: 2, C: 3, Z: 4 };
export const fontsById = [];
export const stats = { advancesProvided: 0, outlinesProvided: 0, kernsProvided: 0, ms: 0 };
export function nativeFontId(font) {
	if (font.__nid === undefined) {
		const h = font.tables.hhea, os2 = font.tables.os2, upm = font.unitsPerEm;
		font.__nid = nr.registerFont(upm, h.ascender / upm, -h.descender / upm, (h.lineGap || 0) / upm); fontsById[font.__nid] = font; font.__nadv = new Set(); font.__nout = new Set(); font.__nkern = new Set(); font.__nstr = new Set();
	}
	return font.__nid;
}
/** advances for every code point of `text` and kerning for its adjacent pairs (what layout needs to measure it) */
export function ensureAdvances(font, id, text) {
	if (font.__nstr.has(text)) { return; } font.__nstr.add(text); const t0 = performance.now(); const seen = font.__nadv, kseen = font.__nkern; let prev = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0); if (!seen.has(cp)) { seen.add(cp); nr.provideAdvance(id, cp, advance(font, cp, 1)); stats.advancesProvided++; }
		if (prev) { const key = prev * 0x110000 + cp; if (!kseen.has(key)) { kseen.add(key); const v = kern(font, prev, cp, 1); if (v !== 0) { nr.provideKern(id, prev, cp, v); stats.kernsProvided++; } } }
		prev = cp;
	}
	stats.ms += performance.now() - t0;
}
/** the outline of one code point (needed at paint time) */
export function ensureOutline(font, id, cp) {
	if (font.__nout.has(cp)) { return; } font.__nout.add(cp); const t0 = performance.now(); const glyph = font.charToGlyph(String.fromCodePoint(cp)); const cmds = glyph.path.commands; const arr = new Float64Array(cmds.length * 7);
	for (let i = 0; i < cmds.length; i++) { const c = cmds[i], o = i * 7; arr[o] = CMD_TYPE[c.type]; arr[o + 1] = c.x ?? 0; arr[o + 2] = c.y ?? 0; arr[o + 3] = c.x1 ?? 0; arr[o + 4] = c.y1 ?? 0; arr[o + 5] = c.x2 ?? 0; arr[o + 6] = c.y2 ?? 0; }
	nr.provideOutline(id, cp, arr); stats.outlinesProvided++; stats.ms += performance.now() - t0;
}
