// Connects a spike 6/7/9 DOM environment to a native window (spike:win): paints the document with the native rasterizer when it changed and turns window messages into DOM
// events (mouse with hit testing, wheel, keyboard, text input). Used by the desktop harness with --window.
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import * as win from 'spike:win';
import { paintDocument } from '../../06-rendering/host/dom/paint.js';
import { NativeBackend } from '../../07-native-render/host/native_backend.js';

import { zoom, ScaledBackend } from '../../06-rendering/host/dom/zoom.js';
import { createInputDriver, editable } from '../../06-rendering/host/dom/input_driver.js';

/** opens the window and keeps it in sync with the document; returns { id, repaint(), close() } */
export function openWindow(ctx, { width, height, title = 'vscode98', exact = false, fps = 30, onClose, background = null } = {}) {
	const { doc, env, log } = ctx; const id = win.create(width, height, title); ctx.timelineMark?.('harness: window created');
	if (background) { const px = new Uint8Array(width * height * 4); for (let i = 0; i < px.length; i += 4) { px[i] = background[0]; px[i + 1] = background[1]; px[i + 2] = background[2]; px[i + 3] = 255; } win.present(id, px, width, height, 0, 0, width, height); }   // the window shows its background colour at once, not white, while the first style pass runs
	let W = width, H = height;
	let paintedPasses = -1, paintedGen = -1, backend = null, lastPaint = 0, forced = true, paints = 0, paintMs = 0;
	const repaint = () => { forced = true; };
	// the clipboard of the text controls is the system clipboard (the window's text is CRLF on Windows, the DOM's LF)
	globalThis.__clipboard98 = { readText: () => { const t = win.clipboardGet(); return t === null || t === undefined ? '' : String(t).replace(/\r\n/g, '\n'); }, writeText: (t) => win.clipboardSet(String(t).replace(/\r?\n/g, '\r\n')) };
	zoom.onChange = (f) => { log?.('[window] zoom ' + f); env.resize?.(Math.round(W / f), Math.round(H / f)); repaint(); };
	const driver = createInputDriver(ctx, { setCursor: (c) => win.setCursor(id, c), activity: repaint });
	function paintNow() {
		const t0 = performance.now(); doc.__ensureLayout(); paintedPasses = (doc.__passStats || []).length; paintedGen = doc.__paintGen | 0;
		if (!backend || backend.w !== W || backend.h !== H) { backend = new NativeBackend(W, H, { exact }); } else { backend.reset(); }
		const z = zoom.factor; const r = paintDocument(doc, z === 1 ? W : Math.round(W / z), z === 1 ? H : Math.round(H / z), z === 1 ? backend : new ScaledBackend(backend, z));
		win.present(id, r.px, W, H, 0, 0, W, H); paints++; paintMs += performance.now() - t0; lastPaint = performance.now();
		if (paints <= 40 && ctx.timelineMark) { ctx.timelineMark(`harness: paint ${paints} (${doc.getElementsByTagName('*').length} elements, ${Math.round(performance.now() - t0)} ms)`); }   // the launch timeline: when the window first showed something, and what
	}
	// any layout pass since the last paint counts: code that reads geometry runs layout itself and clears doc.__dirty, so `__dirty` alone misses most changes
	// the collector runs at idle moments (07-native-render/host/gc98.h): nothing painted and no input for 800 ms (a collection blocks for ~0.8 s on the sandbox, probably 2 s on the laptop: the user must have paused), and the heap has passed the soft threshold
	let lastActive = performance.now(), gcRuns = 0, gcMs = 0;
	const tick = () => {
		if (win.size(id)[0] === 0) { return; }
		try { env.flushFrames?.(); const passes = (doc.__passStats || []).length; const dirty = doc.__dirty || forced || passes !== paintedPasses || (doc.__paintGen | 0) !== paintedGen; if (dirty && performance.now() - lastPaint >= 1000 / fps) { forced = false; paintNow(); lastActive = performance.now(); }
			else if (!dirty && ctx.gcIdle && performance.now() - lastActive >= 800 && globalThis.__gcWanted?.()) { const t = performance.now(); globalThis.__gcNow(); gcRuns++; gcMs += performance.now() - t; lastActive = performance.now(); } } catch (e) { ctx.note?.('paint', e); }
		os.setTimeout(tick, 1000 / fps / 2);
	};
	win.setHandler((wid, type, a, b, c, d, mods) => {
		if (type !== 'paint') { lastActive = performance.now(); }
		if (type !== 'mousemove' && type !== 'paint' && ctx.opt?.('debug-input', '0') === '1') { ctx.log?.('[input] event ' + type + ' ' + a + ' ' + b + ' ' + c + ' ' + d); }
		if (zoom.factor !== 1 && (type === 'mousemove' || type === 'mousedown' || type === 'mouseup' || type === 'dblclick' || type === 'wheel')) { a = Math.round(a / zoom.factor); b = Math.round(b / zoom.factor); }   // window pixels -> CSS pixels
		if (driver.handle(type, a, b, c, d, mods)) { return; }
		switch (type) {
			case 'resize': W = a; H = b; log?.(`[window] resize ${a}x${b}`); env.resize?.(Math.round(a / zoom.factor), Math.round(b / zoom.factor)); repaint(); break;
			case 'focus': { if (a) { env.window.dispatchEvent(new env.window.Event('focus')); } else { env.window.dispatchEvent(new env.window.Event('blur')); } break; }
			case 'close': win.destroy(wid); log?.('[window] closed'); try { onClose?.(); } finally { std.exit(0); } break;
			case 'paint': break;   // the echo of our own present(): repainting on it is an endless loop (found on Windows 7: 12 frames/s of an idle workbench)
		}
	});
	tick();
	return { id, repaint, stats: () => ({ paints, paintMs, gcRuns, gcMs }), close: () => win.destroy(id) };
}
