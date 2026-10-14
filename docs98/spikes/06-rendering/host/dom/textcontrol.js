// What a browser does for <input> and <textarea> besides holding a value (textmodel.js): lay the text out, paint it with the caret, the selection and the placeholder,
// turn keys and the mouse into edits and selection changes, copy/cut/paste, tab navigation, and the default action of clicks on checkboxes and labels.
import { resolveFont, fontMetrics, advance, kern } from './fonts.js';
import { computeStyle, parseColor, resolveLen } from './css.js';
import { ClipboardEvent, Event } from './dom.js';
import { optionList } from './selectmodel.js';
import { controlValue, replaceRange, undoRedo, fireChange, touchPaint } from './textmodel.js';

const TEXT_TYPE = /^(text|search|url|tel|email|password|number|)$/;
/** a control whose value the user edits as text */
export function isTextControl(el) { return !!el && (el.localName === 'textarea' || (el.localName === 'input' && TEXT_TYPE.test((el.getAttribute('type') || 'text').toLowerCase()))); }
const SELECTION_FALLBACK = [51, 144, 255, 255];

// ---- geometry
function lineHeightOf(v, met) { const l = v['line-height']; if (l === 'normal' || l === undefined) { return met.lineHeightNormal; } if (l && l.num !== undefined) { return l.num * v['font-size']; } const r = resolveLen(l, v['font-size']); return r === null ? met.lineHeightNormal : r; }
function measure(font, text, size, ls) { let w = 0, prev = 0; for (const ch of text) { const cp = ch.codePointAt(0); w += advance(font, cp, size) + ls; if (ls === 0 && prev) { w += kern(font, prev, cp, size); } prev = cp; } return w; }
/** x of every UTF-16 index of `text` (length + 1 entries; the second half of a surrogate pair shares the x of its first half) */
function prefixes(font, text, size, ls) { const xs = new Float64Array(text.length + 1); let w = 0, prev = 0, i = 0; for (const ch of text) { const cp = ch.codePointAt(0); xs[i] = w; w += advance(font, cp, size) + ls; if (ls === 0 && prev) { w += kern(font, prev, cp, size); } prev = cp; if (ch.length === 2) { xs[i + 1] = xs[i]; } i += ch.length; } xs[text.length] = w; return xs; }

