// Connects a spike 6/7/9 DOM environment to a native window (spike:win): paints the document with the native rasterizer when it changed and turns window messages into DOM
// events (mouse with hit testing, wheel, keyboard, text input). Used by the desktop harness with --window.
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import * as win from 'spike:win';
import { paintDocument } from '../../06-rendering/host/dom/paint.js';
import { NativeBackend } from '../../07-native-render/host/native_backend.js';

// Windows virtual-key code -> [DOM key, DOM code]; letters, digits and OEM punctuation are handled below
const VK = { 8: ['Backspace', 'Backspace'], 9: ['Tab', 'Tab'], 13: ['Enter', 'Enter'], 16: ['Shift', 'ShiftLeft'], 17: ['Control', 'ControlLeft'], 18: ['Alt', 'AltLeft'], 19: ['Pause', 'Pause'], 20: ['CapsLock', 'CapsLock'], 27: ['Escape', 'Escape'], 32: [' ', 'Space'],
	33: ['PageUp', 'PageUp'], 34: ['PageDown', 'PageDown'], 35: ['End', 'End'], 36: ['Home', 'Home'], 37: ['ArrowLeft', 'ArrowLeft'], 38: ['ArrowUp', 'ArrowUp'], 39: ['ArrowRight', 'ArrowRight'], 40: ['ArrowDown', 'ArrowDown'], 45: ['Insert', 'Insert'], 46: ['Delete', 'Delete'],
	91: ['Meta', 'MetaLeft'], 92: ['Meta', 'MetaRight'], 93: ['ContextMenu', 'ContextMenu'], 144: ['NumLock', 'NumLock'], 145: ['ScrollLock', 'ScrollLock'] };
for (let i = 1; i <= 24; i++) { VK[111 + i] = ['F' + i, 'F' + i]; }
const OEM = { 186: [';', ':', 'Semicolon'], 187: ['=', '+', 'Equal'], 188: [',', '<', 'Comma'], 189: ['-', '_', 'Minus'], 190: ['.', '>', 'Period'], 191: ['/', '?', 'Slash'], 192: ['`', '~', 'Backquote'], 219: ['[', '{', 'BracketLeft'], 220: ['\\', '|', 'Backslash'], 221: [']', '}', 'BracketRight'], 222: ["'", '"', 'Quote'] };
const SHIFTED_DIGITS = ')!@#$%^&*(';
function keyInfo(vk, mods, extended) {
	const shift = !!(mods & 1), caps = !!(mods & 16);
	if (vk >= 65 && vk <= 90) { const c = String.fromCharCode(vk); return [shift !== caps ? c : c.toLowerCase(), 'Key' + c]; }
	if (vk >= 48 && vk <= 57) { return [shift ? SHIFTED_DIGITS[vk - 48] : String.fromCharCode(vk), 'Digit' + String.fromCharCode(vk)]; }
	if (vk >= 96 && vk <= 105) { return [String(vk - 96), 'Numpad' + (vk - 96)]; }
	if (OEM[vk]) { return [shift ? OEM[vk][1] : OEM[vk][0], OEM[vk][2]]; }
	if (vk === 16 || vk === 17 || vk === 18) { return [VK[vk][0], VK[vk][1].replace('Left', extended ? 'Right' : 'Left')]; }
	return VK[vk] || ['Unidentified', 'Unidentified'];
}
const editable = (el) => el && (el.localName === 'textarea' || (el.localName === 'input' && !/^(button|checkbox|radio|submit)$/.test(el.type || 'text')) || el.isContentEditable);

