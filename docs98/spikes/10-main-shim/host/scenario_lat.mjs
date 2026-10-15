// Desktop scenario: wall-clock latency of everyday actions (explorer context menu, menu bar, New File) before and while the language servers start, the way the
// window host drives the document (tick loop: timers, frames, layout, paint). Compare builds or CPU limits (taskset) with it; the VM complaint was that these take seconds.
// Usage: boot_desktop_qjs.mjs ... --workspace <dir> --scenario scenario_lat.mjs   (--rounds N: repeat the busy block)
import { runScenario } from '../../08-workbench-boot/host/boot_common.js';
import { paintDocument } from '../../06-rendering/host/dom/paint.js';
import { NativeBackend } from '../../07-native-render/host/native_backend.js';
import * as os from 'qjs:os';
import * as std from 'qjs:std';
const sleep = (ms) => new Promise((r) => os.setTimeout(r, ms));
export async function run(ctx) { try { await run0(ctx); } catch (e) { ctx.log('lat: failed ' + (e && e.stack || e)); } }
async function run0(ctx) {
	const { doc, log, env } = ctx; const W = ctx.W, H = ctx.H; const ws = ctx.opt('workspace', '/tmp/claude-0/ws98');
	const settle = (s = 20) => runScenario(ctx, { seconds: s, stableRounds: 40 });
	const backend = new NativeBackend(W, H, {}); let painted = -1;
	const MouseEvent = env.window.MouseEvent, PointerEvent = env.window.PointerEvent, KeyboardEvent = env.window.KeyboardEvent, InputEvent = env.window.InputEvent;
	const base = (x, y, o = {}) => ({ clientX: x, clientY: y, screenX: x, screenY: y, bubbles: true, cancelable: true, composed: true, view: env.window, button: 0, buttons: 1, detail: 1, ...o });
	const acc = { frames: 0, layout: 0, paint: 0, ticks: 0 };
	const tick = () => { let t = performance.now(); env.flushFrames?.(); acc.frames += performance.now() - t; acc.ticks++; if (doc.__dirty || doc.__passStats.length !== painted) { t = performance.now(); doc.__ensureLayout(); acc.layout += performance.now() - t; painted = doc.__passStats.length; t = performance.now(); backend.reset(); paintDocument(doc, W, H, backend); acc.paint += performance.now() - t; } };
	/** runs act, then ticks until pred() holds; returns the wall time in ms (or -1 on timeout) */
	async function timed(act, pred, maxMs = 120000) { const t0 = performance.now(); const a0 = { ...acc }; const p0 = doc.__passStats.length; act(); acc.event = performance.now() - t0; for (;;) { await sleep(1); tick(); let ok = false; try { ok = pred(); } catch { } if (ok) { const ms = Math.round(performance.now() - t0); if (ms > Number(ctx.opt('slow', 2000))) { const ps = doc.__passStats.slice(p0); log('lat:   slow ' + ms + ' ms: event ' + acc.event.toFixed(0) + ', frames ' + (acc.frames - a0.frames).toFixed(0) + ', layout ' + (acc.layout - a0.layout).toFixed(0) + ' (passes ' + ps.length + ', style ' + ps.reduce((a, x) => a + x.styleMs, 0).toFixed(0) + ', layout ' + ps.reduce((a, x) => a + x.layoutMs, 0).toFixed(0) + '), paint ' + (acc.paint - a0.paint).toFixed(0) + ', ticks ' + (acc.ticks - a0.ticks)); if (ctx.opt('detail', '0') === '1') { for (const x of ps) { log('lat:     pass ' + JSON.stringify(x, (k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)).slice(0, 700)); } } } return ms; } if (performance.now() - t0 > maxMs) { return -1; } } }
	const rect = (el) => el.getBoundingClientRect();
	const click = (el, o = {}) => { const r = rect(el); const x = r.left + r.width / 2, y = r.top + r.height / 2; const t = (r.height > 0 && doc.elementFromPoint(x, y)) || el; const p = { ...base(x, y, o), pointerId: 1, pointerType: 'mouse', isPrimary: true };
		t.dispatchEvent(new PointerEvent('pointerdown', p)); t.dispatchEvent(new MouseEvent('mousedown', base(x, y, o))); t.dispatchEvent(new PointerEvent('pointerup', { ...p, buttons: 0 })); t.dispatchEvent(new MouseEvent('mouseup', base(x, y, { ...o, buttons: 0 })));
		if (o.button === 2) { t.dispatchEvent(new MouseEvent('contextmenu', base(x, y, { ...o, buttons: 0 }))); } else { t.dispatchEvent(new MouseEvent('click', base(x, y, { ...o, buttons: 0 }))); } };
	const key = (target, k, code, kc) => { for (const type of ['keydown', 'keyup']) { const ev = new KeyboardEvent(type, { key: k, code, keyCode: kc, bubbles: true, cancelable: true, composed: true }); ev.which = kc; target.dispatchEvent(ev); } };
	const menuOpen = () => [...doc.querySelectorAll('.monaco-menu')].some((m) => rect(m).height > 0);
	const closeMenus = async () => { key(doc.activeElement || doc.body, 'Escape', 'Escape', 27); await timed(() => { }, () => !menuOpen(), 5000); await settle(4); };
	const rowOf = (name) => [...doc.querySelectorAll('.explorer-folders-view .monaco-list-row')].find((r) => (r.getAttribute('aria-label') || '').startsWith(name));
	{ const x = doc.querySelector('.onboarding-a-close-btn'); if (x) { click(x); await settle(10); } }
	await settle(20);
	const measure = async (tag) => {
		const res = {};
		const row = rowOf('hello.txt'); if (!row) { log('lat: no hello.txt row'); return res; }
		res.context = await timed(() => click(row, { button: 2, buttons: 2 }), menuOpen); await closeMenus();
		const file = [...doc.querySelectorAll('.menubar .menubar-menu-button')].find((b) => /File/.test(b.textContent)); if (file) { res.menubar = await timed(() => click(file), menuOpen); await closeMenus(); }
		const btn = [...doc.querySelectorAll('.action-label')].find((b) => /^New File/.test(b.getAttribute('aria-label') || ''));
		if (btn) { const name = 'lat_' + tag + '.js'; res.newfileInput = await timed(() => click(btn), () => doc.querySelector('.explorer-item-edit-input input, .monaco-tl-contents .monaco-inputbox input')); const inp = doc.querySelector('.explorer-item-edit-input input, .monaco-tl-contents .monaco-inputbox input');
			if (inp) { inp.value = name; inp.dispatchEvent(new InputEvent('input', { data: name, inputType: 'insertText', bubbles: true })); res.newfileRow = await timed(() => key(inp, 'Enter', 'Enter', 13), () => rowOf(name)); } }
		log('lat: ' + tag + ' ' + JSON.stringify(res)); return res;
	};
	if (ctx.opt('prof', '0') === '1') { globalThis.__sp = { k: {}, tot: 0, share: 0, exam: 0, full: 0, hit: 0, match: 0, nmatch: 0, compute: 0, pseudo: 0, rest: 0, n: 0 }; }
	if (ctx.opt('dump', '0') === '1') { const ix = doc.__ruleIndex; const cat = {}; for (const e of ix.universal) { const c = e.complex.parts[e.complex.parts.length - 1].compound; const k = c.attrs.length ? 'attr' : c.pseudos.length ? 'pseudo:' + c.pseudos.map((p) => p.name).join('+') : 'other'; cat[k] = (cat[k] || 0) + 1; }
		log('lat: universal ' + ix.universal.length + ' ' + JSON.stringify(Object.entries(cat).sort((a, b) => b[1] - a[1]).slice(0, 25)));
		const big = (m) => [...m.entries()].map(([k, l]) => [k, l.length]).sort((a, b) => b[1] - a[1]).slice(0, 12); log('lat: tag buckets ' + JSON.stringify(big(ix.byTag))); log('lat: class buckets ' + JSON.stringify(big(ix.byClass))); }
	await measure('idle'); if (globalThis.__sp) { log('lat: style profile ' + JSON.stringify(globalThis.__sp, (k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v))); }
	await settle(15);
	for (let i = 1; i <= Number(ctx.opt('rounds', 2)); i++) { await measure('busy' + i); }
	await settle(Number(ctx.opt('tail', 30))); await measure('after');
	log('lat: done');
}
