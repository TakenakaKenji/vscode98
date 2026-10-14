// The editing model of <input> and <textarea>: value, selection, undo history and the change event. Pure data (no layout, no painting): dom.js installs it on the
// element classes; textcontrol.js (keyboard, mouse, painting) builds the user-visible behaviour on top of it.
let Event_ = null, InputEvent_ = null;
export function setEventCtors(E, IE) { Event_ = E; InputEvent_ = IE; }

/** a change that needs repainting but not a new layout (the value of a control, its selection, the caret) */
export function touchPaint(el) { const d = el.ownerDocument; if (d) { d.__paintGen = (d.__paintGen | 0) + 1; } }

const isArea = (el) => el.localName === 'textarea';
const normalize = (el, v) => (isArea(el) ? v.replace(/\r\n?/g, '\n') : v.replace(/[\r\n]/g, ''));
const clamp = (n, len) => Math.max(0, Math.min(len, Math.trunc(+n) || 0));
const NO_SELECTION = /^(button|checkbox|radio|submit|reset|file|image|range|color|hidden)$/;

export function controlValue(el) { return el.__value !== undefined ? el.__value : isArea(el) ? normalize(el, el.textContent) : normalize(el, el.getAttribute('value') ?? ''); }

/** the properties installed on HTMLInputElement and HTMLTextAreaElement */
export const textProps = {
	get __tc() { return true; },
	get value() { return controlValue(this); },
	set value(v) {
		const nv = normalize(this, v === null || v === undefined ? '' : String(v)); const old = controlValue(this); this.__value = nv;
		if (nv !== old) { this.__selStart = this.__selEnd = nv.length; this.__selDir = 'none'; touchPaint(this); }
		else { this.__selStart = clamp(this.__selStart ?? 0, nv.length); this.__selEnd = clamp(this.__selEnd ?? 0, nv.length); }
	},
	get defaultValue() { return isArea(this) ? this.textContent : (this.getAttribute('value') ?? ''); },
	set defaultValue(v) { if (isArea(this)) { this.textContent = v; } else { this.setAttribute('value', v); } },
	get selectionStart() { if (NO_SELECTION.test(this.type || '')) { return null; } return clamp(this.__selStart ?? 0, controlValue(this).length); },
	set selectionStart(v) { this.setSelectionRange(v, Math.max(this.selectionEnd ?? 0, clamp(v, controlValue(this).length)), this.__selDir); },
	get selectionEnd() { if (NO_SELECTION.test(this.type || '')) { return null; } return clamp(this.__selEnd ?? 0, controlValue(this).length); },
	set selectionEnd(v) { this.setSelectionRange(Math.min(this.selectionStart ?? 0, clamp(v, controlValue(this).length)), v, this.__selDir); },
	get selectionDirection() { return this.__selDir || 'none'; },
	set selectionDirection(v) { this.__selDir = v; },
	setSelectionRange(s, e, dir = 'none') {
		const len = controlValue(this).length; s = clamp(s, len); e = clamp(e, len); if (e < s) { s = e; }
		if (s !== this.__selStart || e !== this.__selEnd) { this.__selStart = s; this.__selEnd = e; this.__selDir = dir || 'none'; touchPaint(this); this.__selChanged && this.__selChanged(); }
		else { this.__selDir = dir || 'none'; }
	},
	select() { this.setSelectionRange(0, controlValue(this).length, 'none'); },
	setRangeText(text, start, end, mode = 'preserve') {
		const v = controlValue(this); const s0 = clamp(start ?? this.selectionStart, v.length), e0 = clamp(end ?? this.selectionEnd, v.length); const s = Math.min(s0, e0), e = Math.max(s0, e0);
		const oldS = this.selectionStart, oldE = this.selectionEnd; text = normalize(this, String(text)); this.__value = v.slice(0, s) + text + v.slice(e); touchPaint(this);
		const delta = text.length - (e - s); let ns = oldS, ne = oldE;
		if (mode === 'select') { ns = s; ne = s + text.length; } else if (mode === 'start') { ns = ne = s; } else if (mode === 'end') { ns = ne = s + text.length; }
		else { const adj = (p) => (p > e ? p + delta : p > s ? (mode === 'preserve' ? s + text.length : p) : p); ns = adj(oldS); ne = adj(oldE); }
		this.__selStart = clamp(ns, this.__value.length); this.__selEnd = clamp(ne, this.__value.length);
	},
	get readOnly() { return this.hasAttribute('readonly'); }, set readOnly(v) { v ? this.setAttribute('readonly', '') : this.removeAttribute('readonly'); },
	get disabled() { return this.hasAttribute('disabled'); }, set disabled(v) { v ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); },
	get maxLength() { const m = this.getAttribute('maxlength'); return m === null ? -1 : parseInt(m, 10); }, set maxLength(v) { this.setAttribute('maxlength', v); },
	get textLength() { return controlValue(this).length; },
	get labels() { return []; },
	get form() { for (let p = this.parentElement; p; p = p.parentElement) { if (p.localName === 'form') { return p; } } return null; },
	checkValidity() { return true; }, reportValidity() { return true; }, setCustomValidity() { }, get validity() { return { valid: true }; }, get willValidate() { return true; },
};

