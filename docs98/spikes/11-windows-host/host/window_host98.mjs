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
	// what the owner feels, in the log (the laptop logs of v26 had no per-action times): for each click or key, the time in the handler, to the first paint and to the last paint of the burst that followed, and the collections that ran meanwhile; plus a fixed CPU loop every 15 s of idle time, to tell a slowing machine (thermal throttling, other load) from a slowing program
	let pend = null, probeAt = performance.now(), probeFirst = 0, nAct = 0;
	const gcNow = () => { const g = globalThis.__gcStats?.(); return g ? { forced: g[1], heap: Math.round(g[2] / 1048576) } : { forced: 0, heap: 0 }; };
	const finishAct = (why) => { const a = pend; pend = null; if (!a) { return; } lats.push(a.last === null ? 0 : a.last); if (a.last !== null) { spans.push({ label: a.type + ' ' + a.what, a: a.epoch0, b: a.epoch0 + a.last }); } const g = gcNow(); const now = performance.now();
		log?.(`[latency] ${a.type} ${a.what}: handler ${a.handlerMs.toFixed(0)} ms, first paint ${a.first === null ? 'none' : a.first.toFixed(0) + ' ms'}, last paint ${a.last === null ? 'none' : a.last.toFixed(0) + ' ms'}${why ? ' (' + why + ')' : ''}, ${(doc.__passStats || []).length - a.passes0} layout passes, ${paints - a.paints0} paints, forced collections +${g.forced - a.forced0}, idle +${gcRuns - a.idle0}, heap ${g.heap} MB`); };
	const lats = [], spans = [];   // spans: the epoch time of each input and of its last paint, for the profile of the use (10-main-shim/host/use_profile98.js)
	const describe = (el) => { if (!el) { return ''; } let t = ''; try { t = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 28); } catch (e) { } return ` ${el.localName}.${String(el.className || '').split(' ')[0].slice(0, 30)}${t ? ' "' + t + '"' : ''}`; };
	const probe = () => { let x = 0, ms = Infinity; for (let r = 0; r < 3; r++) { const t = performance.now(); for (let i = 0; i < 1500000; i++) { x = (x + i * 7) | 0; } ms = Math.min(ms, (performance.now() - t) * 2); }   // the fastest of three: a preemption in one of them does not count
		if (!probeFirst) { probeFirst = ms; } const g = gcNow();
		log?.(`[probe] fixed loop ${ms.toFixed(0)} ms (first ${probeFirst.toFixed(0)} ms), ${(ms / probeFirst).toFixed(2)}x, collections idle ${gcRuns} (${Math.round(gcMs)} ms) forced ${g.forced}, heap ${g.heap} MB${x === 12345 ? ' ' : ''}`); };
	const tick = () => {
		if (win.size(id)[0] === 0) { return; }
		try { env.flushFrames?.(); const passes = (doc.__passStats || []).length; const dirty = doc.__dirty || forced || passes !== paintedPasses || (doc.__paintGen | 0) !== paintedGen; if (dirty && performance.now() - lastPaint >= 1000 / fps) { forced = false; paintNow(); lastActive = performance.now(); if (pend) { const el = lastPaint - pend.t0; if (pend.first === null) { pend.first = el; } pend.last = el; pend.lastAt = lastPaint; } }
			else if (!dirty && pend && performance.now() - Math.max(pend.lastAt || pend.t0, pend.quietFrom || 0) >= (pend.first === null ? 600 : 250)) { finishAct(''); }
			else if (!dirty && !pend && performance.now() - probeAt >= 15000 && performance.now() - lastActive >= 400) { probeAt = performance.now(); probe(); }
			else if (!dirty && ctx.gcIdle && performance.now() - lastActive >= 800 && globalThis.__gcWanted?.()) { const t = performance.now(); globalThis.__gcNow(); gcRuns++; gcMs += performance.now() - t; lastActive = performance.now(); } } catch (e) { ctx.note?.('paint', e); }
		os.setTimeout(tick, 1000 / fps / 2);
	};
	win.setHandler((wid, type, a, b, c, d, mods) => {
		if (type !== 'paint') { lastActive = performance.now(); }
		if (type !== 'mousemove' && type !== 'paint' && ctx.opt?.('debug-input', '0') === '1') { ctx.log?.('[input] event ' + type + ' ' + a + ' ' + b + ' ' + c + ' ' + d); }
		if (zoom.factor !== 1 && (type === 'mousemove' || type === 'mousedown' || type === 'mouseup' || type === 'dblclick' || type === 'wheel')) { a = Math.round(a / zoom.factor); b = Math.round(b / zoom.factor); }   // window pixels -> CSS pixels
		const act = type === 'mousedown' || type === 'dblclick' || type === 'keydown' || type === 'wheel';
		if (act) { if (pend) { finishAct('next input came first'); } const g = gcNow(); pend = { epoch0: Date.now(), type, what: type === 'keydown' ? 'key ' + a : a + ',' + b, t0: performance.now(), handlerMs: 0, first: null, last: null, lastAt: 0, passes0: (doc.__passStats || []).length, paints0: paints, forced0: g.forced, idle0: gcRuns }; nAct++; }
		if (type === 'mouseup' && pend) { pend.quietFrom = performance.now(); }   // the click itself (a file opening, a menu item running) happens on the mouseup: the burst is not over before it
		ctx.lastDown98 = null; const th = performance.now(); const handled = driver.handle(type, a, b, c, d, mods); if (act && pend && pend.handlerMs === 0) { pend.handlerMs = performance.now() - th; if (ctx.lastDown98) { pend.what += describe(ctx.lastDown98); } }
		if (handled) { return; }
		switch (type) {
			case 'resize': W = a; H = b; log?.(`[window] resize ${a}x${b}`); env.resize?.(Math.round(a / zoom.factor), Math.round(b / zoom.factor)); repaint(); break;
			case 'focus': { if (a) { env.window.dispatchEvent(new env.window.Event('focus')); } else { env.window.dispatchEvent(new env.window.Event('blur')); } break; }
			case 'close': finishAct('window closed'); probe(); { const g = gcNow(); { const v = lats.filter(x => x > 0).sort((p, q) => p - q); const q = (f) => v.length ? v[Math.min(v.length - 1, Math.floor(v.length * f))].toFixed(0) : '-'; log?.(`[window] response time of ${v.length} inputs that changed the screen (input to last paint): median ${q(0.5)} ms, 90th percentile ${q(0.9)} ms, slowest ${q(1)} ms, over 1 s: ${v.filter(x => x > 1000).length}, over 3 s: ${v.filter(x => x > 3000).length}`); }
			log?.(`[window] closing: ${nAct} inputs, ${paints} paints, collections at idle moments ${gcRuns} (${Math.round(gcMs)} ms), forced ${g.forced}, heap ${g.heap} MB`); } win.destroy(wid); log?.('[window] closed'); ctx.useProfile?.(spans); try { onClose?.(); } finally { std.exit(0); } break;
			case 'paint': break;   // the echo of our own present(): repainting on it is an endless loop (found on Windows 7: 12 frames/s of an idle workbench)
		}
	});
	os.setTimeout(() => { try { probe(); } catch (e) { ctx.note?.('probe', e); } }, 200);
	tick();
	return { id, repaint, stats: () => ({ paints, paintMs, gcRuns, gcMs }), close: () => win.destroy(id) };
}