/** opens the window and keeps it in sync with the document; returns { id, repaint(), close() } */
export function openWindow(ctx, { width, height, title = 'vscode98', exact = false, fps = 30, onClose } = {}) {
	const { doc, env, log } = ctx; const id = win.create(width, height, title); let W = width, H = height;
	const Ev = (name, o) => new env.window.MouseEvent(name, { bubbles: true, cancelable: true, composed: true, view: env.window, ...o });
	// Monaco's mouse handling (editor text, selection) listens to Pointer Events, not mouse events: every mouse action is sent as the pointer event first, then as the legacy mouse event, as browsers do
	const Pe = (name, o) => new env.window.PointerEvent(name, { bubbles: true, cancelable: true, composed: true, view: env.window, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...o });
	let charSuppressed = false, paintedPasses = -1, backend = null, hover = null, downTarget = null, lastPaint = 0, forced = true, paints = 0, paintMs = 0;
	const at = (x, y) => doc.elementFromPoint(x, y) || doc.body;
	const dispatch = (el, ev) => { try { return el.dispatchEvent(ev); } catch (e) { ctx.note?.('window event ' + ev.type, e); return true; } };
	const pdispatch = (el, ev) => (ctx.opt?.('no-pointer', '0') === '1' ? true : dispatch(el, ev));   // --no-pointer 1: legacy mouse events only (A/B switch)
	const setCursor = (el) => { try { const c = env.window.getComputedStyle(el).cursor; win.setCursor(id, c && c !== 'auto' ? c : (editable(el) ? 'text' : 'default')); } catch { /* keep */ } };
	const focusFor = (el) => { for (let e = el; e; e = e.parentElement) { if (editable(e) || e.hasAttribute?.('tabindex')) { e.focus?.(); return; } } doc.activeElement?.blur?.(); };
	const repaint = () => { forced = true; };
	function paintNow() {
		const t0 = performance.now(); doc.__ensureLayout(); paintedPasses = (doc.__passStats || []).length;
		if (!backend || backend.w !== W || backend.h !== H) { backend = new NativeBackend(W, H, { exact }); } else { backend.reset(); }
		const r = paintDocument(doc, W, H, backend);
		win.present(id, r.px, W, H, 0, 0, W, H); paints++; paintMs += performance.now() - t0; lastPaint = performance.now();
	}
	// any layout pass since the last paint counts: code that reads geometry runs layout itself and clears doc.__dirty, so `__dirty` alone misses most changes
	const tick = () => {
		if (win.size(id)[0] === 0) { return; }
		try { env.flushFrames?.(); const passes = (doc.__passStats || []).length; const dirty = doc.__dirty || forced || passes !== paintedPasses; if (dirty && performance.now() - lastPaint >= 1000 / fps) { forced = false; paintNow(); } } catch (e) { ctx.note?.('paint', e); }
		os.setTimeout(tick, 1000 / fps / 2);
	};
	win.setHandler((wid, type, a, b, c, d, mods) => {
		const base = { clientX: a, clientY: b, screenX: a, screenY: b, ctrlKey: !!(mods & 2), shiftKey: !!(mods & 1), altKey: !!(mods & 4), metaKey: !!(mods & 8) };
		if (type !== 'mousemove' && type !== 'paint' && ctx.opt?.('debug-input', '0') === '1') { ctx.log?.('[input] event ' + type + ' ' + a + ' ' + b + ' ' + c + ' ' + d); }
		switch (type) {
			case 'mousemove': { const el = at(a, b); if (el !== hover) { if (hover) { pdispatch(hover, Pe('pointerout', { ...base, relatedTarget: el })); dispatch(hover, Ev('mouseout', { ...base, relatedTarget: el })); } pdispatch(el, Pe('pointerover', { ...base, relatedTarget: hover })); dispatch(el, Ev('mouseover', { ...base, relatedTarget: hover })); hover = el; setCursor(el); } pdispatch(el, Pe('pointermove', { ...base, buttons: c })); dispatch(el, Ev('mousemove', { ...base, buttons: c })); break; }
			case 'leave': if (hover) { dispatch(hover, Ev('mouseout', { clientX: -1, clientY: -1 })); hover = null; } break;
			case 'mousedown': { const el = at(a, b); downTarget = el; if (ctx.opt?.('debug-input', '0') === '1') { const d = (e) => e ? e.localName + '.' + String(e.className || '').slice(0, 60) : 'null'; ctx.log?.('[input] mousedown at ' + a + ',' + b + ' target=' + d(el) + ' parent=' + d(el.parentElement) + ' active-before=' + d(doc.activeElement)); os.setTimeout(() => ctx.log?.('[input]   active-after=' + d(doc.activeElement)), 200); } const pointerOk = pdispatch(el, Pe('pointerdown', { ...base, button: c, buttons: d, detail: 1 })); if (pointerOk) { if (dispatch(el, Ev('mousedown', { ...base, button: c, buttons: d, detail: 1 }))) { focusFor(el); } } break; }   // a pointerdown the page cancels (Monaco does, and focuses its own input area) suppresses the compatibility mousedown; the default action of a press (focus the clicked control, or blur) happens only when neither was canceled
			case 'mouseup': { const el = at(a, b); pdispatch(el, Pe('pointerup', { ...base, button: c, buttons: d, detail: 1 })); dispatch(el, Ev('mouseup', { ...base, button: c, buttons: d, detail: 1 })); if (downTarget && (downTarget === el || downTarget.contains?.(el) || el.contains?.(downTarget))) { dispatch(el, Ev(c === 2 ? 'contextmenu' : 'click', { ...base, button: c, detail: 1 })); } downTarget = null; break; }
			case 'dblclick': { const el = at(a, b); if (pdispatch(el, Pe('pointerdown', { ...base, button: c, buttons: d, detail: 2 })) && dispatch(el, Ev('mousedown', { ...base, button: c, buttons: d, detail: 2 }))) { focusFor(el); } pdispatch(el, Pe('pointerup', { ...base, button: c, detail: 2 })); dispatch(el, Ev('mouseup', { ...base, button: c, detail: 2 })); dispatch(el, Ev('click', { ...base, button: c, detail: 2 })); dispatch(el, Ev('dblclick', { ...base, button: c, detail: 2 })); break; }
			case 'wheel': { const el = at(a, b); const px = -c / 120 * 100; dispatch(el, new env.window.WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, ...base, deltaX: d ? -px : 0, deltaY: d ? 0 : px, deltaMode: 0 })); break; }
			case 'keydown': case 'keyup': {
				const [key, code] = keyInfo(a, mods, c); const target = doc.activeElement || doc.body;
				const ev = new env.window.KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, key, code, keyCode: a, which: a, repeat: !!d, ctrlKey: !!(mods & 2), shiftKey: !!(mods & 1), altKey: !!(mods & 4), metaKey: !!(mods & 8) });
				const notPrevented = dispatch(target, ev); if (type === 'keydown') { charSuppressed = !notPrevented; } break;   // a key whose keydown was handled (cancelled) produces no character, as in browsers
			}
			case 'char': {                       // text input: control keys are handled through keydown (Enter, Backspace, Tab)
				const target = doc.activeElement; const sup = charSuppressed; charSuppressed = false; if (sup || !editable(target)) { break; }
				// Enter is the one control character that is text: a <textarea> (Monaco's input area) gets a line break, a single-line <input> only the key events
				const enter = a === 13; if (enter ? target.localName !== 'textarea' : (a < 32 || a === 127)) { break; } const ch = enter ? '\n' : String.fromCodePoint(a);
				const ctrlAlt = (mods & 2) && !(mods & 4); if (ctrlAlt) { break; }
				target.value = (target.value || '') + ch;       // like the spike 10 scenarios: Monaco's input area diffs the textarea value on 'input'
				dispatch(target, new env.window.InputEvent('input', { bubbles: true, data: enter ? null : ch, inputType: enter ? 'insertLineBreak' : 'insertText' })); break;
			}
			case 'resize': W = a; H = b; log?.(`[window] resize ${a}x${b}`); env.resize?.(a, b); repaint(); break;
			case 'focus': { if (a) { env.window.dispatchEvent(new env.window.Event('focus')); } else { env.window.dispatchEvent(new env.window.Event('blur')); } break; }
			case 'close': win.destroy(wid); log?.('[window] closed'); try { onClose?.(); } finally { std.exit(0); } break;
			case 'paint': break;
		}
		if (type !== 'paint' && type !== 'focus' && type !== 'leave') { repaint(); }   // 'paint' is the echo of our own present(): repainting on it is an endless loop (found on Windows 7: 12 frames/s of an idle workbench)
	});
	tick();
	return { id, repaint, stats: () => ({ paints, paintMs }), close: () => win.destroy(id) };
}