/** lays the control's text out: the lines (one for an input, wrapped paragraphs for a textarea) with their x positions; cached on the element until the text, size or font changes */
export function geometry(b) {
	const el = b.el, v = b.v; const value = controlValue(el); const area = el.localName === 'textarea'; const password = !area && (el.getAttribute('type') || '').toLowerCase() === 'password';
	const font = resolveFont(v['font-family'], v['font-weight'], v['font-style']), size = v['font-size']; const ls = typeof v['letter-spacing'] === 'number' ? v['letter-spacing'] : 0;
	const pl = b.pl ?? 0, pt = b.pt ?? 0; const x0 = b.ax + b.bl + pl, y0 = b.ay + b.bt + pt, cw = Math.max(0, b.w - (b.hx ?? (b.bl + b.br + pl + (b.pr ?? 0)))), ch = Math.max(0, b.h - (b.vy ?? (b.bt + b.bb + pt + (b.pb ?? 0))));
	const wrap = area && el.getAttribute('wrap') !== 'off' && !/^(pre|nowrap)$/.test(String(v['white-space']));
	const key = value + '\u0000' + cw + '|' + size + '|' + ls + '|' + (font && font.__path) + '|' + (password ? 'p' : '') + (wrap ? 'w' : '');
	let g = el.__tcGeo; if (g && g.key === key) { g.x0 = x0; g.y0 = y0; g.ch = ch; g.b = b; return g; }
	const met = fontMetrics(font, size); const lh = Math.max(1, lineHeightOf(v, met)); const text = password ? '•'.repeat(value.length) : value; const lines = [];
	const addLine = (s, e, next) => lines.push({ s, e, next, text: text.slice(s, e), xs: null });
	if (!area) { addLine(0, text.length, text.length); }
	else {
		let p = 0; for (;;) {
			let nl = text.indexOf('\n', p); if (nl < 0) { nl = text.length; }
			if (!wrap || cw <= 0) { addLine(p, nl, nl + 1); }
			else {
				let s = p, w = 0, lastBreak = -1, wAtBreak = 0, prev = 0, i = p;
				while (i < nl) {
					const cp = text.codePointAt(i), n = cp > 0xffff ? 2 : 1; const a = advance(font, cp, size) + ls + (ls === 0 && prev ? kern(font, prev, cp, size) : 0);
					if (w + a > cw && i > s && cp !== 32) { if (lastBreak > s) { addLine(s, lastBreak, lastBreak); s = lastBreak; i = lastBreak; w = 0; lastBreak = -1; prev = 0; continue; } addLine(s, i, i); s = i; w = 0; lastBreak = -1; prev = 0; continue; }
					w += a; prev = cp; i += n; if (cp === 32) { lastBreak = i; wAtBreak = w; }
				}
				addLine(s, nl, nl + 1);
			}
			if (nl >= text.length) { break; } p = nl + 1;
		}
	}
	g = { key, b, el, font, size, ls, met, lh, lines, area, x0, y0, cw, ch, text, fontPath: font && font.__path };
	for (let i = 0; i < lines.length; i++) { lines[i].y = i * lh; } g.height = lines.length * lh; el.__tcGeo = g; return g;
}
const lineXs = (g, line) => (line.xs ??= prefixes(g.font, line.text, g.size, g.ls));
function lineOf(g, idx) { const L = g.lines; for (let i = L.length - 1; i >= 0; i--) { if (idx >= L[i].s) { return i; } } return 0; }
/** x (relative to the text origin, unscrolled) and line index of a caret position */
function caretXY(g, idx) { const li = lineOf(g, idx); const line = g.lines[li]; const xs = lineXs(g, line); return { li, x: xs[Math.max(0, Math.min(line.text.length, idx - line.s))], y: line.y }; }
function indexAt(g, px, py) {
	const sx = g.area ? 0 : (g.el.__tcSX || 0), sy = g.area ? (g.el.__scrollTop || 0) : 0; const li = Math.max(0, Math.min(g.lines.length - 1, Math.floor((py - g.y0 + sy) / g.lh))); const line = g.lines[li]; const xs = lineXs(g, line); const x = px - g.x0 + sx;
	const n = line.text.length; for (let i = 0; i < n;) { const w = line.text.codePointAt(i) > 0xffff ? 2 : 1; if (x < (xs[i] + xs[i + w]) / 2) { return line.s + i; } i += w; }
	return line.s + n;
}
/** scrolls the text so that the moving end of the selection is visible */
function ensureVisible(g) {
	const el = g.el; const dir = el.selectionDirection; const idx = dir === 'backward' ? el.selectionStart : el.selectionEnd; const c = caretXY(g, idx);
	if (!g.area) { let sx = el.__tcSX || 0; const total = lineXs(g, g.lines[0])[g.lines[0].text.length]; if (c.x - sx > g.cw - 1) { sx = c.x - g.cw + 1; } if (c.x - sx < 0) { sx = c.x; } sx = Math.max(0, Math.min(sx, Math.max(0, total - g.cw + 1))); if (sx !== (el.__tcSX || 0)) { el.__tcSX = sx; } }
	else { let st = el.__scrollTop || 0; if (c.y < st) { st = c.y; } if (c.y + g.lh > st + g.ch) { st = c.y + g.lh - g.ch; } st = Math.max(0, Math.min(st, Math.max(0, g.height - g.ch))); if (st !== (el.__scrollTop || 0)) { el.__scrollTop = st; } }
}

