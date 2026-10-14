// Turns input messages (the vocabulary of the native window: mousemove/mousedown/mouseup/dblclick/wheel/keydown/keyup/char with pixel coordinates, virtual-key codes and
// modifier bits) into DOM events and the default actions of a browser: focus on click, text editing and selection in <input>/<textarea>, Tab navigation, click activation.
// The window host feeds it from WM_* messages; scenarios and tests feed it directly, so a test exercises exactly the path a user does.
import { createDocSelection } from './docselect.js';
import { createDnd } from './dnd.js';
import { isTextControl, copyCut, controlKeydown, controlTextInput, controlMouseDown, controlMouseMove, controlMouseUp, dragging, controlWheel, focusNext, clickDefault } from './textcontrol.js';

// Windows virtual-key code -> [DOM key, DOM code]; letters, digits and OEM punctuation are handled below
const VK = { 8: ['Backspace', 'Backspace'], 9: ['Tab', 'Tab'], 13: ['Enter', 'Enter'], 16: ['Shift', 'ShiftLeft'], 17: ['Control', 'ControlLeft'], 18: ['Alt', 'AltLeft'], 19: ['Pause', 'Pause'], 20: ['CapsLock', 'CapsLock'], 27: ['Escape', 'Escape'], 32: [' ', 'Space'],
	33: ['PageUp', 'PageUp'], 34: ['PageDown', 'PageDown'], 35: ['End', 'End'], 36: ['Home', 'Home'], 37: ['ArrowLeft', 'ArrowLeft'], 38: ['ArrowUp', 'ArrowUp'], 39: ['ArrowRight', 'ArrowRight'], 40: ['ArrowDown', 'ArrowDown'], 45: ['Insert', 'Insert'], 46: ['Delete', 'Delete'],
	91: ['Meta', 'MetaLeft'], 92: ['Meta', 'MetaRight'], 93: ['ContextMenu', 'ContextMenu'], 144: ['NumLock', 'NumLock'], 145: ['ScrollLock', 'ScrollLock'] };
for (let i = 1; i <= 24; i++) { VK[111 + i] = ['F' + i, 'F' + i]; }
const OEM = { 186: [';', ':', 'Semicolon'], 187: ['=', '+', 'Equal'], 188: [',', '<', 'Comma'], 189: ['-', '_', 'Minus'], 190: ['.', '>', 'Period'], 191: ['/', '?', 'Slash'], 192: ['`', '~', 'Backquote'], 219: ['[', '{', 'BracketLeft'], 220: ['\\', '|', 'Backslash'], 221: [']', '}', 'BracketRight'], 222: ["'", '"', 'Quote'] };
const SHIFTED_DIGITS = ')!@#$%^&*(';
export function keyInfo(vk, mods, extended) {
	const shift = !!(mods & 1), caps = !!(mods & 16);
	if (vk >= 65 && vk <= 90) { const c = String.fromCharCode(vk); return [shift !== caps ? c : c.toLowerCase(), 'Key' + c]; }
	if (vk >= 48 && vk <= 57) { return [shift ? SHIFTED_DIGITS[vk - 48] : String.fromCharCode(vk), 'Digit' + String.fromCharCode(vk)]; }
	if (vk >= 96 && vk <= 105) { return [String(vk - 96), 'Numpad' + (vk - 96)]; }
	if (OEM[vk]) { return [shift ? OEM[vk][1] : OEM[vk][0], OEM[vk][2]]; }
	if (vk === 16 || vk === 17 || vk === 18) { return [VK[vk][0], VK[vk][1].replace('Left', extended ? 'Right' : 'Left')]; }
	return VK[vk] || ['Unidentified', 'Unidentified'];
}
export const editable = (el) => !!el && (el.localName === 'textarea' || (el.localName === 'input' && !/^(button|checkbox|radio|submit|reset|file|image|range|color)$/.test(el.type || 'text')) || el.isContentEditable);
const BUTTONISH = /^(button|submit|reset|checkbox|radio|image)$/;
const isButtonish = (el) => el && (el.localName === 'button' || (el.localName === 'input' && BUTTONISH.test((el.getAttribute('type') || '').toLowerCase())) || (el.localName === 'a' && el.hasAttribute('href')));

