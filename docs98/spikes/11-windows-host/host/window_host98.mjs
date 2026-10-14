// Connects a spike 6/7/9 DOM environment to a native window (spike:win): paints the document with the native rasterizer when it changed and turns window messages into DOM
// events (mouse with hit testing, wheel, keyboard, text input). Used by the desktop harness with --window.
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import * as win from 'spike:win';
import { paintDocument } from '../../06-rendering/host/dom/paint.js';
import { NativeBackend } from '../../07-native-render/host/native_backend.js';

import { createInputDriver, editable } from '../../06-rendering/host/dom/input_driver.js';

/** opens the window and keeps it in sync with the document; returns { id, repaint(), close() } */
export function openWindow(ctx, { width, height, title = 'vscode98', exact = false, fps = 30, onClose } = {}) {
	const { doc, env, log } = ctx; const id = win.create(width, height, title); let W = width, H = height;
	let paintedPasses = -1, paintedGen = -1, backend = null, lastPaint = 0, forced = true, paints = 0, paintMs = 0;
	const repaint = () => { forced = true; };
	// the clipboard of the text controls is the system clipboard (the window's text is CRLF on Windows, the DOM's LF)
	globalThis.__clipboard98 = { readText: () => { const t = win.clipboardGet(); return t === null || t === undefined ? '' : String(t).replace(/\r\n/g, '\n'); }, writeText: (t) => win.clipboardSet(String(t).replace(/\r?\n/g, '\r\n')) };
	const driver = createInputDriver(ctx, { setCursor: (c) => win.setCursor(id, c), activity: repaint });
	function paintNow() {
		const t0 = performance.now(); doc.__ensureLayout(); paintedPasses = (doc.__passStats || []).length; paintedGen = doc.__paintGen | 0;
		if (!backend || backend.w !== W || backend.h !== H) { backend = new NativeBackend(W, H, { exact }); } else { backend.reset(); }
		const r = paintDocument(doc, W, H, backend);
		win.present(id, r.px, W, H, 0, 0, W, H); paints++; paintMs += performance.now() - t0; lastPaint = performance.now();
	}
	// any layout pass since the last paint counts: code that reads geometry runs layout itself and clears doc.__dirty, so `__dirty` alone misses most changes
	const tick = () => {
		if (win.size(id)[0] === 0) { return; }
		try { env.flushFrames?.(); const passes = (doc.__passStats || []).length; const dirty = doc.__dirty || forced || passes !== paintedPasses || (doc.__paintGen | 0) !== paintedGen; if (dirty && performance.now() - lastPaint >= 1000 / fps) { forced = false; paintNow(); } } catch (e) { ctx.note?.('paint', e); }
		os.setTimeout(tick, 1000 / fps / 2);
	};
	win.setHandler((wid, type, a, b, c, d, mods) => {
		if (type !== 'mousemove' && type !== 'paint' && ctx.opt?.('debug-input', '0') === '1') { ctx.log?.('[input] event ' + type + ' ' + a + ' ' + b + ' ' + c + ' ' + d); }
		if (driver.handle(type, a, b, c, d, mods)) { return; }
		switch (type) {
			case 'resize': W = a; H = b; log?.(`[window] resize ${a}x${b}`); env.resize?.(a, b); repaint(); break;
			case 'focus': { if (a) { env.window.dispatchEvent(new env.window.Event('focus')); } else { env.window.dispatchEvent(new env.window.Event('blur')); } break; }
			case 'close': win.destroy(wid); log?.('[window] closed'); try { onClose?.(); } finally { std.exit(0); } break;
			case 'paint': break;   // the echo of our own present(): repainting on it is an endless loop (found on Windows 7: 12 frames/s of an idle workbench)
		}
	});
	tick();
	return { id, repaint, stats: () => ({ paints, paintMs }), close: () => win.destroy(id) };
}