// ---- painting
function selectionColor(el) { const vars = el.__cs && el.__cs.vars; for (const k of ['--vscode-selection-background', '--vscode-editor-selectionBackground']) { const raw = vars && vars.get(k); const c = raw && parseColor(raw); if (c) { return c; } } return SELECTION_FALLBACK; }
function placeholderColor(doc, el, fg) {
	let cs = null; try { const parent = el.parentElement && el.parentElement.__cs; cs = doc.__ruleIndex ? computeStyle(el, parent || el.__cs, doc.__ruleIndex, doc.__env, 'placeholder') : null; } catch { cs = null; }
	const c = cs && cs.values && cs.values.color; if (c) { return c; } return [fg[0], fg[1], fg[2], fg[3] * 0.55];
}
/** paints the text of an <input>/<textarea> box: selection, text (or placeholder), caret */
export function paintTextControl(p, b, dx, dy) {
	const el = b.el; if (!isTextControl(el) || b.v.visibility === 'hidden') { return; } const doc = el.ownerDocument; const g = geometry(b); const value = controlValue(el); const focused = doc.__activeElement === el;
	if (g.cw <= 0 || g.ch <= 0) { return; } if (focused) { ensureVisible(g); }
	const sx = g.area ? 0 : (el.__tcSX || 0), sy = g.area ? (el.__scrollTop || 0) : 0; const ox = g.x0 + dx - sx, oy = g.y0 + dy - sy; const color = b.v.color; if (!color) { return; }
	const baseOf = (line) => (g.area ? Math.round(oy + line.y + (g.lh - (g.met.ascent + g.met.descent)) / 2 + g.met.ascent) : Math.round(g.y0 + dy + (g.ch - (g.met.ascent + g.met.descent)) / 2 + g.met.ascent));
	p.pushClip(g.x0 + dx, g.y0 + dy, g.x0 + dx + g.cw, g.y0 + dy + g.ch);
	try {
		const s = el.selectionStart ?? 0, e = el.selectionEnd ?? 0; const lineTop = (line) => (g.area ? oy + line.y : g.y0 + dy + Math.max(0, (g.ch - g.lh) / 2)); const lineH = Math.min(g.lh, g.ch);
		if (focused && e > s) { const sel = selectionColor(el); for (const line of g.lines) { if (e <= line.s && line.s !== s || s > line.next) { continue; } const a = Math.max(s, line.s), z = Math.min(e, line.e); const xs = lineXs(g, line); const xa = xs[Math.max(0, a - line.s)], xz = xs[Math.max(0, Math.min(line.text.length, z - line.s))] + (e > line.e && line.e < g.text.length && g.area ? g.size * 0.3 : 0); if (xz > xa || (e > line.e && g.area)) { p.fillRect(ox + xa, lineTop(line), xz - xa, lineH, sel); } } }
		if (value === '') { const ph = el.getAttribute('placeholder'); if (ph) { p.b.glyphRun(g.font, g.size, g.ls, 0, g.x0 + dx, baseOf(g.lines[0]), placeholderColor(doc, el, color), 1, ph.replace(/[\r\n]+/g, ' ')); } }
		else { for (const line of g.lines) { if (line.text) { const y = lineTop(line); if (g.area && (y + g.lh < g.y0 + dy || y > g.y0 + dy + g.ch)) { continue; } p.b.glyphRun(g.font, g.size, g.ls, 0, ox, baseOf(line), color, 1, line.text); } } }
		if (focused && e === s && !el.readOnly) { const c = caretXY(g, s); const line = g.lines[c.li]; const top = lineTop(line); p.fillRect(Math.round(ox + c.x), top, 1, lineH, color); }
	} finally { p.popClip(); }
}

/** paints the shown option of a <select> (and the drop-down arrow unless `appearance: none`); a list box (multiple/size > 1) paints its options with the selected ones highlighted */
export function paintSelect(p, b, dx, dy) {
	const el = b.el; if (b.v.visibility === 'hidden') { return; } const v = b.v; const color = v.color; if (!color) { return; }
	const font = resolveFont(v['font-family'], v['font-weight'], v['font-style']), size = v['font-size']; const met = fontMetrics(font, size); const pl = b.pl ?? 0, pt = b.pt ?? 0, pr = b.pr ?? 0, pb = b.pb ?? 0;
	const x0 = b.ax + b.bl + pl + dx, y0 = b.ay + b.bt + pt + dy, cw = b.w - b.bl - b.br - pl - pr, ch = b.h - b.bt - b.bb - pt - pb; if (cw <= 0 || ch <= 0) { return; }
	const opts = optionList(el); const list = el.hasAttribute('multiple') || (parseInt(el.getAttribute('size') ?? '1', 10) || 1) > 1; const appearance = String(v.appearance ?? v['-webkit-appearance'] ?? 'auto');
	p.pushClip(x0, y0, x0 + cw, y0 + ch);
	try {
		if (!list) { const i = el.selectedIndex; const text = i >= 0 && opts[i] ? opts[i].label : ''; if (text) { p.b.glyphRun(font, size, 0, 0, x0, Math.round(y0 + (ch - (met.ascent + met.descent)) / 2 + met.ascent), color, 1, text); } }
		else { const lh = met.lineHeightNormal; opts.forEach((o, k) => { const y = y0 + k * lh; if (y > y0 + ch) { return; } if (o.selected) { p.fillRect(x0, y, cw, lh, [51, 144, 255, 255]); } p.b.glyphRun(font, size, 0, 0, x0 + 2, Math.round(y + met.ascent), o.selected ? [255, 255, 255, 255] : color, 1, o.label); }); }
	} finally { p.popClip(); }
	if (!list && appearance !== 'none') { const ax = b.ax + b.w - b.br - 12 + dx, ay = b.ay + b.h / 2 + dy; for (let k = 0; k < 4; k++) { p.fillRect(Math.round(ax + k), Math.round(ay - 1 + k), 7 - 2 * k, 1, color); } }   // the chevron
}