/** ctx: { doc, env, log?, opt?(name, default), note?(what, error) }; hooks: { setCursor(cursorName), activity() } */
export function createInputDriver(ctx, hooks = {}) {
	const { doc, env } = ctx; const debug = () => ctx.opt?.('debug-input', '0') === '1';
	const Ev = (name, o) => new env.window.MouseEvent(name, { bubbles: true, cancelable: true, composed: true, view: env.window, ...o });
	// Monaco's mouse handling listens to Pointer Events, not mouse events: every mouse action is sent as the pointer event first, then as the legacy mouse event, as browsers do
	const Pe = (name, o) => new env.window.PointerEvent(name, { bubbles: true, cancelable: true, composed: true, view: env.window, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...o });
	const docSel = createDocSelection(doc, env);
	let charSuppressed = false, hover = null, downTarget = null, lastClick = { t: -1e9, x: 0, y: 0, n: 0 };
	const at = (x, y) => doc.elementFromPoint(x, y) || doc.body;
	/** the target of a move/up: the element that captured the pointer (setPointerCapture) or the element under it */
	const target = (x, y) => { const c = doc.__capture; if (c) { if (c.el.isConnected !== false && doc.contains(c.el)) { return c.el; } doc.__capture = null; } return at(x, y); };
	let dnd = null;
	const releaseCapture = () => { const c = doc.__capture; if (c) { doc.__capture = null; dispatch(c.el, new env.window.PointerEvent('lostpointercapture', { bubbles: true, pointerId: c.id ?? 1, pointerType: 'mouse' })); } };
	const dispatch = (el, ev) => { try { return el.dispatchEvent(ev); } catch (e) { ctx.note?.('window event ' + ev.type, e); return true; } };
	const pdispatch = (el, ev) => (ctx.opt?.('no-pointer', '0') === '1' ? true : dispatch(el, ev));   // --no-pointer 1: legacy mouse events only (A/B switch)
	const guard = (what, f) => { try { return f(); } catch (e) { ctx.note?.(what, e); return false; } };
	dnd = createDnd(ctx, { at, dispatch });
	const setCursor = (el) => { try { const c = env.window.getComputedStyle(el).cursor; hooks.setCursor?.(c && c !== 'auto' ? c : (editable(el) ? 'text' : 'default')); } catch { /* keep */ } };
	const focusFor = (el) => { for (let e = el; e; e = e.parentElement) { if (editable(e) || e.hasAttribute?.('tabindex') || isButtonish(e)) { e.focus?.(); return; } } doc.activeElement?.blur?.(); };
	const clickCount = (x, y, base) => { const now = performance.now(); const near = now - lastClick.t < 500 && Math.abs(lastClick.x - x) < 5 && Math.abs(lastClick.y - y) < 5; lastClick = { t: now, x, y, n: near ? Math.min(3, lastClick.n + 1) : (base || 1) }; return lastClick.n; };
	/** the :hover state and the (non-bubbling) enter/leave events of the elements whose hover status changed between two pointer targets */
	const chainOf = (el) => { const c = []; for (let e = el; e; e = e.parentElement) { c.push(e); } return c; };
	const enterLeave = (from, to, base) => {
		const oldChain = from ? chainOf(from) : [], newChain = to ? chainOf(to) : []; const inNew = new Set(newChain), inOld = new Set(oldChain);
		for (const e of oldChain) { if (!inNew.has(e)) { e.__hover = false; e.__invalidate?.('style', 'state', 'hover'); pdispatch(e, Pe('pointerleave', { ...base, bubbles: false, relatedTarget: to })); dispatch(e, Ev('mouseleave', { ...base, bubbles: false, relatedTarget: to })); } }
		for (let i = newChain.length - 1; i >= 0; i--) { const e = newChain[i]; if (!inOld.has(e)) { e.__hover = true; e.__invalidate?.('style', 'state', 'hover'); pdispatch(e, Pe('pointerenter', { ...base, bubbles: false, relatedTarget: from })); dispatch(e, Ev('mouseenter', { ...base, bubbles: false, relatedTarget: from })); } }
	};
	/** :active while a button is down */
	const setActive = (el, on) => { for (let e = el; e; e = e.parentElement) { if (!!e.__active !== on) { e.__active = on; e.__invalidate?.('style', 'state', 'active'); } } };
	const press = (el, a, b, c, d, detail, mods) => {
		const base = { clientX: a, clientY: b, screenX: a, screenY: b, ctrlKey: !!(mods & 2), shiftKey: !!(mods & 1), altKey: !!(mods & 4), metaKey: !!(mods & 8) };
		if (c === 0) { setActive(el, true); }
		const pointerOk = pdispatch(el, Pe('pointerdown', { ...base, button: c, buttons: d, detail })); let ok = false;
		if (pointerOk && dispatch(el, Ev('mousedown', { ...base, button: c, buttons: d, detail }))) { focusFor(el); ok = true; }   // a pointerdown the page cancels (Monaco does, and focuses its own input area) suppresses the compatibility mousedown; the default action of a press happens only when neither was canceled
		if (ok && c === 0) { let tc = false; for (let e = el; e; e = e.parentElement) { if (isTextControl(e)) { guard('text control mousedown', () => controlMouseDown(e, a, b, detail, !!(mods & 1))); tc = true; break; } } if (!tc) { guard('page text selection', () => docSel.start(el, a, b, detail, !!(mods & 1))); } guard('drag arm', () => dnd.arm(el, a, b)); }
		return base;
	};
	function mouse(type, a, b, c, d, mods) {
		const base = { clientX: a, clientY: b, screenX: a, screenY: b, ctrlKey: !!(mods & 2), shiftKey: !!(mods & 1), altKey: !!(mods & 4), metaKey: !!(mods & 8) };
		switch (type) {
			case 'mousemove': {
				if ((c & 1) && guard('drag move', () => dnd.move(a, b, mods))) { return; }
				if (dragging() && (c & 1)) { guard('text control drag', () => controlMouseMove(a, b)); } else if (docSel.active && (c & 1)) { guard('page text drag', () => docSel.move(a, b)); }
				const el = target(a, b); if (el !== hover) { const prev = hover; if (prev) { pdispatch(prev, Pe('pointerout', { ...base, relatedTarget: el })); dispatch(prev, Ev('mouseout', { ...base, relatedTarget: el })); } pdispatch(el, Pe('pointerover', { ...base, relatedTarget: prev })); dispatch(el, Ev('mouseover', { ...base, relatedTarget: prev })); hover = el; enterLeave(prev, el, base); setCursor(el); }
				pdispatch(el, Pe('pointermove', { ...base, buttons: c })); dispatch(el, Ev('mousemove', { ...base, buttons: c })); return;
			}
			case 'leave': if (hover) { const prev = hover; dispatch(prev, Ev('mouseout', { clientX: -1, clientY: -1 })); hover = null; enterLeave(prev, null, base); } return;
			case 'mousedown': { const el = at(a, b); downTarget = el; const detail = c === 0 ? clickCount(a, b, 1) : 1; if (debug()) { const dsc = (e) => e ? e.localName + '.' + String(e.className || '').slice(0, 60) : 'null'; ctx.log?.('[input] mousedown at ' + a + ',' + b + ' target=' + dsc(el) + ' parent=' + dsc(el.parentElement) + ' active-before=' + dsc(doc.activeElement)); } press(el, a, b, c, d, detail, mods); return; }
			case 'mouseup': {
				if (guard('drop', () => dnd.up(a, b, mods))) { if (downTarget) { setActive(downTarget, false); } downTarget = null; docSel.end(); releaseCapture(); return; }
				const el = target(a, b); controlMouseUp(); docSel.end(); if (downTarget) { setActive(downTarget, false); } pdispatch(el, Pe('pointerup', { ...base, button: c, buttons: d, detail: 1 })); dispatch(el, Ev('mouseup', { ...base, button: c, buttons: d, detail: 1 })); releaseCapture();
				if (downTarget && (downTarget === el || downTarget.contains?.(el) || el.contains?.(downTarget))) { if (dispatch(el, Ev(c === 2 ? 'contextmenu' : 'click', { ...base, button: c, detail: 1 })) && c === 0) { guard('click default', () => clickDefault(el)); } } downTarget = null; return;
			}
			case 'dblclick': {
				const el = at(a, b); downTarget = el; lastClick = { t: performance.now(), x: a, y: b, n: 2 }; press(el, a, b, c, d, 2, mods); controlMouseUp(); setActive(el, false); pdispatch(el, Pe('pointerup', { ...base, button: c, detail: 2 })); dispatch(el, Ev('mouseup', { ...base, button: c, detail: 2 }));
				if (dispatch(el, Ev('click', { ...base, button: c, detail: 2 }))) { guard('click default', () => clickDefault(el)); } dispatch(el, Ev('dblclick', { ...base, button: c, detail: 2 })); downTarget = null; return;
			}
			case 'wheel': { const el = at(a, b); const px = -c / 120 * 100; if (dispatch(el, new env.window.WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, ...base, deltaX: d ? -px : 0, deltaY: d ? 0 : px, deltaMode: 0 })) && !d) { for (let e = el; e; e = e.parentElement) { if (e.localName === 'textarea') { guard('textarea wheel', () => controlWheel(e, px)); break; } } } return; }
		}
	}
	function keyboard(type, a, b, c, d, mods) {
		const [key, code] = keyInfo(a, mods, c); const target = doc.activeElement || doc.body;
		const ev = new env.window.KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, key, code, keyCode: a, which: a, repeat: !!d, ctrlKey: !!(mods & 2), shiftKey: !!(mods & 1), altKey: !!(mods & 4), metaKey: !!(mods & 8) });
		const notPrevented = dispatch(target, ev); if (type === 'keydown') { charSuppressed = !notPrevented; }
		if (debug() && type === 'keydown') { ctx.log?.('[input] key ' + key + ' code=' + code + ' mods=' + mods + ' ctrl=' + ev.ctrlKey + ' prevented=' + !notPrevented + ' target=' + (target.localName || '?')); }   // a key whose keydown was handled (cancelled) produces no character, as in browsers
		if (!notPrevented) { return; }
		if (type === 'keydown') {
			if (guard('text control key', () => controlKeydown(target, ev))) { return; }
			if (ev.ctrlKey && !ev.altKey && (key.toLowerCase() === 'c' || key === 'Insert') && doc.__selection && !doc.__selection.isCollapsed) { guard('copy page text', () => copyCut(doc, false)); return; }
			if (key === 'Tab' && !ev.ctrlKey && !ev.altKey) { guard('tab', () => focusNext(doc, ev.shiftKey)); charSuppressed = true; return; }
			if (key === 'Enter' && isButtonish(target)) { dispatch(target, Ev('click', { detail: 0 })) && guard('click default', () => clickDefault(target)); charSuppressed = true; }
		} else if (key === ' ' && isButtonish(target) && !ev.ctrlKey) { dispatch(target, Ev('click', { detail: 0 })) && guard('click default', () => clickDefault(target)); }
	}
	function char(a, mods) {                       // text input: control keys are handled through keydown (Enter, Backspace, Tab)
		const target = doc.activeElement; const sup = charSuppressed; charSuppressed = false; if (sup || !isTextControl(target)) { return; }
		const enter = a === 13; if (enter ? target.localName !== 'textarea' : (a < 32 || a === 127)) { return; }
		if ((mods & 2) && !(mods & 4)) { return; }   // Ctrl+letter is a shortcut, AltGr (Ctrl+Alt) produces text
		guard('text input', () => controlTextInput(target, enter ? '\n' : String.fromCodePoint(a)));
	}
	/** one input message: (type, a, b, c, d, mods) as the window delivers them; returns false for message types it does not handle */
	function handle(type, a, b, c, d, mods) {
		if (type === 'mousemove' || type === 'mousedown' || type === 'mouseup' || type === 'dblclick' || type === 'wheel' || type === 'leave') { mouse(type, a, b, c, d, mods); }
		else if (type === 'keydown' || type === 'keyup') { keyboard(type, a, b, c, d, mods); }
		else if (type === 'char') { char(a, mods); }
		else { return false; }
		hooks.activity?.(type); return true;
	}
	return { handle, get hover() { return hover; } };
}