/** focus/blur bookkeeping: the change event fires on blur (or Enter) when the value differs from the value at focus */
export function controlFocused(el) { el.__valueAtFocus = controlValue(el); }
export function fireChange(el) { if (el.__valueAtFocus !== undefined && el.__valueAtFocus !== controlValue(el)) { el.__valueAtFocus = controlValue(el); el.dispatchEvent(new Event_('change', { bubbles: true })); } }
export function controlBlurred(el) { fireChange(el); }

// ---- editing with undo history
const HISTORY_LIMIT = 200;
function snapshot(el) { return { v: controlValue(el), s: el.selectionStart ?? 0, e: el.selectionEnd ?? 0 }; }
function pushHistory(el, kind) {
	const h = (el.__hist ??= { undo: [], redo: [], last: null }); const snap = snapshot(el);
	if (h.last && kind && kind === h.last && kind === 'typing' && h.undo.length) { /* coalesce runs of typing into one undo step */ } else { h.undo.push(snap); if (h.undo.length > HISTORY_LIMIT) { h.undo.shift(); } }
	h.last = kind; h.redo.length = 0;
}
export function undoRedo(el, redo) {
	const h = el.__hist; if (!h) { return false; } const from = redo ? h.redo : h.undo, to = redo ? h.undo : h.redo; if (!from.length) { return false; }
	to.push(snapshot(el)); const s = from.pop(); h.last = null; el.__value = s.v; el.__selStart = s.s; el.__selEnd = s.e; el.__selDir = 'none'; touchPaint(el);
	el.dispatchEvent(new InputEvent_('input', { bubbles: true, inputType: redo ? 'historyRedo' : 'historyUndo', data: null })); return true;
}

/** replaces value[start, end) with text the way typing does: beforeinput (cancelable), the edit, input. Returns false when canceled or not editable. */
export function replaceRange(el, start, end, text, inputType = 'insertText', coalesce = null) {
	if (el.readOnly || el.disabled) { return false; } const v = controlValue(el); start = clamp(start, v.length); end = clamp(end, v.length); text = normalize(el, text);
	const max = el.maxLength; if (max >= 0 && text) { const room = max - (v.length - (end - start)); if (room <= 0) { text = ''; } else if (text.length > room) { text = text.slice(0, room); } if (!text && start === end) { return false; } }
	if (start === end && !text) { return false; }
	const be = new InputEvent_('beforeinput', { bubbles: true, cancelable: true, inputType, data: text || null }); if (!el.dispatchEvent(be)) { return false; }
	pushHistory(el, coalesce); el.__value = v.slice(0, start) + text + v.slice(end); el.__selStart = el.__selEnd = start + text.length; el.__selDir = 'none'; touchPaint(el);
	el.dispatchEvent(new InputEvent_('input', { bubbles: true, inputType, data: text || null })); return true;
}