// ---- clipboard (a host with a system clipboard installs globalThis.__clipboard98 = { readText(), writeText(text) })
const memoryClipboard = { text: '', readText() { return this.text; }, writeText(t) { this.text = String(t); } };
const clipboard = () => globalThis.__clipboard98 || memoryClipboard;
export function dataTransfer() {   // enough of DataTransfer for clipboard events: string items (Monaco's paste pipeline iterates `items` and calls getAsString), no files
	const data = new Map();
	return { setData(t, v) { data.set(t, String(v)); }, getData(t) { return data.get(t === 'text' ? 'text/plain' : t) ?? ''; }, clearData(t) { if (t) { data.delete(t); } else { data.clear(); } }, get types() { return [...data.keys()]; },
		get items() { return [...data].map(([type, value]) => ({ kind: 'string', type, getAsString(cb) { if (cb) { cb(value); } }, getAsFile() { return null; } })); }, files: [], dropEffect: 'none', effectAllowed: 'all', setDragImage() { } };
}
const selectedText = (el) => controlValue(el).slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
/** copy / cut as a browser performs them: the (cancelable) event first, whose handler may supply the data; then the default for a text control; the data goes to the system clipboard */
export function copyCut(doc, cut) {
	const target = doc.activeElement || doc.body; const dt = dataTransfer(); const ev = new ClipboardEvent(cut ? 'cut' : 'copy', { bubbles: true, cancelable: true, composed: true, clipboardData: dt }); let wrote = false;
	if (target.dispatchEvent(ev)) { if (isTextControl(target) && selectedText(target)) { dt.setData('text/plain', selectedText(target)); if (cut) { replaceRange(target, target.selectionStart, target.selectionEnd, '', 'deleteByCut'); } wrote = true; } }
	else { wrote = dt.types.length > 0; }
	if (!wrote && !cut && !isTextControl(target) && doc.__selection && !doc.__selection.isCollapsed && target.dispatchEvent !== undefined && dt.types.length === 0 && !ev.defaultPrevented) { dt.setData('text/plain', doc.__selection.toString()); wrote = true; }
	if (wrote) { clipboard().writeText(dt.getData('text/plain')); } return true;
}
export function paste(doc, textOverride) {
	const target = doc.activeElement || doc.body; const text = textOverride ?? clipboard().readText(); const dt = dataTransfer(); dt.setData('text/plain', text);
	const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: dt });
	if (target.dispatchEvent(ev) && isTextControl(target)) { replaceRange(target, target.selectionStart, target.selectionEnd, text, 'insertFromPaste'); } return true;
}
/** document.execCommand for the commands VS Code's inputs use */
export function execCommand(doc, cmd, value) {
	const el = doc.activeElement; const tc = isTextControl(el);
	switch (String(cmd).toLowerCase()) {
		case 'copy': return copyCut(doc, false); case 'cut': return copyCut(doc, true); case 'paste': return paste(doc);
		case 'undo': return tc ? undoRedo(el, false) : false; case 'redo': return tc ? undoRedo(el, true) : false;
		case 'selectall': if (tc) { el.select(); return true; } return false;
		case 'delete': return tc ? replaceRange(el, el.selectionStart, el.selectionStart === el.selectionEnd ? el.selectionEnd + 1 : el.selectionEnd, '', 'deleteContentForward') : false;
		case 'inserttext': return tc ? replaceRange(el, el.selectionStart, el.selectionEnd, String(value ?? ''), 'insertText') : false;
		default: return false;
	}
}
export const supportedCommands = new Set(['copy', 'cut', 'paste', 'undo', 'redo', 'selectall', 'delete', 'inserttext']);

