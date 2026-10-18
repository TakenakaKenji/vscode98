// Control comparison, QuickJS host side: the same actions as docs98/spikes/12-control/host/electron_lat.mjs (Electron), each timed from the input event to the
// DOM state that shows the result, the way the window host drives the document (timers, frames, layout, paint per tick). Prints per-round values and medians.
// Usage: boot_desktop_qjs.mjs ... --workspace <dir> --scenario scenario_ctl.mjs [--rounds 3] [--split 1: style/layout/paint split of each action] [--marks 1: the epoch time of each action, to select its samples from a profile]
import { runScenario } from '../../08-workbench-boot/host/boot_common.js';
import { paintDocument } from '../../06-rendering/host/dom/paint.js';
import { NativeBackend } from '../../07-native-render/host/native_backend.js';
import * as os from 'qjs:os';
import * as std from 'qjs:std';
const sleep = (ms) => new Promise((r) => os.setTimeout(r, ms));
export async function run(ctx) { try { await run0(ctx); } catch (e) { ctx.log('ctl: failed ' + (e && e.stack || e)); } }
async function run0(ctx) {
	const { doc, log, env } = ctx; const W = ctx.W, H = ctx.H; const ws = ctx.opt('workspace', '/tmp/claude-0/ws98'); const rounds = Number(ctx.opt('rounds', 3)); const split = ctx.opt('split', '0') === '1'; const marks = ctx.opt('marks', '0') === '1';
	const settle = (s = 20) => runScenario(ctx, { seconds: s, stableRounds: 40 });
	const backend = new NativeBackend(W, H, {}); let painted = -1;
	const MouseEvent = env.window.MouseEvent, PointerEvent = env.window.PointerEvent, KeyboardEvent = env.window.KeyboardEvent, InputEvent = env.window.InputEvent;
	const acc = { frames: 0, layout: 0, paint: 0 };
	const tick = () => { let t = performance.now(); env.flushFrames?.(); acc.frames += performance.now() - t; if (doc.__dirty || doc.__passStats.length !== painted) { t = performance.now(); doc.__ensureLayout(); acc.layout += performance.now() - t; painted = doc.__passStats.length; t = performance.now(); backend.reset(); paintDocument(doc, W, H, backend); acc.paint += performance.now() - t; } };
	const splits = {};
	// between two actions a user pauses: with the idle collector (07-native-render/host/gc98.h) that is where a pending collection runs; its count and time are reported
	let idleGcRuns = 0, idleGcMs = 0; const idleGc = (before) => { if (ctx.gcIdle && globalThis.__gcWanted?.()) { const h0 = globalThis.__gcStats()[2]; const t = performance.now(); globalThis.__gcNow(); idleGcRuns++; idleGcMs += performance.now() - t; log(`ctl: idle collection before ${before}: ${Math.round(performance.now() - t)} ms, heap ${Math.round(h0 / 1048576)} -> ${Math.round(globalThis.__gcStats()[2] / 1048576)} MB`); } };
	if (ctx.opt('no-dispose', '0') === '1') { globalThis.__noDispose98 = true; }
	// --geo 1: after each action a hash of the geometry of every box (the oracle of changes that must not change what is laid out: the same hashes with and without them)
	const geo = ctx.opt('geo', '0') === '1';
	const geoHash = () => { doc.__ensureLayout(); let h = 2166136261 >>> 0; const mix = (v) => { h = Math.imul(h ^ (Math.round(v * 64) | 0), 16777619) >>> 0; }; let n = 0; for (const el of doc.getElementsByTagName('*')) { const b = doc.__layout.boxOf.get(el); if (!b) { continue; } n++; mix(b.ax); mix(b.ay); mix(b.w); mix(b.h); } return h.toString(16) + '/' + n; };
	const why = ctx.opt('why', '0') === '1'; const whyAll = {}; if (why) { globalThis.__whyPasses98 = new Map(); }
	async function timed(name, act, pred, maxMs = 60000) {
		if (why) { globalThis.__whyPasses98.clear(); }
		idleGc(name); const f0 = globalThis.__gcStats?.()[1] ?? 0; const a0 = { ...acc }; const p0 = doc.__passStats.length; const e0 = Date.now(); const t0 = performance.now(); act(); const tEvent = performance.now() - t0;
		for (;;) { await sleep(1); tick(); let ok = false; try { ok = pred(); } catch { } if (ok) { break; } if (performance.now() - t0 > maxMs) { log('ctl: timeout ' + name); return -1; } }
		const ms = Math.round(performance.now() - t0);
		const forced = (globalThis.__gcStats?.()[1] ?? 0) - f0; if (forced) { log(`ctl: ${name} ${ms} ms contained ${forced} collection(s) forced from inside an allocation`); }
		if (why) { const m = (whyAll[name] ??= new Map()); for (const [k, v] of globalThis.__whyPasses98) { m.set(k, (m.get(k) || 0) + v); } }
		if (geo) { log(`ctl: geo ${name} ${geoHash()}`); }
		if (marks) { log(`ctl: mark ${name} ${e0} ${Date.now()}`); }   // epoch ms of the action, for selecting its samples from a profile (14-launch/tests/profile_actions.mjs)
		if (split) { const ps = doc.__passStats.slice(p0); const style = ps.reduce((a, x) => a + x.styleMs, 0), lay = ps.reduce((a, x) => a + x.layoutMs, 0); (splits[name] ??= []).push({ ms, event: Math.round(tEvent), frames: Math.round(acc.frames - a0.frames), style: Math.round(style), layout: Math.round(lay), paint: Math.round(acc.paint - a0.paint), passes: ps.length }); }
		return ms;
	}
	const base = (x, y, o = {}) => ({ clientX: x, clientY: y, screenX: x, screenY: y, bubbles: true, cancelable: true, composed: true, view: env.window, button: 0, buttons: 1, detail: 1, ...o });
	const at = (x, y) => doc.elementFromPoint(x, y) || doc.body;
	const click = (x, y, o = {}) => { const t = at(x, y); const p = { ...base(x, y, o), pointerId: 1, pointerType: 'mouse', isPrimary: true };
		t.dispatchEvent(new PointerEvent('pointerdown', p)); t.dispatchEvent(new MouseEvent('mousedown', base(x, y, o))); t.dispatchEvent(new PointerEvent('pointerup', { ...p, buttons: 0 })); t.dispatchEvent(new MouseEvent('mouseup', base(x, y, { ...o, buttons: 0 })));
		if (o.button === 2) { t.dispatchEvent(new MouseEvent('contextmenu', base(x, y, { ...o, buttons: 0 }))); } else { t.dispatchEvent(new MouseEvent('click', base(x, y, { ...o, buttons: 0 }))); if (o.detail === 2) { t.dispatchEvent(new MouseEvent('dblclick', base(x, y, { ...o, buttons: 0 }))); } } };
	const move = (x, y) => { const t = at(x, y); t.dispatchEvent(new PointerEvent('pointermove', { ...base(x, y, { buttons: 0 }), pointerId: 1, pointerType: 'mouse', isPrimary: true })); t.dispatchEvent(new MouseEvent('mouseover', base(x, y, { buttons: 0 }))); t.dispatchEvent(new MouseEvent('mousemove', base(x, y, { buttons: 0 }))); };
	const keyOn = (target, k, code, kc, mods = {}) => { for (const type of ['keydown', 'keyup']) { const ev = new KeyboardEvent(type, { key: k, code, keyCode: kc, bubbles: true, cancelable: true, composed: true, ...mods }); ev.which = kc; target.dispatchEvent(ev); } };
	const active = () => doc.activeElement || doc.body;
	const rectOf = (sel, text) => { const el = [...doc.querySelectorAll(sel)].find((e) => (!text || (e.getAttribute('aria-label') || e.textContent || '').startsWith(text)) && e.getBoundingClientRect().height > 0); if (!el) { return null; } const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, el }; };
	const center = (r) => [r.x + r.w / 2, r.y + r.h / 2];
	const menuOpen = () => [...doc.querySelectorAll('.monaco-menu')].some((m) => m.getBoundingClientRect().height > 0);
	// Escape until no menu is open (a File menu left open under the explorer would take the next click on a row: its Exit item quits the app)
	const esc = async () => { for (let k = 0; k < 4; k++) { keyOn(active(), 'Escape', 'Escape', 27); for (let i = 0; i < 500 && menuOpen(); i++) { await sleep(1); tick(); } if (!menuOpen()) { break; } } if (menuOpen()) { log('ctl: a menu is still open after Escape'); } await settle(4); };
	const lineHas = (re) => [...doc.querySelectorAll('.editor-instance .view-line')].some((l) => re.test(l.textContent));
	{ const x = doc.querySelector('.onboarding-a-close-btn'); if (x) { x.dispatchEvent(new MouseEvent('click', { bubbles: true })); } }
	std.open(ws + '/caret.txt', 'w').puts('second file\n'); std.open(ws + '/two.txt', 'w').puts('another file here\n');
	await settle(20);
	{ const t0 = performance.now(); while (!(rectOf('.explorer-folders-view .monaco-list-row', 'caret.txt') && rectOf('.explorer-folders-view .monaco-list-row', 'two.txt')) && performance.now() - t0 < 60000) { await sleep(5); tick(); } log('ctl: new files listed after ' + Math.round(performance.now() - t0) + ' ms'); }
	const results = [];
	for (let round = 1; round <= rounds; round++) {
		const res = {};
		{ const r = rectOf('.explorer-folders-view .monaco-list-row', 'hello.txt'); const [x, y] = center(r); res.context = await timed('context', () => click(x, y, { button: 2, buttons: 2 }), menuOpen); await esc(); }
		{ const f = rectOf('.menubar .menubar-menu-button', 'File'), e = rectOf('.menubar .menubar-menu-button', 'Edit'); const [fx, fy] = center(f), [ex, ey] = center(e);
		  res.menubar = await timed('menubar', () => click(fx, fy), menuOpen);
		  res.menuMove = await timed('menuMove', () => move(ex, ey), () => { const b = [...doc.querySelectorAll('.menubar .menubar-menu-button')].find((x) => /Edit/.test(x.textContent)); const f = [...doc.querySelectorAll('.menubar .menubar-menu-button')].find((x) => /File/.test(x.textContent)); const isOpen = (x) => !!x && (x.classList.contains('open') || x.getAttribute('aria-expanded') === 'true'); return isOpen(b) && !isOpen(f) && menuOpen(); }, 3000);
		  await esc(); }
		{ const r = rectOf('.explorer-folders-view .monaco-list-row', 'caret.txt'); const [x, y] = center(r); res.openFile = await timed('openFile', () => click(x, y), () => lineHas(/second.file/)); }
		{ const r = rectOf('.explorer-folders-view .monaco-list-row', 'two.txt'); const [x, y] = center(r); res.switchFile = await timed('switchFile', () => click(x, y), () => lineHas(/another.file/)); }
		{ const r = rectOf('.explorer-folders-view .monaco-list-row', 'caret.txt'); const [x, y] = center(r); await timed('back', () => click(x, y), () => lineHas(/second.file/)); await settle(5); }
		{ const sp = [...doc.querySelectorAll('.editor-instance .view-line span span')].find((s) => /second.file/.test(s.textContent)); const r = sp.getBoundingClientRect(); const n = sp.textContent.length, cw = r.width / n; const col = 3 + (round % 3);
		  res.caret = await timed('caret', () => click(r.left + cw * (col + 0.3), r.top + r.height / 2), () => [...doc.querySelectorAll('.statusbar-item')].some((s) => new RegExp('Col ' + (col + 1) + '\\b').test(s.textContent))); await settle(4);
		  const dx = r.left + cw * 1.5, dy = r.top + r.height / 2;
		  res.dblclick = await timed('dblclick', () => { click(dx, dy); click(dx, dy, { detail: 2 }); }, () => !!doc.querySelector('.editor-instance .selected-text')); await settle(4);
		  click(r.left + r.width + 20, r.top + r.height / 2); await settle(4);
		  const ks = []; const ta = active();
		  for (const [i, ch] of [...'abcde'].entries()) { const want = 'file' + 'abcde'.slice(0, i + 1); ks.push(await timed('key', () => { const t = active(); const kd = new KeyboardEvent('keydown', { key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true, composed: true }); t.dispatchEvent(kd); if (!kd.defaultPrevented && 'value' in t) { t.value = (t.value || '') + ch; t.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true })); } t.dispatchEvent(new KeyboardEvent('keyup', { key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.toUpperCase().charCodeAt(0), bubbles: true })); }, () => [...doc.querySelectorAll('.editor-instance .view-line')].some((l) => l.textContent.replace(/ /g, ' ').includes(want)))); }
		  res.key = Math.round(ks.reduce((a, b) => a + b, 0) / ks.length);
		  for (let i = 0; i < 5; i++) { keyOn(active(), 'Backspace', 'Backspace', 8); await settle(1); } keyOn(active(), 's', 'KeyS', 83, { ctrlKey: true }); await settle(5); void ta; }
		const quickShown = () => { const i = doc.querySelector('.quick-input-widget'); return !!i && i.getBoundingClientRect().height > 0 && doc.querySelectorAll('.quick-input-list .monaco-list-row').length > 0; };
		res.quickOpen = await timed('quickOpen', () => keyOn(active(), 'p', 'KeyP', 80, { ctrlKey: true }), quickShown); await esc();
		res.palette = await timed('palette', () => keyOn(active(), 'P', 'KeyP', 80, { ctrlKey: true, shiftKey: true }), quickShown); await esc();
		for (const [kind, label] of [['newFile', 'New File'], ['newFolder', 'New Folder']]) {
			const b = [...doc.querySelectorAll('.action-label')].find((a) => (a.getAttribute('aria-label') || '').startsWith(label)); const name = `ctl_${kind}_${round}` + (kind === 'newFile' ? '.txt' : '');
			res[kind + 'Input'] = await timed(kind + 'Input', () => { b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); }, () => !!doc.querySelector('.explorer-item-edit-input input, .monaco-tl-contents .monaco-inputbox input'));
			const inp = doc.querySelector('.explorer-item-edit-input input, .monaco-tl-contents .monaco-inputbox input'); inp.value = name; inp.dispatchEvent(new InputEvent('input', { data: name, inputType: 'insertText', bubbles: true }));
			res[kind] = await timed(kind, () => keyOn(inp, 'Enter', 'Enter', 13), () => [...doc.querySelectorAll('.explorer-folders-view .monaco-list-row')].some((r) => (r.getAttribute('aria-label') || '').startsWith(name)));
			await settle(6);
		}
		log('ctl: round ' + round + ' ' + JSON.stringify(res)); results.push(res); await settle(5);
	}
	const med = {}; for (const k of Object.keys(results[0])) { const v = results.map((r) => r[k]).sort((a, b) => a - b); med[k] = v[Math.floor(v.length / 2)]; }
	log('ctl: median ' + JSON.stringify(med));
	if (why) { for (const [name, m] of Object.entries(whyAll)) { const tot = [...m.values()].reduce((a, b) => a + b, 0); log(`ctl: why ${name}: ${tot} layout passes over ${rounds} rounds`); for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 5)) { log(`ctl:   ${v} x ${k.slice(0, 300)}`); } } }
	if (split) { for (const [k, list] of Object.entries(splits)) { const m = list[Math.floor(list.length / 2)]; log('ctl: split ' + k + ' ' + JSON.stringify(m)); } }
	{ const st = globalThis.__gcStats?.(); log(`ctl: gc ${ctx.gcIdle ? 'idle' : 'stock'}: ${idleGcRuns} runs between actions (${Math.round(idleGcMs)} ms), ${st ? st[0] : '?'} idle-scheduled in total, ${st ? st[1] : '?'} forced from inside an allocation, heap ${st ? Math.round(st[2] / 1048576) : '?'} MB`); }
	log('ctl: done');
}