// ---- keyboard
const isWordChar = (ch) => /[\p{L}\p{N}_]/u.test(ch); const isSpace = (ch) => /\s/.test(ch);
function prevIndex(v, i) { if (i <= 0) { return 0; } return i >= 2 && /[\udc00-\udfff]/.test(v[i - 1]) && /[\ud800-\udbff]/.test(v[i - 2]) ? i - 2 : i - 1; }
function nextIndex(v, i) { if (i >= v.length) { return v.length; } return /[\ud800-\udbff]/.test(v[i]) && i + 1 < v.length ? i + 2 : i + 1; }
function wordLeft(v, i) { while (i > 0 && isSpace(v[i - 1])) { i--; } if (i > 0) { const w = isWordChar(v[i - 1]); while (i > 0 && !isSpace(v[i - 1]) && isWordChar(v[i - 1]) === w) { i--; } } return i; }
function wordRight(v, i) { const n = v.length; if (i < n) { const w = isWordChar(v[i]); while (i < n && !isSpace(v[i]) && isWordChar(v[i]) === w) { i++; } } while (i < n && isSpace(v[i]) && v[i] !== '\n') { i++; } return i; }
function wordAt(v, i) { let s = i, e = i; const w = i < v.length && isWordChar(v[i]); const same = (c) => (w ? isWordChar(c) : !isWordChar(c) && !isSpace(c)); if (i >= v.length || isSpace(v[i])) { while (s > 0 && isSpace(v[s - 1]) && v[s - 1] !== '\n') { s--; } while (e < v.length && isSpace(v[e]) && v[e] !== '\n') { e++; } return [s, e]; } while (s > 0 && same(v[s - 1])) { s--; } while (e < v.length && same(v[e])) { e++; } return [s, e]; }

function geoOf(el) { const d = el.ownerDocument; d.__ensureLayout(); const b = d.__layout && d.__layout.boxOf.get(el); return b ? geometry(b) : null; }
function setCaret(el, pos, extend, prefX) {
	const s = el.selectionStart, e = el.selectionEnd; pos = Math.max(0, Math.min(controlValue(el).length, pos));
	if (extend) { const anchor = el.selectionDirection === 'backward' ? e : s; el.setSelectionRange(Math.min(anchor, pos), Math.max(anchor, pos), pos < anchor ? 'backward' : pos > anchor ? 'forward' : 'none'); } else { el.setSelectionRange(pos, pos, 'none'); }
	el.__tcPrefX = prefX; const g = geoOf(el); if (g) { ensureVisible(g); } touchPaint(el);
}
/** the default action of a keydown that no handler canceled, for a focused text control; returns true when it did something */
export function controlKeydown(el, ev) {
	if (!isTextControl(el) || el.disabled) { return false; } const key = ev.key, ctrl = ev.ctrlKey && !ev.altKey, shift = ev.shiftKey, alt = ev.altKey; const v = controlValue(el); const area = el.localName === 'textarea';
	const s = el.selectionStart, e = el.selectionEnd, back = el.selectionDirection === 'backward'; const active = back ? s : e; const edit = !el.readOnly;
	if (ctrl) {
		switch (key.toLowerCase()) {
			case 'a': el.select(); return true;
			case 'c': case 'insert': return copyCut(el.ownerDocument, false);
			case 'x': return edit ? copyCut(el.ownerDocument, true) : copyCut(el.ownerDocument, false);
			case 'v': return edit ? paste(el.ownerDocument) : true;
			case 'z': return edit && undoRedo(el, shift);
			case 'y': return edit && undoRedo(el, true);
		}
	}
	if (shift && !ctrl && key === 'Insert') { return edit ? paste(el.ownerDocument) : true; }
	if (shift && !ctrl && key === 'Delete') { return copyCut(el.ownerDocument, edit); }
	switch (key) {
		case 'Backspace': if (!edit) { return true; } if (s !== e) { replaceRange(el, s, e, '', 'deleteContentBackward'); } else if (s > 0) { replaceRange(el, ctrl ? wordLeft(v, s) : prevIndex(v, s), s, '', ctrl ? 'deleteWordBackward' : 'deleteContentBackward', ctrl ? null : 'deleting'); } return true;
		case 'Delete': if (!edit) { return true; } if (s !== e) { replaceRange(el, s, e, '', 'deleteContentForward'); } else if (e < v.length) { replaceRange(el, e, ctrl ? wordRight(v, e) : nextIndex(v, e), '', ctrl ? 'deleteWordForward' : 'deleteContentForward', ctrl ? null : 'deleting'); } return true;
		case 'ArrowLeft': if (s !== e && !shift) { setCaret(el, ctrl ? wordLeft(v, s) : s, false); } else { setCaret(el, ctrl ? wordLeft(v, active) : prevIndex(v, active), shift); } return true;
		case 'ArrowRight': if (s !== e && !shift) { setCaret(el, ctrl ? wordRight(v, e) : e, false); } else { setCaret(el, ctrl ? wordRight(v, active) : nextIndex(v, active), shift); } return true;
		case 'Home': case 'End': {
			const home = key === 'Home'; if (ctrl || !area) { setCaret(el, home ? 0 : v.length, shift); return true; }
			const g = geoOf(el); if (!g) { return true; } const line = g.lines[lineOf(g, active)]; setCaret(el, home ? line.s : line.e, shift); return true;
		}
		case 'ArrowUp': case 'ArrowDown': {
			const up = key === 'ArrowUp'; if (!area) { setCaret(el, up ? 0 : v.length, shift); return true; }
			const g = geoOf(el); if (!g) { return true; } const c = caretXY(g, active); const x = el.__tcPrefX ?? c.x; const ni = c.li + (up ? -1 : 1);
			if (ni < 0) { setCaret(el, 0, shift); } else if (ni >= g.lines.length) { setCaret(el, v.length, shift); } else { setCaret(el, indexAt(g, g.x0 + x - (el.__tcSX || 0), g.y0 + g.lines[ni].y - (el.__scrollTop || 0) + g.lh / 2), shift, x); } return true;
		}
		case 'PageUp': case 'PageDown': {
			if (!area) { return false; } const g = geoOf(el); if (!g) { return true; } const c = caretXY(g, active); const x = el.__tcPrefX ?? c.x; const step = Math.max(1, Math.floor(g.ch / g.lh)); const ni = Math.max(0, Math.min(g.lines.length - 1, c.li + (key === 'PageUp' ? -step : step)));
			setCaret(el, indexAt(g, g.x0 + x - (el.__tcSX || 0), g.y0 + g.lines[ni].y - (el.__scrollTop || 0) + g.lh / 2), shift, x); return true;
		}
		case 'Enter': if (!area) { fireChange(el); return true; } return false;
	}
	return false;
}
/** typed text (the character message of the window): inserted at the selection, one undo step per run of typing */
export function controlTextInput(el, text) { if (!isTextControl(el) || el.disabled || el.readOnly) { return false; } const s = el.selectionStart, e = el.selectionEnd; const ok = replaceRange(el, s, e, text, text === '\n' ? 'insertLineBreak' : 'insertText', text === '\n' ? null : 'typing'); const g = ok && geoOf(el); if (g) { ensureVisible(g); } return ok; }

// ---- mouse
let drag = null;
export function controlMouseDown(el, x, y, detail, shift) {
	if (!isTextControl(el) || el.disabled) { return false; } const g = geoOf(el); if (!g) { return false; } const idx = indexAt(g, x, y); const v = controlValue(el);
	if (detail >= 3) { const li = g.lines[lineOf(g, idx)]; el.setSelectionRange(g.area ? li.s : 0, g.area ? li.e : v.length, 'forward'); drag = null; }
	else if (detail === 2) { const [ws, we] = wordAt(v, Math.min(idx, v.length)); el.setSelectionRange(ws, we, 'forward'); drag = { el, anchor: ws, end: we, word: true }; }
	else if (shift) { setCaret(el, idx, true); drag = { el, anchor: el.selectionDirection === 'backward' ? el.selectionEnd : el.selectionStart }; }
	else { setCaret(el, idx, false); drag = { el, anchor: idx }; }
	ensureVisible(g); touchPaint(el); return true;
}
export function controlMouseMove(x, y) {
	if (!drag) { return false; } const el = drag.el; const g = geoOf(el); if (!g) { return false; } const idx = indexAt(g, x, y); const v = controlValue(el);
	if (drag.word) { const [ws, we] = wordAt(v, Math.min(idx, v.length)); if (idx < drag.anchor) { el.setSelectionRange(ws, drag.end, 'backward'); } else { el.setSelectionRange(drag.anchor, we, 'forward'); } }
	else { el.setSelectionRange(Math.min(drag.anchor, idx), Math.max(drag.anchor, idx), idx < drag.anchor ? 'backward' : 'forward'); }
	ensureVisible(g); touchPaint(el); return true;
}
export function controlMouseUp() { const was = drag !== null; drag = null; return was; }
export const dragging = () => drag !== null;
/** the wheel over a textarea scrolls its text */
export function controlWheel(el, dy) { if (!isTextControl(el) || el.localName !== 'textarea') { return false; } const g = geoOf(el); if (!g || g.height <= g.ch) { return false; } const st = Math.max(0, Math.min(g.height - g.ch, (el.__scrollTop || 0) + dy)); if (st === (el.__scrollTop || 0)) { return false; } el.__scrollTop = st; touchPaint(el); return true; }

// ---- focus navigation and the default action of clicks
const NATIVE_FOCUSABLE = 'input, textarea, select, button, a[href], [tabindex], [contenteditable=""], [contenteditable="true"]';
function tabbable(doc) {
	const lay = doc.__layout; const out = [];
	for (const el of doc.querySelectorAll(NATIVE_FOCUSABLE)) {
		if (el.disabled || (el.localName === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden')) { continue; }
		const ta = el.getAttribute('tabindex'); const ti = ta === null ? 0 : parseInt(ta, 10); if (ti < 0 || Number.isNaN(ti)) { continue; }
		const b = lay && lay.boxOf.get(el); if (!b || b.w <= 0 && b.h <= 0 || (b.v && b.v.visibility === 'hidden')) { continue; }
		let hidden = false; for (let p = el.parentElement; p; p = p.parentElement) { if (p.getAttribute('aria-hidden') === 'true' && false) { hidden = true; break; } } if (!hidden) { out.push({ el, ti }); }
	}
	const pos = out.filter(x => x.ti > 0).sort((a, b) => a.ti - b.ti), zero = out.filter(x => x.ti === 0); return [...pos, ...zero].map(x => x.el);
}
/** Tab / Shift+Tab: focus moves to the next (previous) focusable element in document order */
export function focusNext(doc, back) {
	doc.__ensureLayout(); const list = tabbable(doc); if (!list.length) { return false; } const cur = doc.activeElement; let i = cur ? list.indexOf(cur) : -1;
	if (i < 0 && cur) { const all = [...doc.querySelectorAll('*')]; const at = all.indexOf(cur); i = -1; for (let k = 0; k < list.length; k++) { if (all.indexOf(list[k]) > at) { i = back ? k : k - 1; break; } } if (i < 0) { i = back ? list.length : -1; } }
	const next = list[(i + (back ? -1 : 1) + list.length) % list.length]; next.focus(); if (isTextControl(next)) { next.select(); } return true;
}
/** the default action of a click that no handler canceled: toggles a checkbox, selects a radio, forwards a label's click to its control */
export function clickDefault(el) {
	for (let e = el; e; e = e.parentElement) {
		if (e.localName === 'label') { const target = e.getAttribute('for') ? e.ownerDocument.getElementById(e.getAttribute('for')) : e.querySelector('input, textarea, select, button'); if (target && target !== el) { target.focus?.(); target.dispatchEvent(new (e.ownerDocument.defaultView.MouseEvent)('click', { bubbles: true, cancelable: true })); } return; }
		if (e.localName === 'input') { const t = (e.getAttribute('type') || '').toLowerCase(); if (e.disabled) { return; } if (t === 'checkbox') { e.checked = !e.checked; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } else if (t === 'radio' && !e.checked) { const name = e.getAttribute('name'); if (name) { for (const r of e.ownerDocument.querySelectorAll('input[type=radio]')) { if (r !== e && r.getAttribute('name') === name) { r.checked = false; } } } e.checked = true; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } return; }
		if (e.localName === 'button' || e.localName === 'a' || e.localName === 'select') { return; }
	}
}
